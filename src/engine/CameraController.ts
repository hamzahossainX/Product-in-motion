/**
 * Camera motion that is not scroll.
 *
 * Two layers, both springs: parallax that leans the camera against the pointer,
 * and a slow Brownian drift so the camera is never perfectly still. The drift
 * is deliberately below the threshold of being seen as motion — a locked-off
 * camera is the single clearest tell that a scene is rendered rather than shot.
 *
 * Phase 5 sets `basePosition` / `baseTarget` from the scroll path; everything
 * here layers on top of whatever those hold.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { SecondOrderDynamics3 } from '../lib/SecondOrderDynamics.ts';
import { BrownianMotion } from '../lib/BrownianMotion.ts';
import type { Pointer } from './Pointer.ts';
import type { DeviceTilt } from './DeviceTilt.ts';

/** How far the camera leans, in world units at the extremes of the viewport. */
const PARALLAX_X = 0.42;
const PARALLAX_Y = 0.26;
/** The target leans a fraction of the camera's lean, so the object stays in
 *  frame while the parallax still reads as depth. */
const TARGET_FOLLOW = 0.28;

const PARALLAX_FREQUENCY = 0.8;
const PARALLAX_DAMPING = 0.85;
const PARALLAX_RESPONSE = 1.1;

const DRIFT_POSITION_AMPLITUDE = 0.03;
const DRIFT_ROTATION_AMPLITUDE = 0.0035;
const DRIFT_FREQUENCY = 0.08;

const scratchPosition = new Vector3();
const scratchTarget = new Vector3();

export class CameraController {
  /** Written by the scroll path in Phase 5; the rest is layered on top. */
  readonly basePosition = new Vector3(0, 1.15, 5.6);
  readonly baseTarget = new Vector3(0, -0.1, 0);

  private readonly parallax =
    new SecondOrderDynamics3(0, 0, 0, PARALLAX_FREQUENCY, PARALLAX_DAMPING, PARALLAX_RESPONSE);
  private readonly drift = new BrownianMotion({
    position: { amplitude: DRIFT_POSITION_AMPLITUDE, frequency: DRIFT_FREQUENCY },
    rotation: { amplitude: DRIFT_ROTATION_AMPLITUDE, frequency: DRIFT_FREQUENCY },
    seed: 4211,
  });

  /** Reduced motion freezes both layers; the scene stays rendered and still. */
  motionEnabled = true;
  /** On touch there is no pointer, so the lean comes from the device. */
  tilt: DeviceTilt | null = null;

  update(camera: PerspectiveCamera, dt: number, pointer: Pointer): void {
    if (!this.motionEnabled) {
      camera.position.copy(this.basePosition);
      camera.lookAt(this.baseTarget);
      return;
    }

    this.drift.update(dt);
    const tilt = this.tilt;
    const useTilt = tilt !== null && tilt.active;
    const leanX = useTilt ? tilt.x : pointer.x;
    const leanY = useTilt ? tilt.y : pointer.y;
    const lean = this.parallax.update(dt, leanX * PARALLAX_X, leanY * PARALLAX_Y, 0);

    scratchPosition.copy(this.basePosition);
    scratchPosition.x += lean.x + this.drift.position.x;
    scratchPosition.y += lean.y + this.drift.position.y;
    scratchPosition.z += this.drift.position.z;
    camera.position.copy(scratchPosition);

    scratchTarget.copy(this.baseTarget);
    scratchTarget.x += lean.x * TARGET_FOLLOW;
    scratchTarget.y += lean.y * TARGET_FOLLOW;
    camera.lookAt(scratchTarget);
    // Roll from the drift's rotation channel: a handheld camera is never level.
    camera.rotateZ(this.drift.rotation.z);
  }
}
