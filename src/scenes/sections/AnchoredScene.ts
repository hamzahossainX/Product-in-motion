/**
 * A section whose object position is decided by the layout, not by the scene.
 *
 * CLAUDE.md rule 3: the DOM drives the 3D. Each of these sections has an empty
 * anchor box in its markup, positioned by CSS in whatever part of its grid the
 * copy leaves free; this reads that box's rect and places the eraser inside it.
 * The object therefore tracks exactly through scroll, resize and a change of
 * breakpoint, and — the reason it exists — never lands on top of the copy.
 * A hard-coded world position per section cannot do that: the position that
 * clears the text at 1920 covers it at 1024.
 *
 * The rect comes from the same cached measurement every ScrollRange uses, so
 * this costs no DOM reads per frame. And the placement is still a weighted
 * claim, not an absolute write: it goes through claimPose like every other
 * section, so each handover is a blend rather than a cut.
 */
import { Quaternion, Vector3 } from 'three';
import { clamp } from '../../lib/math.ts';
import { DomGLRect } from '../../engine/scroll/DomGLRect.ts';
import { depthTo, placeInRect, rectWorldSize } from './domPlacement.ts';
import { SectionScene, type SectionContext } from './SectionScene.ts';
import type { ScrollRange } from '../../engine/scroll/ScrollRange.ts';
import type { SectionDefinition } from './sectionData.ts';

/** Fraction of the anchor box the object's bounding sphere fills. Under 1 so
 *  the bloom and the dust have somewhere to go. */
const FILL = 0.74;
/** The object never gets absurd, whatever the layout does. */
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;

const scratchPosition = new Vector3();
const scratchSize = { x: 0, y: 0 };

export class AnchoredScene extends SectionScene {
  private readonly anchor: ScrollRange | null;
  private readonly rect = new DomGLRect();

  constructor(
    definition: SectionDefinition,
    range: ScrollRange,
    context: SectionContext,
    anchor: ScrollRange | null,
  ) {
    super(definition, range, context);
    this.anchor = anchor;
  }

  protected override claimPose(
    position: Vector3, quaternion: Quaternion, scale: number, weight: number,
  ): void {
    const anchor = this.anchor;
    if (!anchor) {
      super.claimPose(position, quaternion, scale, weight);
      return;
    }

    const { camera, frame, hero } = this.context;
    anchor.fillGLRect(this.rect, frame.scrollPixel, frame.viewportHeight);

    // Depth is taken from the pose the table asked for, so the DOM decides
    // where on screen the object sits and the section still decides how far
    // away it is.
    const depth = depthTo(camera, position);
    placeInRect(camera, this.rect, frame, depth, scratchPosition);
    rectWorldSize(camera, this.rect, frame, depth, scratchSize);

    // Bounding sphere, not width: the object is rotating, and a width match
    // would make it breathe as it turns.
    const boxWorld = Math.min(scratchSize.x, scratchSize.y);
    const radius = hero.boundingRadius;
    const fitted = radius > 0
      ? clamp((boxWorld * FILL) / (radius * 2), MIN_SCALE, MAX_SCALE)
      : scale;

    super.claimPose(scratchPosition, quaternion, fitted, weight);
  }
}
