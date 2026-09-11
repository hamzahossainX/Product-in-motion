/**
 * Masked text reveals, scrubbed by scroll.
 *
 * Every reveal is a paused GSAP timeline whose `progress` is written from a
 * ScrollRange each frame (CLAUDE.md rules 6 and 7 — no ScrollTrigger). A paused
 * timeline scrubbed by a number is deterministic in both directions, so
 * scrolling back up plays the reveal backwards exactly rather than leaving text
 * stranded, which is what a play-once trigger does.
 *
 * The reveals are masked rises out of an overflow-hidden parent, never opacity
 * fades: a fade tells you something appeared, a rise tells you where it came
 * from.
 */
import { gsap } from 'gsap';
import { SplitText } from 'gsap/SplitText';
import { fit } from '../lib/math.ts';
import type { ScrollRange } from '../engine/scroll/ScrollRange.ts';

gsap.registerPlugin(SplitText);

interface RevealKind {
  type: 'lines,chars' | 'words' | 'lines';
  mask: 'lines' | 'words';
  /** Distance risen, as a multiple of the part's own height. */
  rise: number;
  duration: number;
  stagger: number;
  ease: string;
  /** Where in the section's own travel this kind runs. Headings go first and
   *  supporting copy follows, so a section arrives in an order rather than all
   *  at once. Everything finishes well before the section is centred, so it is
   *  readable by the time anyone is reading it. */
  from: number;
  to: number;
}

const KINDS: Record<string, RevealKind> = {
  // Large headings get per-character motion; at display sizes the individual
  // letters are big enough for it to read as craft rather than as noise.
  heading: { type: 'lines,chars', mask: 'lines', rise: 1.05, duration: 0.9, stagger: 0.012, ease: 'expo.out', from: -0.78, to: -0.22 },
  tagline: { type: 'words', mask: 'words', rise: 1.1, duration: 0.8, stagger: 0.03, ease: 'expo.out', from: -0.70, to: -0.14 },
  body: { type: 'lines', mask: 'lines', rise: 1.15, duration: 0.85, stagger: 0.06, ease: 'expo.out', from: -0.62, to: -0.06 },
};

/** Selector to kind. Order matters: the first match wins. */
const TARGETS: { selector: string; kind: keyof typeof KINDS }[] = [
  { selector: '.hero__title, .showcase__title, .statement__title, .section h2, .paper__title', kind: 'heading' },
  { selector: '.hero__lede, .t-body1, .paper__payoff, .t-quote', kind: 'tagline' },
  { selector: '.section p.t-body2, .section p.t-body3.t-measure-narrow', kind: 'body' },
];

interface Reveal {
  element: HTMLElement;
  kind: RevealKind;
  split: SplitText | null;
  timeline: gsap.core.Timeline | null;
  range: ScrollRange;
  /** Last progress written, so an unchanged frame costs nothing. */
  written: number;
}

const PROGRESS_EPSILON = 0.001;

/** SplitText appends "-mask" to these for the clipping wrapper it inserts. */
export const LINE_CLASS = 'split-line';
export const WORD_CLASS = 'split-word';
export const CHAR_CLASS = 'split-char';

export class TextReveal {
  private readonly reveals: Reveal[] = [];
  private enabled = true;

  /** `range` is the section the element belongs to; the reveal is scrubbed by
   *  that section's travel, not by the element's own. */
  add(root: HTMLElement, range: ScrollRange): void {
    for (const target of TARGETS) {
      for (const element of root.querySelectorAll<HTMLElement>(target.selector)) {
        if (this.reveals.some((r) => r.element === element)) continue;
        const kind = KINDS[target.kind];
        if (!kind) continue;
        const reveal: Reveal = {
          element, kind, split: null, timeline: null, range, written: -1,
        };
        this.reveals.push(reveal);
        this.build(reveal);
      }
    }
  }

  private build(reveal: Reveal): void {
    reveal.timeline?.kill();
    reveal.split?.revert();

    const { kind } = reveal;
    const split = new SplitText(reveal.element, {
      type: kind.type,
      mask: kind.mask,
      // Explicit class names. SplitText's defaults are empty strings, and it
      // derives each mask wrapper's class by suffixing the split element's own
      // with "-mask" — so with no class there is nothing to style or select.
      linesClass: LINE_CLASS,
      wordsClass: WORD_CLASS,
      charsClass: CHAR_CLASS,
      // Re-splitting is driven from here, on resize and once fonts land, so
      // SplitText does not also need to watch for it.
      autoSplit: false,
    });
    reveal.split = split;

    const parts: Element[] = kind.type === 'lines,chars'
      ? split.chars
      : kind.type === 'words' ? split.words : split.lines;
    if (parts.length === 0) return;

    const timeline = gsap.timeline({ paused: true });
    timeline.fromTo(parts,
      { yPercent: kind.rise * 100 },
      {
        yPercent: 0,
        duration: kind.duration,
        ease: kind.ease,
        stagger: kind.stagger,
      });
    // Rebuilt while reduced motion is on — a resize, or fonts landing — the
    // timeline has to start at rest, not at the beginning. Starting at 0 and
    // never scrubbing is how every heading ended up displaced off its own line
    // with the preference set.
    const rest = this.enabled ? 0 : 1;
    timeline.progress(rest);
    reveal.written = rest;
    reveal.timeline = timeline;
  }

  /** Reduced motion shows every part at rest and stops scrubbing. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const reveal of this.reveals) {
        reveal.timeline?.progress(1);
        reveal.written = 1;
      }
    }
  }

  /** Re-split after a layout change: line breaks move, so the lines that were
   *  wrapped and masked are no longer the lines on screen. */
  resplit(): void {
    for (const reveal of this.reveals) {
      reveal.written = -1;
      this.build(reveal);
    }
  }

  update(): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.reveals.length; i++) {
      const reveal = this.reveals[i]!;
      // Deliberately not skipped when the section is off screen. Skipping was
      // the obvious optimisation and it broke determinism: a section scrolled
      // far past kept whatever progress it last held instead of settling at
      // its end state, so scrubbing back up from the bottom landed 40 px away
      // from scrubbing down to the same place. `fit` is clamped, so an
      // off-screen section resolves to exactly 0 or 1 and the epsilon below
      // stops it writing again — which is where the cost actually was.
      const progress = fit(reveal.range.ratio, reveal.kind.from, reveal.kind.to, 0, 1);
      if (Math.abs(progress - reveal.written) < PROGRESS_EPSILON) continue;
      reveal.written = progress;
      reveal.timeline?.progress(progress);
    }
  }

  destroy(): void {
    for (const reveal of this.reveals) {
      reveal.timeline?.kill();
      reveal.split?.revert();
    }
    this.reveals.length = 0;
  }
}
