/**
 * The colour grade, as data.
 *
 * A profile is a complete set of grading parameters, never a partial one, so
 * that `blend(other, weight)` always has both endpoints and a section that
 * declares only `bloomAmount` still pulls every other parameter toward the
 * default it inherits. That is what makes CLAUDE.md rule 2 work: the frame
 * starts at DEFAULT_PROFILE and each section blends a partial weight over it,
 * so two overlapping sections cross-fade instead of one winning outright.
 */
import { Color } from 'three';

export interface PostProfileInit {
  bloomAmount?: number;
  bloomThreshold?: number;
  bloomRadius?: number;
  bloomSmoothWidth?: number;
  bloomSaturation?: number;
  bokehAmount?: number;
  bokehFNumber?: number;
  bokehFocusDistance?: number;
  bokehFocalLength?: number;
  bokehFilmHeight?: number;
  vignetteFrom?: number;
  vignetteTo?: number;
  vignetteColorHex?: string;
  saturation?: number;
  contrast?: number;
  brightness?: number;
  tintColorHex?: string;
  tintOpacity?: number;
}

export const PROFILE_DEFAULTS = {
  bloomAmount: 1,
  bloomThreshold: 0.3,
  bloomRadius: 0.25,
  bloomSmoothWidth: 0.75,
  bloomSaturation: 1,
  bokehAmount: 0,
  bokehFNumber: 0.181,
  bokehFocusDistance: 4.5,
  bokehFocalLength: 0.344,
  bokehFilmHeight: 19.26,
  vignetteFrom: 2,
  vignetteTo: 3,
  vignetteColorHex: '#000000',
  saturation: 1,
  contrast: 0,
  brightness: 1,
  tintColorHex: '#E4735C',
  tintOpacity: 0,
} as const;

/** Numeric parameter names, in one place, so blending and the GUI cannot drift
 *  apart when a parameter is added. */
export const PROFILE_NUMBER_KEYS = [
  'bloomAmount', 'bloomThreshold', 'bloomRadius', 'bloomSmoothWidth', 'bloomSaturation',
  'bokehAmount', 'bokehFNumber', 'bokehFocusDistance', 'bokehFocalLength', 'bokehFilmHeight',
  'vignetteFrom', 'vignetteTo', 'saturation', 'contrast', 'brightness', 'tintOpacity',
] as const;

export type ProfileNumberKey = (typeof PROFILE_NUMBER_KEYS)[number];

export class PostProfile {
  bloomAmount = PROFILE_DEFAULTS.bloomAmount;
  bloomThreshold = PROFILE_DEFAULTS.bloomThreshold;
  bloomRadius = PROFILE_DEFAULTS.bloomRadius;
  bloomSmoothWidth = PROFILE_DEFAULTS.bloomSmoothWidth;
  bloomSaturation = PROFILE_DEFAULTS.bloomSaturation;
  bokehAmount = PROFILE_DEFAULTS.bokehAmount;
  bokehFNumber = PROFILE_DEFAULTS.bokehFNumber;
  bokehFocusDistance = PROFILE_DEFAULTS.bokehFocusDistance;
  bokehFocalLength = PROFILE_DEFAULTS.bokehFocalLength;
  bokehFilmHeight = PROFILE_DEFAULTS.bokehFilmHeight;
  vignetteFrom = PROFILE_DEFAULTS.vignetteFrom;
  vignetteTo = PROFILE_DEFAULTS.vignetteTo;
  saturation = PROFILE_DEFAULTS.saturation;
  contrast = PROFILE_DEFAULTS.contrast;
  brightness = PROFILE_DEFAULTS.brightness;
  tintOpacity = PROFILE_DEFAULTS.tintOpacity;

  readonly vignetteColor = new Color(PROFILE_DEFAULTS.vignetteColorHex);
  readonly tintColor = new Color(PROFILE_DEFAULTS.tintColorHex);

  constructor(init: PostProfileInit = {}) {
    this.set(init);
  }

  /** Indexing a union of keys narrows the write type to `never`. This is the
   *  same object, viewed as the record it structurally already is. */
  private get numbers(): Record<ProfileNumberKey, number> {
    return this as Record<ProfileNumberKey, number>;
  }

  set(init: PostProfileInit): this {
    const numbers = this.numbers;
    // Indexed loops, not for...of: an array iterator is an allocation, and
    // copy() and blend() below run every frame (rule 17).
    for (let i = 0; i < PROFILE_NUMBER_KEYS.length; i++) {
      const key = PROFILE_NUMBER_KEYS[i]!;
      const value = init[key];
      if (value !== undefined) numbers[key] = value;
    }
    if (init.vignetteColorHex !== undefined) this.vignetteColor.set(init.vignetteColorHex);
    if (init.tintColorHex !== undefined) this.tintColor.set(init.tintColorHex);
    return this;
  }

  copy(other: PostProfile): this {
    const numbers = this.numbers;
    for (let i = 0; i < PROFILE_NUMBER_KEYS.length; i++) {
      const key = PROFILE_NUMBER_KEYS[i]!;
      numbers[key] = other[key];
    }
    this.vignetteColor.copy(other.vignetteColor);
    this.tintColor.copy(other.tintColor);
    return this;
  }

  /** Move this profile `weight` of the way toward `other`. weight 0 is a no-op,
   *  weight 1 is a copy, and anything between is a genuine halfway grade. */
  blend(other: PostProfile, weight: number): this {
    if (weight <= 0) return this;
    if (weight >= 1) return this.copy(other);
    const numbers = this.numbers;
    for (let i = 0; i < PROFILE_NUMBER_KEYS.length; i++) {
      const key = PROFILE_NUMBER_KEYS[i]!;
      numbers[key] += (other[key] - numbers[key]) * weight;
    }
    this.vignetteColor.lerp(other.vignetteColor, weight);
    this.tintColor.lerp(other.tintColor, weight);
    return this;
  }

  clone(): PostProfile {
    return new PostProfile().copy(this);
  }
}

export const DEFAULT_PROFILE = new PostProfile();
