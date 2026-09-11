/**
 * Everything that exists in 3D space.
 *
 * Owns the scene graph, the camera, the hero object, the dust and the lights —
 * and nothing about how any of it reaches the screen. The gobo lives beside it
 * in the frame loop rather than inside it, because it writes to shared uniforms
 * that materials hold by reference, not to the scene graph.
 *
 * The lighting is the environment map plus three small runtime lights and the
 * gobo. A Blender lightmap bake (L1 spherical harmonics in two RGB textures)
 * would be both cheaper and better than the runtime lights and is the obvious
 * next improvement if this ever gets a modelling pass.
 */
import { AmbientLight, Color, DirectionalLight, Group, PerspectiveCamera, Scene, Texture } from 'three';
import { Background } from '../scenes/Background.ts';
import { Hero } from '../scenes/Hero.ts';
import { Paper } from '../scenes/Paper.ts';
import { Particles } from '../scenes/Particles.ts';
import type { BlueNoise } from './BlueNoise.ts';
import type { SharedUniforms } from './SharedUniforms.ts';

const FOV_DEGREES = 35;
const NEAR = 0.1;
const FAR = 100;

/** Small next to the environment map: these shape the terminator, the env map
 *  does the actual lifting. */
const KEY_COLOR = '#FFE8CE';
const KEY_INTENSITY = 0.95;
const FILL_COLOR = '#9E8C7A';
const FILL_INTENSITY = 0.22;
const RIM_COLOR = '#E4735C';
const RIM_INTENSITY = 0.8;
const AMBIENT_COLOR = '#2E2620';
const AMBIENT_INTENSITY = 0.06;

export class Stage {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly background: Background;
  readonly hero: Hero;
  readonly paper: Paper;
  readonly particles: Particles;
  /** Everything a section can claim hangs off this. */
  readonly world = new Group();

  constructor(blueNoise: BlueNoise, shared: SharedUniforms, width: number, height: number, mobile: boolean) {
    this.camera = new PerspectiveCamera(FOV_DEGREES, width / height, NEAR, FAR);
    this.camera.position.set(0, 1.15, 5.6);
    this.camera.lookAt(0, -0.1, 0);

    this.background = new Background(blueNoise, width / height);
    this.scene.add(this.background.mesh);
    this.scene.add(this.world);

    this.hero = new Hero(shared);
    this.paper = new Paper(shared);
    this.particles = new Particles(shared, mobile);
    this.world.add(this.hero.object, this.paper.mesh, this.particles.mesh);

    const key = new DirectionalLight(new Color(KEY_COLOR), KEY_INTENSITY);
    key.position.set(-3, 4, 4);
    const fill = new DirectionalLight(new Color(FILL_COLOR), FILL_INTENSITY);
    fill.position.set(4, -1, 2.5);
    const rim = new DirectionalLight(new Color(RIM_COLOR), RIM_INTENSITY);
    rim.position.set(1.5, 1.5, -4);
    this.scene.add(key, fill, rim, new AmbientLight(new Color(AMBIENT_COLOR), AMBIENT_INTENSITY));
  }

  /** The prefiltered environment arrives after the first frame; applying it to
   *  the scene reaches every standard material without touching any of them. */
  setEnvironment(texture: Texture): void {
    this.scene.environment = texture;
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.background.setSize(width, height);
  }

  dispose(): void {
    this.background.dispose();
    this.hero.dispose();
    this.paper.dispose();
    this.particles.dispose();
    this.scene.environment?.dispose();
  }
}
