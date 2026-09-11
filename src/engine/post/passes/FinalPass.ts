/**
 * Bloom composite, grade, tonemap, vignette, dither, encode — one pass.
 *
 * Order matters and is fixed: bloom is added to scene-referred light, the grade
 * operates on that (so contrast and saturation act on real radiance, not on
 * already-crushed display values), ACES maps it to display, then vignette,
 * then dither, then the sRGB transfer function. Splitting grade and tonemap
 * into two passes would move a full-resolution read/write for no difference in
 * output, so they share one shader.
 */
import { Color, ShaderMaterial, Texture, Uniform, Vector2, WebGLRenderer } from 'three';
import { blit, createPassMaterial } from '../../FboHelper.ts';
import { LUMA } from '../shaders/common.glsl.ts';
import { ACES } from '../shaders/aces.glsl.ts';
import { BLUE_NOISE } from '../shaders/blueNoise.glsl.ts';
import type { BlueNoise } from '../../BlueNoise.ts';
import type { PostProfile } from '../PostProfile.ts';

/** Scene-referred mid grey. Contrast pivots here so raising contrast darkens
 *  shadows and lifts highlights around a perceptual middle, not around 0.5. */
const GRADE_PIVOT = 0.18;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_bloom;
uniform float u_bloomAmount;
uniform float u_saturation;
uniform float u_contrast;
uniform float u_brightness;
uniform vec3 u_tintColor;
uniform float u_tintOpacity;
uniform float u_vignetteFrom;
uniform float u_vignetteTo;
uniform vec3 u_vignetteColor;
uniform float u_aspect;
uniform sampler2D u_lens;
uniform vec2 u_lensCentre;
uniform float u_lensRadius;
uniform float u_lensOpen;
uniform vec3 u_lensRim;
${LUMA}
${ACES}
${BLUE_NOISE}

const float GRADE_PIVOT = ${GRADE_PIVOT};

void main() {
  vec3 color = texture2D(u_source, v_uv).rgb;
  color += texture2D(u_bloom, v_uv).rgb * u_bloomAmount;

  // The magnifier. Not a zoom of these pixels — that would only enlarge them —
  // but a second render of the same region at the lens target's resolution,
  // which is where the extra detail comes from.
  if (u_lensOpen > 0.001) {
    vec2 offset = (v_uv - u_lensCentre) * vec2(u_aspect, 1.0);
    float edge = length(offset) / max(u_lensRadius, 1e-4);
    float inside = 1.0 - smoothstep(0.92, 1.0, edge);
    if (inside > 0.0) {
      vec2 lensUv = (v_uv - u_lensCentre) / max(u_lensRadius, 1e-4);
      lensUv = lensUv * vec2(u_aspect, 1.0) * 0.5 + 0.5;
      vec3 magnified = texture2D(u_lens, lensUv).rgb;
      color = mix(color, magnified, inside * u_lensOpen);
      // A rim, so the lens has an edge to read as glass.
      float rim = smoothstep(0.86, 0.99, edge) * (1.0 - smoothstep(0.99, 1.02, edge));
      color += u_lensRim * rim * u_lensOpen;
    }
  }

  color *= u_brightness;
  color = mix(vec3(luma(color)), color, u_saturation);
  color = (color - GRADE_PIVOT) * (1.0 + u_contrast) + GRADE_PIVOT;
  color = max(color, vec3(0.0));
  // Multiplicative tint: at the intended opacities this is not seen as colour,
  // only as the scene having been shot on a particular stock.
  color = mix(color, color * u_tintColor, u_tintOpacity);

  color = acesFitted(color);

  float d = length((v_uv - 0.5) * vec2(u_aspect, 1.0)) * 2.0;
  float vignette = smoothstep(u_vignetteFrom, u_vignetteTo, d);
  color = mix(color, u_vignetteColor, vignette);

  color = linearToSRGB(color);
  // Dither last, in display space, where one 8-bit step is exactly the
  // quantisation the framebuffer is about to apply.
  color = ditherOutput(color, gl_FragCoord.xy);

  gl_FragColor = vec4(color, 1.0);
}
`;

export class FinalPass {
  private readonly material: ShaderMaterial;

  constructor(blueNoise: BlueNoise, width: number, height: number) {
    this.material = createPassMaterial(FRAGMENT_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_bloom: new Uniform<Texture | null>(null),
      u_bloomAmount: new Uniform(1),
      u_saturation: new Uniform(1),
      u_contrast: new Uniform(0),
      u_brightness: new Uniform(1),
      u_tintColor: new Uniform(new Color(1, 1, 1)),
      u_tintOpacity: new Uniform(0),
      u_vignetteFrom: new Uniform(2),
      u_vignetteTo: new Uniform(3),
      u_vignetteColor: new Uniform(new Color(0, 0, 0)),
      u_aspect: new Uniform(width / Math.max(1, height)),
      // Shared by reference (rule 19): the noise object mutates these in place.
      u_blueNoise: new Uniform(blueNoise.texture),
      u_blueNoiseScale: new Uniform(blueNoise.scale),
      u_blueNoiseOffset: new Uniform(blueNoise.offset),
      u_ditherAmount: new Uniform(1),
      u_lens: new Uniform<Texture | null>(null),
      u_lensCentre: new Uniform(new Vector2(0.5, 0.5)),
      u_lensRadius: new Uniform(0.14),
      u_lensOpen: new Uniform(0),
      u_lensRim: new Uniform(new Color('#E4735C').multiplyScalar(0.25)),
    });
  }

  setProfile(profile: PostProfile): void {
    const u = this.material.uniforms;
    (u['u_bloomAmount'] as Uniform<number>).value = profile.bloomAmount;
    (u['u_saturation'] as Uniform<number>).value = profile.saturation;
    (u['u_contrast'] as Uniform<number>).value = profile.contrast;
    (u['u_brightness'] as Uniform<number>).value = profile.brightness;
    (u['u_tintOpacity'] as Uniform<number>).value = profile.tintOpacity;
    (u['u_vignetteFrom'] as Uniform<number>).value = profile.vignetteFrom;
    (u['u_vignetteTo'] as Uniform<number>).value = profile.vignetteTo;
    (u['u_tintColor'] as Uniform<Color>).value.copy(profile.tintColor);
    (u['u_vignetteColor'] as Uniform<Color>).value.copy(profile.vignetteColor);
  }

  render(renderer: WebGLRenderer, source: Texture, bloom: Texture): void {
    const u = this.material.uniforms;
    (u['u_source'] as Uniform<Texture | null>).value = source;
    (u['u_bloom'] as Uniform<Texture | null>).value = bloom;
    blit(renderer, this.material, null);
  }

  /** The magnified render, and where to put it. `open` is 0 when there is no
   *  lens, so the branch above costs nothing on every other section. */
  setLens(texture: Texture | null, x: number, y: number, radius: number, open: number): void {
    const u = this.material.uniforms;
    (u['u_lens'] as Uniform<Texture | null>).value = texture;
    (u['u_lensCentre'] as Uniform<Vector2>).value.set(x, y);
    (u['u_lensRadius'] as Uniform<number>).value = radius;
    (u['u_lensOpen'] as Uniform<number>).value = open;
  }

  /** Verification only: the gate compares a dithered frame against this one. */
  setDither(enabled: boolean): void {
    (this.material.uniforms['u_ditherAmount'] as Uniform<number>).value = enabled ? 1 : 0;
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms['u_aspect'] as Uniform<number>).value =
      width / Math.max(1, height);
  }

  dispose(): void { this.material.dispose(); }
}
