/**
 * FXAA, run after TAA.
 *
 * TAA cleans up everything that persists across frames; FXAA catches the first
 * frame after a disocclusion and any edge the neighbourhood clamp rejected.
 * Together they cost one full-screen pass each and beat MSAA, which cannot
 * touch specular shimmer at all.
 *
 * Edge detection runs on an approximate gamma curve, not on the linear values:
 * FXAA's thresholds were tuned for perceptual luma, and in linear light a dark
 * edge falls below the threshold and stays jagged.
 */
import { ShaderMaterial, Texture, Uniform, Vector2, WebGLRenderTarget, WebGLRenderer } from 'three';
import { blit, createPassMaterial } from '../../FboHelper.ts';

/** Below this local contrast, the pixel is left alone. */
const EDGE_THRESHOLD_MIN = 0.0312;
const EDGE_THRESHOLD_MAX = 0.125;
const SUBPIXEL_QUALITY = 0.75;
const SEARCH_STEPS = 12;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_texelSize;

const float EDGE_THRESHOLD_MIN = ${EDGE_THRESHOLD_MIN};
const float EDGE_THRESHOLD_MAX = ${EDGE_THRESHOLD_MAX};
const float SUBPIXEL_QUALITY = ${SUBPIXEL_QUALITY};
const int SEARCH_STEPS = ${SEARCH_STEPS};

