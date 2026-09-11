/**
 * Gate 6 harness — text reveals, letter flippers, preloader, cursor.
 *
 * The gate's items are mostly claims about how motion feels, and each one has a
 * measurable form: a masked rise is a transform on a clipped parent rather than
 * an opacity change; "identically fast" is a sweep duration; "springs, does not
 * snap" is a trajectory that lags and converges.
 */
import { launchChrome, openPage, navigate } from './cdp.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const WIDTH = 1440;
const HEIGHT = 900;

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

const settle = (session, sessionId, frames = 8) => evaluate(session, sessionId, `
  return new Promise(r => { let n = ${frames};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);

const seek = (session, sessionId, pixel, frames = 24) => evaluate(session, sessionId, `
  window.__eraser.pane.scrollTo(${pixel}, true);
  return new Promise(r => { let n = ${frames};
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);

async function main() {
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
    { expect: 'window.__eraser && window.__eraser.render' });

  // --- 1. the preloader is honest, and it goes away ----------------------
  const preload = await evaluate(session, sessionId, `
    const start = performance.now();
    const seen = [];
    while (performance.now() - start < 4000) {
      const el = document.querySelector('.preloader');
      if (!el) break;
      seen.push(Number(getComputedStyle(el).opacity));
      await new Promise(r => requestAnimationFrame(r));
    }
    return { visibleMs: performance.now() - start, samples: seen.length,
             gone: !document.querySelector('.preloader'),
             maxOpacity: seen.length ? Math.max(...seen) : 0,
             loaderProgress: window.__eraser.render.loader.progress };`);
  check('preloader shows, completes and removes itself',
    preload.gone && preload.maxOpacity > 0.9 && preload.visibleMs >= 100,
    `visible ${Math.round(preload.visibleMs)} ms over ${preload.samples} frames, ` +
    `loader progress ${preload.loaderProgress}`);

  await settle(session, sessionId, 20);

  // --- 2. reveals are masked rises, not fades ----------------------------
  const masked = await evaluate(session, sessionId, `
    const wrappers = [...document.querySelectorAll('.split-line-mask, .split-word-mask')];
    const clipped = wrappers.filter(w => ['hidden', 'clip'].includes(getComputedStyle(w).overflow)).length;
    // A part that has not been revealed yet must be displaced, and must not be
    // transparent: a fade is the failure mode this gate exists to catch.
    const parts = [...document.querySelectorAll('.split-char, .split-word, .split-line')].slice(0, 400);
    let displaced = 0;
    let faded = 0;
    for (const p of parts) {
      const s = getComputedStyle(p);
      const m = new DOMMatrixReadOnly(s.transform);
      if (Math.abs(m.f) > 0.5) displaced++;
      if (Number(s.opacity) < 0.99) faded++;
    }
    return { wrappers: wrappers.length, clipped, parts: parts.length, displaced, faded };`);
  check('reveals are masked rises with no opacity fade',
    masked.wrappers > 20 && masked.clipped === masked.wrappers &&
    masked.displaced > 0 && masked.faded === 0,
    `${masked.clipped}/${masked.wrappers} wrappers clipped, ` +
    `${masked.displaced}/${masked.parts} parts displaced, ${masked.faded} faded`);

  // --- 3. reveals scrub deterministically both ways ----------------------
  const limit = await evaluate(session, sessionId, 'return window.__eraser.pane.limit;');
  // Sampled across the whole document with a stride, not the first N: the
  // first forty parts are all in the hero, which is fully revealed at every
  // scroll position past the top, so they would show nothing mid-reveal
  // whatever the reveals were doing.
  const readParts = `
    const all = [...document.querySelectorAll('.split-char, .split-word, .split-line')];
    const stride = Math.max(1, Math.ceil(all.length / 600));
    const out = [];
    for (let i = 0; i < all.length; i += stride) {
      out.push(Math.round(new DOMMatrixReadOnly(getComputedStyle(all[i]).transform).f * 100) / 100);
    }
    return out;`;
  // Find a position where parts are genuinely part-way through their reveal.
  // Comparing two fully-revealed states proves nothing about scrubbing.
  let probe = Math.round(limit * 0.30);
  let midCount = 0;
  for (let i = 1; i < 40; i++) {
    const candidate = Math.round((i / 40) * limit);
    await seek(session, sessionId, candidate, 14);
    const values = await evaluate(session, sessionId, readParts);
    const partial = values.filter((v) => Math.abs(v) > 0.5 && Math.abs(v) < 40).length;
    if (partial > midCount) { midCount = partial; probe = candidate; }
    if (midCount >= 8) break;
  }

  await seek(session, sessionId, 0, 20);
  await seek(session, sessionId, probe, 30);
  const forward = await evaluate(session, sessionId, readParts);
  await seek(session, sessionId, limit, 20);
  await seek(session, sessionId, probe, 30);
  const backward = await evaluate(session, sessionId, readParts);
  const maxDelta = Math.max(...forward.map((v, i) => Math.abs(v - backward[i])));
  const partlyRevealed = forward.filter((v) => Math.abs(v) > 0.5).length;
  check('reveals scrub backwards to the same state as forwards',
    maxDelta < 0.02 && forward.length > 5 && partlyRevealed > 0,
    `at ${probe} px: ${forward.length} parts sampled, ${partlyRevealed} mid-reveal, ` +
    `largest forward/backward difference ${maxDelta.toFixed(3)} px`);

  // --- 4. flippers: same sweep whatever the word length ------------------
  const flip = await evaluate(session, sessionId, `
    const f = window.__eraser.flippers;
    const rows = f.elements.map(el => ({
      text: (el.getAttribute('aria-label') || '').trim(),
      chars: (el.getAttribute('aria-label') || '').trim().length,
      sweep: f.sweepSeconds(el) }));
    rows.sort((a, b) => a.chars - b.chars);
    return { count: rows.length, shortest: rows[0], longest: rows[rows.length - 1] };`);
  const ratio = flip.longest.sweep / flip.shortest.sweep;
  check('a short link and a long link sweep in the same time',
    flip.count > 5 && ratio < 1.35 && ratio > 0.74,
    `${flip.count} flippers; "${flip.shortest.text}" (${flip.shortest.chars} chars) ` +
    `${flip.shortest.sweep.toFixed(3)} s vs "${flip.longest.text}" (${flip.longest.chars}) ` +
    `${flip.longest.sweep.toFixed(3)} s — ${ratio.toFixed(2)}x`);

  // --- 5. hovering actually moves the characters -------------------------
  const hover = await evaluate(session, sessionId, `
    const f = window.__eraser.flippers;
    const el = f.elements.find(e => e.offsetParent !== null) || f.elements[0];
    const char = el.querySelector('.flip__char');
    const before = new DOMMatrixReadOnly(getComputedStyle(char).transform).f;
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    await new Promise(r => setTimeout(r, 260));
    const during = new DOMMatrixReadOnly(getComputedStyle(char).transform).f;
    el.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    await new Promise(r => setTimeout(r, 400));
    const after = new DOMMatrixReadOnly(getComputedStyle(char).transform).f;
    return { before, during, after, label: el.getAttribute('aria-label') };`);
  check('hover flips the characters and releases them',
    Math.abs(hover.during - hover.before) > 2 && Math.abs(hover.after) < 1,
    `"${hover.label}" y ${hover.before.toFixed(1)} -> ${hover.during.toFixed(1)} -> ${hover.after.toFixed(1)} px`);

  // --- 6. re-splitting on resize causes no layout shift ------------------
  const shift = await evaluate(session, sessionId, `
    const heading = document.querySelector('.statement__title') || document.querySelector('h2');
    const before = { h: document.body.scrollHeight, r: heading.getBoundingClientRect().height };
    window.__eraser.reveals.resplit();
    await new Promise(r => requestAnimationFrame(r));
    const after = { h: document.body.scrollHeight, r: heading.getBoundingClientRect().height };
    return { before, after };`);
  check('re-splitting does not shift layout',
    Math.abs(shift.after.h - shift.before.h) < 2 &&
    Math.abs(shift.after.r - shift.before.r) < 1,
    `document ${shift.before.h} -> ${shift.after.h} px, heading ` +
    `${shift.before.r.toFixed(1)} -> ${shift.after.r.toFixed(1)} px`);

  // --- 7. the cursor lags and converges ----------------------------------
  const cursorTrace = await evaluate(session, sessionId, `
    const el = document.querySelector('.cursor');
    const send = (x, y) => window.dispatchEvent(new PointerEvent('pointermove',
      { clientX: x, clientY: y, bubbles: true }));
    send(200, 200);
    await new Promise(r => setTimeout(r, 600));
    send(1100, 700);
    const trace = [];
    for (let i = 0; i < 40; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      trace.push([Math.round(m.m41), Math.round(m.m42)]);
    }
    return trace;`);
  const first = cursorTrace[0];
  const last = cursorTrace[cursorTrace.length - 1];
  const snapped = Math.hypot(first[0] - 1100, first[1] - 700) < 40;
  const converged = Math.hypot(last[0] - 1100, last[1] - 700) < 40;
  check('cursor springs to the pointer instead of snapping',
    !snapped && converged,
    `after 1 frame (${first[0]}, ${first[1]}), after 40 (${last[0]}, ${last[1]}), target (1100, 700)`);

  // --- 8. reduced motion leaves every reveal at rest ----------------------
  const reduced = await evaluate(session, sessionId, `
    window.__eraser.reveals.setEnabled(false);
    await new Promise(r => requestAnimationFrame(r));
    const parts = [...document.querySelectorAll('.split-char, .split-word, .split-line')].slice(0, 200);
    const hidden = parts.filter(p =>
      Math.abs(new DOMMatrixReadOnly(getComputedStyle(p).transform).f) > 1).length;
    window.__eraser.reveals.setEnabled(true);
    return { parts: parts.length, hidden };`);
  check('reduced motion leaves no text displaced off its line',
    reduced.hidden === 0 && reduced.parts > 5,
    `${reduced.hidden} of ${reduced.parts} parts still displaced`);

  check('zero console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  await chrome.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
