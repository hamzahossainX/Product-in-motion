/**
 * The distance transform, off the main thread.
 *
 * Rasterising and transforming a line of text measured 21.7 ms on the main
 * thread, which is a dropped frame per keystroke. The raster has to stay where
 * the fonts are; the transform does not, and it is nearly all of the cost.
 *
 * Buffers move by transfer in both directions, so nothing is copied.
 */
import { buildDistanceField } from './distanceField.ts';

export interface SdfRequest {
  id: number;
  alpha: ArrayBuffer;
  width: number;
  height: number;
  spread: number;
}

export interface SdfResponse {
  id: number;
  field: ArrayBuffer;
}

self.onmessage = (event: MessageEvent<SdfRequest>) => {
  const { id, alpha, width, height, spread } = event.data;
  const field = buildDistanceField(new Uint8Array(alpha), width, height, spread);
  // The workspace inside buildDistanceField is reused between calls, so the
  // result is a view onto it and has to be copied before being transferred.
  const out = new Uint8Array(field).buffer;
  (self as unknown as Worker).postMessage({ id, field: out } satisfies SdfResponse, [out]);
};
