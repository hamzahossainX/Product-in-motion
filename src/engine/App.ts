/**
 * The single frame loop.
 *
 * One rAF for the whole site: scroll, DOM state and the render advance on the
 * same tick, because Lenis runs with `autoRaf: false`. If the renderer had its
 * own loop the 3D would trail the DOM by a frame and every DOM-locked element
 * would shear during fast scrolling.
 *
 * The body of `tick` is the reset-then-claim sequence from CLAUDE.md rule 2.
 */
import { ScrollPane } from './scroll/ScrollPane.ts';
import { ScrollRangeManager, type ScrollRange } from './scroll/ScrollRange.ts';
import { ScrollIndicator } from './scroll/ScrollIndicator.ts';
import { SectionVisibility } from '../sections/SectionVisibility.ts';
import { DebugOverlay, isDebugEnabled, isProbeEnabled } from './DebugOverlay.ts';
import { DebugGui } from './DebugGui.ts';
import { RenderStack } from './RenderStack.ts';
import { ANCHOR_ATTRIBUTE, ANCHOR_SELECTOR } from '../scenes/sections/index.ts';
import { TextReveal } from '../sections/TextReveal.ts';
import { LetterFlipper } from '../sections/LetterFlipper.ts';
import { Preloader } from '../sections/Preloader.ts';
import { Cursor } from '../sections/Cursor.ts';
import { Newsletter } from '../sections/Newsletter.ts';
import { HardnessControl } from '../sections/controls/HardnessControl.ts';
import { ConfiguratorControl } from '../sections/controls/ConfiguratorControl.ts';
import { MagnifierControl } from '../sections/controls/MagnifierControl.ts';
import { UnlearningControl } from '../sections/controls/UnlearningControl.ts';

/** Frame deltas above this are treated as a pause, not elapsed time. A tab
 *  restored after minutes must not advance the site by minutes. */
const MAX_FRAME_DELTA = 1 / 15;
const CONTENT_SELECTOR = '#site-content';
const SECTION_SELECTOR = 'section[id], footer[id]';
/** Every link and button that is a single run of text. Anything with child
 *  elements is skipped by the flipper itself. */
const FLIPPER_SELECTOR = '.site-header a, .site-footer a, .btn, .paper__actions a';
const NEWSLETTER_SELECTOR = '#newsletter';
const WEBGL_READY_CLASS = 'has-webgl';

export class App {
  readonly pane: ScrollPane;
  readonly ranges: ScrollRangeManager;
  readonly render: RenderStack | null;
  private readonly indicator: ScrollIndicator;
  private readonly visibility = new SectionVisibility();
  readonly reveals = new TextReveal();
  readonly flippers: LetterFlipper;
  readonly cursor: Cursor;
  private readonly preloader: Preloader | null;
  private readonly newsletter: Newsletter;
  readonly hardness: HardnessControl | null = null;
  readonly configurator: ConfiguratorControl | null = null;
  readonly magnifier: MagnifierControl | null = null;
  readonly unlearning: UnlearningControl | null = null;
  private readonly debug: DebugOverlay | null;
  readonly gui: DebugGui | null;
  private readonly reducedMotion: MediaQueryList;

  private rafId = 0;
  private lastTimeMs = 0;
  private running = false;
  private readonly onKeyNav: (event: KeyboardEvent) => void;
  private readonly onPointerNav: () => void;
  private readonly onResize: () => void;

  constructor() {
    const content = document.querySelector<HTMLElement>(CONTENT_SELECTOR);
    if (!content) throw new Error(`App: ${CONTENT_SELECTOR} not found`);

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = this.reducedMotion.matches;
    // Built before anything measures: the preloader covers the page while the
    // first layout and the environment prefilter happen.
    this.preloader = new Preloader();
    this.pane = new ScrollPane();
    this.ranges = new ScrollRangeManager(content);
    this.indicator = new ScrollIndicator(this.pane);
    this.debug = isDebugEnabled() ? new DebugOverlay() : null;

    // A machine without a working WebGL context still gets the whole page; the
    // CSS gradient under body::before stays as the background.
    this.render = RenderStack.tryCreate();
    if (this.render) {
      document.documentElement.classList.add(WEBGL_READY_CLASS);
      this.render.setMotionEnabled(!this.reducedMotion.matches);
      // The preference can change while the page is open.
      this.reducedMotion.addEventListener('change', (event) => {
        this.render?.setMotionEnabled(!event.matches);
        this.reveals.setEnabled(!event.matches);
        this.flippers.enabled = !event.matches;
        this.cursor.enabled = !event.matches;
      });
      // Fire and forget: the frame loop renders whatever has arrived, and the
      // Phase 6 preloader subscribes to the same weighted progress.
      this.render.loader.observe((progress) => this.preloader?.setProgress(progress));
      void this.render.loader.start();
    }
    this.gui = this.render && isDebugEnabled() ? new DebugGui() : null;

    const sectionRanges = new Map<string, ReturnType<ScrollRangeManager['add']>>();
    for (const el of document.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) {
      const range = this.ranges.add(el);
      sectionRanges.set(el.id, range);
      this.visibility.add(range);
      this.debug?.track(el.id, range);
      this.reveals.add(el, range);
    }
    this.reveals.setEnabled(!reduced);

    this.flippers = new LetterFlipper(FLIPPER_SELECTOR);
    this.flippers.enabled = !reduced;
    this.cursor = new Cursor();
    this.cursor.enabled = !reduced;
    this.newsletter = new Newsletter(NEWSLETTER_SELECTOR);

    // The controls write into the render stack's interaction state and never
    // touch the scene (rule 4). Without WebGL there is nothing to drive, so
    // they are not built and the DOM keeps its native behaviour.
    if (this.render) {
      const state = this.render.interaction;
      this.hardness = new HardnessControl(state);
      this.configurator = new ConfiguratorControl(state);
      this.magnifier = new MagnifierControl(state);
      this.unlearning = new UnlearningControl(state);
    }

    // Anchors are measured like sections but never hidden like them: an element
    // inside a `visibility: hidden` subtree still has a rect, so nothing here
    // depends on its section being painted.
    const anchors = new Map<string, ScrollRange>();
    for (const element of document.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)) {
      const section = element.getAttribute(ANCHOR_ATTRIBUTE);
      if (section) anchors.set(section, this.ranges.add(element));
    }
    this.render?.bindSections(sectionRanges, anchors);

