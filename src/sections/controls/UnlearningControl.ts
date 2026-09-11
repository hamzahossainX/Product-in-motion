/**
 * The signature interaction: type something, then rub it out.
 *
 * The input is a real `<input>` — it keeps its label, its placeholder and its
 * keyboard behaviour, and what the reader types is published to the scene, not
 * re-implemented in 3D.
 *
 * Erasing is a drag across a surface, which no keyboard can perform, so the
 * same operation is also a button. The button is not a shortcut past the
 * interaction; it runs the same strokes along the same path.
 */
import { clamp } from '../../lib/math.ts';
import { capturePointer } from './capturePointer.ts';
import type { InteractionState } from '../../lib/InteractionState.ts';

const INPUT_ID = 'unlearning-input';
const SHEET_ID = 'unlearning-sheet';
const ERASE_ID = 'unlearning-erase';

/** Stroke radius as a fraction of the sheet's width. */
const STROKE_RADIUS = 0.085;
/** A slow drag removes more than a fast one, as a real eraser does — but a
 *  stationary pointer must not bore a hole, so it is capped. */
const MIN_STRENGTH = 0.14;
const MAX_STRENGTH = 0.5;
const SPEED_FOR_MIN_STRENGTH = 0.06;
/** Points interpolated between two pointer samples, so a fast drag paints a
 *  line rather than a row of dots. */
const MAX_INTERPOLATED = 12;
const SPACING = 0.02;

/** The keyboard sweep: left to right across the middle, in this many steps. */
const SWEEP_STEPS = 34;
const SWEEP_INTERVAL_MS = 16;

export class UnlearningControl {
  private readonly input: HTMLInputElement | null;
  private readonly sheet: HTMLElement | null;
  private readonly eraseButton: HTMLButtonElement | null;
  private readonly state: InteractionState;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly onInput: () => void;
  private readonly onDown: (event: PointerEvent) => void;
  private readonly onMove: (event: PointerEvent) => void;
  private readonly onUp: (event: PointerEvent) => void;
  private readonly onErase: () => void;

  constructor(state: InteractionState) {
    this.state = state;
    this.input = document.querySelector<HTMLInputElement>(`#${INPUT_ID}`);
    this.sheet = document.querySelector<HTMLElement>(`#${SHEET_ID}`);
    this.eraseButton = document.querySelector<HTMLButtonElement>(`#${ERASE_ID}`);

    this.onInput = () => {
      const value = this.input?.value ?? '';
      if (value === this.state.text) return;
      this.state.text = value;
      this.state.textVersion++;
      // A fresh sentence starts on a clean sheet; otherwise the new text
      // appears already half rubbed out.
      this.state.clearVersion++;
    };

    this.onDown = (event) => {
      this.dragging = true;
      this.hasLast = false;
      capturePointer(() => { this.sheet?.setPointerCapture(event.pointerId); });
      this.paint(event.clientX, event.clientY);
      event.preventDefault();
    };
    this.onMove = (event) => {
      if (!this.dragging) return;
      this.paint(event.clientX, event.clientY);
    };
    this.onUp = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.hasLast = false;
      capturePointer(() => { this.sheet?.releasePointerCapture(event.pointerId); });
    };
    this.onErase = () => this.sweep();

    this.input?.addEventListener('input', this.onInput);
    this.sheet?.addEventListener('pointerdown', this.onDown);
    this.sheet?.addEventListener('pointermove', this.onMove);
    this.sheet?.addEventListener('pointerup', this.onUp);
    this.sheet?.addEventListener('pointercancel', this.onUp);
    this.eraseButton?.addEventListener('click', this.onErase);

    this.onInput();
  }

  /** True while the reader is actually rubbing, so the scene can bring the
   *  eraser down onto the sheet. */
  get isErasing(): boolean { return this.dragging || this.sweepTimer !== null; }

  /** Where the eraser is, in sheet space. */
  get pointX(): number { return this.lastX; }
  get pointY(): number { return this.lastY; }

  private paint(clientX: number, clientY: number): void {
    const rect = this.sheet?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    this.queue(x, y);
  }

  private queue(x: number, y: number): void {
    if (this.hasLast) {
      const dx = x - this.lastX;
      const dy = y - this.lastY;
      const distance = Math.hypot(dx, dy);
      const speed = clamp(distance / SPEED_FOR_MIN_STRENGTH, 0, 1);
      const strength = MAX_STRENGTH - (MAX_STRENGTH - MIN_STRENGTH) * speed;
      const steps = Math.min(MAX_INTERPOLATED, Math.max(1, Math.ceil(distance / SPACING)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.state.eraseQueue.push({
          x: this.lastX + dx * t,
          y: this.lastY + dy * t,
          radius: STROKE_RADIUS,
          strength: strength / steps + MIN_STRENGTH * 0.35,
        });
      }
    } else {
      this.state.eraseQueue.push({ x, y, radius: STROKE_RADIUS, strength: MIN_STRENGTH });
    }
    this.lastX = x;
    this.lastY = y;
    this.hasLast = true;
  }

  /** The keyboard equivalent: the same strokes, driven by a timer. */
  sweep(): void {
    if (this.sweepTimer !== null) return;
    let step = 0;
    this.hasLast = false;
    this.sweepTimer = setInterval(() => {
      const t = step / (SWEEP_STEPS - 1);
      this.queue(t, 0.5 + Math.sin(t * Math.PI * 2) * 0.12);
      step++;
      if (step >= SWEEP_STEPS) {
        clearInterval(this.sweepTimer!);
        this.sweepTimer = null;
        this.hasLast = false;
      }
    }, SWEEP_INTERVAL_MS);
  }

  destroy(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.input?.removeEventListener('input', this.onInput);
    this.sheet?.removeEventListener('pointerdown', this.onDown);
    this.sheet?.removeEventListener('pointermove', this.onMove);
    this.sheet?.removeEventListener('pointerup', this.onUp);
    this.sheet?.removeEventListener('pointercancel', this.onUp);
    this.eraseButton?.removeEventListener('click', this.onErase);
  }
}
