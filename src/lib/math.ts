/**
 * Remapping and clamping helpers.
 *
 * `fit` is the single most-used function in this project: every scroll-linked
 * value in the site is a ScrollRange ratio remapped through it (CLAUDE.md
 * rule 6). Build and trust it first.
 */

/** Constrain `v` to [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Constrain `v` to [0, 1]. */
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation. Use for pure maths only — never to smooth a value
 *  over time. Smoothed values use SecondOrderDynamics (CLAUDE.md rule 5). */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse mix: where does `v` sit between `a` and `b`? Unclamped. */
export function inverseMix(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/**
 * Remap `v` from [inMin, inMax] onto [outMin, outMax], clamped to the output
 * range. A zero-width input range collapses to `outMin` rather than dividing
 * by zero.
 */
export function fit(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMin === inMax) return outMin;
  const t = saturate((v - inMin) / (inMax - inMin));
  return outMin + (outMax - outMin) * t;
}

/** `fit` without clamping — the output runs past the range at both ends. */
export function unclampedFit(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMin === inMax) return outMin;
  return outMin + (outMax - outMin) * ((v - inMin) / (inMax - inMin));
}

/**
 * Frame-rate-independent exponential smoothing.
 *
 * A raw `mix(a, b, 0.1)` in a frame loop is tied to frame rate: it converges
 * twice as fast at 120fps as at 60fps. This corrects for `dt`, so `lambda` is
 * a real rate rather than a per-frame fraction. Still prefer a spring for
 * anything the eye will read as motion.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return mix(current, target, 1 - Math.exp(-lambda * dt));
}

/** Smoothstep over [edge0, edge1]. */
export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = saturate(inverseMix(edge0, edge1, v));
  return t * t * (3 - 2 * t);
}

/** Shortest signed distance from `a` to `b` on a unit-wrapping ring. */
export function wrap(v: number, min: number, max: number): number {
  const range = max - min;
  if (range === 0) return min;
  return v - range * Math.floor((v - min) / range);
}
