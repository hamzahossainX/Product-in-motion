/**
 * The custom cursor.
 *
 * Spring-followed, never instant (rule 5): a cursor that tracks the
 * pointer exactly is the system cursor with extra steps, and the lag is the
 * whole effect. It morphs between states declared on the DOM through
 * `data-cursor`, so a region announces what it affords without a second element
 * having to be positioned over it.
 *
 * It never replaces the system cursor on touch, where there is no pointer to
 * follow, and it is suppressed under reduced motion.
 */
import { SecondOrderDynamics2 } from '../lib/SecondOrderDynamics.ts';

/** Fast enough to feel attached, slow enough that the lag reads as weight. */
const FOLLOW_FREQUENCY = 4.2;
const FOLLOW_DAMPING = 0.9;
const FOLLOW_RESPONSE = 0.4;
/** The size spring is slower, so a state change is a morph, not a cut. */
const SIZE_FREQUENCY = 2.6;
const SIZE_DAMPING = 0.85;

const STATE_ATTRIBUTE = 'data-cursor';
const HIDDEN_SCALE = 0;

interface CursorState {
  size: number;
  label: string;
  filled: boolean;
}

const STATES: Record<string, CursorState> = {
  link: { size: 44, label: '', filled: false },
  drag: { size: 72, label: 'DRAG', filled: false },
  type: { size: 56, label: 'TYPE', filled: false },
  erase: { size: 84, label: 'ERASE', filled: true },
};

export class Cursor {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly position = new SecondOrderDynamics2(0, 0, FOLLOW_FREQUENCY, FOLLOW_DAMPING, FOLLOW_RESPONSE);
  private readonly size = new SecondOrderDynamics2(0, 0, SIZE_FREQUENCY, SIZE_DAMPING, 0);

  private targetX = 0;
  private targetY = 0;
  private state: CursorState | null = null;
  private currentName = '';
  private visible = false;
  private writtenTransform = '';
  private writtenSize = -1;

  private readonly onMove: (event: PointerEvent) => void;
  private readonly onOver: (event: PointerEvent) => void;
  private readonly onLeaveWindow: () => void;
  enabled = true;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'cursor';
    this.root.setAttribute('aria-hidden', 'true');
    this.label = document.createElement('span');
    this.label.className = 'cursor__label';
    this.root.append(this.label);
    document.body.append(this.root);

    this.onMove = (event) => {
      this.targetX = event.clientX;
      this.targetY = event.clientY;
      if (!this.visible) {
        // Snap on the first sighting; springing in from the origin would fling
        // the cursor diagonally across the page.
        this.position.reset(event.clientX, event.clientY);
        this.visible = true;
      }
    };
    this.onOver = (event) => {
      const target = event.target as HTMLElement | null;
      const holder = target?.closest<HTMLElement>(`[${STATE_ATTRIBUTE}]`);
      if (holder) {
        this.setState(holder.getAttribute(STATE_ATTRIBUTE) ?? '');
        return;
      }
      // Links and buttons get the plain state without every one of them
      // needing an attribute in the markup.
      this.setState(target?.closest('a, button') ? 'link' : '');
    };
    this.onLeaveWindow = () => { this.visible = false; };

    window.addEventListener('pointermove', this.onMove, { passive: true });
    window.addEventListener('pointerover', this.onOver, { passive: true });
    document.addEventListener('pointerleave', this.onLeaveWindow, { passive: true });
  }

  private setState(name: string): void {
    if (name === this.currentName) return;
    this.currentName = name;
    this.state = STATES[name] ?? null;
    this.label.textContent = this.state?.label ?? '';
    this.root.classList.toggle('cursor--filled', this.state?.filled === true);
  }

  update(dt: number): void {
    const active = this.enabled && this.visible && this.state !== null;
    const targetSize = active ? this.state!.size : HIDDEN_SCALE;

    const point = this.position.update(dt, this.targetX, this.targetY);
    const size = this.size.update(dt, targetSize, 0).x;

    // Both writes build a string, so both are skipped when nothing moved.
    const transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
    if (transform !== this.writtenTransform) {
      this.writtenTransform = transform;
      this.root.style.transform = transform;
    }
    const rounded = Math.max(0, Math.round(size * 10) / 10);
    if (rounded !== this.writtenSize) {
      this.writtenSize = rounded;
      this.root.style.width = `${rounded}px`;
      this.root.style.height = `${rounded}px`;
      this.root.style.opacity = rounded > 1 ? '1' : '0';
    }
  }

  /** For the gate harness: the state the cursor is currently showing. */
  get stateName(): string { return this.currentName; }

  destroy(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerover', this.onOver);
    document.removeEventListener('pointerleave', this.onLeaveWindow);
    this.root.remove();
  }
}
