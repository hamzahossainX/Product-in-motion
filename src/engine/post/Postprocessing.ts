/**
 * The post chain: scene -> TAA -> FXAA -> Bokeh -> Bloom -> Grade+Final.
 *
 * Also the owner of the live grade. CLAUDE.md rule 2 runs through here: the
 * frame wipes the profile back to DEFAULT_PROFILE, every section blends a
 * partial weighted claim over it, and syncProfile() pushes the accumulated
 * result into uniforms exactly once, just before drawing.
 */
import {
  DepthFormat, DepthTexture, PerspectiveCamera, Scene, Texture, UnsignedIntType,
  Vector2, WebGLRenderTarget, WebGLRenderer, Matrix4, NearestFilter,
} from 'three';
import { createRenderTarget, PingPong } from '../FboHelper.ts';
import { BlueNoise } from '../BlueNoise.ts';
import { DEFAULT_PROFILE, PostProfile } from './PostProfile.ts';
import { TaaPass } from './passes/TaaPass.ts';
import { FxaaPass } from './passes/FxaaPass.ts';
import { BokehPass } from './passes/BokehPass.ts';
import { BloomPass } from './passes/BloomPass.ts';
import { FinalPass } from './passes/FinalPass.ts';

/** The magnifier renders the scene again into a square this size. Larger than
 *  the region it covers on screen, which is the entire point: the detail comes
 *  from the extra samples, not from scaling pixels up. */
const LENS_SIZE = 640;

export interface PostOptions {
  /** Mobile drops TAA and halves the bokeh gather (Phase 8 tier). */
  mobile?: boolean;
}

export class Postprocessing {
  /** The live grade. Never assigned wholesale — reset and blended. */
  readonly profile = new PostProfile();
  readonly blueNoise: BlueNoise;

  private readonly sceneTarget: WebGLRenderTarget;
  private readonly depthTexture: DepthTexture;
  private readonly chain: PingPong;
  readonly taa: TaaPass;
  readonly fxaa: FxaaPass;
  readonly bokeh: BokehPass;
  readonly bloom: BloomPass;
  private readonly final: FinalPass;
  private readonly unjitteredProjection = new Matrix4();
  private readonly size = new Vector2();
  private readonly renderer: WebGLRenderer;
  private readonly lens: WebGLRenderTarget;

  constructor(
    renderer: WebGLRenderer,
    width: number,
    height: number,
    options: PostOptions = {},
  ) {
    this.renderer = renderer;
    this.size.set(width, height);
    this.depthTexture = new DepthTexture(width, height, UnsignedIntType);
    this.depthTexture.format = DepthFormat;
    // Depth is read for reprojection and circle of confusion, never filtered:
    // an interpolated depth is a depth that exists nowhere in the scene.
    this.depthTexture.minFilter = NearestFilter;
    this.depthTexture.magFilter = NearestFilter;

    this.sceneTarget = createRenderTarget(width, height, { depthBuffer: true });
    this.sceneTarget.depthTexture = this.depthTexture;

    this.chain = new PingPong(width, height);
    this.blueNoise = new BlueNoise();
    this.taa = new TaaPass(width, height, this.depthTexture);
    this.fxaa = new FxaaPass(width, height);
    this.bokeh = new BokehPass(width, height, this.depthTexture, options.mobile ?? false);
    this.bloom = new BloomPass(width, height);
    this.final = new FinalPass(this.blueNoise, width, height);
    this.lens = createRenderTarget(LENS_SIZE, LENS_SIZE, { depthBuffer: true });
    this.taa.enabled = !(options.mobile ?? false);
  }

  /** Wipe the grade back to neutral. First thing in the frame (rule 2). */
  resetProfile(): void {
    this.profile.copy(DEFAULT_PROFILE);
  }

  /** A section's partial claim on the grade. */
  blendProfile(profile: PostProfile, weight: number): void {
    this.profile.blend(profile, weight);
  }

  /** Push the accumulated grade into uniforms. Once per frame, after claims. */
  syncProfile(): void {
    const p = this.profile;
    this.bloom.setProfile(p.bloomThreshold, p.bloomSmoothWidth, p.bloomSaturation, p.bloomRadius);
    this.bokeh.setProfile(
      p.bokehAmount, p.bokehFNumber, p.bokehFocusDistance, p.bokehFocalLength, p.bokehFilmHeight,
    );
    this.final.setProfile(p);
  }

  setDither(enabled: boolean): void {
    this.final.setDither(enabled);
  }

  /** Where the magnified render goes. Rendered by the stack, not here — it is
   *  a scene render with an offset frustum, not a post pass. */
  get lensTarget(): WebGLRenderTarget { return this.lens; }

  setLens(x: number, y: number, radius: number, open: number): void {
    this.final.setLens(open > 0.001 ? this.lens.texture : null, x, y, radius, open);
  }

  render(scene: Scene, camera: PerspectiveCamera): void {
    const { renderer } = this;
    const width = this.size.x;
    const height = this.size.y;

    camera.updateMatrixWorld();
    this.unjitteredProjection.copy(camera.projectionMatrix);
    this.taa.captureMatrices(camera, this.unjitteredProjection);
    this.bokeh.setCamera(camera.near, camera.far, camera.fov);
    this.taa.applyJitter(camera, width, height);

    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    // Restore immediately: anything that reads the camera after this frame —
    // DOM locking, raycasting, the next frame's reprojection — must not see
    // a sub-pixel offset baked into the projection.
    camera.projectionMatrix.copy(this.unjitteredProjection);

    let current: Texture = this.sceneTarget.texture;
    current = this.taa.render(renderer, current);

    current = this.fxaa.render(renderer, current, this.chain.write);
    this.chain.swap();

    current = this.bokeh.render(renderer, current, this.chain.write);
    this.chain.swap();

    const bloom = this.bloom.render(renderer, current);

    this.blueNoise.update();
    this.final.render(renderer, current, bloom);
    renderer.setRenderTarget(null);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.size.set(w, h);
    this.sceneTarget.setSize(w, h);
    this.depthTexture.image.width = w;
    this.depthTexture.image.height = h;
    this.depthTexture.needsUpdate = true;
    this.chain.setSize(w, h);
    this.taa.setSize(w, h);
    this.fxaa.setSize(w, h);
    this.bokeh.setSize(w, h);
    this.bloom.setSize(w, h);
    this.final.setSize(w, h);
  }

  dispose(): void {
    this.lens.dispose();
    this.sceneTarget.dispose();
    this.depthTexture.dispose();
    this.chain.dispose();
    this.taa.dispose();
    this.fxaa.dispose();
    this.bokeh.dispose();
    this.bloom.dispose();
    this.final.dispose();
    this.blueNoise.dispose();
  }
}
