/**
 * Normalised scroll position for a DOM element.
 *
 * Every scroll-linked animation in this project reads a ScrollRange and remaps
 * it with `fit` (CLAUDE.md rule 6). Nothing reads `window.scrollY` directly and
 * nothing measures the DOM inside the frame loop: rects are cached in document
 * space and only re-measured when the content wrapper actually resizes.
 */
import { fit } from '../../lib/math.ts';

/** Extra viewport fraction counted as "active" on each side, so a section is
 *  awake slightly before it is visible and its reveal is never caught mid-way. */
const ACTIVE_MARGIN = 0.25;

export class ScrollRange {
  readonly element: HTMLElement;

  /** -1 entering from below, 0 centred in the viewport, 1 leaving past the top. */
  ratio = -1;
  /** Element centre as a fraction of viewport height: 0 at the top edge, 1 at
   *  the bottom edge. Unclamped, so it runs past both ends off-screen. */
  screenRatio = 1;
  /** Element height as a multiple of viewport height. */
  viewSize = 0;
  /** 0 -> 1 across the element's own travel through the viewport. */
  progress = 0;
  /** Intersects the viewport, expanded by ACTIVE_MARGIN. */
  isActive = false;

  /** Cached document-space geometry, refreshed only on measure(). */
  private documentTop = 0;
  private documentHeight = 0;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  /** Re-read the DOM. Called on resize only — never per frame. */
  measure(scrollPixel: number): void {
    const rect = this.element.getBoundingClientRect();
    this.documentTop = rect.top + scrollPixel;
    this.documentHeight = rect.height;
  }

  /** Pure arithmetic on cached geometry. Safe to call every frame. */
  update(scrollPixel: number, viewportHeight: number): void {
    if (viewportHeight <= 0) return;

    const centreInViewport =
      this.documentTop + this.documentHeight * 0.5 - scrollPixel;
    const distanceFromCentre = centreInViewport - viewportHeight * 0.5;

    // Full travel from "top edge touching the viewport bottom" to "bottom edge
    // touching the viewport top".
    const travel = (viewportHeight + this.documentHeight) * 0.5;

    this.ratio = travel > 0 ? -distanceFromCentre / travel : 0;
    this.screenRatio = centreInViewport / viewportHeight;
    this.viewSize = this.documentHeight / viewportHeight;
    this.progress = fit(this.ratio, -1, 1, 0, 1);

    const top = this.documentTop - scrollPixel;
    const margin = viewportHeight * ACTIVE_MARGIN;
    this.isActive =
      top < viewportHeight + margin && top + this.documentHeight > -margin;
  }
}

/**
 * Owns every ScrollRange and the single ResizeObserver behind them.
 *
 * One observer on the content wrapper, not one per element: a page of eight
 * full-height sections would otherwise fire eight callbacks for one layout
 * change, and measuring inside each of them is what makes scroll-linked sites
 * jank.
 */
export class ScrollRangeManager {
  private readonly ranges: ScrollRange[] = [];
  private readonly observer: ResizeObserver;
  private readonly onWindowResize: () => void;
  private needsMeasure = true;
  private viewportHeight = 0;

  constructor(contentWrapper: HTMLElement) {
    this.viewportHeight = window.innerHeight;
    this.observer = new ResizeObserver(() => { this.needsMeasure = true; });
    this.observer.observe(contentWrapper);
    this.onWindowResize = () => {
      this.viewportHeight = window.innerHeight;
      this.needsMeasure = true;
    };
    window.addEventListener('resize', this.onWindowResize, { passive: true });
  }

  add(element: HTMLElement): ScrollRange {
    const range = new ScrollRange(element);
    this.ranges.push(range);
    this.needsMeasure = true;
    return range;
  }

  /** Force a re-measure on the next update — e.g. after fonts load. */
  invalidate(): void {
    this.needsMeasure = true;
  }

  /** Advance every range. One DOM read pass at most, only when invalidated. */
  update(scrollPixel: number): void {
    if (this.needsMeasure) {
      this.viewportHeight = window.innerHeight;
      for (const range of this.ranges) range.measure(scrollPixel);
      this.needsMeasure = false;
    }
    for (const range of this.ranges) range.update(scrollPixel, this.viewportHeight);
  }

  get all(): readonly ScrollRange[] {
    return this.ranges;
  }

  destroy(): void {
    this.observer.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    this.ranges.length = 0;
  }
}
