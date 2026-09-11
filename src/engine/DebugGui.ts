/**
 * ?debug=1 grade GUI and render stats.
 *
 * Hand-rolled rather than pulled from a library. Rule 22 says never add a
 * dependency without asking, and a panel of range inputs is not worth
 * interrupting the build to ask for.
 *
 * With `override` on, the panel's profile is blended over the accumulated grade
 * at full weight, so a slider is authoritative. With it off, the sliders follow
 * whatever the sections are claiming — which is how a per-section grade gets
 * read off the page in Phase 5 rather than guessed at.
 */
import type { WebGLRenderer } from 'three';
import { PostProfile, PROFILE_DEFAULTS, type ProfileNumberKey } from './post/PostProfile.ts';
import type { Postprocessing } from './post/Postprocessing.ts';

interface SliderSpec { key: ProfileNumberKey; min: number; max: number; step: number }

const SLIDERS: SliderSpec[] = [
  { key: 'bloomAmount', min: 0, max: 8, step: 0.01 },
  { key: 'bloomThreshold', min: 0, max: 2, step: 0.01 },
  { key: 'bloomRadius', min: 0, max: 1, step: 0.01 },
  { key: 'bloomSmoothWidth', min: 0, max: 1, step: 0.01 },
  { key: 'bloomSaturation', min: 0, max: 3, step: 0.01 },
  { key: 'bokehAmount', min: 0, max: 2, step: 0.01 },
  { key: 'bokehFNumber', min: 0.02, max: 2, step: 0.001 },
  { key: 'bokehFocusDistance', min: 0.1, max: 20, step: 0.01 },
  { key: 'bokehFocalLength', min: 0.05, max: 2, step: 0.001 },
  { key: 'bokehFilmHeight', min: 1, max: 50, step: 0.01 },
  { key: 'vignetteFrom', min: 0, max: 3, step: 0.01 },
  { key: 'vignetteTo', min: 0, max: 4, step: 0.01 },
  { key: 'saturation', min: 0, max: 2, step: 0.01 },
  { key: 'contrast', min: -1, max: 2, step: 0.01 },
  { key: 'brightness', min: 0, max: 3, step: 0.01 },
  { key: 'tintOpacity', min: 0, max: 1, step: 0.001 },
];

const STATS_INTERVAL_SECONDS = 0.25;

export class DebugGui {
  readonly profile = new PostProfile();
  override = true;

  private readonly root = document.createElement('div');
  private readonly stats = document.createElement('pre');
  private readonly inputs = new Map<ProfileNumberKey, HTMLInputElement>();
  private readonly readouts = new Map<ProfileNumberKey, HTMLElement>();
  private readonly vignetteInput = document.createElement('input');
  private readonly tintInput = document.createElement('input');
  private elapsed = 0;
  private frames = 0;
  private frameMsTotal = 0;

  constructor() {
    this.root.className = 'debug-gui';
    this.root.innerHTML = '<header>post profile</header>';

    const toggle = document.createElement('label');
    toggle.className = 'debug-gui__toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.override;
    checkbox.addEventListener('change', () => { this.override = checkbox.checked; });
    toggle.append(checkbox, document.createTextNode(' override section claims'));
    this.root.append(toggle);

    for (const spec of SLIDERS) this.root.append(this.buildSlider(spec));
    this.root.append(this.buildColor('vignette', this.vignetteInput,
      PROFILE_DEFAULTS.vignetteColorHex, (hex) => this.profile.vignetteColor.set(hex)));
    this.root.append(this.buildColor('tint', this.tintInput,
      PROFILE_DEFAULTS.tintColorHex, (hex) => this.profile.tintColor.set(hex)));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'reset';
    reset.addEventListener('click', () => this.reset());
    this.root.append(reset);

    this.stats.className = 'debug-gui__stats';
    this.root.append(this.stats);
    document.body.append(this.root);
  }

  private buildSlider(spec: SliderSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'debug-gui__row';
    const name = document.createElement('span');
    name.textContent = spec.key;
    const value = document.createElement('em');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(this.profile[spec.key]);
    value.textContent = input.value;
    input.addEventListener('input', () => {
      (this.profile as Record<ProfileNumberKey, number>)[spec.key] = Number(input.value);
      value.textContent = input.value;
      // Touching a slider is an unambiguous request to control the grade.
      this.override = true;
      const checkbox = this.root.querySelector<HTMLInputElement>('.debug-gui__toggle input');
      if (checkbox) checkbox.checked = true;
    });
    this.inputs.set(spec.key, input);
    this.readouts.set(spec.key, value);
    row.append(name, input, value);
    return row;
  }

  private buildColor(
    label: string, input: HTMLInputElement, initial: string, onChange: (hex: string) => void,
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'debug-gui__row debug-gui__row--color';
    const name = document.createElement('span');
    name.textContent = `${label}Color`;
    input.type = 'color';
    input.value = initial;
    input.addEventListener('input', () => { onChange(input.value); this.override = true; });
    row.append(name, input);
    return row;
  }

  reset(): void {
    this.profile.set(PROFILE_DEFAULTS);
    for (const [key, input] of this.inputs) {
      input.value = String(this.profile[key]);
      const readout = this.readouts.get(key);
      if (readout) readout.textContent = input.value;
    }
    this.vignetteInput.value = PROFILE_DEFAULTS.vignetteColorHex;
    this.tintInput.value = PROFILE_DEFAULTS.tintColorHex;
  }

  /** Called after every section claim, before syncProfile. */
  apply(post: Postprocessing): void {
    if (this.override) post.blendProfile(this.profile, 1);
  }

  update(dt: number, frameMs: number, renderer: WebGLRenderer, post: Postprocessing): void {
    this.frames++;
    this.frameMsTotal += frameMs;
    this.elapsed += dt;
    if (this.elapsed < STATS_INTERVAL_SECONDS) return;

    const fps = this.frames / this.elapsed;
    const avgMs = this.frameMsTotal / this.frames;
    const info = renderer.info;
    this.stats.textContent =
      `fps        ${fps.toFixed(1)}\n` +
      `frame      ${avgMs.toFixed(2)} ms\n` +
      `draw calls ${info.render.calls}\n` +
      `triangles  ${info.render.triangles}\n` +
      `programs   ${info.programs?.length ?? 0}\n` +
      `textures   ${info.memory.textures}`;
    this.elapsed = 0;
    this.frames = 0;
    this.frameMsTotal = 0;

    if (!this.override) this.follow(post.profile);
  }

  /** Mirror the live grade onto the controls without fighting the user. */
  private follow(profile: PostProfile): void {
    for (const [key, input] of this.inputs) {
      const value = profile[key];
      const text = value.toFixed(3);
      input.value = String(value);
      const readout = this.readouts.get(key);
      if (readout && readout.textContent !== text) readout.textContent = text;
    }
  }

  destroy(): void {
    this.root.remove();
  }
}
