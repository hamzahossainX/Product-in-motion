/**
 * Device orientation, standing in for mouse parallax on touch.
 *
 * A phone has no pointer to lean the camera against, and the same parallax
 * driven by tilt is what gives it back. Heavily damped, and clamped hard: the
 * gesture people actually make is a few degrees of wrist, and mapping the full
 * range of the sensor makes the camera swing every time someone shifts in a
 * chair.
 *
 * iOS requires a user gesture before it will report orientation at all, so the
 * permission is requested on the first touch rather than on load, where it
 * would be refused.
 */
import { clamp } from '../lib/math.ts';
import { SecondOrderDynamics2 } from '../lib/SecondOrderDynamics.ts';

/** Degrees of tilt mapped to the full parallax range. */
const RANGE_DEGREES = 22;
/** Slower than the pointer spring: a hand is never still, and tracking it
 *  closely reads as drift rather than as parallax. Critically damped — a wrist
 *  already overshoots, and a spring that adds its own would swim. */
const FREQUENCY = 0.55;
const DAMPING = 1;

interface PermissionCapableEvent {
  requestPermission?: () => Promise<PermissionState | 'granted' | 'denied'>;
}

export class DeviceTilt {
  /** -1..1, the same shape the pointer publishes. */
  get x(): number { return this.spring.value.x; }
  get y(): number { return this.spring.value.y; }
  /** True once the sensor has actually reported something. */
  active = false;

  private targetX = 0;
  private targetY = 0;
  // A spring, not `value += (target - value) * k` (rule 5). That form is also
  // frame-rate dependent: the same constant settles at a different speed at
  // 30 fps than at 60.
  private readonly spring = new SecondOrderDynamics2(0, 0, FREQUENCY, DAMPING, 0);
  private readonly onOrientation: (event: DeviceOrientationEvent) => void;
  private readonly onFirstTouch: () => void;

  constructor() {
    this.onOrientation = (event) => {
      if (event.gamma === null || event.beta === null) return;
      this.active = true;
      // gamma is left/right, beta is front/back. Beta is offset because a phone
      // is held tilted back, not flat.
      this.targetX = clamp(event.gamma / RANGE_DEGREES, -1, 1);
      this.targetY = clamp((event.beta - 45) / RANGE_DEGREES, -1, 1);
    };

    this.onFirstTouch = () => {
      window.removeEventListener('touchend', this.onFirstTouch);
      const constructor = DeviceOrientationEvent as unknown as PermissionCapableEvent;
      void constructor.requestPermission?.().then((state) => {
        if (state === 'granted') this.listen();
      }).catch(() => { /* refused, or not a secure context */ });
    };

    const constructor = DeviceOrientationEvent as unknown as PermissionCapableEvent;
    if (typeof constructor.requestPermission === 'function') {
      window.addEventListener('touchend', this.onFirstTouch, { passive: true });
    } else {
      this.listen();
    }
  }

  private listen(): void {
    window.addEventListener('deviceorientation', this.onOrientation, { passive: true });
  }

  update(dt: number): void {
    this.spring.update(dt, this.targetX, this.targetY);
  }

  destroy(): void {
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('touchend', this.onFirstTouch);
  }
}
