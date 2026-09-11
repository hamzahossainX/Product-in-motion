/**
 * The hero object: ERASER-1 itself.
 *
 * Built once, never unloaded, persistent for the whole page. Sections never
 * touch its transform directly — `resetTransform()` wipes it at the top of
 * every frame and sections write partial weighted claims, so two sections
 * overlapping in the viewport cross-fade the object's pose instead of one
 * cutting to the other (CLAUDE.md rule 2).
 */
import { Euler, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { createEraserGeometry } from './geometry/EraserGeometry.ts';
import { VARIANTS } from '../lib/InteractionState.ts';
import { createVinylMaterial } from './materials/VinylMaterial.ts';
import { createVinylMaps } from './materials/proceduralMaps.ts';
import { SecondOrderDynamics3 } from '../lib/SecondOrderDynamics.ts';
import { BrownianMotion } from '../lib/BrownianMotion.ts';
import type { SharedUniforms } from '../engine/SharedUniforms.ts';

/** Where the object rests when nothing has claimed it. */
const REST_POSITION = new Vector3(0, -0.02, 0);
const REST_ROTATION = new Euler(0.15, -0.68, 0.05);
const REST_SCALE = 1;

/** Idle drift. Small enough that it is never seen as motion, large enough that
 *  the object is never perfectly still — which is what reads as inert. */
const DRIFT_POSITION_AMPLITUDE = 0.014;
const DRIFT_ROTATION_AMPLITUDE = 0.017;
const DRIFT_FREQUENCY = 0.11;

/** The spring that carries the object between claimed poses. */
const POSE_FREQUENCY = 1.1;
const POSE_DAMPING = 0.9;
const POSE_RESPONSE = 0.6;

/** The variant transition: the object turns away, changes, and turns back.
 *  Swapping geometry on a frame boundary is a cut; this is the animated
 *  transition the gate asks for, and the swap happens at the pinch where the
 *  object is smallest and edge-on. */
const TRANSITION_SECONDS = 0.62;
const TRANSITION_PINCH = 0.34;
const TRANSITION_SPIN = Math.PI;

const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchEuler = new Euler();
const restQuaternion = new Quaternion().setFromEuler(REST_ROTATION);

export class Hero {
  readonly object = new Object3D();
  readonly mesh: Mesh;
  readonly material: MeshStandardMaterial;

  /** Accumulated claim for this frame, before smoothing. */
  private readonly claimedPosition = new Vector3();
  private readonly claimedQuaternion = new Quaternion();
  private claimedScale = REST_SCALE;

  private readonly positionSpring =
    new SecondOrderDynamics3(0, 0, 0, POSE_FREQUENCY, POSE_DAMPING, POSE_RESPONSE);
  /** One geometry per model, built on first use and kept. */
  private readonly geometries = new Map<number, ReturnType<typeof createEraserGeometry>>();
  /** Reduced motion stops the idle wander; the pose spring still runs, so a
   *  section change still moves the object rather than teleporting it. */
  driftEnabled = true;
  private variantIndex = 0;
  private pendingVariant = 0;
  private transition = 0;
  private baseRadius = 1;

  private readonly drift = new BrownianMotion({
    position: { amplitude: DRIFT_POSITION_AMPLITUDE, frequency: DRIFT_FREQUENCY },
    rotation: { amplitude: DRIFT_ROTATION_AMPLITUDE, frequency: DRIFT_FREQUENCY },
  });

  constructor(shared: SharedUniforms) {
    const maps = createVinylMaps();
    this.material = createVinylMaterial(shared, { map: maps.albedo, ormMap: maps.orm });
    this.mesh = new Mesh(this.geometryFor(0), this.material);
    this.mesh.name = 'eraser';
    this.baseRadius = this.mesh.geometry.boundingSphere?.radius ?? 1;
    this.object.add(this.mesh);
    this.resetTransform();
    this.object.position.copy(REST_POSITION);
    this.object.quaternion.copy(restQuaternion);
  }

  /** Rule 2: called at the top of every frame, before any section claims. */
  resetTransform(): void {
    this.claimedPosition.copy(REST_POSITION);
    this.claimedQuaternion.copy(restQuaternion);
    this.claimedScale = REST_SCALE;
  }

  /** A section's partial claim. Never an absolute write. */
  claimTransform(
    position: Vector3, quaternion: Quaternion, weight: number, scale = REST_SCALE,
  ): void {
    if (weight <= 0) return;
    const w = Math.min(1, weight);
    this.claimedPosition.lerp(position, w);
    this.claimedQuaternion.slerp(quaternion, w);
    this.claimedScale += (scale - this.claimedScale) * w;
  }

  /** Applies the frame's accumulated claim, smoothed, plus the idle drift. */
  update(dt: number): void {
    this.drift.positionEnabled = this.driftEnabled;
    this.drift.rotationEnabled = this.driftEnabled;
    this.drift.update(dt);
    const drift = this.drift;
    this.advanceTransition(dt);

    const smoothed = this.positionSpring.update(
      dt, this.claimedPosition.x, this.claimedPosition.y, this.claimedPosition.z);
    this.object.position.set(
      smoothed.x + drift.position.x,
      smoothed.y + drift.position.y,
      smoothed.z + drift.position.z,
    );

    scratchEuler.set(drift.rotation.x, drift.rotation.y, drift.rotation.z);
    scratchQuaternion.setFromEuler(scratchEuler);
    this.object.quaternion.copy(this.claimedQuaternion).multiply(scratchQuaternion);
    this.object.scale.setScalar(this.claimedScale);
  }

  private advanceTransition(dt: number): void {
    const variant = VARIANTS[this.variantIndex] ?? VARIANTS[0]!;
    if (this.transition <= 0) {
      this.mesh.scale.setScalar(1);
      this.mesh.rotation.y = 0;
      // Relative size is carried by the geometry itself, so nothing to do.
      void variant;
      return;
    }

    this.transition = Math.max(0, this.transition - dt);
    const progress = 1 - this.transition / TRANSITION_SECONDS;

    // Swap at the pinch, where the object is smallest and turned away.
    if (progress >= 0.5 && this.variantIndex !== this.pendingVariant) {
      this.variantIndex = this.pendingVariant;
      this.mesh.geometry = this.geometryFor(this.variantIndex);
    }

    // A single smooth pinch: down to TRANSITION_PINCH at halfway, back to 1.
    const pinch = 1 - (1 - TRANSITION_PINCH) * Math.sin(progress * Math.PI);
    this.mesh.scale.setScalar(pinch);
    this.mesh.rotation.y = TRANSITION_SPIN * progress;
  }

  /** Distance from a camera, for the bokeh focus plane and DOM locking. */
  distanceTo(target: Vector3): number {
    return scratchPosition.copy(this.object.position).distanceTo(target);
  }

  private geometryFor(index: number): ReturnType<typeof createEraserGeometry> {
    const existing = this.geometries.get(index);
    if (existing) return existing;
    const variant = VARIANTS[index] ?? VARIANTS[0]!;
    const geometry = createEraserGeometry({ scale: variant.scale, wear: variant.wear });
    this.geometries.set(index, geometry);
    return geometry;
  }

  /** Start a transition to another model. A repeat of the current one is a
   *  no-op; a change mid-transition retargets rather than restarting. */
  setVariant(index: number): void {
    const clamped = Math.max(0, Math.min(VARIANTS.length - 1, index));
    if (clamped === this.pendingVariant) return;
    this.pendingVariant = clamped;
    this.transition = TRANSITION_SECONDS;
  }

  get variant(): number { return this.variantIndex; }
  get isTransitioning(): boolean { return this.transition > 0; }

  /**
   * Radius of the BASE model, not the current one.
   *
   * The DOM-locked fit divides by this, so returning the live radius would
   * scale every model to the same box and the three sizes would look
   * identical — which is the one thing the configurator exists to show.
   */
  get boundingRadius(): number {
    return this.baseRadius;
  }

  get triangleCount(): number {
    const index = this.mesh.geometry.getIndex();
    return index ? index.count / 3 : 0;
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.material.map?.dispose();
    this.material.roughnessMap?.dispose();
    this.material.dispose();
  }
}
