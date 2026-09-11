/**
 * Gate 3 harness — renderer, post chain, grade, banding.
 *
 * Every check is a measurement against the rendered pixels or against a value
 * read out of the live page. Nothing here inspects source.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng } from './png.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/gate3';
const WIDTH = 1440;
const HEIGHT = 900;
const BANDING_RUN_CAP = 24;
const BANDING_MIN_RATIO = 5;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(session, sessionId, expression) {
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed');
  return result.value;
}

/** Let the render loop run n frames so a uniform change reaches the screen. */
async function settle(session, sessionId, frames = 4) {
  await evaluate(session, sessionId, `
    return new Promise(resolve => {
      let n = ${frames};
      const step = () => (--n <= 0) ? resolve(true) : requestAnimationFrame(step);
      requestAnimationFrame(step);
    });
  `);
}

async function shoot(session, sessionId, clip) {
  const { data } = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...clip, scale: 1 },
    captureBeyondViewport: false,
  }, sessionId);
  return decodePng(Buffer.from(data, 'base64'));
}

/** Fraction of pixels that moved by at least `levels`. A whole-frame mean is
 *  the wrong test for anything that acts on edges only — an 8px defocus is
 *  unmistakable on screen and still averages under half a level. */
function changedFraction(a, b, levels) {
  let changed = 0;
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < pixels; i++) {
    const o = i * a.channels;
    if (Math.abs(a.data[o] - b.data[o]) >= levels ||
        Math.abs(a.data[o + 1] - b.data[o + 1]) >= levels ||
        Math.abs(a.data[o + 2] - b.data[o + 2]) >= levels) changed++;
  }
  return changed / pixels;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / n;
}

/**
 * Which pixels carry focus information: the object's silhouette and its
 * specular edges, taken from a reference frame that is in focus.
 *
 * Averaging over the frame is useless here — the edges are a fraction of a
 * percent of the pixels — and a high percentile is barely better, because a
 * softened bright edge still ranks near the top. Fixing the sample set to the
 * edges themselves makes the measurement say what it means.
 */
function edgeMask(reference, minGradient = 12) {
  const mask = [];
  for (let y = 0; y < reference.height; y++) {
    for (let x = 1; x < reference.width; x++) {
      const a = (y * reference.width + x) * reference.channels;
      const b = a - reference.channels;
      if (Math.abs(reference.data[a] - reference.data[b]) >= minGradient) mask.push(a);
    }
  }
  return mask;
}

/** Mean gradient across the reference frame's edges. Defocus flattens them. */
function edgeSharpness(img, mask) {
  if (mask.length === 0) return 0;
  let sum = 0;
  for (const a of mask) {
    sum += Math.abs(img.data[a] - img.data[a - img.channels]);
  }
  return sum / mask.length;
}

function meanLuma(img) {
  let sum = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * img.channels;
    sum += 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
  }
  return sum / n;
}

/**
 * Banding, measured rather than eyeballed.
 *
 * Along a scanline through the gradient, work out how many pixels an undithered
 * image would have to hold the same 8-bit value for — that is 1 / (levels per
 * pixel) — then compare against the longest constant run actually present. A
 * dithered gradient breaks every plateau; an undithered one matches the
 * prediction almost exactly.
 */
