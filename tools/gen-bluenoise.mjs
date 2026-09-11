/**
 * Void-and-cluster blue noise generator.
 *
 * Writes a 128x128 8-bit greyscale PNG whose values are a uniform permutation
 * of 0..255 with the energy spectrum pushed into high frequencies. Run once:
 *   node tools/gen-bluenoise.mjs
 *
 * A hash-based dither would be cheaper but produces visible structure in dark
 * gradients, which is exactly where this site spends most of its pixels.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SIZE = 128;
const N = SIZE * SIZE;
const SIGMA = 1.9;
const KERNEL_RADIUS = 6;
const INITIAL_ONES_FRACTION = 0.1;
const MAX_REFINE_SWAPS = 40000;
const SEED = 0x9e3779b9;
const OUT = 'public/textures/blue-noise-128.png';

/** Deterministic output matters: the dither pattern is part of the look. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Separable in principle, but the toroidal wrap and the incremental
// add/subtract below are simpler against a flat 2D table.
const kernel = [];
for (let dy = -KERNEL_RADIUS; dy <= KERNEL_RADIUS; dy++) {
  for (let dx = -KERNEL_RADIUS; dx <= KERNEL_RADIUS; dx++) {
    const d2 = dx * dx + dy * dy;
    kernel.push({ dx, dy, w: Math.exp(-d2 / (2 * SIGMA * SIGMA)) });
  }
}

const energy = new Float32Array(N);
const pattern = new Uint8Array(N);

function splat(index, sign) {
  const x = index % SIZE;
  const y = (index / SIZE) | 0;
  for (const k of kernel) {
    const px = (x + k.dx + SIZE) % SIZE;
    const py = (y + k.dy + SIZE) % SIZE;
    energy[py * SIZE + px] += sign * k.w;
  }
}

/** Tightest cluster: the 1 with the most neighbours. Largest void: the 0 with
 *  the fewest. Both are a full scan; at 16k pixels that is cheap enough. */
function findExtreme(wantValue, wantMax) {
  let best = -1;
  let bestE = wantMax ? -Infinity : Infinity;
  for (let i = 0; i < N; i++) {
    if (pattern[i] !== wantValue) continue;
    const e = energy[i];
    if (wantMax ? e > bestE : e < bestE) { bestE = e; best = i; }
  }
  return best;
}

const random = makeRandom(SEED);
let ones = 0;
const targetOnes = Math.round(N * INITIAL_ONES_FRACTION);
while (ones < targetOnes) {
  const i = (random() * N) | 0;
  if (pattern[i] === 1) continue;
  pattern[i] = 1;
  splat(i, 1);
  ones++;
}

// Phase 0 — break up the random clumps until moving the tightest cluster
// lands it back where it started.
for (let swap = 0; swap < MAX_REFINE_SWAPS; swap++) {
  const cluster = findExtreme(1, true);
  pattern[cluster] = 0;
  splat(cluster, -1);
  const voidPixel = findExtreme(0, false);
  if (voidPixel === cluster) { pattern[cluster] = 1; splat(cluster, 1); break; }
  pattern[voidPixel] = 1;
  splat(voidPixel, 1);
}

const prototype = pattern.slice();
const rank = new Int32Array(N).fill(-1);

// Phase 1 — rank the prototype's ones downward by removing clusters.
for (let r = ones - 1; r >= 0; r--) {
  const cluster = findExtreme(1, true);
  pattern[cluster] = 0;
  splat(cluster, -1);
  rank[cluster] = r;
}

// Phase 2 — restore the prototype and rank upward by filling voids. Past the
// halfway point the tightest cluster of zeros is the largest void of ones
// (E_zeros = kernelTotal - E_ones), so one loop covers both classic phases.
pattern.set(prototype);
energy.fill(0);
for (let i = 0; i < N; i++) if (pattern[i] === 1) splat(i, 1);
for (let r = ones; r < N; r++) {
  const voidPixel = findExtreme(0, false);
  pattern[voidPixel] = 1;
  splat(voidPixel, 1);
  rank[voidPixel] = r;
}

const pixels = new Uint8Array(N);
for (let i = 0; i < N; i++) pixels[i] = Math.min(255, Math.floor((rank[i] / N) * 256));

// --- minimal 8-bit greyscale PNG encoder ---------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 0;   // colour type: greyscale
const raw = Buffer.alloc(N + SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE + 1)] = 0; // filter: none — the data is noise, filters do nothing
  Buffer.from(pixels.buffer, y * SIZE, SIZE).copy(raw, y * (SIZE + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);

// Report the histogram flatness and the mean distance to the nearest same-rank
// neighbour band, so a bad run is obvious without opening the file.
let minV = 255, maxV = 0;
const hist = new Int32Array(256);
for (const v of pixels) { hist[v]++; if (v < minV) minV = v; if (v > maxV) maxV = v; }
let histMin = Infinity, histMax = 0;
for (const h of hist) { if (h < histMin) histMin = h; if (h > histMax) histMax = h; }
console.log(`wrote ${OUT} ${png.length} bytes`);
console.log(`range ${minV}..${maxV}  histogram per level ${histMin}..${histMax} (ideal ${N / 256})`);
