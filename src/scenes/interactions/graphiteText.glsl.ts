/**
 * The two shaders behind the writing sheet.
 *
 * Split out to keep GraphiteText under the 300-line ceiling (rule 16), and
 * because a GLSL string is a different kind of thing to read than the class
 * that binds it.
 */
export const STROKE_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform vec2 u_centre;
uniform float u_radius;
uniform float u_strength;
uniform float u_aspect;

void main() {
  vec2 d = (v_uv - u_centre) * vec2(u_aspect, 1.0);
  // Soft-edged, because an eraser has no hard boundary and a hard one reads as
  // a stamp rather than a stroke.
  float falloff = 1.0 - smoothstep(u_radius * 0.35, u_radius, length(d));
  gl_FragColor = vec4(vec3(falloff * u_strength), 1.0);
}
`;

export const SHEET_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_erase;
uniform vec3 u_paper;
uniform vec3 u_graphite;
uniform float u_smudge;
uniform float u_reveal;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  // Recover the signed distance and antialias against the screen-space
  // derivative, so the edge stays one pixel wide however close the camera is.
  float signedDistance = texture2D(u_field, v_uv).r - 0.5;
  float width = max(fwidth(signedDistance), 1e-4);
  float ink = smoothstep(-width, width, signedDistance);

  float erased = texture2D(u_erase, v_uv).r;
  // The erase front eats the graphite unevenly; a clean edge reads as a wipe.
  float grain = valueNoise(v_uv * vec2(220.0, 60.0));
  float removal = smoothstep(0.28, 0.72, erased + (grain - 0.5) * 0.32);

  float remaining = ink * (1.0 - removal);
  // Real erasers leave a ghost, and a soft grade leaves more of one.
  float ghost = ink * removal * u_smudge;

  vec3 fibre = u_paper * (0.97 + valueNoise(v_uv * vec2(420.0, 110.0)) * 0.06);
  vec3 color = mix(fibre, u_graphite, clamp(remaining + ghost * 0.22, 0.0, 1.0));
  // The sheet itself fades with the section, not only the writing on it —
  // otherwise a blank page hangs in the middle of every other section.
  gl_FragColor = vec4(color, u_reveal);
}
`;
