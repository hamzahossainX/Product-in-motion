/**
 * Renderer, stage, gobo and post chain, assembled.
 *
 * Exists so App owns one 3D object instead of six, and so a machine with no
 * usable WebGL context fails at exactly one place: `tryCreate` returns null and
 * the site runs as the static page it was in Phase 1.
 *
 * `draw` is the second half of the reset-then-claim sequence in rule 2. The
 * reset and the claims happen in App.tick, above this call.
 */
import { disposeTriangle } from './FboHelper.ts';
import { CameraController } from './CameraController.ts';
import { createEnvironment } from './Environment.ts';
import { Gobo } from './Gobo.ts';
import { Loader } from './Loader.ts';
import { Pointer } from './Pointer.ts';
import { Magnifier } from './Magnifier.ts';
import { InteractionBridge } from './InteractionBridge.ts';
import { DeviceTilt } from './DeviceTilt.ts';
import { Postprocessing } from './post/Postprocessing.ts';
import { Renderer } from './Renderer.ts';
import { createSharedUniforms, type SharedUniforms } from './SharedUniforms.ts';
import { Stage } from './Stage.ts';
import { CameraRig, KeyframeCameraPath, BakedCameraPath, type CameraPath } from './CameraRig.ts';
import { CAMERA_KEYFRAMES, SECTIONS } from '../scenes/sections/sectionData.ts';
import { createSectionScenes, type SectionScene, type SectionContext } from '../scenes/sections/index.ts';
import type { ScrollRange } from './scroll/ScrollRange.ts';
import { GraphiteText } from '../scenes/interactions/GraphiteText.ts';
import { UnlearningScene } from '../scenes/sections/UnlearningScene.ts';
import { HardnessScene } from '../scenes/sections/HardnessScene.ts';
import { createInteractionState, type InteractionState } from '../lib/InteractionState.ts';

/** Rough cost weights for the preloader, in notional bytes. */
const ENVIRONMENT_WEIGHT = 220 * 1024;
const GEOMETRY_WEIGHT = 180 * 1024;
const CAMERA_BAKE_WEIGHT = 90 * 1024;
const CAMERA_BAKE_URL = `${import.meta.env.BASE_URL}models/camera-path.json`;
/**
 * Whether to go looking for a baked camera path at all.
 *
 * There is no bake in the repository yet, and fetching one that is not there
 * costs a 404 in the console of every visitor. `BakedCameraPath.load` handles
 * the miss correctly and falls through to the keyframe path, but a failed
 * request is logged by the browser before any of our code sees it, and this is
 * a site whose audience opens the console.
 *
 * So the seam is opt-in: drop the bake into public/models and set
 * VITE_CAMERA_BAKE=1. The loader entry stays registered either way, so the
 * preloader's weighting — and the timing gate 6 measures — does not change.
 */
const CAMERA_BAKE_ENABLED = import.meta.env['VITE_CAMERA_BAKE'] === '1';


export class RenderStack {
  readonly renderer: Renderer;
  readonly stage: Stage;
  readonly post: Postprocessing;
  readonly gobo: Gobo;
  readonly pointer = new Pointer();
  readonly mobile: boolean;
  readonly tilt: DeviceTilt | null = null;
  readonly camera = new CameraController();
  readonly loader: Loader;
  readonly shared: SharedUniforms;
  readonly rig: CameraRig;
  readonly interaction: InteractionState = createInteractionState();
  readonly graphite: GraphiteText;
  /** Written by the unlearning control each frame; 1 while rubbing. */
  eraseContact = 0;
  erasePointX = 0.5;
  erasePointY = 0.5;
  /** Swapped in place if a bake arrives, so the rig never re-binds. */
  private readonly pathRef: { current: CameraPath };
  private scenes: SectionScene[] = [];
  private unlearning: UnlearningScene | null = null;
  readonly bridge = new InteractionBridge();
  readonly magnifier = new Magnifier();
  private readonly frame = { scrollPixel: 0, viewportWidth: 0, viewportHeight: 0 };
  /** Wall-clock cost of the last draw, for the stats panel. */
  lastFrameMs = 0;

