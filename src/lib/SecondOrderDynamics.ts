/**
 * Second-order dynamics — a critically-dampable spring.
 *
 * Every smoothed value in this project runs through one of these, never a lerp
 * (CLAUDE.md rule 5). A lerp converges at a rate tied to frame rate and reads
 * as cheap; a spring has mass and momentum and reads as physical.
 *
 * Parameters, all in the constructor as (initialValue, f, z, r):
 *   f — natural frequency in Hz. How fast it responds.
 *   z — damping ratio. <1 overshoots and settles, 1 is critical, >1 is sluggish.
 *   r — initial response. >0 anticipates the target, 0 eases in, <0 winds up
 *       against the motion first.
 *
 * Suggested starting points: general f=1.5 z=0.8 r=2; springy hover f=1.5 z=0.5 r=3.
 */

/** Integration steps larger than this are split. At 1/30s the clamped k2 keeps
 *  the system stable; beyond it the *displacement* per step gets visibly wrong. */
const MAX_SUBSTEP = 1 / 30;

/** A tab restored after minutes away reports an enormous dt. Past this we stop
 *  integrating and snap, rather than run hundreds of catch-up substeps. */
const MAX_TOTAL_DT = 0.25;

/** Coefficients derived from (f, z, r). Shared by the scalar and vector springs. */
export class SpringCoefficients {
  k1: number = 0;
  k2: number = 0;
  k3: number = 0;

  constructor(f: number, z: number, r: number) {
    this.set(f, z, r);
  }

  set(f: number, z: number, r: number): void {
    const w = 2 * Math.PI * f;
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (w * w);
    this.k3 = (r * z) / w;
  }

  /**
   * k2 clamped so the explicit integrator cannot go unstable at large dt.
   * Without this a dropped frame makes the spring oscillate and diverge.
   */
  stableK2(dt: number): number {
    return Math.max(this.k2, 0.5 * dt * dt + 0.5 * dt * this.k1, dt * this.k1);
  }
}

/**
 * Split a frame delta into stable substeps.
 *
 * `total` is the clamped frame time and is what target velocity must be
 * measured against. Dividing the target's change by the *substep* instead
 * inflates the estimate by the substep count and then re-applies that inflated
 * anticipation impulse once per substep — which sent the spring to 4.9x its
 * target at 8fps before this was separated out.
 */
/** Scratch, at module scope. Springs run several times a frame and returning a
 *  fresh object from here was the largest remaining allocation in the loop
 *  (CLAUDE.md rule 17). Not reentrant — every caller reads it out immediately,
 *  before anything else can plan. */
const plan = { step: 0, count: 0, total: 0 };

function planSteps(dt: number): typeof plan {
  const total = Math.min(dt, MAX_TOTAL_DT);
  if (total <= 0) {
    plan.step = 0; plan.count = 0; plan.total = 0;
    return plan;
  }
  const count = Math.max(1, Math.ceil(total / MAX_SUBSTEP));
  plan.step = total / count;
  plan.count = count;
  plan.total = total;
  return plan;
}

/** Scalar spring. */
export class SecondOrderDynamics {
  value: number;
  valueVel = 0;
  readonly coefficients: SpringCoefficients;
  private previousTarget: number;

  constructor(initialValue: number, f = 1.5, z = 0.8, r = 2) {
    this.value = initialValue;
    this.previousTarget = initialValue;
    this.coefficients = new SpringCoefficients(f, z, r);
  }

  setParams(f: number, z: number, r: number): void {
    this.coefficients.set(f, z, r);
  }

  /** Snap to `value` and kill all momentum. */
  reset(value: number): void {
    this.value = value;
    this.previousTarget = value;
    this.valueVel = 0;
  }

  /**
   * Advance towards `target`. `targetVel` is estimated by finite difference
   * when not supplied; pass it when the true derivative is known.
   */
  update(dt: number, target: number, targetVel?: number): number {
    const { step, count, total } = planSteps(dt);
    if (count === 0) return this.value;

    const c = this.coefficients;
    const xd = targetVel ?? (total > 0 ? (target - this.previousTarget) / total : 0);
    this.previousTarget = target;

    for (let i = 0; i < count; i++) {
      const k2 = c.stableK2(step);
      this.value += step * this.valueVel;
      this.valueVel +=
        (step * (target + c.k3 * xd - this.value - c.k1 * this.valueVel)) / k2;
    }
    return this.value;
  }
}

