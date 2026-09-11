/**
 * Graphite dust.
 *
 * One InstancedMesh, one draw call, real geometry — tetrahedral crumbs, not
 * point sprites, so they catch the light and tumble instead of reading as a
 * flat overlay.
 *
 * All motion happens in the vertex shader from a per-instance seed, so the
 * frame loop does nothing per particle: no matrix composition, no attribute
 * upload, and nothing to allocate (CLAUDE.md rule 17).
 */
import {
  AdditiveBlending, Color, DoubleSide, InstancedBufferAttribute,
  InstancedBufferGeometry, InstancedMesh, ShaderMaterial, TetrahedronGeometry, Uniform,
} from 'three';
import type { SharedUniforms } from '../engine/SharedUniforms.ts';

const DESKTOP_COUNT = 420;
const MOBILE_COUNT = 90;
const CRUMB_RADIUS = 0.014;

/** The spiral the swarm follows. */
const PATH_RADIUS_MIN = 1.1;
const PATH_RADIUS_MAX = 3.4;
const PATH_HEIGHT = 4.6;
const PATH_CURVE_AMPLITUDE = 0.55;
const PATH_PHASE_SPEED = 0.16;
const SPIRAL_FREQUENCY_MIN = 0.25;
const SPIRAL_FREQUENCY_MAX = 0.85;
const RISE_SPEED = 0.035;
const SPIN_SPEED = 0.9;

/** How far the pointer shoves the near ones. */
const POINTER_PUSH = 0.42;
/** Dust is only visible where light falls on it. Gating the crumbs on the gobo
 *  cookie is both what actually happens in a room and what stops them reading
 *  as glitter scattered over the frame. */
const BRIGHTNESS = 0.34;
const GOBO_GATE = 0.75;

const VERTEX_SHADER = /* glsl */ `
attribute vec4 a_seed;      // radius, phase, spiralFrequency, size
attribute float a_spin;
uniform float u_time;
uniform vec2 u_pointer;
uniform sampler2D u_goboMap;
uniform mat4 u_goboMatrix;
varying float v_fade;
varying vec3 v_normal;
varying float v_light;

const float PATH_HEIGHT = ${PATH_HEIGHT};
const float PATH_CURVE_AMPLITUDE = ${PATH_CURVE_AMPLITUDE};
const float PATH_PHASE_SPEED = ${PATH_PHASE_SPEED};
const float RISE_SPEED = ${RISE_SPEED};
const float POINTER_PUSH = ${POINTER_PUSH};

mat3 rotation(vec3 axis, float angle) {
  float s = sin(angle), c = cos(angle);
  float t = 1.0 - c;
  return mat3(
    t * axis.x * axis.x + c,          t * axis.x * axis.y - s * axis.z, t * axis.x * axis.z + s * axis.y,
    t * axis.x * axis.y + s * axis.z, t * axis.y * axis.y + c,          t * axis.y * axis.z - s * axis.x,
    t * axis.x * axis.z - s * axis.y, t * axis.y * axis.z + s * axis.x, t * axis.z * axis.z + c);
}

void main() {
  float radius = a_seed.x;
  float phase = a_seed.y;
  float spiral = a_seed.z;
  float size = a_seed.w;

  float angle = phase * 6.2831853 + u_time * PATH_PHASE_SPEED * spiral;
  // Radius breathes so the swarm is a volume rather than a cylinder shell.
  float r = radius * (1.0 - PATH_CURVE_AMPLITUDE * 0.5
          + PATH_CURVE_AMPLITUDE * 0.5 * sin(angle * 0.7 + phase * 12.0));

  float rise = fract(phase + u_time * RISE_SPEED);
  vec3 centre = vec3(cos(angle) * r, (rise - 0.5) * PATH_HEIGHT, sin(angle) * r);

  // Scaled to nothing at both ends of the loop, so the wrap is never a pop.
  v_fade = smoothstep(0.0, 0.14, rise) * (1.0 - smoothstep(0.86, 1.0, rise));

  vec2 toPointer = centre.xy - u_pointer * 3.0;
  centre.xy += normalize(toPointer + 1e-4) * POINTER_PUSH / (1.0 + dot(toPointer, toPointer));

  mat3 tumble = rotation(normalize(vec3(0.3, 1.0, 0.6)), u_time * ${SPIN_SPEED} * a_spin);
  vec3 local = tumble * position * size * v_fade;
  v_normal = normalize(tumble * normal);

  vec4 world = modelMatrix * vec4(centre + local, 1.0);

  // Sampled per instance in the vertex stage, not per fragment: a crumb is a
  // few pixels across, so one lookup at its centre is the whole story.
  vec4 projected = u_goboMatrix * world;
  float cookie = 0.0;
  if (projected.w > 0.0) {
    vec2 guv = projected.xy / projected.w;
    if (all(greaterThanEqual(guv, vec2(0.0))) && all(lessThanEqual(guv, vec2(1.0)))) {
      cookie = texture2D(u_goboMap, guv).r;
    }
  }
  v_light = mix(1.0 - ${GOBO_GATE}, 1.0, cookie);

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying float v_fade;
varying float v_light;
varying vec3 v_normal;
uniform vec3 u_color;
uniform vec3 u_goboDirection;

void main() {
  // A crumb is too small for a lighting model to read as anything but a facet
  // brightness, so that is all it gets: face toward the key light, brighter.
  float facing = 0.18 + 0.82 * max(dot(normalize(v_normal), u_goboDirection), 0.0);
  gl_FragColor = vec4(u_color * (facing * v_fade * v_light * ${BRIGHTNESS}), 1.0);
}
`;

