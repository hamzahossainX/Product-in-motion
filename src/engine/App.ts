/**
 * The single frame loop.
 *
 * One rAF for the whole site. Phase 3 hangs the renderer off `update` and the
 * reset-then-claim sequence from CLAUDE.md rule 2 goes here — which is why
 * Lenis runs with `autoRaf: false`: scroll and render must advance on the same
 * tick or the 3D will lag the DOM by a frame.
 */
import { ScrollPane } from './scroll/ScrollPane.ts';
import { ScrollRangeManager } from './scroll/ScrollRange.ts';
import { ScrollIndicator } from './scroll/ScrollIndicator.ts';
import { SectionVisibility } from '../sections/SectionVisibility.ts';
import { DebugOverlay, isDebugEnabled } from './DebugOverlay.ts';

/** Frame deltas above this are treated as a pause, not elapsed time. A tab
 *  restored after minutes must not advance the site by minutes. */
const MAX_FRAME_DELTA = 1 / 15;
const CONTENT_SELECTOR = '#site-content';
const SECTION_SELECTOR = 'section[id], footer[id]';

export class App {
  readonly pane: ScrollPane;
  readonly ranges: ScrollRangeManager;
  private readonly indicator: ScrollIndicator;
  private readonly visibility = new SectionVisibility();
  private readonly debug: DebugOverlay | null;
  private readonly reducedMotion: MediaQueryList;

  private rafId = 0;
  private lastTimeMs = 0;
  private running = false;
  private readonly onKeyNav: (event: KeyboardEvent) => void;
  private readonly onPointerNav: () => void;

  constructor() {
    const content = document.querySelector<HTMLElement>(CONTENT_SELECTOR);
    if (!content) throw new Error(`App: ${CONTENT_SELECTOR} not found`);

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.pane = new ScrollPane();
    this.ranges = new ScrollRangeManager(content);
    this.indicator = new ScrollIndicator(this.pane);
    this.debug = isDebugEnabled() ? new DebugOverlay() : null;

    for (const el of document.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) {
      const range = this.ranges.add(el);
      this.visibility.add(range);
      this.debug?.track(el.id, range);
    }

    // Hiding offscreen sections costs keyboard reachability, so it is suspended
    // the moment the user tabs and restored when they go back to a pointer.
    this.onKeyNav = (event: KeyboardEvent) => {
      if (event.key === 'Tab') this.visibility.setEnabled(false);
    };
    this.onPointerNav = () => this.visibility.setEnabled(true);
    window.addEventListener('keydown', this.onKeyNav, { passive: true });
    window.addEventListener('pointerdown', this.onPointerNav, { passive: true });

    // Web fonts change line counts and therefore every section's height, so the
    // first measurement is only provisional until they land.
    document.fonts?.ready.then(() => this.ranges.invalidate());

    // A handle for tuning and for the gate harness. Debug builds only, so it
    // never becomes an accidental public API.
    if (this.debug) {
      (window as unknown as { __eraser?: App }).__eraser = this;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (timeMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const dt = Math.min((timeMs - this.lastTimeMs) / 1000, MAX_FRAME_DELTA);
    this.lastTimeMs = timeMs;

    this.pane.update(timeMs);
    this.ranges.update(this.pane.scrollPixel);
    this.visibility.update();
    this.indicator.update(dt);
    this.debug?.update(dt, this.pane);
  };

  /** Reduced motion keeps the page usable and every section painted. */
  get prefersReducedMotion(): boolean {
    return this.reducedMotion.matches;
  }

  destroy(): void {
    this.stop();
    window.removeEventListener('keydown', this.onKeyNav);
    window.removeEventListener('pointerdown', this.onPointerNav);
    this.indicator.destroy();
    this.ranges.destroy();
    this.pane.destroy();
    this.debug?.destroy();
    this.visibility.showAll();
  }
}
