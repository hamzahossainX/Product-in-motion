/**
 * The scroll-linked camera path.
 *
 * Two implementations behind one interface. The preferred one is a baked
 * camera — per-frame position, quaternion and focal length exported from
 * Blender or Houdini and scrubbed by scroll — because artist-keyframed motion
 * is the difference between cinematic and programmatic and nothing procedural
 * matches it. No bake exists yet, so `KeyframeCameraPath` is what runs; the
 * interface is the seam a bake drops into without a single section changing.
 *
 * Keyframes are anchored to DOM sections, not to fixed page percentages. A
 * section that grows by two lines of copy would otherwise slide out from under
 * its own camera move.
 */
import { CatmullRomCurve3, PerspectiveCamera, Vector3 } from 'three';
import { clamp, smoothstep } from '../lib/math.ts';
import type { ScrollRange } from './scroll/ScrollRange.ts';
import type { CameraController } from './CameraController.ts';

export interface CameraKeyframe {
  /** Section id this keyframe is pinned to. */
  section: string;
  position: Vector3;
  lookAt: Vector3;
  fov: number;
  /** Where in the section's own travel the keyframe sits. 0 is centred. */
  offset?: number;
}

export interface CameraPath {
  /** Writes position and target for `progress` in 0..1 and returns the FOV. */
  sample(progress: number, outPosition: Vector3, outTarget: Vector3): number;
  /** Re-anchor to the measured DOM. Called whenever ranges re-measure. */
  anchor(ranges: Map<string, ScrollRange>, limit: number, viewportHeight: number): void;
  readonly ready: boolean;
}

/** Blender and Houdini default aperture at 2048x1024. */
const BAKE_APERTURE = 41.4214;
const BAKE_FILM_WIDTH = 2048;
const BAKE_FILM_HEIGHT = 1024;

/** Focal length in millimetres to vertical field of view in degrees. */
export function focalToFov(focal: number): number {
  const sensor = (BAKE_FILM_HEIGHT * BAKE_APERTURE) / BAKE_FILM_WIDTH;
  return (2 * Math.atan(sensor / 2 / focal) * 180) / Math.PI;
}

export class KeyframeCameraPath implements CameraPath {
  readonly ready = true;
  private readonly keyframes: CameraKeyframe[];
  /** Page progress of each keyframe, filled in by anchor(). */
  private readonly stops: number[];
  private readonly positionCurve: CatmullRomCurve3;
  private readonly targetCurve: CatmullRomCurve3;

  constructor(keyframes: CameraKeyframe[]) {
    this.keyframes = keyframes;
    this.stops = keyframes.map((_, i) => i / Math.max(1, keyframes.length - 1));
    // Centripetal Catmull-Rom, not linear segments: a camera that changes
    // direction abruptly at every keyframe reads as a sequence of moves, and
    // the whole point of the phase is that it reads as one.
    this.positionCurve = new CatmullRomCurve3(
      keyframes.map((k) => k.position.clone()), false, 'centripetal', 0.5);
    this.targetCurve = new CatmullRomCurve3(
      keyframes.map((k) => k.lookAt.clone()), false, 'centripetal', 0.5);
  }

  anchor(ranges: Map<string, ScrollRange>, limit: number, viewportHeight: number): void {
    if (limit <= 0) return;
    for (let i = 0; i < this.keyframes.length; i++) {
      const key = this.keyframes[i]!;
      const range = ranges.get(key.section);
      if (!range) continue;
      const centre = range.centreScrollPixel(viewportHeight);
      const offset = (key.offset ?? 0) * viewportHeight;
      this.stops[i] = clamp((centre + offset) / limit, 0, 1);
    }
    // Anchors must stay ordered even if a section is shorter than its offset.
    for (let i = 1; i < this.stops.length; i++) {
      this.stops[i] = Math.max(this.stops[i]!, this.stops[i - 1]!);
    }
  }