export class Particles {
  readonly mesh: InstancedMesh;
  readonly count: number;
  private readonly material: ShaderMaterial;
  private readonly geometry: InstancedBufferGeometry;

  constructor(shared: SharedUniforms, mobile: boolean) {
    this.count = mobile ? MOBILE_COUNT : DESKTOP_COUNT;

    const source = new TetrahedronGeometry(CRUMB_RADIUS, 0);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.index = source.index;
    this.geometry.attributes = source.attributes;
    this.geometry.instanceCount = this.count;

    const seeds = new Float32Array(this.count * 4);
    const spins = new Float32Array(this.count);
    // A fixed lattice would read as a pattern and a Math.random() swarm differs
    // every reload; a hash of the index is neither.
    for (let i = 0; i < this.count; i++) {
      const h = (n: number) => {
        const v = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
        return v - Math.floor(v);
      };
      seeds[i * 4] = PATH_RADIUS_MIN + h(1) * (PATH_RADIUS_MAX - PATH_RADIUS_MIN);
      seeds[i * 4 + 1] = h(2);
      seeds[i * 4 + 2] = SPIRAL_FREQUENCY_MIN + h(3) * (SPIRAL_FREQUENCY_MAX - SPIRAL_FREQUENCY_MIN);
      seeds[i * 4 + 3] = 0.35 + h(4) * 0.85;
      spins[i] = 0.4 + h(5) * 1.4;
    }
    this.geometry.setAttribute('a_seed', new InstancedBufferAttribute(seeds, 4));
    this.geometry.setAttribute('a_spin', new InstancedBufferAttribute(spins, 1));

    this.material = new ShaderMaterial({
      uniforms: {
        u_time: shared.u_time,
        u_pointer: shared.u_pointer,
        u_goboDirection: shared.u_goboDirection,
        u_goboMap: shared.u_goboMap,
        u_goboMatrix: shared.u_goboMatrix,
        u_color: new Uniform(new Color('#C89A5B')),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: DoubleSide,
      // Dust catching light adds to what is behind it; it never occludes.
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, this.count);
    this.mesh.frustumCulled = false;   // the swarm is always partly on screen
    this.mesh.name = 'graphite-dust';
    source.dispose();
  }

  /** Nothing per frame: the shader reads shared uniforms the engine updates. */
  get drawCallCount(): number { return 1; }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
