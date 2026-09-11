/**
 * Reads the interaction state into the scene.
 *
 * The controls write plain data and never touch anything 3D (rule 4); this is
 * the one place that data becomes material properties, geometry
 * swaps and erase strokes. Everything continuous arrives through a spring, so
 * a slider reads as a control being used rather than a value being set.
 *
 * Version counters rather than value comparison: rebuilding the distance field
 * because a string is equal to itself is the expensive mistake, and comparing
 * strings every frame to avoid it is the cheap one.
 */
import { mix } from '../lib/math.ts';
import { SecondOrderDynamics } from '../lib/SecondOrderDynamics.ts';
import type { InteractionState } from '../lib/InteractionState.ts';
import type { GraphiteText } from '../scenes/interactions/GraphiteText.ts';
import type { Hero } from '../scenes/Hero.ts';

const HARDNESS_FREQUENCY = 2.2;
const HARDNESS_DAMPING = 0.85;

/** Harder grades are denser and glossier; softer ones chalky and matte. */
const ROUGHNESS_SOFT = 0.78;
const ROUGHNESS_HARD = 0.46;
const ENV_INTENSITY_SOFT = 0.36;
const ENV_INTENSITY_HARD = 0.62;
/** A soft grade leaves more of a ghost behind on the paper. */
const SMUDGE_SOFT = 0.55;
const SMUDGE_HARD = 0.12;

/**
 * Minimum gap between rebuilds of the graphite text.
 *
 * Each rebuild rasterises, hands a mask to the worker and uploads a 262 kB
 * texture. Once per frame is bounded only by how fast input arrives, and a
 * synthetic 60-characters-per-second test pushed frames past 33 ms. Nobody
 * types at 60 cps — 50 ms is shorter than the gap between two of even a fast
 * typist's keystrokes, so nothing perceptible is lost and the cost is bounded
 * whatever the input rate.
 */
const TEXT_REBUILD_INTERVAL_MS = 50;

export class InteractionBridge {
  readonly hardnessSpring =
    new SecondOrderDynamics(0.5, HARDNESS_FREQUENCY, HARDNESS_DAMPING, 0);

  private lastVariantVersion = -1;
  private builtTextVersion = -1;
  private lastClearVersion = -1;
  private lastTextBuildMs = 0;

  update(dt: number, state: InteractionState, hero: Hero, graphite: GraphiteText): void {
    const hardness = this.hardnessSpring.update(dt, state.hardness);
    hero.material.roughness = mix(ROUGHNESS_SOFT, ROUGHNESS_HARD, hardness);
    hero.material.envMapIntensity = mix(ENV_INTENSITY_SOFT, ENV_INTENSITY_HARD, hardness);
    graphite.setSmudge(mix(SMUDGE_SOFT, SMUDGE_HARD, hardness));

    if (state.variantVersion !== this.lastVariantVersion) {
      this.lastVariantVersion = state.variantVersion;
      hero.setVariant(state.variant);
    }

    // Throttled, with a trailing rebuild: the version last built is tracked
    // separately from the version last seen, so the final keystroke always
    // lands even if it arrived inside the interval.
    if (state.textVersion !== this.builtTextVersion) {
      const now = performance.now();
      if (now - this.lastTextBuildMs >= TEXT_REBUILD_INTERVAL_MS) {
        this.lastTextBuildMs = now;
        this.builtTextVersion = state.textVersion;
        graphite.setText(state.text);
      }
    }

    if (state.clearVersion !== this.lastClearVersion) {
      this.lastClearVersion = state.clearVersion;
      graphite.requestClear();
    }

    for (let i = 0; i < state.eraseQueue.length; i++) {
      graphite.addStroke(state.eraseQueue[i]!);
    }
    state.eraseQueue.length = 0;
  }
}
