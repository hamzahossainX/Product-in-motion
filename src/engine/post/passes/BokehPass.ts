/**
 * Physical depth of field.
 *
 * The blur radius is a real circle of confusion from the thin-lens equation —
 * aperture diameter, focal length, focus distance, film height — not a blur
 * strength dialled by hand. That is what makes the focus plane behave like a
 * lens: pulling focus moves a plane through the scene instead of fading a blur
 * in and out, and a longer camera lens deepens the blur on its own.
 *
 *   coc = |A · f · (z − P)| / (z · (P − f))       A = f / N
 *
 * Gathering runs at half resolution: the whole point of the pass is that the
 * result has no high frequencies left, so shading it at full resolution would
 * be four times the cost for a difference nobody can see.
 */
import { ShaderMaterial, Texture, Uniform, Vector2, WebGLRenderTarget, WebGLRenderer } from 'three';
import { blit, createPassMaterial, createRenderTarget } from '../../FboHelper.ts';
import { LUMA, LINEARIZE_DEPTH } from '../shaders/common.glsl.ts';

/** Beyond this the gather cost stops buying visible quality. */
const MAX_COC_PIXELS = 28;
/** Golden-angle spiral taps. Halved on the mobile tier. */
const SAMPLE_COUNT = 32;
const MOBILE_SAMPLE_COUNT = 16;
const DOWNSAMPLE = 0.5;
/** Vertical FOV the profile's bokeh defaults were tuned against. */
const REFERENCE_FOV_DEGREES = 35;

const COC_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_depth;
uniform vec2 u_texelSize;
uniform float u_near;
uniform float u_far;
uniform float u_fNumber;
uniform float u_focusDistance;
uniform float u_focalLength;
uniform float u_filmHeight;
uniform float u_amount;
uniform float u_focalScale;
uniform float u_resolutionHeight;
${LINEARIZE_DEPTH}

