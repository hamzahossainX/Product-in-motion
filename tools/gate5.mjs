/**
 * Gate 5 harness — scroll-linked camera and weighted section claims.
 *
 * The gate's central question, "does it read as one continuous camera move",
 * is answered here by measuring continuity rather than by looking: a path made
 * of absolute per-section writes has a discontinuity at every handover, and a
 * path made of blended claims does not.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng, encodePng } from './png.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/gate5';
const WIDTH = 1440;
const HEIGHT = 900;
/** Scroll samples across the page for the continuity trace. */
const TRACE_SAMPLES = 400;
/** Frames in the contact sheet. */
const SHEET_FRAMES = 12;
/** A camera step larger than this between adjacent samples is a cut. */
const MAX_STEP_MULTIPLE = 6;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function evaluate(session, sessionId, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result.value;
}

const settle = (session, sessionId, frames = 6) => evaluate(session, sessionId, `
  return new Promise(r => { let n = ${frames};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f);
    requestAnimationFrame(f); });`);

/** Jump to an exact scroll position and let the springs finish. */
const seek = (session, sessionId, pixel, frames = 30) => evaluate(session, sessionId, `
  window.__eraser.pane.scrollTo(${pixel}, true);
  return new Promise(r => { let n = ${frames};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f);
    requestAnimationFrame(f); });`);

