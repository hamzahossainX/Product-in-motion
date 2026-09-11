/**
 * The hover flip on every link.
 *
 * Each character gets an absolutely positioned duplicate one line below it
 * inside an overflow-hidden box; hovering slides the stack up so the clone
 * takes the original's place.
 *
 * The speed scales with character count. A fixed per-character stagger makes a
 * twenty-character link take seven times as long as a three-character one, and
 * the long one reads as sluggish even though every character moves at the same
 * rate. Dividing the stagger span by the count keeps the whole sweep the same
 * length whatever the word is, which is what "identically fast" means here.
 */
import { gsap } from 'gsap';

/** duration = 1 / (BASE + SPAN / charCount). */
const SPEED_BASE = 2;
const SPEED_PER_CHAR = 4;
/** Total time the stagger is spread across, whatever the character count. */
const STAGGER_SPAN = 0.16;
const EASE_IN = 'expo.out';
const EASE_OUT = 'expo.out';
const FLIPPER_CLASS = 'is-flipper';
const INNER_CLASS = 'flip__inner';
const CHAR_CLASS = 'flip__char';
const CLONE_CLASS = 'flip__clone';

interface Flipper {
  chars: HTMLElement[];
  duration: number;
  stagger: number;
  tween: gsap.core.Tween | null;
}

/** Splits into characters here rather than through SplitText: this needs a
 *  clone inside each character, which SplitText has no concept of, and the
 *  markup is simple enough that the plugin would only be indirection. */
function buildChars(element: HTMLElement): HTMLElement[] {
  const text = element.textContent ?? '';
  const chars: HTMLElement[] = [];
  // The clip box is an inner span around the text run, not the element itself.
  // On a padded control — a button — clipping the element clips at its padding
  // box, and the clone sitting one line below lands inside that padding and is
  // simply visible, so the label reads twice.
  const inner = document.createElement('span');
  inner.className = INNER_CLASS;

  for (const character of text) {
    const span = document.createElement('span');
    span.className = CHAR_CLASS;
    // A space with no width collapses the gap between words; a non-breaking
    // space in both layers keeps the two copies exactly the same width.
    const glyph = character === ' ' ? ' ' : character;
    span.textContent = glyph;
    const clone = document.createElement('span');
    clone.className = CLONE_CLASS;
    clone.textContent = glyph;
    clone.setAttribute('aria-hidden', 'true');
    span.append(clone);
    inner.append(span);
    chars.push(span);
  }

  // The visible text is now split across many spans, so the accessible name
  // has to be restored explicitly or a screen reader reads it letter by letter.
  element.setAttribute('aria-label', text.trim());
  element.replaceChildren(inner);
  return chars;
}

export class LetterFlipper {
  private readonly flippers = new Map<HTMLElement, Flipper>();
  private readonly onEnter: (event: Event) => void;
  private readonly onLeave: (event: Event) => void;
  enabled = true;

  constructor(selector: string) {
    this.onEnter = (event) => this.play(event.currentTarget as HTMLElement, true);
    this.onLeave = (event) => this.play(event.currentTarget as HTMLElement, false);

    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      // Nested elements would be flattened by textContent; skip anything that
      // is not a single run of text.
      if (element.childElementCount > 0) continue;
      const text = (element.textContent ?? '').trim();
      if (text.length === 0) continue;

      element.classList.add(FLIPPER_CLASS);
      const chars = buildChars(element);
      const speed = SPEED_BASE + SPEED_PER_CHAR / chars.length;
      this.flippers.set(element, {
        chars,
        duration: 1 / speed,
        stagger: STAGGER_SPAN / chars.length,
        tween: null,
      });
      element.addEventListener('pointerenter', this.onEnter);
      element.addEventListener('pointerleave', this.onLeave);
      element.addEventListener('focus', this.onEnter);
      element.addEventListener('blur', this.onLeave);
    }
  }

  private play(element: HTMLElement, forward: boolean): void {
    const flipper = this.flippers.get(element);
    if (!flipper || !this.enabled) return;
    flipper.tween?.kill();
    flipper.tween = gsap.to(flipper.chars, {
      yPercent: forward ? -100 : 0,
      duration: flipper.duration,
      ease: forward ? EASE_IN : EASE_OUT,
      stagger: forward ? flipper.stagger : { each: flipper.stagger, from: 'end' },
      overwrite: true,
    });
  }

  /** For the gate harness and for tuning: how long a full sweep takes. */
  sweepSeconds(element: HTMLElement): number {
    const flipper = this.flippers.get(element);
    if (!flipper) return 0;
    return flipper.duration + flipper.stagger * (flipper.chars.length - 1);
  }

  get elements(): HTMLElement[] {
    return [...this.flippers.keys()];
  }

  destroy(): void {
    for (const [element, flipper] of this.flippers) {
      flipper.tween?.kill();
      element.removeEventListener('pointerenter', this.onEnter);
      element.removeEventListener('pointerleave', this.onLeave);
      element.removeEventListener('focus', this.onEnter);
      element.removeEventListener('blur', this.onLeave);
    }
    this.flippers.clear();
  }
}