function bandingReport(img, y) {
  const channel = 0;
  const row = [];
  for (let x = 0; x < img.width; x++) row.push(img.data[(y * img.width + x) * img.channels + channel]);
  const span = Math.abs(row[row.length - 1] - row[0]);
  const levelsPerPixel = span / row.length;
  const predictedRun = levelsPerPixel > 0 ? 1 / levelsPerPixel : Infinity;

  let maxRun = 1, run = 1;
  for (let x = 1; x < row.length; x++) {
    run = row[x] === row[x - 1] ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  return { span, predictedRun, maxRun };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Hardware, not SwiftShader: a six-pass chain in software takes seconds a
  // frame, and the pixel checks below need dozens of frames.
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
  await navigate(session, sessionId, `${URL_BASE}/?debug=1`,
    { expect: 'window.__eraser && window.__eraser.render' });
  await settle(session, sessionId, 20);

  // --- 1. canvas placement ------------------------------------------------
  const canvas = await evaluate(session, sessionId, `
    const c = document.getElementById('gl-canvas');
    if (!c) return null;
    const s = getComputedStyle(c);
    return {
      position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents,
      ariaHidden: c.getAttribute('aria-hidden'),
      cssWidth: c.clientWidth, cssHeight: c.clientHeight,
      bufferWidth: c.width, bufferHeight: c.height,
      contentZ: getComputedStyle(document.querySelector('.site-content')).zIndex,
    };
  `);
  check('canvas is fixed, behind content, non-interactive, aria-hidden',
    canvas?.position === 'fixed' && canvas.pointerEvents === 'none' &&
    canvas.ariaHidden === 'true' && Number(canvas.zIndex) < Number(canvas.contentZ),
    `z ${canvas?.zIndex} vs content ${canvas?.contentZ}, ${canvas?.cssWidth}x${canvas?.cssHeight} css`);

  // --- 2. DPR clamp -------------------------------------------------------
  const dprSamples = [];
  for (const scale of [1, 2, 3]) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: scale, mobile: false,
    }, sessionId);
    await settle(session, sessionId, 6);
    dprSamples.push(await evaluate(session, sessionId, `
      const r = window.__eraser.render.renderer;
      return { devicePixelRatio, pixelRatio: r.pixelRatio, gl: r.gl.getPixelRatio() };
    `));
  }
  const clamped = dprSamples.every((s) => s.pixelRatio <= 1.5 + 1e-6 && s.gl === s.pixelRatio);
  const at3 = dprSamples[2];
  check('DPR clamped to 1.5 on a 3x display', clamped && Math.abs(at3.pixelRatio - 1.5) < 1e-6,
    dprSamples.map((s) => `dpr${s.devicePixelRatio}->${s.pixelRatio.toFixed(3)}`).join('  '));

  // --- 3. pixel budget ----------------------------------------------------
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 3840, height: 2160, deviceScaleFactor: 3, mobile: false,
  }, sessionId);
  await settle(session, sessionId, 6);
  const budget = await evaluate(session, sessionId, `
    const r = window.__eraser.render.renderer;
    return {
      pixelRatio: r.pixelRatio,
      pixels: innerWidth * innerHeight * r.pixelRatio * r.pixelRatio,
      buffer: [r.drawingBufferSize.x, r.drawingBufferSize.y],
    };
  `);
  check('pixel budget scales DPR below 1.5 at 3840x2160',
    budget.pixelRatio < 1.5 && budget.pixels <= 2560 * 1440 * 1.02,
    `dpr ${budget.pixelRatio.toFixed(3)}, ${(budget.pixels / 1e6).toFixed(2)}Mpx vs 3.69Mpx budget, buffer ${budget.buffer.join('x')}`);

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await settle(session, sessionId, 10);

  // --- 4. banding ---------------------------------------------------------
  await evaluate(session, sessionId, `
    for (const el of document.body.children) {
      if (el.id !== 'gl-canvas') el.style.visibility = 'hidden';
    }
    return true;
  `);
  await settle(session, sessionId, 8);
  const bg = await shoot(session, sessionId, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  writeFileSync(`${OUT_DIR}/background.png`, Buffer.from(
    (await session.send('Page.captureScreenshot', {
      format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    }, sessionId)).data, 'base64'));

  // Control: the same frame with the dither switched off. Comparing the two is
  // the only way to show the dither is what removes the banding, rather than
  // the gradient happening to be steep enough not to band here.
  await evaluate(session, sessionId, `window.__eraser.render.setDither(false); return true;`);
  await settle(session, sessionId, 8);
  const bgFlat = await shoot(session, sessionId, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await evaluate(session, sessionId, `window.__eraser.render.setDither(true); return true;`);
  await settle(session, sessionId, 8);

  const rows = [Math.round(HEIGHT * 0.12), Math.round(HEIGHT * 0.5), Math.round(HEIGHT * 0.88)];
  const bandReports = rows.map((y) => ({
    y, dithered: bandingReport(bg, y).maxRun, undithered: bandingReport(bgFlat, y).maxRun,
  }));
  const worst = bandReports.reduce((a, b) => (b.dithered > a.dithered ? b : a));
  const ratio = bandReports.map((r) => r.undithered / Math.max(1, r.dithered));
  // The cap is a statistic, not a taste call. Triangular dither leaves three
  // possible values in a flat region, the middle one about half the time, so
  // over 1440 pixels x 3 rows the longest run of one value by chance is around
  // log2(4300) ~ 12. A cap below that fails on luck; RUN_CAP is twice it. The
  // ratio is what actually distinguishes dithered from banded — an undithered
  // image scores 1 by construction.
  check('background gradient shows no banding plateaus',
    worst.dithered <= BANDING_RUN_CAP && Math.min(...ratio) >= BANDING_MIN_RATIO,
    bandReports.map((r) => `y${r.y}: ${r.dithered}px run vs ${r.undithered}px undithered`).join('  '));

  // --- 5. palette warmth --------------------------------------------------
  let coolPixels = 0, total = 0;
  for (let y = 0; y < bg.height; y += 7) {
    for (let x = 0; x < bg.width; x += 7) {
      const o = (y * bg.width + x) * bg.channels;
      total++;
      if (bg.data[o + 2] > bg.data[o] + 2) coolPixels++;
    }
  }
  check('rendered frame contains no blue-dominant pixels',
    coolPixels === 0, `${coolPixels}/${total} pixels with blue > red`);

  // --- 6. every grade parameter changes the image -------------------------
  await evaluate(session, sessionId, `
    window.__eraser.gui.override = true;
    window.__eraser.gui.profile.set({ bloomAmount: 1.6, bokehAmount: 0 });
    return true;
  `);
  await settle(session, sessionId, 8);
  const baseline = await shoot(session, sessionId, { x: 0, y: 0, width: WIDTH, height: HEIGHT });

  const EXTREMES = [
    ['bloomAmount', 8], ['bloomThreshold', 0.02], ['bloomRadius', 1],
    ['bloomSmoothWidth', 0], ['bloomSaturation', 3], ['bokehAmount', 1.5],
    ['bokehFNumber', 0.05], ['bokehFocusDistance', 1.2], ['bokehFocalLength', 1.2],
    ['bokehFilmHeight', 4], ['vignetteFrom', 0.2], ['vignetteTo', 0.9],
    ['saturation', 0], ['contrast', 1.5], ['brightness', 2.2], ['tintOpacity', 1],
  ];
  const weak = [];
  for (const [key, value] of EXTREMES) {
    // Bokeh parameters only matter while the effect is on.
    const prelude = key.startsWith('bokeh') && key !== 'bokehAmount'
      ? `g.profile.set({ bokehAmount: 1 });` : '';
    await evaluate(session, sessionId, `
      const g = window.__eraser.gui;
      g.profile.set({ bloomAmount: 1.6, bokehAmount: 0, bloomThreshold: 0.3, bloomRadius: 0.25,
        bloomSmoothWidth: 0.75, bloomSaturation: 1, bokehFNumber: 0.181, bokehFocusDistance: 4.5,
        bokehFocalLength: 0.344, bokehFilmHeight: 19.26, vignetteFrom: 2, vignetteTo: 3,
        saturation: 1, contrast: 0, brightness: 1, tintOpacity: 0 });
      ${prelude}
      g.profile.set({ ${key}: ${value} });
      return true;
    `);
    await settle(session, sessionId, 8);
    const shot = await shoot(session, sessionId, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const diff = meanAbsDiff(baseline, shot);
    const moved = changedFraction(baseline, shot, 4);
    if (diff < 0.5 && moved < 0.001) weak.push(`${key} mean ${diff.toFixed(3)} moved ${(moved * 100).toFixed(3)}%`);
    else console.log(`      ${key.padEnd(20)} mean |delta| ${diff.toFixed(2)}  pixels moved >=4 levels ${(moved * 100).toFixed(2)}%`);
  }
  check('every PostProfile parameter visibly changes the image',
    weak.length === 0, weak.length ? `no visible change: ${weak.join(', ')}` : 'all 16 parameters');

  // --- 7. bokeh moves a focus plane, not a blur amount --------------------
  // A blur slider makes the whole image progressively softer. A focus plane
  // makes the object sharpest at exactly its own distance and softer either
  // side of it, so sharpness against focus distance must have an interior peak.
  const objectDistance = await evaluate(session, sessionId, `
    const s = window.__eraser.render.stage;
    return s.camera.position.distanceTo(s.hero.object.position);
  `);
  const box = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  // The final pass adds one 8-bit step of noise to every pixel, which is far
  // more horizontal gradient than the object's edges carry. Measuring focus
  // through it would report the noise floor, so it comes off for the sweep.
  // The background's own dither stays on, so the gradient behind stays smooth.
  await evaluate(session, sessionId, `window.__eraser.render.post.setDither(false); return true;`);
  // Reference frame: bokeh off, so the mask is the object's real edges.
  await evaluate(session, sessionId,
    `window.__eraser.gui.profile.set({ bokehAmount: 0 }); return true;`);
  await settle(session, sessionId, 8);
  const focusMask = edgeMask(await shoot(session, sessionId, box));

  const sweep = [];
  for (const distance of [1.5, 3, objectDistance, 12, 30]) {
    await evaluate(session, sessionId, `
      window.__eraser.gui.profile.set({ bokehAmount: 1.4, bokehFNumber: 0.181, bokehFocusDistance: ${distance} });
      return true;
    `);
    await settle(session, sessionId, 8);
    const shot = await shoot(session, sessionId, box);
    sweep.push({ distance, sharpness: edgeSharpness(shot, focusMask) });
  }
  await evaluate(session, sessionId, `window.__eraser.render.post.setDither(true); return true;`);
  const peak = sweep.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
  const peakIndex = sweep.indexOf(peak);
  check('bokeh focus plane sits at the object and pulls off it',
    peakIndex === 2 && peak.sharpness > sweep[0].sharpness * 1.15,
    `object at ${objectDistance.toFixed(2)}; edge sharpness ` +
    sweep.map((s) => `${s.distance.toFixed(1)}:${s.sharpness.toFixed(2)}`).join('  ') +
    ` over ${focusMask.length} edge pixels`);

  // The far end of the sweep barely changes edge sharpness, and that is the
  // lens, not the code: far-field circle of confusion converges on A*f/z, about
  // 6.6 px here, however far the focus plane is pushed. Sharpness is therefore
  // the wrong instrument for the far side — what the gate asks is whether the
  // image visibly changes, so that is measured directly in pixels.
  await evaluate(session, sessionId,
    `window.__eraser.gui.profile.set({ bokehAmount: 1.4, bokehFocusDistance: ${objectDistance} });
     return true;`);
  await settle(session, sessionId, 8);
  const inFocus = await shoot(session, sessionId, box);
  await evaluate(session, sessionId,
    `window.__eraser.gui.profile.set({ bokehAmount: 1.4, bokehFocusDistance: 30 }); return true;`);
  await settle(session, sessionId, 8);
  const farFocus = await shoot(session, sessionId, box);
  const focusMoved = changedFraction(inFocus, farFocus, 4);
  check('pulling focus visibly changes the image',
    focusMoved > 0.005,
    `${(focusMoved * 100).toFixed(2)}% of pixels moved by 4+ levels between ` +
    `focus ${objectDistance.toFixed(1)} and focus 30`);

  // --- 8. blendProfile(A, 0.5) is genuinely halfway -----------------------
  const halfway = await evaluate(session, sessionId, `
    const g = window.__eraser.gui;
    const a = g.profile.clone().set({ brightness: 0.5, bloomAmount: 0, saturation: 0.2, contrast: -0.3 });
    const b = g.profile.clone().set({ brightness: 2.5, bloomAmount: 5, saturation: 1.8, contrast: 0.9 });
    const mid = a.clone().blend(b, 0.5);
    window.__gateProfiles = { a, b, mid };
    return {
      brightness: mid.brightness, bloomAmount: mid.bloomAmount,
      saturation: mid.saturation, contrast: mid.contrast,
      tint: [mid.tintColor.r, mid.tintColor.g, mid.tintColor.b],
    };
  `);
  const numericHalfway =
    Math.abs(halfway.brightness - 1.5) < 1e-6 && Math.abs(halfway.bloomAmount - 2.5) < 1e-6 &&
    Math.abs(halfway.saturation - 1.0) < 1e-6 && Math.abs(halfway.contrast - 0.3) < 1e-6;

  const lumas = [];
  for (const which of ['a', 'mid', 'b']) {
    await evaluate(session, sessionId,
      `window.__eraser.gui.profile.copy(window.__gateProfiles.${which}); return true;`);
    await settle(session, sessionId, 8);
    lumas.push(meanLuma(await shoot(session, sessionId, { x: 0, y: 0, width: WIDTH, height: HEIGHT })));
  }
  check('blendProfile(A, 0.5) renders a state between the two profiles',
    numericHalfway && lumas[0] < lumas[1] && lumas[1] < lumas[2],
    `numeric exact; mean luma ${lumas.map((l) => l.toFixed(1)).join(' < ')}`);

  // --- 9. draw calls, triangles, no console errors ------------------------
  await evaluate(session, sessionId, `
    window.__eraser.gui.reset();
    for (const el of document.body.children) el.style.visibility = '';
    return true;
  `);
  await settle(session, sessionId, 10);
  const info = await evaluate(session, sessionId, `
    const i = window.__eraser.render.renderer.gl.info;
    return { calls: i.render.calls, triangles: i.render.triangles, programs: i.programs.length,
             textures: i.memory.textures, geometries: i.memory.geometries };
  `);
  check('draw calls within budget', info.calls <= 80,
    `${info.calls} calls, ${info.triangles} triangles, ${info.programs} programs, ${info.textures} textures`);

  await sleep(300);
  check('zero console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  const gui = await session.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  }, sessionId);
  writeFileSync(`${OUT_DIR}/gui.png`, Buffer.from(gui.data, 'base64'));

  await chrome.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots in ${OUT_DIR}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