// No `clip`: Page.captureScreenshot takes its clip in DOCUMENT coordinates, so
// a fixed clip at y=0 photographs the top of the page however far the viewport
// has scrolled — which silently produced a black frame for every capture below
// the fold. Omitting it captures the viewport, which is what is wanted.
async function shoot(session, sessionId) {
  const { data } = await session.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false }, sessionId);
  return decodePng(Buffer.from(data, 'base64'));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const chrome = await launchChrome({ gpu: true });
  const { session, sessionId } = await openPage(chrome.wsUrl);

  const consoleErrors = [];
  session.on('Runtime.exceptionThrown', (p) =>
    consoleErrors.push(p.exceptionDetails?.exception?.description ?? 'exception'));
  session.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
    { expect: 'window.__eraser && window.__eraser.render && window.__eraser.render.stage.scene.environment' });
  await settle(session, sessionId, 30);

  // --- 1. every section is bound and claims ------------------------------
  const bound = await evaluate(session, sessionId, `
    return window.__eraser.render.sectionScenes.map(s => s.id);`);
  check('every section in SPEC.md has a scene', bound.length === 9,
    bound.join(', '));

  // --- 2. continuity of the camera path ----------------------------------
  // Sampled without rendering: the path is a pure function of scroll, so the
  // trace isolates it from parallax, drift and the spring on the object.
  const trace = await evaluate(session, sessionId, `
    const e = window.__eraser, r = e.render;
    const limit = e.pane.limit;
    const out = [];
    const pos = new (Object.getPrototypeOf(r.camera.basePosition).constructor)();
    const tgt = new (Object.getPrototypeOf(r.camera.baseTarget).constructor)();
    for (let i = 0; i < ${TRACE_SAMPLES}; i++) {
      const progress = i / (${TRACE_SAMPLES} - 1);
      const fov = r.rig.path.sample(progress, pos, tgt);
      out.push([pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, fov]);
    }
    return { out, limit };`);
  const steps = [];
  for (let i = 1; i < trace.out.length; i++) {
    const a = trace.out[i - 1];
    const b = trace.out[i];
    steps.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const sorted = [...steps].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  check('camera path is continuous — no cut at any handover',
    worst < median * MAX_STEP_MULTIPLE,
    `worst step ${worst.toFixed(4)} vs median ${median.toFixed(4)} world units ` +
    `(${(worst / median).toFixed(1)}x, cut threshold ${MAX_STEP_MULTIPLE}x)`);

  const fovs = trace.out.map((s) => s[6]);
  check('field of view moves across the page',
    Math.max(...fovs) - Math.min(...fovs) > 4,
    `${Math.min(...fovs).toFixed(1)}° to ${Math.max(...fovs).toFixed(1)}°`);

  // --- 3. sections overlap: two claims at once ---------------------------
  // Weights are read from live frames, so they come out of the real
  // reset-then-claim pass rather than being re-derived by the harness.
  const blendSamples = [];
  const limit = trace.limit;
  for (let i = 0; i <= 24; i++) {
    await seek(session, sessionId, (i / 24) * limit, 10);
    blendSamples.push(await evaluate(session, sessionId, `
      const s = window.__eraser.render.sectionScenes;
      return { progress: window.__eraser.pane.progress,
               weights: s.map(x => [x.id, Number(x.weight.toFixed(4))]).filter(w => w[1] > 0) };`));
  }
  const multi = blendSamples.filter((s) => s.weights.length >= 2).length;
  const none = blendSamples.filter((s) => s.weights.length === 0).length;
  check('sections blend rather than cut — two claims at once',
    multi >= blendSamples.length * 0.4 && none === 0,
    `${multi} of ${blendSamples.length} scroll positions have 2+ sections claiming, ` +
    `${none} have none`);

  // --- 3b. every anchor box is actually on screen ------------------------
  // An anchor placed by percentage inside a section taller than the viewport
  // can sit entirely above the fold, which puts the object off-screen while
  // every other check still passes.
  const anchorBoxes = await evaluate(session, sessionId, `
    const e = window.__eraser;
    const out = [];
    for (const scene of e.render.sectionScenes) {
      const anchor = document.getElementById(scene.id + '-object-anchor');
      if (!anchor) continue;
      const px = scene.range.centreScrollPixel(window.innerHeight);
      e.pane.scrollTo(px, true);
      await new Promise(r => { let n = 16;
        const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });
      const b = anchor.getBoundingClientRect();
      out.push({ id: scene.id, top: Math.round(b.top), bottom: Math.round(b.bottom),
        inView: b.top >= 0 && b.bottom <= window.innerHeight &&
                b.left >= 0 && b.right <= window.innerWidth });
    }
    return out;`);
  const offscreenAnchors = anchorBoxes.filter((a) => !a.inView);
  check('every object anchor is inside the viewport at its section centre',
    offscreenAnchors.length === 0 && anchorBoxes.length >= 5,
    `${anchorBoxes.length} anchors` +
    (offscreenAnchors.length ? `; off screen: ${offscreenAnchors.map((a) => `${a.id} (${a.top}..${a.bottom})`).join(', ')}` : ''));

  // --- 4. the grade moves, and moves smoothly ----------------------------
  const grades = [];
  for (let i = 0; i <= 40; i++) {
    await seek(session, sessionId, (i / 40) * limit, 6);
    grades.push(await evaluate(session, sessionId, `
      const p = window.__eraser.render.post.profile;
      return [p.bloomAmount, p.bokehAmount, p.contrast, p.saturation, p.tintOpacity];`));
  }
  const bloom = grades.map((g) => g[0]);
  let worstGradeStep = 0;
  for (let i = 1; i < grades.length; i++) {
    for (let k = 0; k < grades[i].length; k++) {
      worstGradeStep = Math.max(worstGradeStep, Math.abs(grades[i][k] - grades[i - 1][k]));
    }
  }
  check('grade shifts between sections but never steps',
    Math.max(...bloom) - Math.min(...bloom) > 1 && worstGradeStep < 2.5,
    `bloom ${Math.min(...bloom).toFixed(2)}-${Math.max(...bloom).toFixed(2)}, ` +
    `largest single-sample change ${worstGradeStep.toFixed(3)}`);

  // --- 5. determinism: scrubbing back is identical -----------------------
  const probe = Math.round(limit * 0.62);
  await seek(session, sessionId, 0, 20);
  await seek(session, sessionId, probe, 60);
  const forward = await evaluate(session, sessionId, `
    const c = window.__eraser.render.camera;
    return [...c.basePosition.toArray(), ...c.baseTarget.toArray()];`);
  await seek(session, sessionId, limit, 20);
  await seek(session, sessionId, probe, 60);
  const backward = await evaluate(session, sessionId, `
    const c = window.__eraser.render.camera;
    return [...c.basePosition.toArray(), ...c.baseTarget.toArray()];`);
  const drift = Math.max(...forward.map((v, i) => Math.abs(v - backward[i])));
  check('scrubbing backwards lands on the same camera as forwards',
    drift < 1e-4, `largest axis difference ${drift.toExponential(2)} world units`);

  // --- 6. fast scroll and resize -----------------------------------------
  const abuse = await evaluate(session, sessionId, `
    const e = window.__eraser;
    const limit = e.pane.limit;
    for (let i = 0; i < 40; i++) {
      e.pane.scrollTo(Math.random() * limit, true);
      await new Promise(r => requestAnimationFrame(r));
    }
    const c = e.render.camera;
    const v = [...c.basePosition.toArray(), ...c.baseTarget.toArray(),
               ...e.render.stage.camera.position.toArray()];
    return v.every(Number.isFinite);`);
  check('fast random scrolling leaves the camera finite', abuse === true,
    '40 random jumps');

  await seek(session, sessionId, Math.round(limit * 0.45), 30);
  const beforeResize = await evaluate(session, sessionId,
    'return window.__eraser.pane.scrollPixel / window.__eraser.pane.limit;');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1100, height: 780, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await settle(session, sessionId, 30);
  const afterResize = await evaluate(session, sessionId,
    'return window.__eraser.pane.scrollPixel / window.__eraser.pane.limit;');
  check('resize mid-scroll keeps the reading position',
    Math.abs(afterResize - beforeResize) < 0.06,
    `progress ${beforeResize.toFixed(4)} -> ${afterResize.toFixed(4)}`);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await settle(session, sessionId, 20);

  // --- 7. contact sheet of the whole scroll ------------------------------
  const tiles = [];
  for (let i = 0; i < SHEET_FRAMES; i++) {
    await seek(session, sessionId, (i / (SHEET_FRAMES - 1)) * limit, 24);
    tiles.push(await shoot(session, sessionId));
  }
  const cols = 3;
  const rows = Math.ceil(SHEET_FRAMES / cols);
  const tw = Math.floor(WIDTH / 3);
  const th = Math.floor(HEIGHT / 3);
  const sheet = Buffer.alloc(tw * cols * th * rows * 3);
  for (let t = 0; t < tiles.length; t++) {
    const img = tiles[t];
    const ox = (t % cols) * tw;
    const oy = Math.floor(t / cols) * th;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const src = ((y * 3) * img.width + x * 3) * img.channels;
        const dst = (((oy + y) * tw * cols) + ox + x) * 3;
        sheet[dst] = img.data[src];
        sheet[dst + 1] = img.data[src + 1];
        sheet[dst + 2] = img.data[src + 2];
      }
    }
  }
  writeFileSync(`${OUT_DIR}/scroll-sheet.png`,
    encodePng(tw * cols, th * rows, 3, sheet));

  // --- 8. performance and draw calls -------------------------------------
  const info = await evaluate(session, sessionId, `
    const i = window.__eraser.render.renderer.gl.info;
    return { calls: i.render.calls, triangles: i.render.triangles };`);
  check('draw calls within budget', info.calls <= 80,
    `${info.calls} calls, ${info.triangles} triangles`);

  check('zero console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  await chrome.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`contact sheet: ${OUT_DIR}/scroll-sheet.png`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
