/**
 * Smooth noise-driven drift, for organic idle motion.
 *
 * Nothing physical is ever perfectly still. A camera that holds an exact
 * position reads as computer-generated; the same camera with a slow, sub-
 * perceptual drift reads as handheld. Position and rotation are separate
 * channels with independent amplitude, frequency and enable flags, because
 * a scene usually wants one and not the other.
 */
import type { Vec3Like } from './SecondOrderDynamics.ts';

/** Lattice spacing of the value-noise. One unit of `x` is one lattice step. */
const LATTICE = 1;
/** Channel offsets, chosen far apart so the six channels never correlate. */
const CHANNEL_STRIDE = 137.13;
/** Hash constants — arbitrary large primes, standard integer-hash practice. */
const HASH_A = 0x45d9f3b;
const HASH_B = 0x119de1f3;

/**
 * Deterministic smooth 1D value noise in [-1, 1].
 *
 * Seeded and lattice-hashed rather than accumulating `Math.random()`, so the
 * motion is reproducible frame to frame and allocates nothing when sampled.
 */
export class Simple1DNoise {
  private readonly seed: number;

  constructor(seed = 0) {
    this.seed = seed;
  }

  /** Integer hash -> [0, 1). */
  private hash(i: number): number {
    let h = (i ^ this.seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), HASH_A) >>> 0;
    h = Math.imul(h ^ (h >>> 16), HASH_B) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 0xffffffff;
  }

  /** Smooth noise at `x`, in [-1, 1]. */
  get(x: number): number {
    const scaled = x / LATTICE;
    const i = Math.floor(scaled);
    const f = scaled - i;
    // Smootherstep: zero first and second derivative at both ends, so the
    // drift has no perceptible kink as it crosses a lattice point.
    const t = f * f * f * (f * (f * 6 - 15) + 10);
    const a = this.hash(i);
    const b = this.hash(i + 1);
    return (a + (b - a) * t) * 2 - 1;
  }
}

export interface BrownianChannelOptions {
  /** Peak displacement per axis. */
  amplitude?: number | Vec3Like;
  /** Cycles per second through the noise field. */
  frequency?: number;
  enabled?: boolean;
}

export interface BrownianMotionOptions {
  position?: BrownianChannelOptions;
  rotation?: BrownianChannelOptions;
  seed?: number;
}

function toVec3(v: number | Vec3Like | undefined, fallback: number): Vec3Like {
  if (v === undefined) return { x: fallback, y: fallback, z: fallback };
  if (typeof v === 'number') return { x: v, y: v, z: v };
  return { x: v.x, y: v.y, z: v.z };
}

export class BrownianMotion {
  /** Current drift offset. Read it; do not write it. */
  readonly position: Vec3Like = { x: 0, y: 0, z: 0 };
  /** Current drift rotation, in radians. Read it; do not write it. */
  readonly rotation: Vec3Like = { x: 0, y: 0, z: 0 };

  positionAmplitude: Vec3Like;
  positionFrequency: number;
  positionEnabled: boolean;

  rotationAmplitude: Vec3Like;
  rotationFrequency: number;
  rotationEnabled: boolean;

  private time = 0;
  private readonly noise: Simple1DNoise[];

  constructor(options: BrownianMotionOptions = {}) {
    const pos = options.position ?? {};
    const rot = options.rotation ?? {};
    this.positionAmplitude = toVec3(pos.amplitude, 1);
    this.positionFrequency = pos.frequency ?? 1;
    this.positionEnabled = pos.enabled ?? true;
    this.rotationAmplitude = toVec3(rot.amplitude, 1);
    this.rotationFrequency = rot.frequency ?? 1;
    this.rotationEnabled = rot.enabled ?? true;

    const seed = options.seed ?? 0;
    // Six independent channels: position xyz, then rotation xyz.
    this.noise = Array.from({ length: 6 }, (_, i) => new Simple1DNoise(seed + i * 7919));
  }

  /** Snap both channels back to zero and restart the noise walk. */
  reset(): void {
    this.time = 0;
    this.position.x = 0; this.position.y = 0; this.position.z = 0;
    this.rotation.x = 0; this.rotation.y = 0; this.rotation.z = 0;
  }

  update(dt: number): void {
    this.time += dt;

    if (this.positionEnabled) {
      const t = this.time * this.positionFrequency;
      this.position.x = this.noise[0]!.get(t) * this.positionAmplitude.x;
      this.position.y = this.noise[1]!.get(t + CHANNEL_STRIDE) * this.positionAmplitude.y;
      this.position.z = this.noise[2]!.get(t + CHANNEL_STRIDE * 2) * this.positionAmplitude.z;
    } else {
      this.position.x = 0; this.position.y = 0; this.position.z = 0;
    }

    if (this.rotationEnabled) {
      const t = this.time * this.rotationFrequency;
      this.rotation.x = this.noise[3]!.get(t + CHANNEL_STRIDE * 3) * this.rotationAmplitude.x;
      this.rotation.y = this.noise[4]!.get(t + CHANNEL_STRIDE * 4) * this.rotationAmplitude.y;
      this.rotation.z = this.noise[5]!.get(t + CHANNEL_STRIDE * 5) * this.rotationAmplitude.z;
    } else {
      this.rotation.x = 0; this.rotation.y = 0; this.rotation.z = 0;
    }
  }
}
