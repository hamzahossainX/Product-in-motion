/**
 * The projected light.
 *
 * An animated cookie is rendered to a 512x512 target every frame and projected
 * across the scene through `u_goboMatrix`. This is the single largest
 * contributor to the scene reading as expensive: light that crawls over static
 * geometry does more than any amount of added detail.
 *
 * The mouse feeds it through VELOCITY, not position. A light that tracked the
 * cursor would read as a follow-spot; one that swings when the cursor is thrown
 * and settles when it stops reads as a physical fixture on a boom.
 *
 * `reset()` runs at the top of every frame (CLAUDE.md rule 2) and sections
 * blend partial claims over the defaults.
 */
import {
  Matrix4, PerspectiveCamera, ShaderMaterial, UnsignedByteType, Uniform,
  Vector3, WebGLRenderer, WebGLRenderTarget, MathUtils,
} from 'three';
import { blit, createPassMaterial, createRenderTarget } from './FboHelper.ts';
import { SecondOrderDynamics2 } from '../lib/SecondOrderDynamics.ts';
import type { SharedUniforms } from './SharedUniforms.ts';
import type { Pointer } from './Pointer.ts';

const SIZE = 512;
/** Cookie units per second. */
const BASE_SPEED = 4;
/** The gobo is the shaping light, not a modifier on an already-lit scene. */
const BASE_INTENSITY = 1.5;
/**
 * Pointer velocity into the swing spring's velocity.
 *
 * Not the spec's 0.003: that value multiplied a displacement, added straight
 * into the swing's position each frame. This is an impulse into a spring, and
 * the peak displacement it produces is roughly v/omega rather than v — at
 * 0.85 Hz that is a factor of about five, and the flick has to accumulate over
 * several frames besides. Measured: 0.018 produced a quarter of the swing the
 * displacement form did, and the response is linear, so this is that value
 * scaled to land back on it.
 */
const MOUSE_STRENGTH = 0.075;
/** Mouse velocity added to the cookie's own scroll speed. */
const MOUSE_EXTRA_SPEED = 0.5;
/** The swing is a spring back to rest with the pointer's velocity pushed into
 *  it, which is what a fixture on a boom actually does — and rule 5 asks for a
 *  spring rather than an exponential decay curve. */
const SWING_FREQUENCY = 0.85;
const SWING_DAMPING = 0.55;
const MAX_SWING = 0.42;

const PROJECTOR_FOV = 58;
const PROJECTOR_DISTANCE = 9;
const PROJECTOR_NEAR = 0.5;
const PROJECTOR_FAR = 30;
const PROJECTOR_POSITION = new Vector3(-3.4, 5.2, 5.6);

const COOKIE_SHADER = /* glsl */ `
precision highp float;
varying vec2 v_uv;
uniform float u_offset;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += valueNoise(p) * amplitude;
    p *= 2.03;
    amplitude *= 0.5;
  }
  return sum;
}

void main() {
  vec2 p = v_uv * 6.5;
  p.y -= u_offset;

  // Two decorrelated layers drifting at different rates: one alone reads as a
  // texture sliding past, two read as light through something moving.
  float a = fbm(p);
  float b = fbm(p * 1.7 + vec2(u_offset * 0.21, 4.3));
  float clouds = smoothstep(0.32, 0.86, a * 0.65 + b * 0.5);

  // Slats, softened and slowly breathing, so there is one recognisable shape
  // in the pattern rather than pure noise.
  float slats = 0.5 + 0.5 * sin(p.y * 2.1 + sin(u_time * 0.11) * 0.6);
  slats = smoothstep(0.18, 0.95, slats);

  gl_FragColor = vec4(vec3(mix(clouds, clouds * slats, 0.55)), 1.0);
}
`;

const BIAS = new Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const scratchDirection = new Vector3();

export class Gobo {
  readonly target: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly projector: PerspectiveCamera;
  private readonly uniforms: SharedUniforms;
  private readonly swing =
    new SecondOrderDynamics2(0, 0, SWING_FREQUENCY, SWING_DAMPING, 0);

  /** Claimable per frame; reset() restores these before sections write. */
  private speed = BASE_SPEED;
  private intensity = BASE_INTENSITY;
  private offset = 0;
  /** Reduced motion holds the cookie still. It is still projected — the light
   *  is most of what the scene looks like — it just stops crawling. */
  motionEnabled = true;

  constructor(uniforms: SharedUniforms) {
    this.uniforms = uniforms;
    this.target = createRenderTarget(SIZE, SIZE, { type: UnsignedByteType });
    this.target.texture.name = 'gobo-cookie';
    this.material = createPassMaterial(COOKIE_SHADER, {
      u_offset: new Uniform(0),
      u_time: new Uniform(0),
    });

    this.projector = new PerspectiveCamera(
      PROJECTOR_FOV, 1, PROJECTOR_NEAR, PROJECTOR_FAR);
    this.projector.position.copy(PROJECTOR_POSITION)
      .normalize().multiplyScalar(PROJECTOR_DISTANCE);
    this.projector.lookAt(0, 0, 0);

    uniforms.u_goboMap.value = this.target.texture;
  }

  /** Rule 2: wipe the claimable state at the top of the frame. */
  reset(): void {
    this.speed = BASE_SPEED;
    this.intensity = BASE_INTENSITY;
  }

  /** A section's partial claim. Weight 0 is a no-op; weight 1 is authoritative. */
  claim(speed: number, intensity: number, weight: number): void {
    if (weight <= 0) return;
    const w = Math.min(1, weight);
    this.speed += (speed - this.speed) * w;
    this.intensity += (intensity - this.intensity) * w;
  }

  update(renderer: WebGLRenderer, dt: number, pointer: Pointer, elapsed: number): void {
    // Velocity, not position: a fast flick swings the fixture and speeds the
    // cookie up; holding the cursor still lets both settle.
    const speedBoost = this.motionEnabled ? pointer.speed * MOUSE_EXTRA_SPEED : 0;
    if (this.motionEnabled) this.offset += (this.speed + speedBoost) * dt;

    if (this.motionEnabled) {
      // Velocity in, not position: the pointer shoves the boom and the spring
      // carries it back.
      this.swing.valueVel.x += pointer.velocityX * MOUSE_STRENGTH;
      this.swing.valueVel.y += pointer.velocityY * MOUSE_STRENGTH;
    }
    this.swing.update(dt, 0, 0);
    const swingX = MathUtils.clamp(this.swing.value.x, -MAX_SWING, MAX_SWING);
    const swingY = MathUtils.clamp(this.swing.value.y, -MAX_SWING, MAX_SWING);

    this.projector.position.copy(PROJECTOR_POSITION)
      .normalize().multiplyScalar(PROJECTOR_DISTANCE);
    this.projector.position.applyAxisAngle(AXIS_Y, swingX);
    this.projector.position.applyAxisAngle(AXIS_X, swingY);
    this.projector.lookAt(0, 0, 0);
    this.projector.updateMatrixWorld();

    (this.material.uniforms['u_offset'] as Uniform<number>).value = this.offset;
    (this.material.uniforms['u_time'] as Uniform<number>).value = elapsed;
    blit(renderer, this.material, this.target);

    this.uniforms.u_goboMatrix.value
      .multiplyMatrices(this.projector.projectionMatrix, this.projector.matrixWorldInverse)
      .premultiply(BIAS);
    scratchDirection.copy(this.projector.position).normalize();
    this.uniforms.u_goboDirection.value.copy(scratchDirection);
    this.uniforms.u_goboIntensity.value = this.intensity;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
