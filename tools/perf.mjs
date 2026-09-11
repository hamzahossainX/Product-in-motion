/**
 * Frame-time harness, run on the real GPU.
 *
 * Headless Chrome defaults to SwiftShader, and a frame time measured in
 * software says nothing about whether the site holds 60fps — so this one asks
 * for hardware and reports the renderer it actually got, because a number
 * without that label is not evidence of anything.
 *
 *   node tools/perf.mjs                 # idle, hero
 *   SCROLL=1 node tools/perf.mjs        # scrolling the full page
 */
import { launchChrome, openPage, navigate } from './cdp.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const SECONDS = Number(process.env.SECONDS ?? 6);
const SCROLL = process.env.SCROLL === '1';
/** A frame is "dropped" once it costs more than two 60Hz intervals. */
const DROP_MS = 33.4;

async function evaluate(session, sessionId, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result.value;
}

const chrome = await launchChrome({ gpu: true });
const { session, sessionId } = await openPage(chrome.wsUrl);
await session.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
}, sessionId);
// probe, not debug: the overlay and GUI would be part of every frame measured.
await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
  { expect: 'window.__eraser && window.__eraser.render' });

const renderer = await evaluate(session, sessionId, `
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
`);

const report = await evaluate(session, sessionId, `
  const deltas = [];
  const limit = window.__eraser.pane.limit;
  let last = performance.now();
  const start = last;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  const step = (now) => {
    deltas.push(now - last);
    last = now;
    if (${SCROLL}) {
      const t = (now - start) / (${SECONDS} * 1000);
      window.__eraser.pane.scrollTo(limit * Math.min(1, t), true);
    }
    if (now - start < ${SECONDS} * 1000) requestAnimationFrame(step);
    else resolveDone();
  };
  requestAnimationFrame(step);
  await done;

  // Discard the first few frames: they include shader compilation, which is a
  // startup cost, not a steady-state frame time.
  const steady = deltas.slice(8).sort((a, b) => a - b);
  const at = (q) => steady[Math.min(steady.length - 1, Math.floor(steady.length * q))];
  const info = window.__eraser.render.renderer.gl.info;
  return {
    frames: steady.length,
    median: at(0.5), p95: at(0.95), worst: steady[steady.length - 1],
    dropped: steady.filter(d => d > ${DROP_MS}).length,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs.length,
    renderMs: window.__eraser.render.lastFrameMs,
  };
`);

console.log(`renderer    ${renderer}`);
console.log(`mode        ${SCROLL ? 'scrolling full page' : 'idle'} at ${WIDTH}x${HEIGHT}, ${SECONDS}s`);
console.log(`frames      ${report.frames}`);
console.log(`median      ${report.median.toFixed(2)} ms  (${(1000 / report.median).toFixed(1)} fps)`);
console.log(`p95         ${report.p95.toFixed(2)} ms`);
console.log(`worst       ${report.worst.toFixed(2)} ms`);
console.log(`dropped     ${report.dropped} frames over ${DROP_MS} ms`);
console.log(`draw calls  ${report.drawCalls}`);
console.log(`triangles   ${report.triangles}`);
console.log(`programs    ${report.programs}`);

await chrome.close();
process.exit(report.median > 18 || report.dropped > report.frames * 0.02 ? 1 : 0);
