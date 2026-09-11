/**
 * The graphite-grade slider.
 *
 * The native input keeps three discrete steps, because three grades is what the
 * product has and that is what a keyboard and a screen reader should get. A
 * drag, though, tracks the pointer continuously and only settles onto the
 * nearest stop when released — which is how a real detented control behaves,
 * and what stops the 3D jumping between three poses.
 *
 * Nothing here touches the scene. It writes a number into the shared
 * interaction state; the frame loop reads it.
 */
import { clamp } from '../../lib/math.ts';
import { capturePointer } from './capturePointer.ts';
import { HARDNESS_STOPS, type InteractionState } from '../../lib/InteractionState.ts';

const SLIDER_ID = 'hardness-slider';
const READOUT_ID = 'hardness-readout';
const STOP_SELECTOR = '.hardness__stop';
const CURRENT_CLASS = 'is-current';
const FILL_PROPERTY = '--hardness-fill';

export class HardnessControl {
  private readonly slider: HTMLInputElement | null;
  private readonly readout: HTMLOutputElement | null;
  private readonly stops: HTMLElement[];
  private readonly state: InteractionState;
  private dragging = false;
  private writtenStop = -1;

  private readonly onInput: () => void;
  private readonly onPointerDown: (event: PointerEvent) => void;
  private readonly onPointerMove: (event: PointerEvent) => void;
  private readonly onPointerUp: () => void;

  constructor(state: InteractionState) {
    this.state = state;
    this.slider = document.querySelector<HTMLInputElement>(`#${SLIDER_ID}`);
    this.readout = document.querySelector<HTMLOutputElement>(`#${READOUT_ID}`);
    this.stops = [...document.querySelectorAll<HTMLElement>(STOP_SELECTOR)];

    this.onInput = () => {
      if (this.dragging) return;   // the drag path owns the value while it runs
      this.apply(this.fractionFromValue());
    };
    this.onPointerDown = (event) => {
      this.dragging = true;
      capturePointer(() => { this.slider?.setPointerCapture(event.pointerId); });
      this.apply(this.fractionFromPointer(event.clientX));
    };
    this.onPointerMove = (event) => {
      if (!this.dragging) return;
      this.apply(this.fractionFromPointer(event.clientX));
    };
    this.onPointerUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      // Settle onto the detent. The native value has already been stepped by
      // the browser, so this only has to follow it.
      this.apply(this.fractionFromValue());
    };

    this.slider?.addEventListener('input', this.onInput);
    this.slider?.addEventListener('pointerdown', this.onPointerDown);
    this.slider?.addEventListener('pointermove', this.onPointerMove);
    this.slider?.addEventListener('pointerup', this.onPointerUp);
    this.slider?.addEventListener('pointercancel', this.onPointerUp);

    this.apply(this.fractionFromValue());
  }

  private fractionFromValue(): number {
    const slider = this.slider;
    if (!slider) return 0.5;
    const max = Number(slider.max) || 1;
    return clamp(Number(slider.value) / max, 0, 1);
  }

  private fractionFromPointer(clientX: number): number {
    const slider = this.slider;
    if (!slider) return 0.5;
    const rect = slider.getBoundingClientRect();
    return rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
  }

  private apply(fraction: number): void {
    this.state.hardness = fraction;

    // The fill is a custom property so the CSS owns how it is drawn.
    this.slider?.style.setProperty(FILL_PROPERTY, `${(fraction * 100).toFixed(2)}%`);

    const index = Math.round(fraction * (HARDNESS_STOPS.length - 1));
    const stop = HARDNESS_STOPS[index];
    if (this.readout && stop) {
      // Interpolated between the two named grades, not snapped: the readout is
      // the coefficient, and the coefficient is continuous while dragging.
      this.readout.value = coefficientAt(fraction).toFixed(2);
    }
    if (index !== this.writtenStop) {
      this.writtenStop = index;
      for (let i = 0; i < this.stops.length; i++) {
        this.stops[i]!.classList.toggle(CURRENT_CLASS, i === index);
      }
    }
  }

  destroy(): void {
    this.slider?.removeEventListener('input', this.onInput);
    this.slider?.removeEventListener('pointerdown', this.onPointerDown);
    this.slider?.removeEventListener('pointermove', this.onPointerMove);
    this.slider?.removeEventListener('pointerup', this.onPointerUp);
    this.slider?.removeEventListener('pointercancel', this.onPointerUp);
  }
}

/** Abrasion coefficient across the three grades, linearly between stops. */
export function coefficientAt(fraction: number): number {
  const last = HARDNESS_STOPS.length - 1;
  const scaled = clamp(fraction, 0, 1) * last;
  const index = Math.min(last - 1, Math.floor(scaled));
  const t = scaled - index;
  const from = HARDNESS_STOPS[index]!.abrasion;
  const to = HARDNESS_STOPS[index + 1]!.abrasion;
  return from + (to - from) * t;
}
