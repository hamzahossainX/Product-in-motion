/**
 * Putting a 3D object inside a DOM box.
 *
 * Shared by every section that lets the layout decide where its object sits
 * (rule 3). The camera's own basis is used rather than an unprojection
 * — it is already orthonormal in the world matrix, so this needs no matrix
 * inverse and allocates nothing.
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { DomGLRect } from '../../engine/scroll/DomGLRect.ts';

const scratchForward = new Vector3();
const scratchAxis = new Vector3();
const scratchToPoint = new Vector3();

export interface Viewport { viewportWidth: number; viewportHeight: number }

/** Half-extents of the camera's frustum at `depth`, in world units. */
export function frustumHalfSize(
  camera: PerspectiveCamera, depth: number, out: { x: number; y: number },
): void {
  out.y = Math.tan((camera.fov * Math.PI) / 360) * depth;
  out.x = out.y * camera.aspect;
}

/** Depth from the camera to `target`, along the camera's forward axis. */
export function depthTo(camera: PerspectiveCamera, target: Vector3): number {
  camera.getWorldDirection(scratchForward);
  scratchToPoint.copy(target).sub(camera.position);
  return Math.max(0.1, scratchToPoint.dot(scratchForward));
}

const half = { x: 0, y: 0 };

/** World position at which `rect`'s centre appears, `depth` in front of the
 *  camera. */
export function placeInRect(
  camera: PerspectiveCamera, rect: DomGLRect, view: Viewport, depth: number, out: Vector3,
): Vector3 {
  frustumHalfSize(camera, depth, half);
  const ndcX = (rect.centerX / Math.max(1, view.viewportWidth)) * 2 - 1;
  const ndcY = (rect.centerY / Math.max(1, view.viewportHeight)) * 2 - 1;

  camera.getWorldDirection(scratchForward);
  out.copy(camera.position).addScaledVector(scratchForward, depth);

  const e = camera.matrixWorld.elements;
  scratchAxis.set(e[0]!, e[1]!, e[2]!);            // camera right
  out.addScaledVector(scratchAxis, ndcX * half.x);
  scratchAxis.set(e[4]!, e[5]!, e[6]!);            // camera up
  out.addScaledVector(scratchAxis, ndcY * half.y);
  return out;
}

/** The rect's size in world units at `depth`. */
export function rectWorldSize(
  camera: PerspectiveCamera, rect: DomGLRect, view: Viewport, depth: number,
  out: { x: number; y: number },
): void {
  frustumHalfSize(camera, depth, half);
  out.x = (rect.z / Math.max(1, view.viewportWidth)) * half.x * 2;
  out.y = (rect.w / Math.max(1, view.viewportHeight)) * half.y * 2;
}