float fxaaLuma(vec3 c) {
  // sqrt() is a cheap stand-in for the sRGB transfer function; the exact curve
  // does not matter, only that contrast is measured perceptually.
  return dot(sqrt(max(c, vec3(0.0))), vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 texel = u_texelSize;
  vec3 rgbM = texture2D(u_source, v_uv).rgb;
  float lumaM = fxaaLuma(rgbM);
  float lumaN = fxaaLuma(texture2D(u_source, v_uv + vec2(0.0, -texel.y)).rgb);
  float lumaS = fxaaLuma(texture2D(u_source, v_uv + vec2(0.0,  texel.y)).rgb);
  float lumaW = fxaaLuma(texture2D(u_source, v_uv + vec2(-texel.x, 0.0)).rgb);
  float lumaE = fxaaLuma(texture2D(u_source, v_uv + vec2( texel.x, 0.0)).rgb);

  float lumaMin = min(lumaM, min(min(lumaN, lumaS), min(lumaW, lumaE)));
  float lumaMax = max(lumaM, max(max(lumaN, lumaS), max(lumaW, lumaE)));
  float range = lumaMax - lumaMin;

  if (range < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  float lumaNW = fxaaLuma(texture2D(u_source, v_uv + vec2(-texel.x, -texel.y)).rgb);
  float lumaNE = fxaaLuma(texture2D(u_source, v_uv + vec2( texel.x, -texel.y)).rgb);
  float lumaSW = fxaaLuma(texture2D(u_source, v_uv + vec2(-texel.x,  texel.y)).rgb);
  float lumaSE = fxaaLuma(texture2D(u_source, v_uv + vec2( texel.x,  texel.y)).rgb);

  float lumaNS = lumaN + lumaS;
  float lumaWE = lumaW + lumaE;
  float lumaNWNE = lumaNW + lumaNE;
  float lumaSWSE = lumaSW + lumaSE;
  float lumaNWSW = lumaNW + lumaSW;
  float lumaNESE = lumaNE + lumaSE;

  float edgeHorizontal =
    abs(-2.0 * lumaW + lumaNWSW) + abs(-2.0 * lumaM + lumaNS) * 2.0 +
    abs(-2.0 * lumaE + lumaNESE);
  float edgeVertical =
    abs(-2.0 * lumaN + lumaNWNE) + abs(-2.0 * lumaM + lumaWE) * 2.0 +
    abs(-2.0 * lumaS + lumaSWSE);
  bool isHorizontal = edgeHorizontal >= edgeVertical;

  float luma1 = isHorizontal ? lumaN : lumaW;
  float luma2 = isHorizontal ? lumaS : lumaE;
  float gradient1 = luma1 - lumaM;
  float gradient2 = luma2 - lumaM;
  bool is1Steepest = abs(gradient1) >= abs(gradient2);
  float gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

  float stepLength = isHorizontal ? texel.y : texel.x;
  float lumaLocalAverage;
  if (is1Steepest) { stepLength = -stepLength; lumaLocalAverage = 0.5 * (luma1 + lumaM); }
  else { lumaLocalAverage = 0.5 * (luma2 + lumaM); }

  vec2 currentUv = v_uv;
  if (isHorizontal) currentUv.y += stepLength * 0.5;
  else currentUv.x += stepLength * 0.5;

  vec2 offset = isHorizontal ? vec2(texel.x, 0.0) : vec2(0.0, texel.y);
  vec2 uv1 = currentUv - offset;
  vec2 uv2 = currentUv + offset;
  float lumaEnd1 = fxaaLuma(texture2D(u_source, uv1).rgb) - lumaLocalAverage;
  float lumaEnd2 = fxaaLuma(texture2D(u_source, uv2).rgb) - lumaLocalAverage;
  bool reached1 = abs(lumaEnd1) >= gradientScaled;
  bool reached2 = abs(lumaEnd2) >= gradientScaled;

  // Walk along the edge until both ends leave the local luma band. The span
  // length is what decides how far the pixel is shifted.
  for (int i = 0; i < SEARCH_STEPS; i++) {
    if (reached1 && reached2) break;
    if (!reached1) {
      uv1 -= offset;
      lumaEnd1 = fxaaLuma(texture2D(u_source, uv1).rgb) - lumaLocalAverage;
      reached1 = abs(lumaEnd1) >= gradientScaled;
    }
    if (!reached2) {
      uv2 += offset;
      lumaEnd2 = fxaaLuma(texture2D(u_source, uv2).rgb) - lumaLocalAverage;
      reached2 = abs(lumaEnd2) >= gradientScaled;
    }
  }

  float distance1 = isHorizontal ? (v_uv.x - uv1.x) : (v_uv.y - uv1.y);
  float distance2 = isHorizontal ? (uv2.x - v_uv.x) : (uv2.y - v_uv.y);
  bool isDirection1 = distance1 < distance2;
  float distanceFinal = min(distance1, distance2);
  float edgeThickness = distance1 + distance2;
  float pixelOffset = -distanceFinal / max(edgeThickness, 1e-6) + 0.5;

  bool isLumaCenterSmaller = lumaM < lumaLocalAverage;
  bool correctVariation =
    ((isDirection1 ? lumaEnd1 : lumaEnd2) < 0.0) != isLumaCenterSmaller;
  float finalOffset = correctVariation ? pixelOffset : 0.0;

  // Sub-pixel term: recovers the detail the span walk alone would soften.
  float lumaAverage = (1.0 / 12.0) * (2.0 * (lumaNS + lumaWE) + lumaNWSW + lumaNESE);
  float subPixelOffset1 = clamp(abs(lumaAverage - lumaM) / max(range, 1e-6), 0.0, 1.0);
  float subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
  float subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * SUBPIXEL_QUALITY;
  finalOffset = max(finalOffset, subPixelOffsetFinal);

  vec2 finalUv = v_uv;
  if (isHorizontal) finalUv.y += finalOffset * stepLength;
  else finalUv.x += finalOffset * stepLength;

  gl_FragColor = vec4(texture2D(u_source, finalUv).rgb, 1.0);
}
`;

export class FxaaPass {
  private readonly material: ShaderMaterial;
  enabled = true;

  constructor(width: number, height: number) {
    this.material = createPassMaterial(FRAGMENT_SHADER, {
      u_source: new Uniform<Texture | null>(null),
      u_texelSize: new Uniform(new Vector2(1 / width, 1 / height)),
    });
  }

  render(renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget): Texture {
    if (!this.enabled) return source;
    (this.material.uniforms['u_source'] as Uniform<Texture | null>).value = source;
    blit(renderer, this.material, target);
    return target.texture;
  }

  setSize(width: number, height: number): void {
    (this.material.uniforms['u_texelSize'] as Uniform<Vector2>).value.set(1 / width, 1 / height);
  }

  dispose(): void { this.material.dispose(); }
}
