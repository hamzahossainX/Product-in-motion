/**
 * Builds the section scenes from the measured DOM.
 *
 * `scenes/` and `sections/` never import each other (CLAUDE.md rule 4); they
 * meet here, and all they exchange is a ScrollRange.
 */
import { SECTIONS } from './sectionData.ts';
import { SectionScene, type SectionContext } from './SectionScene.ts';
import { AnchoredScene } from './AnchoredScene.ts';
import type { ScrollRange } from '../../engine/scroll/ScrollRange.ts';

/**
 * Anchors are declared on the element, not derived from its id.
 *
 * An id convention looked tidier and quietly failed the moment a section's
 * anchor was also something else — the unlearning sheet is the drag surface
 * first and the anchor second, and it is not called `unlearning-object-anchor`.
 * An attribute says what the element is for.
 */
export const ANCHOR_ATTRIBUTE = 'data-gl-anchor';
export const ANCHOR_SELECTOR = `[${ANCHOR_ATTRIBUTE}]`;

export function createSectionScenes(
  ranges: Map<string, ScrollRange>,
  context: SectionContext,
  anchors: Map<string, ScrollRange>,
): SectionScene[] {
  const scenes: SectionScene[] = [];
  for (const definition of SECTIONS) {
    const range = ranges.get(definition.id);
    if (!range) continue;
    const anchor = anchors.get(definition.id) ?? null;
    // Sections without an anchor — the macro close-up and the footer — are
    // meant to fill or to leave the frame, and a layout box would fight that.
    scenes.push(anchor
      ? new AnchoredScene(definition, range, context, anchor)
      : new SectionScene(definition, range, context));
  }
  return scenes;
}

export { SectionScene, AnchoredScene };
export type { SectionContext };
