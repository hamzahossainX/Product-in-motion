/**
 * The projected light, sampled inside a material's lighting term.
 *
 * A moving cookie across static geometry does more for perceived cost than any
 * amount of extra polygons, which is why this is injected into every lit
 * material rather than faked as a screen-space overlay: it has to respect the
 * surface normal and move correctly as the object turns.
 */
/** Declared in both stages, so it goes in its own chunk. */
export const GOBO_VARYING = /* glsl */ `
varying vec3 v_goboWorldPosition;
`;

export const GOBO_UNIFORMS = /* glsl */ `
uniform sampler2D u_goboMap;
uniform mat4 u_goboMatrix;
uniform vec3 u_goboColor;
uniform float u_goboIntensity;
uniform vec3 u_goboDirection;
`;

export const GOBO_VERTEX = /* glsl */ `
v_goboWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

/**
 * Returns the projected light colour arriving at this fragment.
 *
 * Outside the projector's frustum the cookie contributes nothing — clamped
 * sampling would smear the border texel across the whole scene instead.
 */
export const GOBO_SAMPLE = /* glsl */ `
vec3 sampleGobo(vec3 worldPosition, vec3 worldNormal) {
  vec4 projected = u_goboMatrix * vec4(worldPosition, 1.0);
  if (projected.w <= 0.0) return vec3(0.0);
  vec2 uv = projected.xy / projected.w;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);

  // Soft border, so the projector has no visible rectangular edge.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), uv) *
              (1.0 - smoothstep(vec2(0.88), vec2(1.0), uv));
  float border = edge.x * edge.y;

  float lambert = max(dot(worldNormal, u_goboDirection), 0.0);
  float cookie = texture2D(u_goboMap, uv).r;
  return u_goboColor * (cookie * lambert * border * u_goboIntensity);
}
`;
