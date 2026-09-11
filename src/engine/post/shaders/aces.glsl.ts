/**
 * Hand-written ACES filmic tonemap (rule 11).
 *
 * The full ACES RRT+ODT fit from Stephen Hill: transform into the AP1-ish
 * working matrix, apply the rational fit, transform back. It is written out
 * here rather than using renderer.toneMapping because it has to run inside the
 * final pass, after bloom and inside the grade, so that the grade operates on
 * scene-referred light and the tonemap is the last thing before display.
 */
export const ACES = /* glsl */ `
const mat3 ACES_INPUT_MAT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUTPUT_MAT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFitted(vec3 color) {
  color = ACES_INPUT_MAT * color;
  color = rrtAndOdtFit(color);
  color = ACES_OUTPUT_MAT * color;
  return clamp(color, 0.0, 1.0);
}

/** Manual sRGB encode. three is told the output is linear so this is the only
 *  place the transfer function is applied — one transform, one location. */
vec3 linearToSRGB(vec3 c) {
  return mix(
    c * 12.92,
    1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c)
  );
}
`;
