/**
 * The one renderer and the one canvas for the whole site.
 *
 * Owns device-pixel-ratio policy. Two limits apply at once: a hard 1.5 clamp
 * (CLAUDE.md rule 9) and a total pixel budget, because a 1.5x 4K display would
 * otherwise ask for 33M pixels through a six-pass chain.
 */
import { WebGLRenderer, LinearSRGBColorSpace, NoToneMapping, Vector2 } from 'three';

const MAX_PIXEL_RATIO = 1.5;
/** The mobile tier shades fewer pixels: a phone's GPU is a fraction of a
 *  laptop's and its screen is a fraction of the size, so the density that
 *  matters is far lower than the one it reports. */
const MOBILE_PIXEL_RATIO = 1.25;
/** 2560x1440 at DPR 1 — the widest frame we are willing to shade. */
const PIXEL_BUDGET = 2560 * 1440;
const MOBILE_PIXEL_BUDGET = 1280 * 720;
const MIN_PIXEL_RATIO = 0.5;
const CANVAS_ID = 'gl-canvas';

export class Renderer {
  readonly gl: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** Drawing-buffer size in physical pixels. Post passes size against this. */
  readonly drawingBufferSize = new Vector2();
  /** CSS size in logical pixels. DOM-locked rects size against this. */
  readonly viewportSize = new Vector2();
  pixelRatio = 1;

  /** Dragging a window between a 1x and a 2x display changes
   *  devicePixelRatio without changing innerWidth, so no resize event fires
   *  and the canvas would stay at the old density. A resolution media query is
   *  the only thing that reports it. */
  private dprQuery: MediaQueryList | null = null;
  private readonly onPixelRatioChange = (): void => { this.resize(); };

  private readonly mobile: boolean;

  constructor(mobile = false) {
    this.mobile = mobile;
    this.canvas = document.createElement('canvas');
    this.canvas.id = CANVAS_ID;
    this.canvas.setAttribute('aria-hidden', 'true');

    this.gl = new WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      preserveDrawingBuffer: false,
    });

    // The post chain works in linear light end to end and the final pass encodes
    // to sRGB by hand, next to the ACES fit, so the whole transform is in one
    // readable place. Letting three encode as well would double-apply it.
    this.gl.outputColorSpace = LinearSRGBColorSpace;
    this.gl.toneMapping = NoToneMapping;   // rule 11: ACES lives in the final pass
    this.gl.autoClear = false;
    this.gl.info.autoReset = false;

    document.body.prepend(this.canvas);
    this.resize();
  }

  /** DPR that satisfies both the hard clamp and the pixel budget. */
  private computePixelRatio(width: number, height: number): number {
    const cap = this.mobile ? MOBILE_PIXEL_RATIO : MAX_PIXEL_RATIO;
    const budget = this.mobile ? MOBILE_PIXEL_BUDGET : PIXEL_BUDGET;
    const clamped = Math.min(cap, window.devicePixelRatio || 1);
    const area = width * height;
    if (area <= 0) return clamped;
    const budgeted = Math.sqrt(budget / area);
    return Math.max(MIN_PIXEL_RATIO, Math.min(clamped, budgeted));
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.pixelRatio = this.computePixelRatio(width, height);
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(width, height, true);
    this.viewportSize.set(width, height);
    this.gl.getDrawingBufferSize(this.drawingBufferSize);
    this.watchPixelRatio();
  }

  private watchPixelRatio(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
    this.dprQuery.addEventListener('change', this.onPixelRatioChange);
  }

  /** Draw calls and triangles for the debug panel; reset once per frame. */
  resetInfo(): void {
    this.gl.info.reset();
  }

  destroy(): void {
    this.dprQuery?.removeEventListener('change', this.onPixelRatioChange);
    this.gl.dispose();
    this.canvas.remove();
  }
}
