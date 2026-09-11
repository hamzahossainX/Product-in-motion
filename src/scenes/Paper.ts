/**
 * The sheet the eraser sits on.
 *
 * Secondary geometry from CONCEPT.md, and the single largest thing the gobo
 * has to play across. A projected light crawling over a big matte surface is
 * most of what separates a rendered scene from a WebGL demo — with the object
 * alone in a void there is nothing for the light to be projected onto, so the
 * gobo reads as a vague gradient rather than as light.
 *
 * It also grounds the shot — an object floating in black has no scale — but it
 * stays deliberately underexposed and inside a tight pool. The hero of the
 * hero section is the eraser; the sheet is what it is standing on. Phase 5's
 * unlearning section claims a wider pool and drops the camera onto it, which
 * is where the paper is supposed to take the frame.
 */
import { DoubleSide, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three';
import { createVinylMaterial } from './materials/VinylMaterial.ts';
import type { SharedUniforms } from '../engine/SharedUniforms.ts';

const WIDTH = 15;
const DEPTH = 11;
/** Enough segments to carry the warp; the sheet is otherwise flat. */
const SEGMENTS_X = 48;
const SEGMENTS_Y = 36;

const COLOR = '#9C8E7C';
const ROUGHNESS = 0.94;
const ENV_MAP_INTENSITY = 0.2;
/** Beyond this the sheet falls into the dark rather than running to a horizon.
 *  Centred on the object, not the origin — the sheet is large enough that its
 *  own edges stay inside the darkness at every camera position on the path. */
const LIGHT_POOL_RADIUS = 4.1;

const Y = -1.02;
const TILT = -Math.PI / 2 + 0.055;

/** Paper is never flat. Amplitude is under a millimetre at this scale — read
 *  as a soft undulation in the reflection, never as a wave. */
const WARP_AMPLITUDE = 0.055;
const WARP_FREQUENCY_X = 0.42;
const WARP_FREQUENCY_Y = 0.31;

export class Paper {
  readonly mesh: Mesh;
  private readonly material: MeshStandardMaterial;
  private readonly geometry: PlaneGeometry;

  constructor(shared: SharedUniforms) {
    this.geometry = new PlaneGeometry(WIDTH, DEPTH, SEGMENTS_X, SEGMENTS_Y);
    const position = this.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      position.setZ(i,
        Math.sin(x * WARP_FREQUENCY_X) * Math.cos(y * WARP_FREQUENCY_Y) * WARP_AMPLITUDE +
        Math.sin(x * WARP_FREQUENCY_X * 2.7 + 1.4) * WARP_AMPLITUDE * 0.35);
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();

    this.material = createVinylMaterial(shared, {
      color: COLOR,
      roughness: ROUGHNESS,
      envMapIntensity: ENV_MAP_INTENSITY,
      wearAware: false,
      lightPoolRadius: LIGHT_POOL_RADIUS,
      contactShadow: true,
    });
    this.material.side = DoubleSide;
    this.material.name = 'paper';

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.rotation.x = TILT;
    this.mesh.position.y = Y;
    this.mesh.name = 'paper';
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
