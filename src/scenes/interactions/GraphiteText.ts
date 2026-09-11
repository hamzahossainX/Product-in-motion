/**
 * What the reader typed, as graphite on paper, and the erasing of it.
 *
 * Three pieces: the glyphs rasterised to a distance field so they stay crisp
 * as the camera closes in, a render target holding wherever the eraser has
 * been, and a sheet whose shader subtracts the second from the first.
 *
 * The erase mask is a render target rather than a canvas because a drag emits
 * several points between two frames and each is blitted additively — repainting
 * a canvas and re-uploading it every frame would move half a megabyte per frame
 * to say the same thing.
 */
import {
  DataTexture, LinearFilter, Mesh, AdditiveBlending, PlaneGeometry,
  RedFormat, ShaderMaterial, Uniform, UnsignedByteType, Vector2, WebGLRenderer,
  WebGLRenderTarget, ClampToEdgeWrapping, Color,
} from 'three';
import { blit, createPassMaterial, createRenderTarget } from '../../engine/FboHelper.ts';
import { buildDistanceField } from '../../lib/distanceField.ts';
import type { SdfRequest, SdfResponse } from '../../lib/sdfWorker.ts';
import type { EraseStroke } from '../../lib/InteractionState.ts';
import type { SharedUniforms } from '../../engine/SharedUniforms.ts';
import { SHEET_SHADER, STROKE_SHADER } from './graphiteText.glsl.ts';

/** The sheet's text area, in texels. */
const FIELD_WIDTH = 1024;
const FIELD_HEIGHT = 256;
/** Pixels either side of the edge the distance field encodes. */
const SPREAD = 8;
/** The erase mask does not need the resolution the glyphs do — it is soft by
 *  nature, and a quarter of the texels is a quarter of the fill. */
const MASK_WIDTH = 512;
const MASK_HEIGHT = 128;

const FONT_STACK = '"General Sans", ui-sans-serif, system-ui, sans-serif';
const FONT_SIZE = 108;
const LINE_HEIGHT = 1.12;
const MAX_LINES = 2;
const PADDING_X = 44;

const PAPER_COLOR = '#D9CDB6';
const GRAPHITE_COLOR = '#241F1A';
const SHEET_ASPECT = FIELD_WIDTH / FIELD_HEIGHT;



export class GraphiteText {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly field: DataTexture;
  private readonly mask: WebGLRenderTarget;
  private readonly strokeMaterial: ShaderMaterial;
  private readonly sheetMaterial: ShaderMaterial;
  private readonly pending: EraseStroke[] = [];
  private clearRequested = true;
  /** The transform runs in a worker; this drops responses that arrive after a
   *  newer keystroke has already been sent. */
  private requestId = 0;
  private readonly worker: Worker | null;

