/**
 * The site's scroll authority.
 *
 * Wraps Lenis and owns the single source of truth for scroll position. Every
 * scroll-linked value in the project reads from here, through a ScrollRange —
 * never from `window.scrollY` directly, and never from ScrollTrigger, which
 * this project does not use (rule 7).
 */
import Lenis from 'lenis';

/** Lenis smoothing factor. Lower is heavier. */
const LERP = 0.1;
const WHEEL_MULTIPLIER = 1;
/** Arrow keys move a fixed distance; Page keys move a viewport less an overlap. */
const ARROW_STEP_PX = 100;
const PAGE_OVERLAP = 0.1;
/** Keys we consume. Space is deliberately absent — it belongs to focused controls. */
const KEY_STEPS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'] as const;

export class ScrollPane {
  readonly lenis: Lenis;

  /** Current scroll offset in CSS pixels. */
  scrollPixel = 0;
  /** Normalised 0 -> 1 across the scrollable length. */
  progress = 0;
  /** Pixels scrolled since the previous frame. Signed. Drives velocity effects. */
  scrollViewDelta = 0;
  /** `scrollViewDelta` as a fraction of viewport height — resolution-independent. */
  scrollViewDeltaRatio = 0;

  private previousScroll = 0;
  private readonly onKeyDown: (event: KeyboardEvent) => void;

  constructor() {
    // The browser restoring scroll before Lenis initialises produces a visible
    // jump on reload, so we own restoration.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    this.lenis = new Lenis({
      lerp: LERP,
      wheelMultiplier: WHEEL_MULTIPLIER,
      // We drive raf ourselves from the single frame loop, so scroll and the
      // eventual render stay on the same tick.
      autoRaf: false,
      // A page this long needs the wheel smoothed but touch to keep its native
      // flick inertia, which syncTouch would otherwise flatten.
      smoothWheel: true,
      syncTouch: false,
      overscroll: false,
      anchors: true,
      autoResize: true,
    });

    this.scrollPixel = this.lenis.scroll;
    this.previousScroll = this.scrollPixel;

    this.onKeyDown = (event: KeyboardEvent) => this.handleKey(event);
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!KEY_STEPS.includes(event.key as (typeof KEY_STEPS)[number])) return;

    // Never steal arrows from a focused input, slider or button.
    const target = event.target as HTMLElement | null;
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return;

    const viewport = window.innerHeight;
    let delta = 0;
    switch (event.key) {
      case 'ArrowUp': delta = -ARROW_STEP_PX; break;
      case 'ArrowDown': delta = ARROW_STEP_PX; break;
      case 'PageUp': delta = -viewport * (1 - PAGE_OVERLAP); break;
      case 'PageDown': delta = viewport * (1 - PAGE_OVERLAP); break;
      case 'Home': this.scrollTo(0); event.preventDefault(); return;
      case 'End': this.scrollTo(this.lenis.limit); event.preventDefault(); return;
      default: return;
    }
    event.preventDefault();
    this.scrollTo(this.lenis.scroll + delta);
  }

  scrollTo(target: number | string | HTMLElement, immediate = false): void {
    this.lenis.scrollTo(target, { immediate });
  }

  /** Advance Lenis and recompute the derived values. Call once per frame. */
  update(timeMs: number): void {
    this.lenis.raf(timeMs);
    this.scrollPixel = this.lenis.scroll;
    this.progress = this.lenis.progress || 0;
    this.scrollViewDelta = this.scrollPixel - this.previousScroll;
    this.scrollViewDeltaRatio =
      window.innerHeight > 0 ? this.scrollViewDelta / window.innerHeight : 0;
    this.previousScroll = this.scrollPixel;
  }

  /** True while the user is actively scrolling — used to fade the indicator. */
  get isScrolling(): boolean {
    return Boolean(this.lenis.isScrolling);
  }

  get limit(): number {
    return this.lenis.limit;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.lenis.destroy();
  }
}
