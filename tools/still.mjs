/**
 * Capture a still of the canvas with all DOM hidden.
 *
 * The Phase 4 gate is "the still frame looks like a rendered product shot" —
 * which is a question about pixels, so the pixels have to be looked at.
 *
 *   node tools/still.mjs out.png [seconds-to-settle]
 */
import { writeFileSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng } from './png.mjs';

const OUT = process.argv[2] ?? 'still.png';
const SETTLE_FRAMES = Number(process.argv[3] ?? 90);
const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const HIDE_DOM = process.env.HIDE_DOM !== '0';

async function evaluate(session, sessionId, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result.value;
}

const chrome = await launchChrome({ gpu: true });
const { session, sessionId } = await openPage(chrome.wsUrl);
session.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error' || p.type === 'warning') {
    console.log(`[${p.type}]`, p.args.map((a) => a.value ?? a.description).join(' '));
  }
});
session.on('Runtime.exceptionThrown', (p) =>
  console.log('[exception]', p.exceptionDetails?.exception?.description));

await session.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
}, sessionId);
// probe, not debug: a still of the page should not have the GUI over it.
await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
  { expect: 'window.__eraser && window.__eraser.render' });

if (HIDE_DOM) {
  await evaluate(session, sessionId, `
    for (const el of document.body.children) {
      if (el.id !== 'gl-canvas') el.style.visibility = 'hidden';
    }
    return true;`);
}
await evaluate(session, sessionId, `
  return new Promise(r => { let n = ${SETTLE_FRAMES};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f);
    requestAnimationFrame(f); });`);

const info = await evaluate(session, sessionId, `
  const i = window.__eraser.render.renderer.gl.info;
  const s = window.__eraser.render.stage;
  return { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs.length,
           heroTriangles: s.hero.triangleCount, particles: s.particles.count,
           envReady: !!s.scene.environment, frameMs: window.__eraser.render.lastFrameMs };`);
console.log(JSON.stringify(info));

const { data } = await session.send('Page.captureScreenshot', {
  format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
}, sessionId);
const png = Buffer.from(data, 'base64');
writeFileSync(OUT, png);

// Exposure, as numbers. "Looks blown out" is a judgement; "4% of the frame is
// within two levels of white" is something to tune against.
const img = decodePng(png);
const lumas = [];
let clipped = 0;
for (let i = 0; i < img.width * img.height; i++) {
  const o = i * img.channels;
  const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
  lumas.push(l);
  if (img.data[o] >= 253 && img.data[o + 1] >= 253 && img.data[o + 2] >= 253) clipped++;
}
lumas.sort((a, b) => a - b);
const at = (q) => lumas[Math.floor(lumas.length * q)].toFixed(1);
console.log(`luma p10 ${at(0.1)}  p50 ${at(0.5)}  p90 ${at(0.9)}  p99 ${at(0.99)}  max ${at(0.9999)}`);
console.log(`clipped to white ${(clipped / lumas.length * 100).toFixed(2)}%`);
console.log(`wrote ${OUT}`);
await chrome.close();