    // Hiding offscreen sections costs keyboard reachability, so it is suspended
    // the moment the user tabs and restored when they go back to a pointer.
    this.onKeyNav = (event: KeyboardEvent) => {
      if (event.key === 'Tab') this.visibility.setEnabled(false);
    };
    this.onPointerNav = () => this.visibility.setEnabled(true);
    this.onResize = () => this.render?.resize();
    window.addEventListener('keydown', this.onKeyNav, { passive: true });
    window.addEventListener('pointerdown', this.onPointerNav, { passive: true });
    window.addEventListener('resize', this.onResize, { passive: true });

    // Web fonts change line counts and therefore every section's height, so the
    // first measurement is only provisional until they land.
    // Fonts change every line break, so the split lines that were wrapped and
    // masked are no longer the lines on screen until they land.
    document.fonts?.ready.then(() => {
      this.ranges.invalidate();
      this.anchorCamera();
      this.reveals.resplit();
    });
    window.addEventListener('resize', () => {
      this.anchorCamera();
      this.preloader?.handleResize();
      this.reveals.resplit();
    }, { passive: true });
    this.anchorCamera();

    // A handle for tuning and for the gate harness. Query-flagged only, so it
    // never becomes an accidental public API.
    if (this.debug || isProbeEnabled()) {
      (window as unknown as { __eraser?: App }).__eraser = this;
    }
  }

  /** Re-pin the camera keyframes to the measured sections. Layout changes move
   *  every section, and a camera path anchored to stale positions would drift
   *  out of sync with the copy it is framing. */
  private anchorCamera(): void {
    const render = this.render;
    if (!render) return;

    // The magnifier's box moves with the page, so its screen position has to be
    // republished as the page scrolls, not only when it is dragged.
    this.magnifier?.publish();
    if (this.unlearning) {
      render.eraseContact = this.unlearning.isErasing ? 1 : 0;
      render.erasePointX = this.unlearning.pointX;
      render.erasePointY = this.unlearning.pointY;
    }
    const map = new Map<string, ScrollRange>();
    for (const range of this.ranges.all) {
      if (range.element.id) map.set(range.element.id, range);
    }
    render.rig.anchor(map, this.pane.limit, window.innerHeight);
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
    this.reveals.update();
    this.indicator.update(dt);
    this.cursor.update(dt);
    this.preloader?.update(dt);
    this.debug?.update(dt, this.pane);

    const render = this.render;
    if (!render) return;

    // The magnifier's box moves with the page, so its screen position has to be
    // republished as the page scrolls, not only when it is dragged.
    this.magnifier?.publish();
    if (this.unlearning) {
      render.eraseContact = this.unlearning.isErasing ? 1 : 0;
      render.erasePointX = this.unlearning.pointX;
      render.erasePointY = this.unlearning.pointY;
    }

    // --- reset-then-claim (rule 2) ---------------------------------------
    render.post.resetProfile();
    render.gobo.reset();
    render.stage.hero.resetTransform();
    render.claim(dt, this.pane.scrollPixel, this.pane.progress);
    this.gui?.apply(render.post);
    render.post.syncProfile();

    render.draw(dt);
    this.gui?.update(dt, render.lastFrameMs, render.renderer.gl, render.post);
  };

  /** Reduced motion keeps the page usable and every section painted. */
  get prefersReducedMotion(): boolean {
    return this.reducedMotion.matches;
  }

  destroy(): void {
    this.stop();
    window.removeEventListener('keydown', this.onKeyNav);
    window.removeEventListener('pointerdown', this.onPointerNav);
    window.removeEventListener('resize', this.onResize);
    this.indicator.destroy();
    this.reveals.destroy();
    this.flippers.destroy();
    this.cursor.destroy();
    this.preloader?.destroy();
    this.newsletter.destroy();
    this.hardness?.destroy();
    this.configurator?.destroy();
    this.magnifier?.destroy();
    this.unlearning?.destroy();
    this.ranges.destroy();
    this.pane.destroy();
    this.debug?.destroy();
    this.gui?.destroy();
    this.render?.dispose();
    this.visibility.showAll();
    document.documentElement.classList.remove(WEBGL_READY_CLASS);
  }
}
