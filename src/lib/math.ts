/**
 * Remapping and clamping helpers.
 *
 * `fit` is the single most-used function in this project: every scroll-linked
 * value in the site is a ScrollRange ratio remapped through it (rule 6).
 * Build and trust it first.
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
 *  over time. Smoothed values use SecondOrderDynamics (rule 5). */
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

/** Smoothstep over [edge0, edge1]. */
export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = saturate(inverseMix(edge0, edge1, v));
  return t * t * (3 - 2 * t);
}

