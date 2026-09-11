/**
 * Temporal anti-aliasing.
 *
 * The camera projection is jittered by a Halton sequence each frame, so over
 * N frames every pixel is sampled at N sub-pixel positions. This pass folds the
 * new frame into a history buffer, reprojecting the history through the depth
 * buffer so a moving camera keeps its accumulated detail instead of smearing.
 *
 * Native MSAA is not an option (CLAUDE.md rule 10) and would not help anyway:
 * it antialiases geometry edges only, while most of the aliasing here is
 * specular shimmer on the object's bevels, which is a shading problem.
 */
import { Matrix4, ShaderMaterial, Texture, Uniform, Vector2, WebGLRenderTarget, WebGLRenderer, Camera, PerspectiveCamera } from 'three';
import { blit, createPassMaterial, PingPong } from '../../FboHelper.ts';
import { LUMA, YCOCG, TONE_WEIGHT } from '../shaders/common.glsl.ts';

/** Sub-pixel sample count before the sequence repeats. Eight converges fast
 *  enough to look clean within a third of a second and short enough that a
 *  slow-moving camera never reveals the pattern. */
const JITTER_SAMPLES = 8;
/** How much history survives each frame. Higher is smoother and ghostier. */
const FEEDBACK = 0.9;
/** Reprojection further than this many pixels is treated as a disocclusion. */
const MAX_REPROJECT_PIXELS = 64;

function halton(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  let i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

const JITTER_OFFSETS: Vector2[] = Array.from({ length: JITTER_SAMPLES }, (_, i) =>
  new Vector2(halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5),
);

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_current;
uniform sampler2D u_history;
uniform sampler2D u_depth;
uniform vec2 u_texelSize;
uniform mat4 u_reproject;
uniform float u_feedback;
uniform float u_maxReprojectPixels;
${LUMA}
${YCOCG}
${TONE_WEIGHT}

void main() {
  vec3 current = texture2D(u_current, v_uv).rgb;

  float depth = texture2D(u_depth, v_uv).x;
  // Sky and cleared background have nothing to reproject against; taking the
  // current sample there avoids dragging a halo behind moving geometry.
  if (depth >= 1.0) { gl_FragColor = vec4(current, 1.0); return; }

  vec4 clip = vec4(v_uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 previous = u_reproject * clip;
  vec2 historyUv = (previous.xy / previous.w) * 0.5 + 0.5;

  vec2 driftPixels = (historyUv - v_uv) / u_texelSize;
  bool offscreen = any(lessThan(historyUv, vec2(0.0))) || any(greaterThan(historyUv, vec2(1.0)));
  if (offscreen || length(driftPixels) > u_maxReprojectPixels) {
    gl_FragColor = vec4(current, 1.0);
    return;
  }

  // Neighbourhood clamp: the history is only allowed to be a colour that
  // actually occurs around this pixel this frame. Without it, TAA ghosts.
  vec3 minC = vec3(1e5);
  vec3 maxC = vec3(-1e5);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = rgbToYCoCg(toneCompress(
        texture2D(u_current, v_uv + vec2(float(x), float(y)) * u_texelSize).rgb));
      minC = min(minC, s);
      maxC = max(maxC, s);
    }
  }

  vec3 historyYCoCg = rgbToYCoCg(toneCompress(texture2D(u_history, historyUv).rgb));
  historyYCoCg = clamp(historyYCoCg, minC, maxC);
  vec3 history = toneExpand(yCoCgToRgb(historyYCoCg));

  gl_FragColor = vec4(mix(current, history, u_feedback), 1.0);
}
`;

export class TaaPass {
  private readonly history: PingPong;
  private readonly material: ShaderMaterial;
  private readonly currentViewProjection = new Matrix4();
  private readonly previousViewProjection = new Matrix4();
  private readonly scratch = new Matrix4();
  private frameIndex = 0;
  private hasHistory = false;
  enabled = true;

  constructor(width: number, height: number, depth: Texture) {
    this.history = new PingPong(width, height);
    this.material = createPassMaterial(FRAGMENT_SHADER, {
      u_current: new Uniform<Texture | null>(null),
      u_history: new Uniform<Texture | null>(null),
      u_depth: new Uniform(depth),
      u_texelSize: new Uniform(new Vector2(1 / width, 1 / height)),
      u_reproject: new Uniform(new Matrix4()),
      u_feedback: new Uniform(FEEDBACK),
      u_maxReprojectPixels: new Uniform(MAX_REPROJECT_PIXELS),
    });
  }

  /** Offset the projection by a sub-pixel amount for this frame. Must be undone
   *  before anything reads the camera for non-rendering purposes. */
  applyJitter(camera: PerspectiveCamera, width: number, height: number): void {
    if (!this.enabled) return;
    const offset = JITTER_OFFSETS[this.frameIndex % JITTER_SAMPLES];
    if (!offset) return;
    const e = camera.projectionMatrix.elements;
    e[8] = (e[8] ?? 0) + (offset.x * 2) / width;
    e[9] = (e[9] ?? 0) + (offset.y * 2) / height;
  }

  /** Record the unjittered matrices. Reprojection must use the clean pair or
   *  the history search wobbles by the jitter amount every frame. */
  captureMatrices(camera: Camera, unjitteredProjection: Matrix4): void {
    this.previousViewProjection.copy(this.currentViewProjection);
    this.currentViewProjection.multiplyMatrices(unjitteredProjection, camera.matrixWorldInverse);
  }

  render(renderer: WebGLRenderer, source: Texture): Texture {
    if (!this.enabled) return source;
    const uniforms = this.material.uniforms;

    this.scratch.copy(this.currentViewProjection).invert();
    (uniforms['u_reproject'] as Uniform<Matrix4>).value
      .multiplyMatrices(this.previousViewProjection, this.scratch);

    (uniforms['u_current'] as Uniform<Texture | null>).value = source;
    (uniforms['u_history'] as Uniform<Texture | null>).value =
      this.hasHistory ? this.history.texture : source;
    (uniforms['u_feedback'] as Uniform<number>).value = this.hasHistory ? FEEDBACK : 0;

    blit(renderer, this.material, this.history.write);
    this.history.swap();
    this.hasHistory = true;
    this.frameIndex++;
    return this.history.texture;
  }

  /** A resize invalidates the history: it is the wrong resolution and the wrong
   *  projection, so reprojecting it would fabricate detail. */
  setSize(width: number, height: number): void {
    this.history.setSize(width, height);
    (this.material.uniforms['u_texelSize'] as Uniform<Vector2>).value.set(1 / width, 1 / height);
    this.hasHistory = false;
  }

  get historyTarget(): WebGLRenderTarget { return this.history.read; }

  dispose(): void {
    this.history.dispose();
    this.material.dispose();
  }
}
