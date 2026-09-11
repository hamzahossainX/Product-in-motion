/**
 * One section's claim on the shared 3D state.
 *
 * `preUpdate` writes PARTIAL WEIGHTED CLAIMS ONLY (CLAUDE.md rule 2). Nothing
 * here ever sets an absolute value: the frame has already reset the hero, the
 * gobo and the grade to their defaults, and every section blends over that by
 * its own weight. Two sections visible at once therefore cross-fade
 * automatically, which is the whole reason the scroll reads as one move rather
 * than a sequence of slides.
 *
 * The weight is a window over the section's own ScrollRange: zero before it
 * arrives, one while it owns the frame, zero after it leaves. It has to fall
 * back to zero — a weight that latches at 1 would mean every passed section
 * keeps voting forever, and the last one down the page would always win.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { fit } from '../../lib/math.ts';
import type { ScrollRange } from '../../engine/scroll/ScrollRange.ts';
import type { Hero } from '../Hero.ts';
import type { Gobo } from '../../engine/Gobo.ts';
import type { Postprocessing } from '../../engine/post/Postprocessing.ts';
import type { SectionDefinition } from './sectionData.ts';

/** Where the window opens and closes, in ScrollRange.ratio. The plateau across
 *  the middle is what gives each section a moment that is unambiguously its
 *  own; the ramps are what overlap with its neighbours. */
const RAMP_IN_START = -0.95;
const RAMP_IN_END = -0.3;
const RAMP_OUT_START = 0.3;
const RAMP_OUT_END = 0.95;

/** Per-frame values a section may need. Written once by the render stack, read
 *  by every section — never re-derived, and never measured from the DOM here. */
export interface FrameState {
  scrollPixel: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface SectionContext {
  hero: Hero;
  gobo: Gobo;
  post: Postprocessing;
  camera: PerspectiveCamera;
  frame: FrameState;
}

const scratchPosition = new Vector3();

export class SectionScene {
  readonly id: string;
  readonly range: ScrollRange;
  protected readonly definition: SectionDefinition;
  protected readonly context: SectionContext;
  protected readonly poseQuaternion: Quaternion;
  /** Last weight written. Read by the debug overlay and by the gate harness. */
  weight = 0;

  constructor(definition: SectionDefinition, range: ScrollRange, context: SectionContext) {
    this.id = definition.id;
    this.definition = definition;
    this.range = range;
    this.context = context;
    this.poseQuaternion = new Quaternion().setFromEuler(definition.pose.rotation);
  }

  /** 0 outside this section's travel, 1 while it owns the frame. */
  protected computeWeight(): number {
    const r = this.range.ratio;
    return fit(r, RAMP_IN_START, RAMP_IN_END, 0, 1) *
           fit(r, RAMP_OUT_START, RAMP_OUT_END, 1, 0);
  }

  /** Called once per frame after the reset, before syncProfile. */
  preUpdate(_dt: number): void {
    const weight = this.computeWeight();
    this.weight = weight;
    if (weight <= 0) return;

    const pose = this.definition.pose;
    this.claimPose(scratchPosition.copy(pose.position), this.poseQuaternion, pose.scale, weight);
    this.context.gobo.claim(pose.goboSpeed, pose.goboIntensity, weight);
    this.context.post.blendProfile(this.definition.profile, weight);
  }

  /** The pose position, in a scratch vector a subclass can reuse rather than
   *  allocating one per frame. */
  protected scratchPosition(): Vector3 {
    return scratchPosition.copy(this.definition.pose.position);
  }

  /** Split out so a subclass can move the object without duplicating the
   *  weighting or the claims around it. */
  protected claimPose(
    position: Vector3, quaternion: Quaternion, scale: number, weight: number,
  ): void {
    this.context.hero.claimTransform(position, quaternion, weight, scale);
  }
}
