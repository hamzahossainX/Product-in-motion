/**
 * Multi-mip bloom.
 *
 * A single large gaussian is both expensive and wrong: real lens glare has
 * energy at every scale at once. Downsampling through a mip chain with the
 * 13-tap filter and tent-upsampling back up gives that spread almost free,
 * because each level costs a quarter of the one above it.
 *
 * The result is left as a separate texture rather than composited here — the
 * final pass adds it, so the grade sees bloom and base together and there is
 * one fewer full-resolution pass in the chain.
 */
import { ShaderMaterial, Texture, Uniform, Vector2, WebGLRenderTarget, WebGLRenderer } from 'three';
import { blit, createPassMaterial, createRenderTarget } from '../../FboHelper.ts';
import { LUMA } from '../shaders/common.glsl.ts';

/** Six levels reaches roughly a third of the screen at 1080p, which is as wide
 *  as bloom can spread before it reads as fog rather than glare. */
const MIP_COUNT = 6;
const MIN_MIP_SIZE = 8;
/** Bloom starts at half resolution; the prefilter box-averages into it. */
const BASE_DOWNSAMPLE = 0.5;

const PREFILTER_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texelSize;
uniform float u_threshold;
uniform float u_smoothWidth;
uniform float u_saturation;
${LUMA}