void main() {
  float depth = texture2D(u_depth, v_uv).x;
  float z = linearizeDepth(depth, u_near, u_far);

  float focal = u_focalLength * u_focalScale;
  float aperture = focal / max(u_fNumber, 1e-4);
  float denom = max(z * (u_focusDistance - focal), 1e-6);
  float cocWorld = abs(aperture * focal * (z - u_focusDistance)) / denom;
  float cocPixels = cocWorld / max(u_filmHeight, 1e-4) * u_resolutionHeight * u_amount;
  cocPixels = min(cocPixels, ${MAX_COC_PIXELS}.0);
  // Signed so the composite can tell a near-field halo from a far-field one.
  float signedCoc = z < u_focusDistance ? -cocPixels : cocPixels;

  // Box-average the four full-res texels this half-res texel covers, so the
  // gather does not alias against the sharp image.
  vec3 color =
    texture2D(u_source, v_uv + vec2(-0.5,-0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2( 0.5,-0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2(-0.5, 0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2( 0.5, 0.5) * u_texelSize).rgb;
  gl_FragColor = vec4(color * 0.25, signedCoc);
}
`;

const GATHER_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_coc;
uniform vec2 u_texelSize;
uniform int u_sampleCount;
${LUMA}

const float GOLDEN_ANGLE = 2.39996323;
const int MAX_SAMPLES = ${SAMPLE_COUNT};

void main() {
  vec4 center = texture2D(u_coc, v_uv);
  float centerRadius = abs(center.a) * 0.5;   // half-res pixels

  vec3 sum = center.rgb;
  float weightSum = 1.0;

  for (int i = 0; i < MAX_SAMPLES; i++) {
    if (i >= u_sampleCount) break;
    float t = (float(i) + 0.5) / float(u_sampleCount);
    float radius = sqrt(t);                    // uniform area over the disc
    float angle = float(i) * GOLDEN_ANGLE;
    vec2 offset = vec2(cos(angle), sin(angle)) * radius;

    vec4 s = texture2D(u_coc, v_uv + offset * centerRadius * u_texelSize);
    float sampleRadius = abs(s.a) * 0.5;
    // A sample only contributes if its own circle reaches this pixel. Without
    // that test a sharp foreground bleeds into a blurred background.
    float reach = radius * centerRadius;
    float weight = clamp(sampleRadius - reach + 1.0, 0.0, 1.0);
    // Near-field samples scatter over everything in front of them.
    weight = s.a < 0.0 ? max(weight, clamp(sampleRadius - reach + 1.0, 0.0, 1.0)) : weight;
    sum += s.rgb * weight;
    weightSum += weight;
  }

  gl_FragColor = vec4(sum / weightSum, center.a);
}
`;

const COMPOSITE_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_blurred;
uniform float u_amount;

void main() {
  vec3 sharp = texture2D(u_source, v_uv).rgb;
  vec4 blurred = texture2D(u_blurred, v_uv);
  // One pixel of circle of confusion is a sharp pixel; the ramp to fully
  // blurred is deliberately gentle so the focus plane has no visible edge.
  float mixAmount = clamp(abs(blurred.a) - 1.0, 0.0, 1.0);
  gl_FragColor = vec4(mix(sharp, blurred.rgb, mixAmount * step(0.0001, u_amount)), 1.0);
}
`;

export class BokehPass {
  private readonly cocMaterial: ShaderMaterial;
  private readonly gatherMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly cocTarget: WebGLRenderTarget;
  private readonly gatherTarget: WebGLRenderTarget;

  constructor(width: number, height: number, depth: Texture, mobile: boolean) {
    const half = this.halfSize(width, height);
    this.cocTarget = createRenderTarget(half.x, half.y);
    this.gatherTarget = createRenderTarget(half.x, half.y);

    this.cocMaterial = createPassMaterial(COC_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_depth: new Uniform(depth),
      u_texelSize: new Uniform(new Vector2(1 / width, 1 / height)),
      u_near: new Uniform(0.1),
      u_far: new Uniform(100),
      u_fNumber: new Uniform(0.181),
      u_focusDistance: new Uniform(4.5),
      u_focalLength: new Uniform(0.344),
      u_filmHeight: new Uniform(19.26),
      u_amount: new Uniform(0),
      u_focalScale: new Uniform(1),
      u_resolutionHeight: new Uniform(height),
    });
    this.gatherMaterial = createPassMaterial(GATHER_SHADER, {
      u_coc: new Uniform<Texture | null>(null),
      u_texelSize: new Uniform(new Vector2(1 / half.x, 1 / half.y)),
      u_sampleCount: new Uniform(mobile ? MOBILE_SAMPLE_COUNT : SAMPLE_COUNT),
    });
    this.compositeMaterial = createPassMaterial(COMPOSITE_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_blurred: new Uniform<Texture | null>(null),
      u_amount: new Uniform(0),
    });
  }

  private halfSize(width: number, height: number): Vector2 {
    return new Vector2(
      Math.max(1, Math.round(width * DOWNSAMPLE)),
      Math.max(1, Math.round(height * DOWNSAMPLE)),
    );
  }

  /** Focal scale from the live camera: a narrower field of view is a longer
   *  lens, and a longer lens has a shallower depth of field for free. */
  static focalScaleForFov(fovDegrees: number): number {
    const reference = Math.tan((REFERENCE_FOV_DEGREES * Math.PI) / 360);
    const current = Math.tan((fovDegrees * Math.PI) / 360);
    return current > 1e-6 ? reference / current : 1;
  }

  setSampleCount(count: number): void {
    (this.gatherMaterial.uniforms['u_sampleCount'] as Uniform<number>).value =
      Math.min(SAMPLE_COUNT, Math.max(4, count));
  }

  setCamera(near: number, far: number, fovDegrees: number): void {
    const u = this.cocMaterial.uniforms;
    (u['u_near'] as Uniform<number>).value = near;
    (u['u_far'] as Uniform<number>).value = far;
    (u['u_focalScale'] as Uniform<number>).value = BokehPass.focalScaleForFov(fovDegrees);
  }

  setProfile(
    amount: number, fNumber: number, focusDistance: number,
    focalLength: number, filmHeight: number,
  ): void {
    const u = this.cocMaterial.uniforms;
    (u['u_amount'] as Uniform<number>).value = amount;
    (u['u_fNumber'] as Uniform<number>).value = fNumber;
    (u['u_focusDistance'] as Uniform<number>).value = focusDistance;
    (u['u_focalLength'] as Uniform<number>).value = focalLength;
    (u['u_filmHeight'] as Uniform<number>).value = filmHeight;
    (this.compositeMaterial.uniforms['u_amount'] as Uniform<number>).value = amount;
  }

  get amount(): number {
    return (this.compositeMaterial.uniforms['u_amount'] as Uniform<number>).value;
  }

  render(renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget): Texture {
    if (this.amount <= 0.0001) return source;
    (this.cocMaterial.uniforms['u_source'] as Uniform<Texture | null>).value = source;
    blit(renderer, this.cocMaterial, this.cocTarget);

    (this.gatherMaterial.uniforms['u_coc'] as Uniform<Texture | null>).value = this.cocTarget.texture;
    blit(renderer, this.gatherMaterial, this.gatherTarget);

    const c = this.compositeMaterial.uniforms;
    (c['u_source'] as Uniform<Texture | null>).value = source;
    (c['u_blurred'] as Uniform<Texture | null>).value = this.gatherTarget.texture;
    blit(renderer, this.compositeMaterial, target);
    return target.texture;
  }

  setSize(width: number, height: number): void {
    const half = this.halfSize(width, height);
    this.cocTarget.setSize(half.x, half.y);
    this.gatherTarget.setSize(half.x, half.y);
    (this.cocMaterial.uniforms['u_texelSize'] as Uniform<Vector2>).value.set(1 / width, 1 / height);
    (this.cocMaterial.uniforms['u_resolutionHeight'] as Uniform<number>).value = height;
    (this.gatherMaterial.uniforms['u_texelSize'] as Uniform<Vector2>).value.set(1 / half.x, 1 / half.y);
  }

  dispose(): void {
    this.cocTarget.dispose();
    this.gatherTarget.dispose();
    this.cocMaterial.dispose();
    this.gatherMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}
