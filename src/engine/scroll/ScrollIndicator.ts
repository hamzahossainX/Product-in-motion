/**
 * The custom scrollbar.
 *
 * Native scrollbars are hidden site-wide, so this is the only pointer-driven
 * scroll affordance. It is draggable to scrub, and its opacity is eased once
 * per frame rather than by a CSS transition — a transition would fight the
 * frame loop and could not be driven by scroll velocity later.
 */
import { clamp, fit } from '../../lib/math.ts';
import type { ScrollPane } from './ScrollPane.ts';

/** Opacity units per second. In is fast because a scrollbar that lags the
 *  first wheel notch feels broken; out is slow so it recedes rather than blinks. */
const FADE_IN_RATE = 8;
const FADE_OUT_RATE = 2;
/** Idle time before the bar starts fading out. */
const HOLD_SECONDS = 0.5;
/** Movement under this many pixels per frame does not count as scrolling. */
const MOVEMENT_EPSILON = 0.05;
/** Thumb never shrinks below this fraction of the track, however long the page. */
const MIN_THUMB_RATIO = 0.06;
/** Smaller than the third decimal place every style write is rounded to. */
const WRITE_EPSILON = 0.0005;

/** Below three decimal places nothing written above would render differently,
 *  and NaN on the first frame always differs, which forces the initial write. */
function differs(next: number, written: number): boolean {
  return !(Math.abs(next - written) < WRITE_EPSILON);
}

export class ScrollIndicator {
  private readonly root: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly pane: ScrollPane;

  private opacity = 0;
  private idleTime = 0;
  private dragging = false;

  /** Last values actually written to the DOM, so an unchanged frame is free. */
  private writtenOpacity = Number.NaN;
  private writtenThumbRatio = Number.NaN;
  private writtenOffset = Number.NaN;
  private writtenInteractive: boolean | null = null;
  private pointerId: number | null = null;
  private dragOffset = 0;

  constructor(pane: ScrollPane, parent: HTMLElement = document.body) {
    this.pane = pane;

    this.root = document.createElement('div');
    this.root.className = 'scroll-indicator';
    this.root.setAttribute('aria-hidden', 'true');

    this.thumb = document.createElement('div');
    this.thumb.className = 'scroll-indicator__thumb';
    this.root.appendChild(this.thumb);
    parent.appendChild(this.root);

    this.root.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  private onPointerDown = (event: PointerEvent): void => {
    const trackHeight = this.root.clientHeight;
    const thumbHeight = this.thumb.offsetHeight;
    const trackTop = this.root.getBoundingClientRect().top;
    const thumbTop = this.thumb.getBoundingClientRect().top;

    this.dragging = true;
    this.pointerId = event.pointerId;
    // Grabbing the thumb keeps the grab point under the cursor; clicking the
    // bare track centres the thumb on the cursor instead of jumping by its top.
    const onThumb = event.clientY >= thumbTop && event.clientY <= thumbTop + thumbHeight;
    this.dragOffset = onThumb ? event.clientY - thumbTop : thumbHeight * 0.5;

    this.root.setPointerCapture(event.pointerId);
    this.scrubTo(event.clientY, trackTop, trackHeight, thumbHeight);
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const trackHeight = this.root.clientHeight;
    const thumbHeight = this.thumb.offsetHeight;
    const trackTop = this.root.getBoundingClientRect().top;
    this.scrubTo(event.clientY, trackTop, trackHeight, thumbHeight);
    this.idleTime = 0;
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = null;
    if (this.root.hasPointerCapture(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId);
    }
  };

  private scrubTo(
    clientY: number,
    trackTop: number,
    trackHeight: number,
    thumbHeight: number,
  ): void {
    const travel = Math.max(1, trackHeight - thumbHeight);
    const local = clamp(clientY - trackTop - this.dragOffset, 0, travel);
    this.pane.scrollTo(this.pane.limit * (local / travel), true);
  }

  /** Advance opacity and thumb geometry. Called once per frame.
   *
   *  Every write below builds a string, and a string a frame is the only
   *  allocation left in the loop once the 3D side is using scratch objects.
   *  So each value is compared against what was last written and skipped when
   *  it has not moved — which on a still page is all four of them. */
  update(dt: number): void {
    const moving = Math.abs(this.pane.scrollViewDelta) > MOVEMENT_EPSILON;
    if (moving || this.dragging) this.idleTime = 0;
    else this.idleTime += dt;

    const wantVisible = this.dragging || this.idleTime < HOLD_SECONDS;
    // Per-frame easing, not a CSS transition: this has to stay under the frame
    // loop's control so velocity can drive it in a later phase.
    const rate = wantVisible ? FADE_IN_RATE : -FADE_OUT_RATE;
    this.opacity = clamp(this.opacity + rate * dt, 0, 1);

    if (differs(this.opacity, this.writtenOpacity)) {
      this.writtenOpacity = this.opacity;
      this.root.style.opacity = this.opacity.toFixed(3);
    }
    const interactive = this.opacity > 0.01;
    if (interactive !== this.writtenInteractive) {
      this.writtenInteractive = interactive;
      this.root.style.pointerEvents = interactive ? 'auto' : 'none';
    }

    // Fully faded out and not moving: nothing about the thumb can be seen, so
    // there is no reason to compute or write it.
    if (this.opacity <= 0) return;

    const limit = this.pane.limit;
    const viewport = window.innerHeight;
    const total = limit + viewport;
    const thumbRatio = total > 0 ? Math.max(MIN_THUMB_RATIO, viewport / total) : 1;
    if (differs(thumbRatio, this.writtenThumbRatio)) {
      this.writtenThumbRatio = thumbRatio;
      this.thumb.style.height = `${(thumbRatio * 100).toFixed(3)}%`;
    }

    const p = limit > 0 ? fit(this.pane.scrollPixel, 0, limit, 0, 1) : 0;
    const offset = p * (100 / thumbRatio - 100);
    if (differs(offset, this.writtenOffset)) {
      this.writtenOffset = offset;
      this.thumb.style.transform = `translateY(${offset.toFixed(3)}%)`;
    }
  }

  destroy(): void {
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.root.remove();
  }
}
