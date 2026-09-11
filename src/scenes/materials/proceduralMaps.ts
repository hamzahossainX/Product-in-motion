/**
 * Vinyl surface maps, generated rather than shipped.
 *
 * CONCEPT.md asks for embedded graphite particles and a surface that rewards a
 * macro shot. That is two 256x256 textures — an albedo with specks and an ORM
 * with the matching roughness break-up — which is 40 lines of arithmetic and
 * no bytes over the wire, so there is nothing to load, decode, or ship a format
 * fallback for.
 */
import { DataTexture, LinearMipmapLinearFilter, LinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace } from 'three';

const SIZE = 256;
const BASE_COLOR: [number, number, number] = [232, 220, 200];
/** Fraction of texels that are a graphite inclusion. */
const SPECK_DENSITY = 0.055;
const SPECK_DARKNESS = 0.42;
const MOTTLE_FREQUENCY = 6;
const MOTTLE_AMPLITUDE = 0.06;

const BASE_ROUGHNESS = 0.66;
const ROUGHNESS_VARIATION = 0.13;
/** Graphite inclusions sit slightly proud and read glossier than the vinyl. */
const SPECK_ROUGHNESS = 0.34;

function hash(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function smootherstep(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Tiling value noise: the lattice wraps, so the texture repeats seamlessly. */
function tilingNoise(x: number, y: number, frequency: number, seed: number): number {
  const fx = x * frequency, fy = y * frequency;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = smootherstep(fx - ix), ty = smootherstep(fy - iy);
  const wrap = (v: number) => ((v % frequency) + frequency) % frequency;
  const c00 = hash(wrap(ix), wrap(iy), seed);
  const c10 = hash(wrap(ix + 1), wrap(iy), seed);
  const c01 = hash(wrap(ix), wrap(iy + 1), seed);
  const c11 = hash(wrap(ix + 1), wrap(iy + 1), seed);
  return (c00 * (1 - tx) + c10 * tx) * (1 - ty) + (c01 * (1 - tx) + c11 * tx) * ty;
}

function finish(texture: DataTexture, srgb: boolean): DataTexture {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface VinylMaps { albedo: DataTexture; orm: DataTexture }

export function createVinylMaps(): VinylMaps {
  const albedoData = new Uint8Array(SIZE * SIZE * 4);
  const ormData = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const i = (y * SIZE + x) * 4;

      const mottle = (tilingNoise(u, v, MOTTLE_FREQUENCY, 3) - 0.5) * 2 * MOTTLE_AMPLITUDE;
      const isSpeck = hash(x, y, 11) < SPECK_DENSITY;
      const speckShade = isSpeck ? 1 - SPECK_DARKNESS * (0.5 + hash(x, y, 29) * 0.5) : 1;
      const shade = (1 + mottle) * speckShade;

      albedoData[i] = Math.max(0, Math.min(255, Math.round(BASE_COLOR[0] * shade)));
      albedoData[i + 1] = Math.max(0, Math.min(255, Math.round(BASE_COLOR[1] * shade)));
      albedoData[i + 2] = Math.max(0, Math.min(255, Math.round(BASE_COLOR[2] * shade)));
      albedoData[i + 3] = 255;

      const grain = (tilingNoise(u, v, 24, 7) - 0.5) * 2 * ROUGHNESS_VARIATION;
      const roughness = isSpeck ? SPECK_ROUGHNESS : BASE_ROUGHNESS + grain;
      ormData[i] = 255;                                            // no baked occlusion
      ormData[i + 1] = Math.round(Math.max(0, Math.min(1, roughness)) * 255);
      ormData[i + 2] = 0;                                          // never metallic
      ormData[i + 3] = 255;
    }
  }

  return {
    albedo: finish(new DataTexture(albedoData, SIZE, SIZE, RGBAFormat), true),
    orm: finish(new DataTexture(ormData, SIZE, SIZE, RGBAFormat), false),
  };
}
