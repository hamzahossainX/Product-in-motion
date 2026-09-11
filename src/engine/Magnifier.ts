/**
 * The magnifier's second render.
 *
 * `camera.setViewOffset` asks the camera for a sub-rectangle of its own
 * frustum, rendered into a square target — the same scene, the same grade and
 * the same lighting, with more samples across a smaller area. Zooming the
 * finished frame instead would enlarge pixels and reveal nothing, which is the
 * whole point of a macro moment.
 *
 * Costs one extra scene render, and only while the section that uses it has
 * weight. Everywhere else `open` is zero and the final pass skips the branch.
 */
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { clamp } from '../lib/math.ts';
import { SecondOrderDynamics } from '../lib/SecondOrderDynamics.ts';
import type { Postprocessing } from './post/Postprocessing.ts';

/** Radius on screen, as a fraction of viewport height. */
const RADIUS = 0.155;
/** How much of the frustum is re-rendered. Smaller is more magnification. */
const ZOOM = 3.6;
/** Opens and closes with the section rather than snapping (rule 5). */
const FREQUENCY = 3;
const DAMPING = 1;
/** Below this the lens contributes nothing and the extra render is skipped. */
const CLOSED = 0.001;

export class Magnifier {
  private readonly spring = new SecondOrderDynamics(0, FREQUENCY, DAMPING, 0);
  /** Normalised screen position, written by the control. GL-space Y. */
  x = 0.5;
  y = 0.5;

  /** Advance toward `weight` and render if there is anything to render. */
  update(
    dt: number,
    weight: number,
    renderer: WebGLRenderer,
    post: Postprocessing,
    scene: Scene,
    camera: PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
  ): number {
    const open = this.spring.update(dt, weight);
    if (open <= CLOSED) {
      post.setLens(0.5, 0.5, RADIUS, 0);
      return open;
    }

    const side = (RADIUS * viewportHeight * 2) / ZOOM;
    const centreX = clamp(this.x, 0, 1) * viewportWidth;
    // The state stores GL-space Y; a view offset is in DOM space.
    const centreY = (1 - clamp(this.y, 0, 1)) * viewportHeight;

    camera.setViewOffset(viewportWidth, viewportHeight,
      centreX - side / 2, centreY - side / 2, side, side);
    camera.updateMatrixWorld();
    renderer.setRenderTarget(post.lensTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    camera.clearViewOffset();

    post.setLens(this.x, this.y, RADIUS, open);
    return open;
  }
}
