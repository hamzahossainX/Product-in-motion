/**
 * A DOM rect expressed in GL space.
 *
 * DOM measures Y downward from the top of the viewport; GL measures it upward
 * from the bottom. This flip is what lets a 3D object lock exactly to a DOM
 * element's box (CLAUDE.md rule 3: DOM drives 3D, never the reverse), and what
 * a scissor or viewport call needs to be handed.
 *
 * Extends three's Vector4 so it can be fed straight to `setViewport` /
 * `setScissor` and to `vec4` uniforms without copying.
 */
import { Vector4 } from 'three';

export class DomGLRect extends Vector4 {
  /**
   * Set from DOM-space values, flipping Y.
   *
   * @param x           left edge, CSS px from the viewport's left
   * @param y           top edge, CSS px from the viewport's top
   * @param width       box width in CSS px
   * @param height      box height in CSS px
   * @param viewportHeight the viewport height to flip against
   */
  setFromDom(
    x: number,
    y: number,
    width: number,
    height: number,
    viewportHeight: number,
  ): this {
    return this.set(x, viewportHeight - (y + height), width, height);
  }

  /** Set from a live `getBoundingClientRect()` result. */
  setFromClientRect(rect: DOMRectReadOnly, viewportHeight: number): this {
    return this.setFromDom(rect.left, rect.top, rect.width, rect.height, viewportHeight);
  }

  /** Scale into device pixels — what scissor and viewport actually want. */
  toDevicePixels(target: DomGLRect, pixelRatio: number): DomGLRect {
    return target.set(
      this.x * pixelRatio,
      this.y * pixelRatio,
      this.z * pixelRatio,
      this.w * pixelRatio,
    ) as DomGLRect;
  }

  /** Vector4 already aliases z/w as width/height, so only the edges are added. */
  get left(): number { return this.x; }
  get right(): number { return this.x + this.z; }
  get bottom(): number { return this.y; }
  get top(): number { return this.y + this.w; }
  get centerX(): number { return this.x + this.z * 0.5; }
  get centerY(): number { return this.y + this.w * 0.5; }
}
