/**
 * Gate 8 — final acceptance.
 *
 * Every box on the list, measured. Runs the desktop tier and then a mobile
 * emulation, because "holds 30fps with a simplified scene" is a different
 * build path and asserting it from the desktop numbers would prove nothing.
 */
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng } from './png.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const DESKTOP = { width: 1440, height: 900, dpr: 1 };
const MOBILE = { width: 390, height: 844, dpr: 3 };
/** Budgets from the prompt pack. */
const DESKTOP_DRAW_CALLS = 80;
const MOBILE_DRAW_CALLS = 40;
const MOBILE_FRAME_MS = 33.4;
const JS_BUDGET_KB = 400;
/** WCAG AA for normal-size text. */
const CONTRAST_AA = 4.5;

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

const settle = (session, sessionId, frames = 20) => evaluate(session, sessionId, `
  return new Promise(r => { let n = ${frames};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);

async function shoot(session, sessionId) {
  const { data } = await session.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false }, sessionId);
  return decodePng(Buffer.from(data, 'base64'));
}

/** Measures a full-page scroll and returns frame statistics. */
const scrollProfile = (session, sessionId, seconds) => evaluate(session, sessionId, `
  const deltas = [];
  const limit = window.__eraser.pane.limit;
  let last = performance.now();
  const start = last;
  await new Promise(resolve => {
    const step = (now) => {
      deltas.push(now - last);
      last = now;
      window.__eraser.pane.scrollTo(limit * Math.min(1, (now - start) / (${seconds} * 1000)), true);
      if (now - start < ${seconds} * 1000) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  const steady = deltas.slice(10).sort((a, b) => a - b);
  const info = window.__eraser.render.renderer.gl.info;
  return { median: steady[steady.length >> 1], p95: steady[Math.floor(steady.length * 0.95)],
           worst: steady[steady.length - 1], frames: steady.length,
           calls: info.render.calls, triangles: info.render.triangles,
           dpr: window.__eraser.render.renderer.pixelRatio,
           particles: window.__eraser.render.stage.particles.count,
           taa: window.__eraser.render.post.taa.enabled };`);

async function main() {
  const chrome = await launchChrome({ gpu: true });
  const { session, sessionId } = await openPage(chrome.wsUrl);

  const consoleErrors = [];
  session.on('Runtime.exceptionThrown', (p) =>
    consoleErrors.push(p.exceptionDetails?.exception?.description?.split('\n')[0] ?? 'exception'));
  session.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });

  // ---------------------------------------------------------- desktop tier
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: DESKTOP.width, height: DESKTOP.height, deviceScaleFactor: DESKTOP.dpr, mobile: false,
  }, sessionId);
  await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
    { expect: 'window.__eraser && window.__eraser.render.stage.scene.environment' });
  await settle(session, sessionId, 60);

  const desktop = await scrollProfile(session, sessionId, 6);
  check('desktop holds 60fps through a full-page scroll',
    desktop.median <= 17.5 && desktop.p95 <= 20,
    `median ${desktop.median.toFixed(2)} ms, p95 ${desktop.p95.toFixed(2)} ms, ` +
    `worst ${desktop.worst.toFixed(2)} ms over ${desktop.frames} frames`);
  check('desktop draw calls within budget', desktop.calls <= DESKTOP_DRAW_CALLS,
    `${desktop.calls} calls, ${desktop.triangles} triangles`);

  // --- the page survives without the canvas ------------------------------
  const withoutCanvas = await evaluate(session, sessionId, `
    const canvas = document.getElementById('gl-canvas');
    canvas.style.display = 'none';
    await new Promise(r => requestAnimationFrame(r));
    const text = document.body.innerText.replace(/\\s+/g, ' ').trim();
    const headings = document.querySelectorAll('h1, h2, h3').length;
    const links = document.querySelectorAll('a[href]').length;
    canvas.style.display = '';
    return { words: text.split(' ').length, headings, links,
             ariaHidden: canvas.getAttribute('aria-hidden'),
             pointerEvents: getComputedStyle(canvas).pointerEvents };`);
  check('removing the canvas still leaves a page worth reading',
    withoutCanvas.words > 400 && withoutCanvas.headings >= 8 &&
    withoutCanvas.ariaHidden === 'true' && withoutCanvas.pointerEvents === 'none',
    `${withoutCanvas.words} words, ${withoutCanvas.headings} headings, ` +
    `${withoutCanvas.links} links; canvas aria-hidden and non-interactive`);

  // --- contrast on every run of body copy --------------------------------
  const contrast = await evaluate(session, sessionId, `
    const parse = (value) => {
      const m = value.match(/[\\d.]+/g).map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 };
    };
    const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    // Behind everything is the page background, and behind that the render,
    // whose darkest region is the value to test against.
    const page = parse(getComputedStyle(document.body).backgroundColor);
    const worst = [];
    for (const el of document.querySelectorAll('p, li, dd, dt, td, th, h1, h2, h3, h4, figcaption, label, span, a, button, output')) {
      if (!el.textContent || !el.textContent.trim()) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const fg = over(parse(style.color), page);
      const l1 = lum(fg), l2 = lum(page);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const required = large ? 3 : 4.5;
      if (ratio < required) {
        worst.push({ text: el.textContent.trim().slice(0, 28), ratio: +ratio.toFixed(2),
                     size: +size.toFixed(1), required });
      }
    }
    return worst;`);
  check(`text contrast meets AA (${CONTRAST_AA}:1 normal, 3:1 large)`,
    contrast.length === 0,
    contrast.length ? contrast.slice(0, 4).map((c) => `"${c.text}" ${c.ratio}:1 at ${c.size}px`).join('; ')
      : 'every run of copy passes against the page background');

  // --- focus is visible on every interactive element ---------------------
  // Driven with real Tab presses, not el.focus(): `:focus-visible` is the
  // selector that matters and Chrome does not apply it to a programmatic focus
  // on a button, so scripted focus would report a false failure — and, worse,
  // a false pass for anything styled on plain `:focus`.
  await evaluate(session, sessionId, `
    // Back to the top through the scroll pane: Lenis owns window.scrollTo, and
    // starting the walk from the bottom of the page reaches a different set.
    window.__eraser.pane.scrollTo(0, true);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return new Promise(r => { let n = 20;
      const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);
  const tabbed = [];
  for (let i = 0; i < 90; i++) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.send('Input.dispatchKeyEvent', {
        type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      }, sessionId);
    }
    const row = await evaluate(session, sessionId, `
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const width = parseFloat(s.outlineWidth) || 0;
      // Identity has to include the class: without it every link collapses to
      // "a" and a walk over fourteen distinct elements counts as seven.
      const name = el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '.' + ((el.className || '').split(' ')[0] || 'anon'));
      return { id: name,
               visible: (s.outlineStyle !== 'none' && width >= 1.5) || s.boxShadow !== 'none',
               outline: s.outlineStyle + ' ' + s.outlineWidth };`);
    if (row) tabbed.push(row);
  }
  const unseen = tabbed.filter((row) => !row.visible);
  const uniqueTabbed = new Set(tabbed.map((r) => r.id));
  // The four controls Phase 7 added are the ones most likely to be missed,
  // because they are the ones that are not plain links.
  const required = ['input#unlearning-input', 'button#unlearning-erase',
    'input#hardness-slider', 'div#abrasion-zoom-box'];
  const unreached = required.filter((id) => !uniqueTabbed.has(id));
  check('every interactive element has a visible focus state',
    unseen.length === 0 && unreached.length === 0 && uniqueTabbed.size >= 12,
    `${uniqueTabbed.size} distinct elements reached by Tab` +
    (unreached.length ? `; never reached: ${unreached.join(', ')}` : '') +
    (unseen.length ? `; no visible ring on: ${[...new Set(unseen.map((u) => u.id))].slice(0, 5).join(', ')}`
      : ', all with a ring of 1.5px or more') +
    (uniqueTabbed.size < 12 ? ` — reached: ${[...uniqueTabbed].join(', ')}` : ''));

  // --- reduced motion ----------------------------------------------------
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  }, sessionId);
  await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
    { expect: 'window.__eraser && window.__eraser.render.stage.scene.environment' });
  await settle(session, sessionId, 60);
  const still = await evaluate(session, sessionId, `
    const rs = window.__eraser.render;
    const cam = rs.stage.camera;
    const before = cam.position.toArray();
    const clockBefore = rs.shared.u_time.value;
    await new Promise(r => setTimeout(r, 1200));
    const after = cam.position.toArray();
    const parts = [...document.querySelectorAll('.split-char, .split-word, .split-line')].slice(0, 200);
    const displaced = parts.filter(p =>
      Math.abs(new DOMMatrixReadOnly(getComputedStyle(p).transform).f) > 1).length;
    return {
      cameraDrift: Math.max(...after.map((v, i) => Math.abs(v - before[i]))),
      clockAdvanced: rs.shared.u_time.value - clockBefore,
      rendering: rs.renderer.gl.info.render.calls > 0,
      displaced, parts: parts.length };`);
  const reducedShot = await shoot(session, sessionId);
  let litPixels = 0;
  for (let i = 0; i < reducedShot.width * reducedShot.height; i += 7) {
    const o = i * reducedShot.channels;
    if (reducedShot.data[o] > 40) litPixels++;
  }
  check('reduced motion gives a still page that still renders',
    still.cameraDrift < 0.001 && still.clockAdvanced < 0.001 &&
    still.rendering && still.displaced === 0 && litPixels > 1000,
    `camera moved ${still.cameraDrift.toFixed(5)} over 1.2 s, scene clock advanced ` +
    `${still.clockAdvanced.toFixed(4)} s, ${still.rendering ? 'still drawing' : 'NOT drawing'}, ` +
    `${still.displaced}/${still.parts} text parts displaced`);
  await session.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);

  // ---------------------------------------------------------- mobile tier
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: MOBILE.width, height: MOBILE.height, deviceScaleFactor: MOBILE.dpr, mobile: true,
  }, sessionId);
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'pointer', value: 'coarse' }],
  }, sessionId);
  await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
    { expect: 'window.__eraser && window.__eraser.render.stage.scene.environment' });
  await settle(session, sessionId, 60);

  const mobile = await scrollProfile(session, sessionId, 5);
  check('the mobile tier is simplified, not disabled',
    mobile.particles <= 210 && mobile.taa === false && mobile.dpr <= 1.25 && mobile.calls > 5,
    `${mobile.particles} particles (desktop ${desktop.particles}), TAA ${mobile.taa ? 'on' : 'off'}, ` +
    `DPR ${mobile.dpr.toFixed(2)}, ${mobile.calls} draw calls`);
  check('mobile holds its 30fps floor',
    mobile.p95 <= MOBILE_FRAME_MS,
    `median ${mobile.median.toFixed(2)} ms, p95 ${mobile.p95.toFixed(2)} ms over ${mobile.frames} frames`);
  check('mobile draw calls within budget', mobile.calls <= MOBILE_DRAW_CALLS,
    `${mobile.calls} calls, ${mobile.triangles} triangles`);

  const noOverflow = await evaluate(session, sessionId, `
    const wide = [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).overflowX !== 'auto';
    }).slice(0, 5).map(el => el.className || el.tagName);
    return { scrollWidth: document.documentElement.scrollWidth, inner: window.innerWidth, wide };`);
  check('no horizontal overflow at 390px',
    noOverflow.scrollWidth <= noOverflow.inner + 1,
    `document ${noOverflow.scrollWidth}px in a ${noOverflow.inner}px viewport` +
    (noOverflow.wide.length ? `; wide: ${noOverflow.wide.join(', ')}` : ''));

  await session.send('Emulation.setEmulatedMedia', { features: [] }, sessionId);
  check('zero console errors across every tier', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  await chrome.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
