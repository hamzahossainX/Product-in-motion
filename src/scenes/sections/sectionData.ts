/**
 * The eight scroll moments, as data.
 *
 * One entry per section in SPEC.md: where the camera goes, how the object is
 * posed, what the gobo does, and the colour grade. Keeping it as a table rather
 * than eight near-identical classes means a section's whole behaviour is
 * readable in one screen, and the numbers can be tuned against the `?debug=1`
 * GUI without hunting through files. Sections that grow real behaviour in
 * Phase 7 subclass SectionScene; the table stays their data.
 *
 * Every profile below is a full profile — see PostProfile — so a section that
 * only cares about bloom still pulls everything else back toward the default it
 * is blended over.
 */
import { Euler, Vector3 } from 'three';
import { PostProfile, type PostProfileInit } from '../../engine/post/PostProfile.ts';
import type { CameraKeyframe } from '../../engine/CameraRig.ts';

export interface SectionPose {
  /** Where the hero sits when this section owns the frame. */
  position: Vector3;
  rotation: Euler;
  scale: number;
  /** Cookie units per second, and how hard the projected light reads. */
  goboSpeed: number;
  goboIntensity: number;
}

export interface SectionDefinition {
  id: string;
  pose: SectionPose;
  profile: PostProfile;
}

/**
 * A tint at 1.5% opacity.
 *
 * Consciously invisible, unconsciously felt — the difference between a scene
 * that was rendered and one that was graded. Anything strong enough to name as
 * a colour is too strong.
 */
const TINT = 0.015;

function define(
  id: string, pose: SectionPose, profile: PostProfileInit,
): SectionDefinition {
  return { id, pose, profile: new PostProfile(profile) };
}

export const SECTIONS: SectionDefinition[] = [
  // 1 — HERO. Floating centre, clean and slightly lifted.
  define('hero', {
    position: new Vector3(0, -0.02, 0),
    rotation: new Euler(0.15, -0.68, 0.05),
    scale: 1,
    goboSpeed: 4,
    goboIntensity: 1.5,
  }, {
    bloomAmount: 1.4, bloomThreshold: 0.32, bloomSaturation: 1.1,
    tintColorHex: '#E4735C', tintOpacity: TINT,
    vignetteFrom: 1.5, vignetteTo: 2.6,
  }),

  // 2 — STATEMENT. Orbit to present the worn edge; warmer, bloom rising.
  define('statement', {
    position: new Vector3(0.1, 0.05, 0.15),
    rotation: new Euler(0.05, -2.05, -0.04),
    scale: 1.04,
    goboSpeed: 3.2,
    goboIntensity: 1.75,
  }, {
    bloomAmount: 2.1, bloomThreshold: 0.28, bloomSaturation: 1.25,
    tintColorHex: '#C89A5B', tintOpacity: TINT * 1.4,
    saturation: 1.04, vignetteFrom: 1.3, vignetteTo: 2.4,
  }),

  // 3 — UNLEARNING. Overhead, paper filling frame. Neutral and clear.
  define('unlearning', {
    position: new Vector3(0, 0.12, 0.4),
    rotation: new Euler(-0.06, -0.28, 0.02),
    scale: 0.98,
    goboSpeed: 2.2,
    goboIntensity: 1.15,
  }, {
    bloomAmount: 0.5, bloomThreshold: 0.55, bloomSaturation: 1,
    contrast: 0.12, saturation: 0.96,
    tintColorHex: '#F4EADB', tintOpacity: TINT * 0.8,
    vignetteFrom: 1.9, vignetteTo: 3,
  }),

  // 4 — ABRASION. Extreme close-up; shallow depth of field, bloom to zero.
  define('abrasion', {
    position: new Vector3(-0.06, 0.02, 0.1),
    rotation: new Euler(0.02, -1.15, 0.01),
    scale: 1,
    goboSpeed: 1.4,
    goboIntensity: 0.95,
  }, {
    // CONCEPT.md gives 0.75 for the focus distance. That was for its own
    // camera; this one sits 1.5 units off the surface, and focusing at 0.75
    // puts the plane in front of the object so the entire frame is soft. The
    // number that matters is the one that lands on the surface.
    bloomAmount: 0, bokehAmount: 1, bokehFocusDistance: 1.45, bokehFNumber: 0.12,
    contrast: 0.18, saturation: 0.94,
    tintColorHex: '#6B6259', tintOpacity: TINT * 1.6,
    vignetteFrom: 1.2, vignetteTo: 2.5,
  }),

  // 5 — HARDNESS. Mid and held. Phase 7's slider drives this cooler or warmer.
  define('hardness', {
    position: new Vector3(0.04, 0, 0),
    rotation: new Euler(0.2, -0.95, -0.08),
    scale: 1.02,
    goboSpeed: 3,
    goboIntensity: 1.35,
  }, {
    bloomAmount: 1.2, bloomThreshold: 0.34,
    tintColorHex: '#C89A5B', tintOpacity: TINT,
    saturation: 1.02, vignetteFrom: 1.6, vignetteTo: 2.8,
  }),

  // 6 — SHOWCASE. Widest move on the page, hottest grade.
  define('showcase', {
    position: new Vector3(0, 0.16, -0.2),
    rotation: new Euler(-0.3, -3.6, 0.22),
    scale: 1.1,
    goboSpeed: 6.5,
    goboIntensity: 2.1,
  }, {
    // CONCEPT.md asks for the hottest profile on the page, and bloomAmount 6
    // is its number. The threshold is what keeps it from being a white
    // lozenge: at 0.22 the object's whole diffuse surface blooms and the form
    // disappears; at 0.8 only the specular rim does, which is hotter to look
    // at and still an eraser.
    bloomAmount: 6, bloomSaturation: 2, bloomThreshold: 0.8, bloomRadius: 0.42,
    saturation: 1.1, brightness: 1.05,
    tintColorHex: '#E4735C', tintOpacity: TINT * 2,
    vignetteFrom: 1.1, vignetteTo: 2.4,
  }),

  // 7 — CONFIGURATOR. Product-lit, mid. Phase 7 swaps the variant here.
  define('configurator', {
    position: new Vector3(0, -0.04, 0.25),
    rotation: new Euler(0.12, -5.1, 0.03),
    scale: 1,
    goboSpeed: 2.6,
    goboIntensity: 1.25,
  }, {
    bloomAmount: 1, bloomThreshold: 0.4,
    contrast: 0.06, saturation: 1,
    tintColorHex: '#F4EADB', tintOpacity: TINT * 0.6,
    vignetteFrom: 1.7, vignetteTo: 3,
  }),

  // 8 — PAPER. The object settles; shallow depth of field, bloom to zero.
  define('paper', {
    position: new Vector3(0, -0.1, 0),
    rotation: new Euler(0.08, -6.1, 0),
    scale: 0.96,
    goboSpeed: 1.6,
    goboIntensity: 0.9,
  }, {
    bloomAmount: 0.2, bokehAmount: 0.85, bokehFocusDistance: 4.2,
    contrast: 0.04, saturation: 0.97,
    tintColorHex: '#2E2620', tintOpacity: TINT * 1.2,
    vignetteFrom: 1.2, vignetteTo: 2.6,
  }),

  // 9 — FOOTER. Final rest. Nothing left to look at but the copy.
  define('footer', {
    position: new Vector3(0, -0.22, -0.1),
    rotation: new Euler(0.05, -6.4, 0),
    scale: 0.9,
    goboSpeed: 1.1,
    goboIntensity: 0.7,
  }, {
    bloomAmount: 0, bokehAmount: 1, bokehFocusDistance: 2.4,
    brightness: 0.88, saturation: 0.92,
    tintColorHex: '#2E2620', tintOpacity: TINT * 1.6,
    vignetteFrom: 0.9, vignetteTo: 2.2,
  }),
];

