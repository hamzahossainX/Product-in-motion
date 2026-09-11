/**
 * The hardness section: a slider that changes how the scene is lit and graded.
 *
 * CONCEPT.md asks for the grade to shift "cooler and harder toward 2H, warmer
 * and softer toward 2B". Changing only the object's roughness was technically a
 * response and visually almost nothing — 0.08% of the frame — because the
 * object is a small part of a wide shot. The grade is what carries it.
 *
 * "Cooler" here is relative, not literal: the palette has no blue in it (rule
 * 15), so 2H moves toward a pale neutral cream and 2B toward cedar and ochre.
 * The whole thing is still a weighted claim — the shift only applies where this
 * section owns the frame.
 */
import { mix } from '../../lib/math.ts';
import { PostProfile } from '../../engine/post/PostProfile.ts';
import { SectionScene, type SectionContext } from './SectionScene.ts';
import type { ScrollRange } from '../../engine/scroll/ScrollRange.ts';
import type { SectionDefinition } from './sectionData.ts';
import type { InteractionState } from '../../lib/InteractionState.ts';

/** Aggressive 2B: warm, soft, generous bloom, low contrast. */
const SOFT = new PostProfile({
  bloomAmount: 2.2, bloomThreshold: 0.24, bloomRadius: 0.46, bloomSaturation: 1.35,
  contrast: -0.1, saturation: 1.14, brightness: 1.04,
  tintColorHex: '#C89A5B', tintOpacity: 0.05,
  vignetteFrom: 1.35, vignetteTo: 2.6,
});

/** Precise 2H: pale, hard, bloom pulled back, contrast up. */
const HARD = new PostProfile({
  bloomAmount: 0.55, bloomThreshold: 0.62, bloomRadius: 0.14, bloomSaturation: 0.85,
  contrast: 0.3, saturation: 0.9, brightness: 0.97,
  tintColorHex: '#F4EADB', tintOpacity: 0.035,
  vignetteFrom: 1.8, vignetteTo: 3,
});

const GOBO_SPEED_SOFT = 2.2;
const GOBO_SPEED_HARD = 4.4;
const GOBO_INTENSITY_SOFT = 1.75;
const GOBO_INTENSITY_HARD = 0.95;

export class HardnessScene extends SectionScene {
  private readonly interaction: InteractionState;
  /** Blended in place each frame; allocating a profile per frame would be an
   *  allocation per frame (rule 17). */
  private readonly graded = new PostProfile();

  constructor(
    definition: SectionDefinition,
    range: ScrollRange,
    context: SectionContext,
    interaction: InteractionState,
  ) {
    super(definition, range, context);
    this.interaction = interaction;
  }

  override preUpdate(_dt: number): void {
    const weight = this.computeWeight();
    this.weight = weight;
    if (weight <= 0) return;

    const hardness = this.interaction.hardness;
    const pose = this.definition.pose;

    this.claimPose(
      this.scratchPosition(), this.poseQuaternion, pose.scale, weight);
    this.context.gobo.claim(
      mix(GOBO_SPEED_SOFT, GOBO_SPEED_HARD, hardness),
      mix(GOBO_INTENSITY_SOFT, GOBO_INTENSITY_HARD, hardness),
      weight);

    this.graded.copy(SOFT).blend(HARD, hardness);
    this.context.post.blendProfile(this.graded, weight);
  }
}