  constructor(_shared: SharedUniforms) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = FIELD_WIDTH;
    this.canvas.height = FIELD_HEIGHT;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });

    this.field = new DataTexture(
      new Uint8Array(FIELD_WIDTH * FIELD_HEIGHT), FIELD_WIDTH, FIELD_HEIGHT,
      RedFormat, UnsignedByteType);
    this.field.minFilter = LinearFilter;
    this.field.magFilter = LinearFilter;
    this.field.wrapS = ClampToEdgeWrapping;
    this.field.wrapT = ClampToEdgeWrapping;
    this.field.generateMipmaps = false;
    this.field.needsUpdate = true;

    this.mask = createRenderTarget(MASK_WIDTH, MASK_HEIGHT, { type: UnsignedByteType });
    this.strokeMaterial = createPassMaterial(STROKE_SHADER, {
      u_centre: new Uniform(new Vector2(0.5, 0.5)),
      u_radius: new Uniform(0.1),
      u_strength: new Uniform(1),
      u_aspect: new Uniform(SHEET_ASPECT),
    });
    // Strokes accumulate; the mask is the union of everywhere the eraser went.
    this.strokeMaterial.blending = AdditiveBlending;

    this.sheetMaterial = new ShaderMaterial({
      uniforms: {
        u_field: new Uniform(this.field),
        u_erase: new Uniform(this.mask.texture),
        u_paper: new Uniform(new Color(PAPER_COLOR)),
        u_graphite: new Uniform(new Color(GRAPHITE_COLOR)),
        u_smudge: new Uniform(0.3),
        u_reveal: new Uniform(0),
      },
      vertexShader: /* glsl */ `
        varying vec2 v_uv;
        void main() {
          v_uv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: SHEET_SHADER,
      // Alpha-blended, so the sheet can fade in and out with its section
      // rather than appearing and vanishing on a frame boundary. It writes no
      // depth: it is a card in front of the scene, not part of its geometry.
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new Mesh(new PlaneGeometry(1, 1 / SHEET_ASPECT), this.sheetMaterial);
    this.mesh.name = 'writing-sheet';
    this.mesh.frustumCulled = false;

    this.worker = createWorker();
    if (this.worker) {
      this.worker.onmessage = (event: MessageEvent<SdfResponse>) => {
        // A stale response is a field for text the reader has already changed.
        if (event.data.id !== this.requestId) return;
        this.field.image.data = new Uint8Array(event.data.field);
        this.field.needsUpdate = true;
      };
    }
  }

  /** Rasterise, then turn the raster into a distance field. Called on input,
   *  never per frame. */
  setText(text: string): void {
    const ctx = this.context;
    if (!ctx) return;

    ctx.clearRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

    const lines = wrapText(ctx, text.trim(), FIELD_WIDTH - PADDING_X * 2);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const lineHeight = FONT_SIZE * LINE_HEIGHT;
    const top = FIELD_HEIGHT / 2 - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.font = `500 ${FONT_SIZE}px ${FONT_STACK}`;
      ctx.fillText(lines[i]!, PADDING_X, top + i * lineHeight);
    }

    // Canvas gives rows top to bottom; a DataTexture is uploaded bottom to
    // top, and three does not apply flipY to data textures. Flipping here is
    // free and puts the correction next to the reason for it.
    const pixels = ctx.getImageData(0, 0, FIELD_WIDTH, FIELD_HEIGHT).data;
    const alpha = new Uint8Array(FIELD_WIDTH * FIELD_HEIGHT);
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      const source = (FIELD_HEIGHT - 1 - y) * FIELD_WIDTH;
      const destination = y * FIELD_WIDTH;
      for (let x = 0; x < FIELD_WIDTH; x++) {
        alpha[destination + x] = pixels[(source + x) * 4]!;
      }
    }

    const id = ++this.requestId;
    if (this.worker) {
      const request: SdfRequest = {
        id, alpha: alpha.buffer, width: FIELD_WIDTH, height: FIELD_HEIGHT, spread: SPREAD,
      };
      this.worker.postMessage(request, [alpha.buffer]);
      return;
    }
    // No worker: do it here rather than not at all.
    this.field.image.data = new Uint8Array(
      buildDistanceField(alpha, FIELD_WIDTH, FIELD_HEIGHT, SPREAD));
    this.field.needsUpdate = true;
  }

  addStroke(stroke: EraseStroke): void {
    this.pending.push(stroke);
  }

  requestClear(): void {
    this.clearRequested = true;
    this.pending.length = 0;
  }

  /** How much of the sheet is showing. Claimed by the section's weight. */
  setReveal(reveal: number): void {
    (this.sheetMaterial.uniforms['u_reveal'] as Uniform<number>).value = reveal;
    // Fully faded is not the same as not drawn: an invisible transparent plane
    // still costs a draw call and still blends.
    this.mesh.visible = reveal > 0.002;
  }

  /** Rule 2: the sheet is claimable state, so the frame wipes it first. */
  resetReveal(): void {
    this.setReveal(0);
  }

  /** Softer grades leave more of a ghost behind. */
  setSmudge(smudge: number): void {
    (this.sheetMaterial.uniforms['u_smudge'] as Uniform<number>).value = smudge;
  }

  /** Drains the queue into the mask. One blit per stroke, so a fast drag paints
   *  a line rather than a row of dots. */
  update(renderer: WebGLRenderer): void {
    if (this.clearRequested) {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(this.mask);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      renderer.setRenderTarget(previous);
      this.clearRequested = false;
    }
    if (this.pending.length === 0) return;

    const u = this.strokeMaterial.uniforms;
    for (let i = 0; i < this.pending.length; i++) {
      const stroke = this.pending[i]!;
      (u['u_centre'] as Uniform<Vector2>).value.set(stroke.x, 1 - stroke.y);
      (u['u_radius'] as Uniform<number>).value = stroke.radius;
      (u['u_strength'] as Uniform<number>).value = stroke.strength;
      blit(renderer, this.strokeMaterial, this.mask);
    }
    this.pending.length = 0;
  }

  get aspect(): number { return SHEET_ASPECT; }

  dispose(): void {
    this.worker?.terminate();
    this.mesh.geometry.dispose();
    this.sheetMaterial.dispose();
    this.strokeMaterial.dispose();
    this.field.dispose();
    this.mask.dispose();
  }
}

/** A worker is an enhancement, not a requirement: some environments refuse to
 *  construct one and the synchronous path still produces the same field. */
function createWorker(): Worker | null {
  try {
    return new Worker(new URL('../../lib/sdfWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** Greedy wrap, shrinking to MAX_LINES by dropping the overflow. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (text.length === 0) return [];
  ctx.font = `500 ${FONT_SIZE}px ${FONT_STACK}`;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === MAX_LINES) return lines;
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current);
  return lines;
}
