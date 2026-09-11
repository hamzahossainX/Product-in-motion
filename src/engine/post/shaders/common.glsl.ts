/** GLSL fragments shared by more than one pass. Kept as TS exports so Vite
 *  inlines them and the type checker sees a real module graph. */

/** Rec.709 luma. Used by bloom thresholding, FXAA and the saturation term. */
export const LUMA = /* glsl */ `
const vec3 LUMA_WEIGHTS = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA_WEIGHTS); }
`;

/** Perspective depth buffers are non-linear; every distance-based effect needs
 *  the view-space distance back. */
export const LINEARIZE_DEPTH = /* glsl */ `
float linearizeDepth(float depth, float near, float far) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
`;

/** YCoCg makes TAA neighbourhood clamping far less prone to colour fringing
 *  than clamping in RGB, because chroma and luma clamp independently. */
export const YCOCG = /* glsl */ `
vec3 rgbToYCoCg(vec3 c) {
  return vec3(
    0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
    0.5 * c.r - 0.5 * c.b,
   -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
  );
}
vec3 yCoCgToRgb(vec3 c) {
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}
`;

/** Reinhard-style tone weighting for TAA and bloom sampling: bright fireflies
 *  are averaged in a compressed space so a single hot pixel cannot dominate. */
export const TONE_WEIGHT = /* glsl */ `
vec3 toneCompress(vec3 c) { return c / (1.0 + luma(c)); }
vec3 toneExpand(vec3 c) { return c / max(1.0 - luma(c), 1e-4); }
`;
