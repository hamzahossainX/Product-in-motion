/**
 * The preloader.
 *
 * Canvas2D, not DOM: the shape is the eraser's silhouette filling with real
 * load progress, and a fill that tracks a number is a drawing problem, not a
 * layout one.
 *
 * The progress is honest — it comes from the weighted loader, so it reflects
 * work done rather than files counted. It is also smoothed by a spring, because
 * a weighted loader completes in steps and a bar that jumps reads as fake even
 * when it is the truthful one.
 */
import { SecondOrderDynamics } from '../lib/SecondOrderDynamics.ts';
import { clamp } from '../lib/math.ts';

/** Never flash. On a warm cache everything resolves in one frame, and a
 *  preloader that appears and vanishes inside 30 ms is just a flicker. */
const MIN_VISIBLE_SECONDS = 0.1;
const FADE_SECONDS = 0.45;
/** The eraser, drawn at this size in CSS pixels and scaled by the viewport. */
const SHAPE_WIDTH = 190;
const SHAPE_HEIGHT = 74;
const SHAPE_RADIUS = 12;
const OUTLINE_WIDTH = 1.5;

const COLOR_BACKGROUND = '#0E0B08';
const COLOR_OUTLINE = 'rgba(244, 234, 219, 0.34)';
const COLOR_FILL = '#E8B48A';
const COLOR_LABEL = 'rgba(244, 234, 219, 0.52)';
const LABEL_FONT = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
const LABEL_GAP = 30;

/** The glow behind the shape, cached once. Rebuilding a radial gradient every
 *  frame is the single most expensive thing a Canvas2D loop can do. */
const GLOW_SIZE = 255;
const GLOW_COLOR_INNER = 'rgba(232, 180, 138, 0.30)';
const GLOW_COLOR_OUTER = 'rgba(232, 180, 138, 0)';
const GLOW_SCALE = 3.2;

const PROGRESS_FREQUENCY = 2.4;
const PROGRESS_DAMPING = 1;
const PROGRESS_RESPONSE = 0;

export class Preloader {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly glow: HTMLCanvasElement;
  private readonly spring =
    new SecondOrderDynamics(0, PROGRESS_FREQUENCY, PROGRESS_DAMPING, PROGRESS_RESPONSE);

  private target = 0;
  private elapsed = 0;
  private fading = 0;
  private done = false;
  private pixelRatio = 1;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'preloader';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-label', 'Loading');

    this.canvas = document.createElement('canvas');
    this.root.append(this.canvas);
    document.body.append(this.root);
    this.context = this.canvas.getContext('2d');

    this.glow = document.createElement('canvas');
    this.glow.width = GLOW_SIZE;
    this.glow.height = GLOW_SIZE;
    const glowContext = this.glow.getContext('2d');
    if (glowContext) {
      const half = GLOW_SIZE / 2;
      const gradient = glowContext.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, GLOW_COLOR_INNER);
      gradient.addColorStop(1, GLOW_COLOR_OUTER);
      glowContext.fillStyle = gradient;
      glowContext.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
    }

    this.resize();
  }

  /** Wire to the loader: honest, weighted, monotonic. */
  setProgress(progress: number): void {
    this.target = clamp(progress, 0, 1);
  }

  private resize(): void {
    this.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.pixelRatio);
    this.canvas.height = Math.round(window.innerHeight * this.pixelRatio);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  /** Returns true once it has finished and removed itself. */
  update(dt: number): boolean {
    if (this.done) return true;
    this.elapsed += dt;

    const shown = this.spring.update(dt, this.target);
    const settled = this.target >= 1 && shown > 0.995;
    if (settled && this.elapsed >= MIN_VISIBLE_SECONDS) {
      this.fading += dt;
    }
    const opacity = 1 - clamp(this.fading / FADE_SECONDS, 0, 1);
    this.root.style.opacity = opacity.toFixed(3);

    if (opacity <= 0) {
      // display:none, not just transparent: a full-viewport canvas left in the
      // page keeps compositing for the rest of the session.
      this.root.style.display = 'none';
      this.done = true;
      this.root.remove();
      return true;
    }

    this.draw(clamp(shown, 0, 1));
    return false;
  }

  private draw(progress: number): void {
    const ctx = this.context;
    if (!ctx) return;
    const width = this.canvas.width;
    const height = this.canvas.height;

    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLOR_BACKGROUND;
    ctx.fillRect(0, 0, width / this.pixelRatio, height / this.pixelRatio);

    const cx = width / this.pixelRatio / 2;
    const cy = height / this.pixelRatio / 2;
    const glowSize = SHAPE_WIDTH * GLOW_SCALE;
    ctx.drawImage(this.glow, cx - glowSize / 2, cy - glowSize / 2, glowSize, glowSize);

    const left = cx - SHAPE_WIDTH / 2;
    const top = cy - SHAPE_HEIGHT / 2;

    ctx.beginPath();
    ctx.roundRect(left, top, SHAPE_WIDTH, SHAPE_HEIGHT, SHAPE_RADIUS);
    ctx.strokeStyle = COLOR_OUTLINE;
    ctx.lineWidth = OUTLINE_WIDTH;
    ctx.stroke();

    // Fills left to right, like something being written rather than poured.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = COLOR_FILL;
    ctx.fillRect(left, top, SHAPE_WIDTH * progress, SHAPE_HEIGHT);
    ctx.restore();

    ctx.fillStyle = COLOR_LABEL;
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.round(progress * 100)}%`, cx, top + SHAPE_HEIGHT + LABEL_GAP);
  }

  handleResize(): void {
    if (!this.done) this.resize();
  }

  destroy(): void {
    this.done = true;
    this.root.remove();
  }
}
