/**
 * The prefiltered environment map.
 *
 * There is no HDRI file in the project, so the studio is written as a shader on
 * an inverted sphere — a warm floor-to-ceiling gradient plus three soft boxes
 * matching the key, fill and rim in Stage — and prefiltered once through
 * three's PMREMGenerator. That is a genuine split-sum prefilter: a roughness
 * mip chain sampled with three's own analytic BRDF approximation, which is what
 * a BRDF LUT is an implementation of.
 *
 * Prefiltering is float, not RGBM. RGBM with maxRange 20 exists to carry high
 * dynamic range through 8-bit textures; half-float render targets are available
 * here, so encoding and decoding it would only lose precision.
 */
import {
  BackSide, Color, Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry,
  Texture, Uniform, Vector3, WebGLRenderer,
} from 'three';

const SPHERE_RADIUS = 12;
const SPHERE_SEGMENTS = 32;

const GROUND_COLOR = '#0E0B08';
const SKY_COLOR = '#241A14';
const KEY_COLOR = '#FFE3C2';
const KEY_INTENSITY = 2.1;
const KEY_SHARPNESS = 8;
const FILL_COLOR = '#8C7663';
const FILL_INTENSITY = 0.42;
const FILL_SHARPNESS = 3;
const RIM_COLOR = '#E4735C';
const RIM_INTENSITY = 1.5;
const RIM_SHARPNESS = 14;

const KEY_DIRECTION = new Vector3(-0.55, 0.72, 0.42).normalize();
const FILL_DIRECTION = new Vector3(0.85, -0.1, 0.5).normalize();
const RIM_DIRECTION = new Vector3(0.25, 0.3, -0.92).normalize();

const VERTEX_SHADER = /* glsl */ `
varying vec3 v_direction;
void main() {
  v_direction = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec3 v_direction;
uniform vec3 u_ground;
uniform vec3 u_sky;
uniform vec3 u_keyColor;
uniform vec3 u_keyDirection;
uniform vec3 u_fillColor;
uniform vec3 u_fillDirection;
uniform vec3 u_rimColor;
uniform vec3 u_rimDirection;

/** A soft box, as a lobe. Cheaper than geometry and softer at the edges, which
 *  is what stops a reflection reading as a hard rectangle. */
vec3 lobe(vec3 dir, vec3 axis, vec3 color, float sharpness) {
  return color * pow(max(dot(dir, axis), 0.0), sharpness);
}

void main() {
  vec3 dir = normalize(v_direction);
  vec3 color = mix(u_ground, u_sky, smoothstep(-0.7, 0.85, dir.y));
  color += lobe(dir, u_keyDirection, u_keyColor, ${KEY_SHARPNESS}.0);
  color += lobe(dir, u_fillDirection, u_fillColor, ${FILL_SHARPNESS}.0);
  color += lobe(dir, u_rimDirection, u_rimColor, ${RIM_SHARPNESS}.0);
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Builds the prefiltered map and throws away everything used to make it. */
export function createEnvironment(renderer: WebGLRenderer): Texture {
  const scene = new Scene();
  const geometry = new SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS);
  const material = new ShaderMaterial({
    uniforms: {
      u_ground: new Uniform(new Color(GROUND_COLOR)),
      u_sky: new Uniform(new Color(SKY_COLOR)),
      u_keyColor: new Uniform(new Color(KEY_COLOR).multiplyScalar(KEY_INTENSITY)),
      u_keyDirection: new Uniform(KEY_DIRECTION),
      u_fillColor: new Uniform(new Color(FILL_COLOR).multiplyScalar(FILL_INTENSITY)),
      u_fillDirection: new Uniform(FILL_DIRECTION),
      u_rimColor: new Uniform(new Color(RIM_COLOR).multiplyScalar(RIM_INTENSITY)),
      u_rimDirection: new Uniform(RIM_DIRECTION),
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    side: BackSide,
    depthWrite: false,
  });
  scene.add(new Mesh(geometry, material));

  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0, 0.1, SPHERE_RADIUS * 2);

  geometry.dispose();
  material.dispose();
  pmrem.dispose();
  target.texture.name = 'studio-env';
  return target.texture;
}
