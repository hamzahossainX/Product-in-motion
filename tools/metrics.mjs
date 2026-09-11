/**
 * Load metrics, measured directly.
 *
 * Lighthouse is not installed, and installing it is a dependency decision
 * rule 22 reserves for the author. These are the measurements its performance
 * score is computed from, taken from the same APIs it uses — so they can be
 * read against its thresholds without claiming a score that was never run.
 *
 *   node tools/metrics.mjs
 */
import { launchChrome, openPage } from './cdp.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const WIDTH = 1440;
const HEIGHT = 900;
const OBSERVE_MS = 9000;

/** Lighthouse desktop scoring curve, p10 / median (seconds, or unitless). */
const THRESHOLDS = {
  fcp: { good: 0.934, poor: 1.6 },
  lcp: { good: 1.2, poor: 2.4 },
  tbt: { good: 0.15, poor: 0.35 },
  cls: { good: 0.1, poor: 0.25 },
};

const chrome = await launchChrome({ gpu: true });
const { session, sessionId } = await openPage(chrome.wsUrl);
await session.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
}, sessionId);

// The observers have to exist before the document does, or the entries that
// matter have already been emitted by the time the script runs.
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__metrics = { fcp: 0, lcp: 0, cls: 0, longTasks: [] };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint') window.__metrics.fcp = e.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__metrics.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) window.__metrics.cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__metrics.longTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  `,
}, sessionId);

await session.send('Page.navigate', { url: `${URL_BASE}/` }, sessionId);
await new Promise((r) => setTimeout(r, OBSERVE_MS));

const { result } = await session.send('Runtime.evaluate', {
  expression: `(() => {
    const m = window.__metrics;
    const nav = performance.getEntriesByType('navigation')[0];
    // Total Blocking Time: every long task's time beyond 50 ms, between first
    // paint and the end of the observation window.
    let tbt = 0;
    for (const [start, duration] of m.longTasks) {
      if (start < m.fcp) continue;
      tbt += Math.max(0, duration - 50);
    }
    return JSON.stringify({
      fcp: m.fcp / 1000, lcp: m.lcp / 1000, cls: m.cls, tbt: tbt / 1000,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd / 1000 : 0,
      load: nav ? nav.loadEventEnd / 1000 : 0,
      transferred: nav ? nav.transferSize : 0,
      longTasks: m.longTasks.length,
    });
  })()`,
  returnByValue: true,
}, sessionId);

const metrics = JSON.parse(result.value);
const verdict = (value, t) => value <= t.good ? 'good' : value <= t.poor ? 'needs work' : 'poor';

console.log(`first contentful paint  ${metrics.fcp.toFixed(3)} s   ${verdict(metrics.fcp, THRESHOLDS.fcp)}`);
console.log(`largest contentful paint ${metrics.lcp.toFixed(3)} s   ${verdict(metrics.lcp, THRESHOLDS.lcp)}`);
console.log(`total blocking time     ${metrics.tbt.toFixed(3)} s   ${verdict(metrics.tbt, THRESHOLDS.tbt)}`);
console.log(`cumulative layout shift ${metrics.cls.toFixed(4)}     ${verdict(metrics.cls, THRESHOLDS.cls)}`);
console.log(`DOMContentLoaded        ${metrics.domContentLoaded.toFixed(3)} s`);
console.log(`load                    ${metrics.load.toFixed(3)} s`);
console.log(`long tasks observed     ${metrics.longTasks}`);

await chrome.close();
const allGood = metrics.fcp <= THRESHOLDS.fcp.poor && metrics.lcp <= THRESHOLDS.lcp.poor &&
  metrics.tbt <= THRESHOLDS.tbt.poor && metrics.cls <= THRESHOLDS.cls.good;
process.exit(allGood ? 0 : 1);
