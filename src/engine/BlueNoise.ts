/**
 * The dither source.
 *
 * 128x128, RepeatWrapping, NearestFilter, no mipmaps — filtering or mipmapping
 * a blue-noise texture destroys the property that makes it useful, because a
 * blurred blue noise is just low-frequency noise, which is banding again.
 */
import { NearestFilter, NoColorSpace, RepeatWrapping, Texture, TextureLoader, Vector2 } from 'three';
import { BLUE_NOISE_TEXTURE_SIZE } from './post/shaders/blueNoise.glsl.ts';

const TEXTURE_URL = `${import.meta.env.BASE_URL}textures/blue-noise-128.png`;
/** Golden-ratio increments per frame: the offset never repeats a position on
 *  the tile for a very long time, so no beat frequency appears in the grain. */
const OFFSET_STEP_X = 0.7548776662;
const OFFSET_STEP_Y = 0.5698402909;

export class BlueNoise {
  readonly texture: Texture;
  /** Pixels-to-tiles scale; the final pass multiplies gl_FragCoord by this. */
  readonly scale = new Vector2(1 / BLUE_NOISE_TEXTURE_SIZE, 1 / BLUE_NOISE_TEXTURE_SIZE);
  readonly offset = new Vector2();

  constructor(onLoad?: () => void) {
    this.texture = new TextureLoader().load(TEXTURE_URL, onLoad);
    this.texture.wrapS = RepeatWrapping;
    this.texture.wrapT = RepeatWrapping;
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = NoColorSpace;  // raw data, not colour
    this.texture.name = 'blue-noise-128';
  }

  /** Advance the tile. Called once per frame, never per pass. */
  update(): void {
    this.offset.x = (this.offset.x + OFFSET_STEP_X) % 1;
    this.offset.y = (this.offset.y + OFFSET_STEP_Y) % 1;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