  private elapsed = 0;
  private motionEnabled = true;
  private lastDevicePixelRatio = window.devicePixelRatio || 1;

  private constructor(renderer: Renderer, mobile: boolean) {
    this.renderer = renderer;
    this.mobile = mobile;
    if (mobile) {
      this.tilt = new DeviceTilt();
      this.camera.tilt = this.tilt;
    }
    const { x, y } = renderer.drawingBufferSize;

    this.shared = createSharedUniforms();
    this.post = new Postprocessing(renderer.gl, x, y, { mobile });
    this.loader = new Loader(mobile);
    this.gobo = new Gobo(this.shared);
    this.stage = new Stage(this.post.blueNoise, this.shared, x, y, mobile);
    this.graphite = new GraphiteText(this.shared);
    this.stage.world.add(this.graphite.mesh);

    // Both are real startup cost and both are registered, so the Phase 6
    // preloader reflects work rather than a count of files.
    this.loader.add('environment', ENVIRONMENT_WEIGHT, () => {
      this.stage.setEnvironment(createEnvironment(renderer.gl));
      // Compile every material now, behind the preloader, rather than the
      // first time each is drawn. Lazy compilation put two 33 ms frames into a
      // full-page scroll — the sheet and the magnifier are not encountered
      // until the reader is already moving.
      renderer.gl.compile(this.stage.scene, this.stage.camera);
    });
    this.loader.add('geometry', GEOMETRY_WEIGHT, () => { /* built in Stage */ });

    // A baked camera beats anything procedural, so the loader always looks for
    // one. Until a bake exists the fetch fails and the keyframe path stays —
    // dropping a file into public/models is the whole integration.
    this.pathRef = { current: new KeyframeCameraPath(CAMERA_KEYFRAMES) };
    this.rig = new CameraRig(this.pathRef);
    this.loader.add('camera-bake', CAMERA_BAKE_WEIGHT, async () => {
      if (!CAMERA_BAKE_ENABLED) return;
      const baked = new BakedCameraPath();
      if (await baked.load(CAMERA_BAKE_URL)) this.pathRef.current = baked;
    });
  }

  static tryCreate(): RenderStack | null {
    try {
      const mobile = RenderStack.isMobile();
      return new RenderStack(new Renderer(mobile), mobile);
    } catch (error) {
      console.warn('WebGL unavailable; falling back to the static page.', error);
      return null;
    }
  }

  /** Hands the measured DOM to the sections and the camera path. */
  bindSections(ranges: Map<string, ScrollRange>, anchors: Map<string, ScrollRange>): void {
    const context: SectionContext = {
      hero: this.stage.hero,
      gobo: this.gobo,
      post: this.post,
      camera: this.stage.camera,
      frame: this.frame,
    };
    this.scenes = createSectionScenes(ranges, context, anchors);

    // Two sections need more than the table gives them, so they are built here
    // rather than in the generic factory.
    const replace = (id: string, make: (
      definition: (typeof SECTIONS)[number], range: ScrollRange) => SectionScene): SectionScene | null => {
      const range = ranges.get(id);
      const definition = SECTIONS.find((d) => d.id === id);
      if (!range || !definition) return null;
      const scene = make(definition, range);
      const index = this.scenes.findIndex((existing) => existing.id === id);
      if (index >= 0) this.scenes[index] = scene;
      else this.scenes.push(scene);
      return scene;
    };

    this.unlearning = replace('unlearning', (definition, range) => new UnlearningScene(
      definition, range, context, anchors.get('unlearning') ?? null,
      this.graphite, this.interaction)) as UnlearningScene | null;
    replace('hardness', (definition, range) =>
      new HardnessScene(definition, range, context, this.interaction));
  }

  get sectionScenes(): readonly SectionScene[] { return this.scenes; }