/** Structural shape of a 2-component vector — matches three's Vector2 without
 *  importing it, so src/lib stays free of a rendering dependency. */
export interface Vec2Like { x: number; y: number }
/** Structural shape of a 3-component vector — matches three's Vector3. */
export interface Vec3Like extends Vec2Like { z: number }

/** Two-component spring. Each axis integrates independently, shared coefficients. */
export class SecondOrderDynamics2 {
  readonly value: Vec2Like;
  readonly valueVel: Vec2Like = { x: 0, y: 0 };
  readonly coefficients: SpringCoefficients;
  private readonly previousTarget: Vec2Like;

  constructor(x = 0, y = 0, f = 1.5, z = 0.8, r = 2) {
    this.value = { x, y };
    this.previousTarget = { x, y };
    this.coefficients = new SpringCoefficients(f, z, r);
  }

  setParams(f: number, z: number, r: number): void {
    this.coefficients.set(f, z, r);
  }

  reset(x: number, y: number): void {
    this.value.x = x; this.value.y = y;
    this.previousTarget.x = x; this.previousTarget.y = y;
    this.valueVel.x = 0; this.valueVel.y = 0;
  }

  update(dt: number, targetX: number, targetY: number): Vec2Like {
    const { step, count, total } = planSteps(dt);
    if (count === 0) return this.value;

    const c = this.coefficients;
    const xdX = total > 0 ? (targetX - this.previousTarget.x) / total : 0;
    const xdY = total > 0 ? (targetY - this.previousTarget.y) / total : 0;
    this.previousTarget.x = targetX;
    this.previousTarget.y = targetY;

    for (let i = 0; i < count; i++) {
      const k2 = c.stableK2(step);
      this.value.x += step * this.valueVel.x;
      this.value.y += step * this.valueVel.y;
      this.valueVel.x +=
        (step * (targetX + c.k3 * xdX - this.value.x - c.k1 * this.valueVel.x)) / k2;
      this.valueVel.y +=
        (step * (targetY + c.k3 * xdY - this.value.y - c.k1 * this.valueVel.y)) / k2;
    }
    return this.value;
  }
}

/** Three-component spring. */
export class SecondOrderDynamics3 {
  readonly value: Vec3Like;
  readonly valueVel: Vec3Like = { x: 0, y: 0, z: 0 };
  readonly coefficients: SpringCoefficients;
  private readonly previousTarget: Vec3Like;

  constructor(x = 0, y = 0, z = 0, f = 1.5, damping = 0.8, r = 2) {
    this.value = { x, y, z };
    this.previousTarget = { x, y, z };
    this.coefficients = new SpringCoefficients(f, damping, r);
  }

  setParams(f: number, damping: number, r: number): void {
    this.coefficients.set(f, damping, r);
  }

  reset(x: number, y: number, z: number): void {
    this.value.x = x; this.value.y = y; this.value.z = z;
    this.previousTarget.x = x; this.previousTarget.y = y; this.previousTarget.z = z;
    this.valueVel.x = 0; this.valueVel.y = 0; this.valueVel.z = 0;
  }

  update(dt: number, tx: number, ty: number, tz: number): Vec3Like {
    const { step, count, total } = planSteps(dt);
    if (count === 0) return this.value;

    const c = this.coefficients;
    const dX = total > 0 ? (tx - this.previousTarget.x) / total : 0;
    const dY = total > 0 ? (ty - this.previousTarget.y) / total : 0;
    const dZ = total > 0 ? (tz - this.previousTarget.z) / total : 0;
    this.previousTarget.x = tx; this.previousTarget.y = ty; this.previousTarget.z = tz;

    for (let i = 0; i < count; i++) {
      const k2 = c.stableK2(step);
      this.value.x += step * this.valueVel.x;
      this.value.y += step * this.valueVel.y;
      this.value.z += step * this.valueVel.z;
      this.valueVel.x += (step * (tx + c.k3 * dX - this.value.x - c.k1 * this.valueVel.x)) / k2;
      this.valueVel.y += (step * (ty + c.k3 * dY - this.value.y - c.k1 * this.valueVel.y)) / k2;
      this.valueVel.z += (step * (tz + c.k3 * dZ - this.value.z - c.k1 * this.valueVel.z)) / k2;
    }
    return this.value;
  }
}
