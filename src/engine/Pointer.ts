/**
 * The pointer, as a spring.
 *
 * Two things read it: camera parallax, which wants the smoothed POSITION, and
 * the gobo, which wants the smoothed VELOCITY — a light that swings when the
 * mouse is thrown across the screen and settles when it stops. A raw pointer
 * position has no velocity worth using; a spring's does.
 */
import { SecondOrderDynamics2 } from '../lib/SecondOrderDynamics.ts';

/** Frequency, damping, response of the pointer spring. Slow and slightly
 *  overshooting, so a flick produces a swing rather than a step. */
const FREQUENCY = 1.1;
const DAMPING = 0.72;
const RESPONSE = 1.4;

export class Pointer {
  /** Smoothed position, normalised to -1..1 with +y up. */
  readonly spring = new SecondOrderDynamics2(0, 0, FREQUENCY, DAMPING, RESPONSE);
  /** Raw target, updated by events only. */
  private targetX = 0;
  private targetY = 0;
  /** True once the user has actually moved a pointer; touch devices never do. */
  hasMoved = false;

  private readonly onMove: (event: PointerEvent) => void;

  constructor() {
    this.onMove = (event: PointerEvent) => {
      this.targetX = (event.clientX / window.innerWidth) * 2 - 1;
      this.targetY = -((event.clientY / window.innerHeight) * 2 - 1);
      this.hasMoved = true;
    };
    window.addEventListener('pointermove', this.onMove, { passive: true });
  }

  update(dt: number): void {
    this.spring.update(dt, this.targetX, this.targetY);
  }

  get x(): number { return this.spring.value.x; }
  get y(): number { return this.spring.value.y; }
  get velocityX(): number { return this.spring.valueVel.x; }
  get velocityY(): number { return this.spring.valueVel.y; }
  get speed(): number {
    return Math.hypot(this.spring.valueVel.x, this.spring.valueVel.y);
  }

  destroy(): void {
    window.removeEventListener('pointermove', this.onMove);
  }
}