void main() {
  vec3 color =
    texture2D(u_source, v_uv + vec2(-0.5,-0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2( 0.5,-0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2(-0.5, 0.5) * u_texelSize).rgb +
    texture2D(u_source, v_uv + vec2( 0.5, 0.5) * u_texelSize).rgb;
  color *= 0.25;

  // Soft knee: a hard threshold makes bloom pop on and off as a highlight
  // crosses it, which is the single most obvious sign of a cheap bloom.
  float brightness = max(color.r, max(color.g, color.b));
  float knee = max(u_threshold * u_smoothWidth, 1e-4);
  float soft = clamp(brightness - u_threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, brightness - u_threshold) / max(brightness, 1e-4);
  color *= contribution;

  color = mix(vec3(luma(color)), color, u_saturation);
  gl_FragColor = vec4(color, 1.0);
}
`;

const DOWNSAMPLE_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texelSize;

// 13-tap partial-Karis downsample: the four inner 2x2 groups are averaged
// separately, which is what stops a single bright pixel flickering between
// mip levels as the camera moves.
void main() {
  vec2 t = u_texelSize;
  vec3 a = texture2D(u_source, v_uv + vec2(-2.0, 2.0) * t).rgb;
  vec3 b = texture2D(u_source, v_uv + vec2( 0.0, 2.0) * t).rgb;
  vec3 c = texture2D(u_source, v_uv + vec2( 2.0, 2.0) * t).rgb;
  vec3 d = texture2D(u_source, v_uv + vec2(-2.0, 0.0) * t).rgb;
  vec3 e = texture2D(u_source, v_uv).rgb;
  vec3 f = texture2D(u_source, v_uv + vec2( 2.0, 0.0) * t).rgb;
  vec3 g = texture2D(u_source, v_uv + vec2(-2.0,-2.0) * t).rgb;
  vec3 h = texture2D(u_source, v_uv + vec2( 0.0,-2.0) * t).rgb;
  vec3 i = texture2D(u_source, v_uv + vec2( 2.0,-2.0) * t).rgb;
  vec3 j = texture2D(u_source, v_uv + vec2(-1.0, 1.0) * t).rgb;
  vec3 k = texture2D(u_source, v_uv + vec2( 1.0, 1.0) * t).rgb;
  vec3 l = texture2D(u_source, v_uv + vec2(-1.0,-1.0) * t).rgb;
  vec3 m = texture2D(u_source, v_uv + vec2( 1.0,-1.0) * t).rgb;

  vec3 result = (j + k + l + m) * 0.5;
  result += (a + b + d + e) * 0.125;
  result += (b + c + e + f) * 0.125;
  result += (d + e + g + h) * 0.125;
  result += (e + f + h + i) * 0.125;
  gl_FragColor = vec4(result * 0.25, 1.0);
}
`;

const UPSAMPLE_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_previous;
uniform vec2 u_texelSize;
uniform float u_radius;

// 9-tap tent, added onto the level below. u_radius widens the tent, which is
// what the profile's bloomRadius controls.
void main() {
  vec2 t = u_texelSize * u_radius;
  vec3 sum = texture2D(u_source, v_uv + vec2(-1.0, -1.0) * t).rgb;
  sum += texture2D(u_source, v_uv + vec2( 0.0, -1.0) * t).rgb * 2.0;
  sum += texture2D(u_source, v_uv + vec2( 1.0, -1.0) * t).rgb;
  sum += texture2D(u_source, v_uv + vec2(-1.0,  0.0) * t).rgb * 2.0;
  sum += texture2D(u_source, v_uv).rgb * 4.0;
  sum += texture2D(u_source, v_uv + vec2( 1.0,  0.0) * t).rgb * 2.0;
  sum += texture2D(u_source, v_uv + vec2(-1.0,  1.0) * t).rgb;
  sum += texture2D(u_source, v_uv + vec2( 0.0,  1.0) * t).rgb * 2.0;
  sum += texture2D(u_source, v_uv + vec2( 1.0,  1.0) * t).rgb;
  gl_FragColor = vec4(sum / 16.0 + texture2D(u_previous, v_uv).rgb, 1.0);
}
`;

interface Mip {
  /** Downsample chain level. */
  down: WebGLRenderTarget;
  /** Upsample accumulation for this level. A level cannot be both the source
   *  and the destination of one blit, so the two chains stay separate. */
  up: WebGLRenderTarget;
  size: Vector2;
}

export class BloomPass {
  private readonly prefilter: ShaderMaterial;
  private readonly downsample: ShaderMaterial;
  private readonly upsample: ShaderMaterial;
  private mips: Mip[] = [];

  constructor(width: number, height: number) {
    this.prefilter = createPassMaterial(PREFILTER_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_texelSize: new Uniform(new Vector2(1 / width, 1 / height)),
      u_threshold: new Uniform(0.3),
      u_smoothWidth: new Uniform(0.75),
      u_saturation: new Uniform(1),
    });
    this.downsample = createPassMaterial(DOWNSAMPLE_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_texelSize: new Uniform(new Vector2()),
    });
    this.upsample = createPassMaterial(UPSAMPLE_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_previous: new Uniform<Texture | null>(null),
      u_texelSize: new Uniform(new Vector2()),
      u_radius: new Uniform(1),
    });
    this.buildMips(width, height);
  }

  private buildMips(width: number, height: number): void {
    for (const mip of this.mips) { mip.down.dispose(); mip.up.dispose(); }
    this.mips = [];
    let w = Math.max(1, Math.round(width * BASE_DOWNSAMPLE));
    let h = Math.max(1, Math.round(height * BASE_DOWNSAMPLE));
    for (let i = 0; i < MIP_COUNT; i++) {
      this.mips.push({
        down: createRenderTarget(w, h),
        up: createRenderTarget(w, h),
        size: new Vector2(w, h),
      });
      if (w <= MIN_MIP_SIZE || h <= MIN_MIP_SIZE) break;
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  setProfile(threshold: number, smoothWidth: number, saturation: number, radius: number): void {
    const u = this.prefilter.uniforms;
    (u['u_threshold'] as Uniform<number>).value = threshold;
    (u['u_smoothWidth'] as Uniform<number>).value = smoothWidth;
    (u['u_saturation'] as Uniform<number>).value = saturation;
    // bloomRadius arrives as a 0..1 design value; the tent wants texels.
    (this.upsample.uniforms['u_radius'] as Uniform<number>).value = 1 + radius * 3;
  }

  /** Returns the widest level of the upsample chain: the accumulated bloom. */
  render(renderer: WebGLRenderer, source: Texture): Texture {
    const first = this.mips[0];
    const last = this.mips[this.mips.length - 1];
    if (!first || !last) return source;

    (this.prefilter.uniforms['u_source'] as Uniform<Texture | null>).value = source;
    blit(renderer, this.prefilter, first.down);

    for (let i = 1; i < this.mips.length; i++) {
      const from = this.mips[i - 1];
      const to = this.mips[i];
      if (!from || !to) break;
      (this.downsample.uniforms['u_source'] as Uniform<Texture | null>).value = from.down.texture;
      (this.downsample.uniforms['u_texelSize'] as Uniform<Vector2>).value
        .set(1 / from.size.x, 1 / from.size.y);
      blit(renderer, this.downsample, to.down);
    }

    // Walk back up: tent-filter the level above, add the matching downsample
    // level, write to this level's own up target. Source and destination are
    // always different textures.
    let accumulated = last.down.texture;
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const above = this.mips[i + 1];
      const level = this.mips[i];
      if (!above || !level) break;
      const u = this.upsample.uniforms;
      (u['u_source'] as Uniform<Texture | null>).value = accumulated;
      (u['u_previous'] as Uniform<Texture | null>).value = level.down.texture;
      (u['u_texelSize'] as Uniform<Vector2>).value.set(1 / above.size.x, 1 / above.size.y);
      blit(renderer, this.upsample, level.up);
      accumulated = level.up.texture;
    }

    return accumulated;
  }

  setSize(width: number, height: number): void {
    (this.prefilter.uniforms['u_texelSize'] as Uniform<Vector2>).value
      .set(1 / width, 1 / height);
    this.buildMips(width, height);
  }

  dispose(): void {
    for (const mip of this.mips) { mip.down.dispose(); mip.up.dispose(); }
    this.prefilter.dispose();
    this.downsample.dispose();
    this.upsample.dispose();
  }
}
