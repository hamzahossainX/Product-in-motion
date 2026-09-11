/**
 * The draggable magnifier over the abrasion section.
 *
 * The box is a DOM element, so it is a real focus target with a real cursor
 * affordance, and it can be moved with a keyboard. What it publishes is a
 * position in normalised screen space, which the final pass turns into a lens
 * over the rendered image — so what is magnified is the actual render, not a
 * picture of it.
 */
import { clamp } from '../../lib/math.ts';
import { capturePointer } from './capturePointer.ts';
import type { InteractionState } from '../../lib/InteractionState.ts';

const BOX_ID = 'abrasion-zoom-box';
const DRAGGING_CLASS = 'is-dragging';
/** Fraction of the container the box moves per arrow press. */
const KEY_STEP = 0.06;
const POSITION_X = '--zoom-x';
const POSITION_Y = '--zoom-y';

export class MagnifierControl {
  private readonly box: HTMLElement | null;
  private readonly container: HTMLElement | null;
  private readonly state: InteractionState;
  /** Position within the container, 0..1, of the box's centre. */
  private localX = 0.5;
  private localY = 0.5;
  private dragging = false;
  private grabX = 0;
  private grabY = 0;

  private readonly onDown: (event: PointerEvent) => void;
  private readonly onMove: (event: PointerEvent) => void;
  private readonly onUp: (event: PointerEvent) => void;
  private readonly onKey: (event: KeyboardEvent) => void;

  constructor(state: InteractionState) {
    this.state = state;
    this.box = document.querySelector<HTMLElement>(`#${BOX_ID}`);
    this.container = this.box?.parentElement ?? null;

    if (this.box) {
      // It is operable, so it has to be reachable and announced as such.
      this.box.setAttribute('tabindex', '0');
      this.box.setAttribute('role', 'slider');
      this.box.setAttribute('aria-label', 'Magnifier position');
      this.box.removeAttribute('aria-hidden');
    }

    this.onDown = (event) => {
      const box = this.box;
      if (!box) return;
      this.dragging = true;
      box.classList.add(DRAGGING_CLASS);
      capturePointer(() => { box.setPointerCapture(event.pointerId); });
      const rect = box.getBoundingClientRect();
      this.grabX = event.clientX - (rect.left + rect.width / 2);
      this.grabY = event.clientY - (rect.top + rect.height / 2);
      event.preventDefault();
    };
    this.onMove = (event) => {
      if (!this.dragging) return;
      this.moveTo(event.clientX - this.grabX, event.clientY - this.grabY);
    };
    this.onUp = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.box?.classList.remove(DRAGGING_CLASS);
      capturePointer(() => { this.box?.releasePointerCapture(event.pointerId); });
    };
    this.onKey = (event) => {
      const dx = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const dy = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (dx === 0 && dy === 0) return;
      event.preventDefault();
      this.localX = clamp(this.localX + dx * KEY_STEP, 0, 1);
      this.localY = clamp(this.localY + dy * KEY_STEP, 0, 1);
      this.write();
    };

    this.box?.addEventListener('pointerdown', this.onDown);
    this.box?.addEventListener('pointermove', this.onMove);
    this.box?.addEventListener('pointerup', this.onUp);
    this.box?.addEventListener('pointercancel', this.onUp);
    this.box?.addEventListener('keydown', this.onKey);
    this.write();
  }

  private moveTo(clientX: number, clientY: number): void {
    const bounds = this.container?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    this.localX = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    this.localY = clamp((clientY - bounds.top) / bounds.height, 0, 1);
    this.write();
  }

  private write(): void {
    this.box?.style.setProperty(POSITION_X, `${(this.localX * 100).toFixed(2)}%`);
    this.box?.style.setProperty(POSITION_Y, `${(this.localY * 100).toFixed(2)}%`);
    this.box?.setAttribute('aria-valuetext',
      `${Math.round(this.localX * 100)}% across, ${Math.round(this.localY * 100)}% down`);
    this.publish();
  }

  /** Screen-space centre of the box, which is what the lens needs. */
  publish(): void {
    const box = this.box;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const width = window.innerWidth || 1;
    const height = window.innerHeight || 1;
    this.state.magnifierX = (rect.left + rect.width / 2) / width;
    // GL space counts up from the bottom.
    this.state.magnifierY = 1 - (rect.top + rect.height / 2) / height;
  }

  destroy(): void {
    this.box?.removeEventListener('pointerdown', this.onDown);
    this.box?.removeEventListener('pointermove', this.onMove);
    this.box?.removeEventListener('pointerup', this.onUp);
    this.box?.removeEventListener('pointercancel', this.onUp);
    this.box?.removeEventListener('keydown', this.onKey);
  }
}