/**
 * The camera path.
 *
 * One continuous move: push in through the hero, orbit for the statement, drop
 * overhead onto the paper, dive to the macro, pull back for the widest moment
 * of the page, then settle. Positions are anchored to the sections above by id.
 */
export const CAMERA_KEYFRAMES: CameraKeyframe[] = [
  { section: 'hero', position: new Vector3(0, 1.15, 5.6), lookAt: new Vector3(0, -0.1, 0), fov: 35 },
  { section: 'statement', position: new Vector3(2.4, 1.05, 4.3), lookAt: new Vector3(0.1, -0.05, 0), fov: 33 },
  { section: 'unlearning', position: new Vector3(1.1, 3.5, 1.9), lookAt: new Vector3(0, -0.35, 0), fov: 38 },
  { section: 'abrasion', position: new Vector3(-0.75, 0.42, 1.25), lookAt: new Vector3(0.15, -0.05, 0.1), fov: 26 },
  { section: 'hardness', position: new Vector3(-2.5, 1.0, 3.9), lookAt: new Vector3(0, -0.05, 0), fov: 32 },
  { section: 'showcase', position: new Vector3(-3.4, 2.6, 8.2), lookAt: new Vector3(0, 0.05, 0), fov: 42 },
  { section: 'configurator', position: new Vector3(1.6, 0.9, 4.6), lookAt: new Vector3(0, -0.05, 0), fov: 34 },
  { section: 'paper', position: new Vector3(0.6, 2.1, 4.0), lookAt: new Vector3(0, -0.4, 0), fov: 36 },
  { section: 'footer', position: new Vector3(0, 1.35, 5.2), lookAt: new Vector3(0, -0.5, 0), fov: 38 },
];
