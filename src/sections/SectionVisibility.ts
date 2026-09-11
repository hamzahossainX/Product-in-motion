/**
 * Hides sections that are not near the viewport.
 *
 * `visibility: hidden` takes a section out of paint and out of the accessibility
 * tree without changing layout, so the document height and every cached rect
 * stay exactly as they were. On a ~10,000px page this is most of the difference
 * between a smooth scroll and a janky one.
 */
import type { ScrollRange } from '../engine/scroll/ScrollRange.ts';

const HIDDEN_CLASS = 'is-offscreen';

export class SectionVisibility {
  private readonly entries: { range: ScrollRange; hidden: boolean }[] = [];
  private enabled = true;

  add(range: ScrollRange): void {
    this.entries.push({ range, hidden: false });
  }

  /**
   * Suspend hiding.
   *
   * `visibility: hidden` also removes an element from the tab order, so with
   * six of nine sections hidden only 4 of the page's 30 focusable elements were
   * reachable — a keyboard user could not reach 26 links. While the user is
   * navigating by keyboard the paint saving is not worth that, so hiding is
   * suspended and every section stays reachable. Pointer input re-enables it.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.showAll();
  }

  /** Toggle only on change — writing the class every frame would thrash style. */
  update(): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const shouldHide = !entry.range.isActive;
      if (shouldHide === entry.hidden) continue;
      entry.hidden = shouldHide;
      entry.range.element.classList.toggle(HIDDEN_CLASS, shouldHide);
    }
  }

  /** Reveal everything — used by the reduced-motion path and on teardown. */
  showAll(): void {
    for (const entry of this.entries) {
      entry.hidden = false;
      entry.range.element.classList.remove(HIDDEN_CLASS);
    }
  }
}
