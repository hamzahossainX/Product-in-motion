/**
 * What the controls publish and the scenes read.
 *
 * `sections/` and `scenes/` never import each other (CLAUDE.md rule 4). They
 * share this, and nothing else. It is plain data with no behaviour, written by
 * DOM event handlers and read by the frame loop — which is also the rule that
 * interaction state lives outside the render loop and the loop only reads it.
 */

export interface EraseStroke {
  /** Normalised sheet coordinates, 0..1, origin top left. */
  x: number;
  y: number;
  /** Radius as a fraction of the sheet's width. */
  radius: number;
  /** 0..1. A slow drag removes more than a fast one, like a real eraser. */
  strength: number;
}

export interface InteractionState {
  /** 0 is Aggressive 2B, 0.5 Balanced HB, 1 Precise 2H. */
  hardness: number;
  /** 0 ERASER, 1 ERASER Pro, 2 ERASER Pro Max. */
  variant: number;
  /** Bumped on every change so the scene can start a transition. */
  variantVersion: number;
  /** Magnifier centre in normalised screen space, plus how open the lens is. */
  magnifierX: number;
  magnifierY: number;
  magnifierOpen: number;
  /** What the reader typed. */
  text: string;
  /** Bumped when `text` changes, so the scene re-rasterises once per change
   *  rather than comparing strings every frame. */
  textVersion: number;
  /** Drained by the scene each frame. Strokes are queued rather than applied
   *  directly because a pointer can fire several moves between two frames and
   *  every one of them has to be painted, not just the last. */
  eraseQueue: EraseStroke[];
  /** Bumped when the reader asks for a clean sheet. */
  clearVersion: number;
}

export function createInteractionState(): InteractionState {
  return {
    hardness: 0.5,
    variant: 0,
    variantVersion: 0,
    magnifierX: 0.5,
    magnifierY: 0.5,
    magnifierOpen: 0,
    text: '',
    textVersion: 0,
    eraseQueue: [],
    clearVersion: 0,
  };
}

/** The three grades, in the order the slider presents them. */
export const HARDNESS_STOPS = [
  { label: 'Aggressive 2B', abrasion: 0.86 },
  { label: 'Balanced HB', abrasion: 0.62 },
  { label: 'Precise 2H', abrasion: 0.34 },
] as const;

/** The model family, matching the comparison table in the markup. */
export const VARIANTS = [
  { id: 'eraser', name: 'ERASER', scale: 1, wear: 1 },
  { id: 'pro', name: 'ERASER Pro', scale: 1.32, wear: 0.55 },
  { id: 'pro-max', name: 'ERASER Pro Max', scale: 1.9, wear: 0.15 },
] as const;
