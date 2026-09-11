/**
 * `?debug=1` readout.
 *
 * Prints live ScrollRange values for every section plus frame timing. Built now
 * rather than in Phase 8 because a scroll system cannot be verified by eye —
 * the -1 -> 0 -> 1 sweep either reads cleanly here or it does not.
 */
import type { ScrollRange } from './scroll/ScrollRange.ts';
import type { ScrollPane } from './scroll/ScrollPane.ts';

const FPS_SMOOTHING = 0.9;

export function isDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

/**
 * `?probe=1` exposes the same handle with no overlay and no GUI.
 *
 * The debug panels build strings and touch the DOM every frame, which is fine
 * to look at and useless to measure against: a frame-loop allocation test run
 * with them on measures them. This flag is how the gate harness gets at the
 * app without changing what it is measuring.
 */
export function isProbeEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('probe') === '1';
}

export class DebugOverlay {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly ranges: { id: string; range: ScrollRange }[] = [];
  private smoothedFps = 60;

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'debug-overlay';
    this.root.setAttribute('aria-hidden', 'true');
    this.body = document.createElement('pre');
    this.body.className = 'debug-overlay__body';
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
  }

  track(id: string, range: ScrollRange): void {
    this.ranges.push({ id, range });
  }

  update(dt: number, pane: ScrollPane): void {
    const fps = dt > 0 ? 1 / dt : 0;
    this.smoothedFps = this.smoothedFps * FPS_SMOOTHING + fps * (1 - FPS_SMOOTHING);

    let out = `${this.smoothedFps.toFixed(1)} fps   ${(dt * 1000).toFixed(2)} ms\n`;
    out += `scroll ${pane.scrollPixel.toFixed(1)} / ${pane.limit.toFixed(0)}`;
    out += `   progress ${pane.progress.toFixed(4)}\n`;
    out += `delta ${pane.scrollViewDelta.toFixed(2)}px  (${pane.scrollViewDeltaRatio.toFixed(4)} vh)\n`;
    out += '─'.repeat(46) + '\n';
    out += 'section         ratio  screen  viewSz  prog  act\n';
    for (const { id, range } of this.ranges) {
      out += id.padEnd(15).slice(0, 15);
      out += pad(range.ratio, 7);
      out += pad(range.screenRatio, 8);
      out += pad(range.viewSize, 8);
      out += pad(range.progress, 6);
      out += range.isActive ? '   ●' : '   ·';
      out += '\n';
    }
    this.body.textContent = out;
  }

  destroy(): void {
    this.root.remove();
  }
}

function pad(v: number, width: number): string {
  return v.toFixed(2).padStart(width);
}
