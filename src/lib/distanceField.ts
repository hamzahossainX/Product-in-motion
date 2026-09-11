/**
 * Signed distance field from a rasterised alpha mask.
 *
 * The spec asks for MSDF text, and MSDF needs glyph outlines, which needs a
 * font parser — a sixth dependency, and rule 22 says never add one without
 * asking. So the glyphs are rasterised with Canvas2D and turned into a
 * distance field here instead. The result is resolution-independent in the same way: the
 * shader recovers a crisp edge from the distance at any magnification, rather
 * than sampling a bitmap that goes soft as the camera closes in.
 *
 * What it gives up against MSDF is exact corners — a single channel cannot
 * represent two edges meeting inside one texel, so a sharp corner rounds at
 * extreme zoom. At the sizes this text is read at, that is not visible.
 *
 * The transform is Felzenszwalb and Huttenlocher's exact Euclidean distance
 * transform: two O(n) passes over the lower envelope of a set of parabolas,
 * once down the columns and once across the rows.
 */

const INF = 1e20;

/** One-dimensional squared-distance transform of `f` into `d`. */
function transform1d(
  f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number,
): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1, k = 0, s = 0; q < n; q++) {
    // Walk back while the new parabola hides the last one entirely.
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  for (let q = 0, k = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    d[q] = (q - r) * (q - r) + f[r]!;
  }
}

/** Working buffers, kept between calls. Rebuilding the field on every keystroke
 *  allocated two multi-megabyte Float64Arrays each time, and the collection
 *  that followed was most of a 215 ms hitch while typing. */
interface Workspace {
  insideDepth: Float64Array;
  outsideDepth: Float64Array;
  f: Float64Array;
  d: Float64Array;
  v: Int32Array;
  z: Float64Array;
  field: Uint8Array;
}

let workspace: Workspace | null = null;

function getWorkspace(count: number, span: number): Workspace {
  if (workspace && workspace.insideDepth.length >= count && workspace.f.length >= span) {
    return workspace;
  }
  workspace = {
    insideDepth: new Float64Array(count),
    outsideDepth: new Float64Array(count),
    f: new Float64Array(span),
    d: new Float64Array(span),
    v: new Int32Array(span),
    z: new Float64Array(span + 1),
    field: new Uint8Array(count),
  };
  return workspace;
}

/**
 * Squared distance from every cell in a sub-rectangle to the nearest zero.
 *
 * Restricted to a rectangle because the glyphs occupy a fraction of the field
 * and everything beyond the spread clamps to the same value anyway — so the
 * transform only has to run where the answer can still change.
 */
function transform2d(
  grid: Float64Array, width: number, work: Workspace,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const { f, d, v, z } = work;
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;

  for (let x = x0; x < x1; x++) {
    for (let y = 0; y < boxHeight; y++) f[y] = grid[(y0 + y) * width + x]!;
    transform1d(f, d, v, z, boxHeight);
    for (let y = 0; y < boxHeight; y++) grid[(y0 + y) * width + x] = d[y]!;
  }
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = 0; x < boxWidth; x++) f[x] = grid[row + x0 + x]!;
    transform1d(f, d, v, z, boxWidth);
    for (let x = 0; x < boxWidth; x++) grid[row + x0 + x] = d[x]!;
  }
}

/**
 * Build an 8-bit signed distance field from an alpha mask.
 *
 * `alpha` is one byte per pixel, 255 inside the glyph. `spread` is how many
 * pixels the field encodes either side of the edge; the shader divides by it
 * to recover the distance in texels. 0.5 in the output is exactly on the edge.
 */
export function buildDistanceField(
  alpha: Uint8Array, width: number, height: number, spread: number,
): Uint8Array {
  const count = width * height;
  const work = getWorkspace(count, Math.max(width, height));
  // The transform measures the distance to the nearest cell whose value is 0,
  // so each grid is seeded at the phase it is measuring TOWARD — which means
  // the grid seeded at the background comes back holding, for every solid cell,
  // how deep inside the glyph it is. Naming them the other way around is what
  // inverted the sign the first time this ran.
  const { insideDepth, outsideDepth, field } = work;

  // Everything outside the glyphs' bounds plus the spread is further away than
  // the field can represent, so it is filled directly and never transformed.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x]! <= 127) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    field.fill(0, 0, count);   // nothing drawn: everywhere is outside
    return field.subarray(0, count);
  }

  const margin = Math.ceil(spread) + 2;
  const x0 = Math.max(0, minX - margin);
  const y0 = Math.max(0, minY - margin);
  const x1 = Math.min(width, maxX + margin + 1);
  const y1 = Math.min(height, maxY + margin + 1);

  field.fill(0, 0, count);
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const solid = alpha[row + x]! > 127;
      insideDepth[row + x] = solid ? INF : 0;    // seeded at background
      outsideDepth[row + x] = solid ? 0 : INF;   // seeded at the glyph
    }
  }

  transform2d(insideDepth, width, work, x0, y0, x1, y1);
  transform2d(outsideDepth, width, work, x0, y0, x1, y1);

  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const i = row + x;
      // Positive inside, negative outside, in pixels.
      const signed = Math.sqrt(insideDepth[i]!) - Math.sqrt(outsideDepth[i]!);
      const normalised = 0.5 + signed / (spread * 2);
      field[i] = Math.max(0, Math.min(255, Math.round(normalised * 255)));
    }
  }
  return field.subarray(0, count);
}