  /**
   * The claim half of rule 2. Runs after the frame's resets and before
   * syncProfile: every section writes a partial weighted claim, nothing writes
   * an absolute value, and overlapping sections blend rather than cut.
   */
  claim(dt: number, scrollPixel: number, progress: number): void {
    this.frame.scrollPixel = scrollPixel;
    this.frame.viewportWidth = this.renderer.viewportSize.x;
    this.frame.viewportHeight = this.renderer.viewportSize.y;
    // Order matters here. The rig writes the base pose, the controller layers
    // parallax and drift onto the camera itself, and only then do the sections
    // read it — because a DOM-locked object is placed against the camera's
    // basis, and using last frame's would lag the object behind the box it is
    // supposed to be locked to during fast scrolling.
    // Rule 2: the sheet is claimed by its section like everything else, so it
    // is wiped here and only the unlearning section brings it back.
    this.graphite.resetReveal();
    this.bridge.update(dt, this.interaction, this.stage.hero, this.graphite);
    if (this.unlearning) {
      this.unlearning.contact = this.eraseContact;
      this.unlearning.pointX = this.erasePointX;
      this.unlearning.pointY = this.erasePointY;
    }

    this.pointer.update(dt);
    this.tilt?.update(dt);
    this.rig.update(this.stage.camera, this.camera, progress);
    this.camera.update(this.stage.camera, dt, this.pointer);
    this.stage.camera.updateMatrixWorld();
    for (let i = 0; i < this.scenes.length; i++) this.scenes[i]!.preUpdate(dt);
  }

  /** The abrasion section's weight, which is what opens the lens. */
  magnifierWeight(): number {
    for (let i = 0; i < this.scenes.length; i++) {
      if (this.scenes[i]!.id === 'abrasion') return this.scenes[i]!.weight;
    }
    return 0;
  }

  /** Coarse pointer plus a narrow viewport: the Phase 8 mobile render tier. */
  static isMobile(): boolean {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  /** Both dither sites at once: the gradient's own, and the final output's. */
  setDither(enabled: boolean): void {
    this.post.setDither(enabled);
    this.stage.background.setDither(enabled);
  }

  /**
   * Reduced motion, everywhere at once.
   *
   * The scene keeps rendering — the requirement is a still page that still
   * looks like the site, not a blank one. What stops is everything that moves
   * on its own: the camera's parallax and drift, the gobo's crawl, the hero's
   * idle wander, and the dust, which all read from the same clock.
   */
  setMotionEnabled(enabled: boolean): void {
    this.motionEnabled = enabled;
    this.camera.motionEnabled = enabled;
    this.stage.hero.driftEnabled = enabled;
    this.gobo.motionEnabled = enabled;
  }

  draw(dt: number): void {
    // The resolution media query catches a display change on every browser
    // that fires it; this catches the ones that do not. Reading
    // devicePixelRatio costs nothing and forces no layout.
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.lastDevicePixelRatio) {
      this.lastDevicePixelRatio = dpr;
      this.resize();
    }

    const start = performance.now();
    // The dust and the cookie both read this clock, so holding it still is what
    // freezes them — no per-system flag needed.
    if (this.motionEnabled) this.elapsed += dt;
    this.shared.u_time.value = this.elapsed;

    // The pointer and the camera have already advanced in claim(), above.
    this.shared.u_pointer.value.set(this.pointer.x, this.pointer.y);
    this.gobo.update(this.renderer.gl, dt, this.pointer, this.elapsed);
    this.stage.hero.update(dt);
    this.shared.u_heroPosition.value.copy(this.stage.hero.object.position);

    this.graphite.update(this.renderer.gl);

    this.renderer.resetInfo();
    this.magnifier.x = this.interaction.magnifierX;
    this.magnifier.y = this.interaction.magnifierY;
    this.magnifier.update(dt, this.magnifierWeight(), this.renderer.gl, this.post,
      this.stage.scene, this.stage.camera,
      this.renderer.viewportSize.x, this.renderer.viewportSize.y);
    this.post.render(this.stage.scene, this.stage.camera);
    this.lastFrameMs = performance.now() - start;
  }

  resize(): void {
    this.renderer.resize();
    const { x, y } = this.renderer.drawingBufferSize;
    this.post.setSize(x, y);
    this.stage.setSize(x, y);
  }

  dispose(): void {
    disposeTriangle();
    this.pointer.destroy();
    this.tilt?.destroy();
    this.graphite.dispose();
    this.gobo.dispose();
    this.post.dispose();
    this.stage.dispose();
    this.renderer.destroy();
  }
}
