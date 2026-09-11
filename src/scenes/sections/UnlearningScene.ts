/**
 * The unlearning section: the sheet, and the eraser being dragged over it.
 *
 * Both are placed from the same DOM box, so the pointer's position over that
 * box maps directly onto the sheet's surface and onto where the eraser appears.
 * Without that shared frame the object would drift away from the point the
 * reader is actually rubbing.
 *
 * Everything is still a weighted claim (rule 2). The eraser's position while
 * dragging is claimed at the section's own weight, so approaching or leaving
 * the section blends it back to the pose the table asked for rather than
 * snapping.
 */
import { Quaternion, Vector3 } from 'three';
import { mix } from '../../lib/math.ts';
import { DomGLRect } from '../../engine/scroll/DomGLRect.ts';
import { SecondOrderDynamics3 } from '../../lib/SecondOrderDynamics.ts';
import { depthTo, placeInRect, rectWorldSize } from './domPlacement.ts';
import { SectionScene, type SectionContext } from './SectionScene.ts';
import type { ScrollRange } from '../../engine/scroll/ScrollRange.ts';
import type { SectionDefinition } from './sectionData.ts';
import type { GraphiteText } from '../interactions/GraphiteText.ts';
import type { InteractionState } from '../../lib/InteractionState.ts';

/** The eraser hovers this far off the sheet, and drops onto it when rubbing.
 *  Both are fractions of the sheet's height. */
const HOVER_HEIGHT = 0.55;
const CONTACT_HEIGHT = 0.09;
/** Held small against the sheet. At 0.6 the eraser covered half the page and
 *  the reader could not see what they were rubbing out. */
const ERASER_SCALE = 0.34;

const CONTACT_FREQUENCY = 3.4;
const CONTACT_DAMPING = 0.75;

const scratchSheet = new Vector3();
const scratchTarget = new Vector3();
const scratchAxis = new Vector3();
const scratchSize = { x: 0, y: 0 };

export class UnlearningScene extends SectionScene {
  private readonly anchor: ScrollRange | null;
  private readonly sheet: GraphiteText;
  private readonly interaction: InteractionState;
  private readonly rect = new DomGLRect();
  private readonly eraser = new SecondOrderDynamics3(
    0, 0, 0, CONTACT_FREQUENCY, CONTACT_DAMPING, 0);
  /** Set by the control each frame; 1 while the reader is rubbing. */
  contact = 0;
  /** Where the eraser is over the sheet, 0..1. */
  pointX = 0.5;
  pointY = 0.5;
  /** preUpdate records the frame delta so claimPose, which does not receive
   *  one, can still advance the spring against real time. */
  private frameDelta = 1 / 60;

  constructor(
    definition: SectionDefinition,
    range: ScrollRange,
    context: SectionContext,
    anchor: ScrollRange | null,
    sheet: GraphiteText,
    interaction: InteractionState,
  ) {
    super(definition, range, context);
    this.anchor = anchor;
    this.sheet = sheet;
    this.interaction = interaction;
  }

  protected override claimPose(
    position: Vector3, quaternion: Quaternion, scale: number, weight: number,
  ): void {
    const anchor = this.anchor;
    if (!anchor) {
      super.claimPose(position, quaternion, scale, weight);
      return;
    }

    const { camera, frame } = this.context;
    anchor.fillGLRect(this.rect, frame.scrollPixel, frame.viewportHeight);
    const depth = depthTo(camera, position);
    placeInRect(camera, this.rect, frame, depth, scratchSheet);
    rectWorldSize(camera, this.rect, frame, depth, scratchSize);

    // The sheet fills the box exactly, so the pointer's position over the DOM
    // element and the point on the sheet are the same point.
    this.sheet.mesh.position.copy(scratchSheet);
    this.sheet.mesh.quaternion.copy(camera.quaternion);
    this.sheet.mesh.scale.set(scratchSize.x, scratchSize.x, 1);
    this.sheet.setReveal(weight);

    // The eraser sits over the point being rubbed, in the sheet's own plane,
    // lifted toward the camera by the hover height.
    const e = camera.matrixWorld.elements;
    scratchTarget.copy(scratchSheet);
    scratchAxis.set(e[0]!, e[1]!, e[2]!);                 // camera right
    scratchTarget.addScaledVector(scratchAxis, (this.pointX - 0.5) * scratchSize.x);
    scratchAxis.set(e[4]!, e[5]!, e[6]!);                 // camera up
    scratchTarget.addScaledVector(scratchAxis, (0.5 - this.pointY) * scratchSize.y);
    scratchAxis.set(e[8]!, e[9]!, e[10]!);                // camera backward
    scratchTarget.addScaledVector(
      scratchAxis, mix(HOVER_HEIGHT, CONTACT_HEIGHT, this.contact) * scratchSize.y);

    const settled = this.eraser.update(
      this.frameDelta, scratchTarget.x, scratchTarget.y, scratchTarget.z);
    scratchTarget.set(settled.x, settled.y, settled.z);

    super.claimPose(scratchTarget, quaternion, scale * ERASER_SCALE, weight);
  }

  override preUpdate(dt: number): void {
    this.frameDelta = dt;
    super.preUpdate(dt);
    // Softer grades leave more of a ghost behind.
    this.sheet.setSmudge(mix(0.55, 0.12, this.interaction.hardness));
  }
}