  sample(progress: number, outPosition: Vector3, outTarget: Vector3): number {
    const count = this.keyframes.length;
    const last = count - 1;
    let i = 0;
    while (i < last - 1 && progress > this.stops[i + 1]!) i++;

    const from = this.stops[i]!;
    const to = this.stops[i + 1]!;
    const local = to > from ? clamp((progress - from) / (to - from), 0, 1) : 0;
    // Ease inside the segment, then walk the curve in a single parameter, so
    // the path stays C1 across keyframes while each segment still eases.
    const u = clamp((i + smoothstep(0, 1, local)) / last, 0, 1);

    this.positionCurve.getPoint(u, outPosition);
    this.targetCurve.getPoint(u, outTarget);

    const fovFrom = this.keyframes[i]!.fov;
    const fovTo = this.keyframes[i + 1]!.fov;
    return fovFrom + (fovTo - fovFrom) * smoothstep(0, 1, local);
  }
}

/**
 * Placeholder for a baked path.
 *
 * Loads per-frame position, quaternion and focal arrays from a JSON bake in
 * public/models and scrubs them by scroll ratio, converting focal to FOV. It
 * reports `ready: false` until a bake exists, and `createCameraPath` falls
 * through to the keyframe path — so dropping a bake in is a data change.
 */
export class BakedCameraPath implements CameraPath {
  ready = false;
  private positions: Float32Array | null = null;
  private targets: Float32Array | null = null;
  private focals: Float32Array | null = null;

  async load(url: string): Promise<boolean> {
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      const data = await response.json() as
        { positions: number[]; targets: number[]; focals: number[] };
      this.positions = new Float32Array(data.positions);
      this.targets = new Float32Array(data.targets);
      this.focals = new Float32Array(data.focals);
      this.ready = this.focals.length > 1;
      return this.ready;
    } catch {
      return false;
    }
  }

  anchor(): void { /* a bake is already parameterised by scroll */ }

  sample(progress: number, outPosition: Vector3, outTarget: Vector3): number {
    const focals = this.focals;
    const positions = this.positions;
    const targets = this.targets;
    if (!focals || !positions || !targets) return 35;

    const frames = focals.length - 1;
    const exact = clamp(progress, 0, 1) * frames;
    const a = Math.floor(exact);
    const b = Math.min(frames, a + 1);
    const t = exact - a;

    outPosition.set(
      positions[a * 3]! + (positions[b * 3]! - positions[a * 3]!) * t,
      positions[a * 3 + 1]! + (positions[b * 3 + 1]! - positions[a * 3 + 1]!) * t,
      positions[a * 3 + 2]! + (positions[b * 3 + 2]! - positions[a * 3 + 2]!) * t,
    );
    outTarget.set(
      targets[a * 3]! + (targets[b * 3]! - targets[a * 3]!) * t,
      targets[a * 3 + 1]! + (targets[b * 3 + 1]! - targets[a * 3 + 1]!) * t,
      targets[a * 3 + 2]! + (targets[b * 3 + 2]! - targets[a * 3 + 2]!) * t,
    );
    return focalToFov(focals[a]! + (focals[b]! - focals[a]!) * t);
  }
}

const scratchPosition = new Vector3();
const scratchTarget = new Vector3();

/** How fast the FOV is allowed to chase the path, to keep resize from popping. */
const FOV_EPSILON = 0.01;

export class CameraRig {
  private readonly pathRef: { current: CameraPath };

  constructor(pathRef: { current: CameraPath }) {
    this.pathRef = pathRef;
  }

  get path(): CameraPath { return this.pathRef.current; }

  anchor(ranges: Map<string, ScrollRange>, limit: number, viewportHeight: number): void {
    this.pathRef.current.anchor(ranges, limit, viewportHeight);
  }

  /**
   * Writes the path's pose into the controller's base, which then layers
   * parallax and drift over it. The rig never touches the camera directly —
   * that keeps mouse and scroll from fighting for the same field.
   */
  update(camera: PerspectiveCamera, controller: CameraController, progress: number): void {
    const fov = this.pathRef.current.sample(progress, scratchPosition, scratchTarget);
    controller.basePosition.copy(scratchPosition);
    controller.baseTarget.copy(scratchTarget);
    if (Math.abs(camera.fov - fov) > FOV_EPSILON) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
