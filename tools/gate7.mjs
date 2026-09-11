/**
 * Gate 7 harness — the interactive sections.
 *
 * "Genuinely changes the 3D in real time" is a claim about pixels, so every
 * check here drives the control the way a reader would and then looks at the
 * frame. Where an interaction is compared before and after, the frame loop is
 * stopped and stepped by hand, because the scene animates on its own and a
 * moving gobo would otherwise register as the interaction working.
 */
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng } from './png.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const WIDTH = 1440;
const HEIGHT = 900;
/** Fraction of the frame that must move for a change to count as visible. */
const VISIBLE_FRACTION = 0.004;

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

async function shoot(session, sessionId) {
  const { data } = await session.send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false }, sessionId);
  return decodePng(Buffer.from(data, 'base64'));
}

function movedFraction(a, b, levels = 4) {
  let moved = 0;
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  for (let i = 0; i < pixels; i++) {
    const o = i * a.channels;
    if (Math.abs(a.data[o] - b.data[o]) >= levels ||
        Math.abs(a.data[o + 1] - b.data[o + 1]) >= levels) moved++;
  }
  return moved / pixels;
}

const goto = (session, sessionId, id, frames = 50) => evaluate(session, sessionId, `
  const e = window.__eraser;
  const r = e.ranges.all.find(x => x.element === document.getElementById('${id}'));
  e.pane.scrollTo(r.centreScrollPixel(window.innerHeight), true);
  return new Promise(res => { let n = ${frames};
    const f = () => (--n <= 0) ? res(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);

/** Hide the DOM so only the render is compared. */
const hideDom = (session, sessionId, hidden) => evaluate(session, sessionId, `
  for (const el of document.body.children) {
    if (el.id !== 'gl-canvas') el.style.visibility = ${hidden} ? 'hidden' : '';
  }
  return true;`);

async function main() {
  const chrome = await launchChrome({ gpu: true });
  const { session, sessionId } = await openPage(chrome.wsUrl);

  const consoleErrors = [];
  session.on('Runtime.exceptionThrown', (p) =>
    consoleErrors.push(p.exceptionDetails?.exception?.description?.split('\n')[0] ?? 'exception'));
  session.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description).join(' '));
  });

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
    { expect: 'window.__eraser && window.__eraser.render.stage.scene.environment' });
  await evaluate(session, sessionId, 'return new Promise(r => setTimeout(r, 1200));');

  // A hand-stepped frame, so nothing but the interaction moves between shots.
  await evaluate(session, sessionId, `
    const rs = window.__eraser.render, e = window.__eraser;
    window.__step = (dt) => {
      rs.post.resetProfile();
      rs.gobo.reset();
      rs.stage.hero.resetTransform();
      rs.claim(dt, e.pane.scrollPixel, e.pane.progress);
      rs.post.syncProfile();
      rs.draw(dt);
    };
    window.__freeze = () => { e.stop(); window.__step(0); };
    window.__thaw = () => e.start();
    return true;`);

  // --- 1. the slider changes the 3D --------------------------------------
  await goto(session, sessionId, 'hardness');
  await hideDom(session, sessionId, true);
  await evaluate(session, sessionId, `
    const s = window.__eraser.render.interaction;
    s.hardness = 0;
    window.__eraser.render.bridge.hardnessSpring.reset(0);
    window.__freeze();
    return true;`);
  const soft = await shoot(session, sessionId);
  await evaluate(session, sessionId, `
    const s = window.__eraser.render.interaction;
    s.hardness = 1;
    window.__eraser.render.bridge.hardnessSpring.reset(1);
    window.__step(0);
    return true;`);
  const hard = await shoot(session, sessionId);
  const sliderMoved = movedFraction(soft, hard);
  check('the grade slider changes the render',
    sliderMoved > VISIBLE_FRACTION,
    `${(sliderMoved * 100).toFixed(2)}% of pixels moved between 2B and 2H`);
  await evaluate(session, sessionId, 'window.__thaw(); return true;');
  await hideDom(session, sessionId, false);

  // --- 2. the configurator transition is animated, not a swap ------------
  await goto(session, sessionId, 'configurator');
  const transition = await evaluate(session, sessionId, `
    const hero = window.__eraser.render.stage.hero;
    document.querySelectorAll('.configurator__option')[2].click();
    const samples = [];
    for (let i = 0; i < 45; i++) {
      await new Promise(r => requestAnimationFrame(r));
      samples.push({
        scale: Number(hero.mesh.scale.x.toFixed(4)),
        spin: Number(hero.mesh.rotation.y.toFixed(4)),
        variant: hero.variant,
        moving: hero.isTransitioning });
    }
    return samples;`);
  const scales = transition.map((s) => s.scale);
  const spins = transition.map((s) => s.spin);
  const intermediate = scales.filter((s) => s < 0.97 && s > 0.2).length;
  const swapFrame = transition.findIndex((s) => s.variant === 2);
  check('the configurator transition is animated, not a swap',
    intermediate >= 8 && Math.max(...spins) > 1 && swapFrame > 2,
    `${intermediate} frames at an intermediate scale (min ${Math.min(...scales).toFixed(2)}), ` +
    `spin to ${Math.max(...spins).toFixed(2)} rad, model swapped on frame ${swapFrame}`);

  const variantChange = await evaluate(session, sessionId, `
    return { variant: window.__eraser.render.stage.hero.variant,
             tableHighlighted: document.querySelectorAll('.is-current-column').length };`);
  check('the comparison table follows the 3D',
    variantChange.variant === 2 && variantChange.tableHighlighted > 5,
    `model ${variantChange.variant}, ${variantChange.tableHighlighted} cells highlighted`);

  // --- 3. typing renders into the scene ----------------------------------
  await goto(session, sessionId, 'unlearning');
  await hideDom(session, sessionId, true);
  await evaluate(session, sessionId, 'window.__freeze(); return true;');
  const blank = await shoot(session, sessionId);
  await evaluate(session, sessionId, `
    const input = document.getElementById('unlearning-input');
    input.value = 'Delete this sentence';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Three moves, in this order. The loop is frozen, so the first step is what
    // carries the new text into the scene at all; the distance transform then
    // runs in a worker, so the field lands a few milliseconds after that; and
    // only the second step draws with it.
    window.__step(0);
    await new Promise(r => setTimeout(r, 300));
    window.__step(0);
    return true;`);
  const typed = await shoot(session, sessionId);
  const textMoved = movedFraction(blank, typed);
  check('what is typed appears in the 3D scene',
    textMoved > VISIBLE_FRACTION,
    `${(textMoved * 100).toFixed(2)}% of pixels moved when the text was set`);

  // --- 4. dragging the eraser removes it ---------------------------------
  await evaluate(session, sessionId, `
    const sheet = document.getElementById('unlearning-sheet');
    const r = sheet.getBoundingClientRect();
    const send = (type, x, y) => sheet.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, pointerId: 1, bubbles: true, isPrimary: true }));
    send('pointerdown', r.left + r.width * 0.1, r.top + r.height * 0.5);
    for (let i = 1; i <= 30; i++) {
      send('pointermove', r.left + r.width * (0.1 + 0.8 * i / 30), r.top + r.height * 0.5);
      window.__step(1 / 60);
    }
    send('pointerup', r.left + r.width * 0.9, r.top + r.height * 0.5);
    window.__step(0);
    return true;`);
  const erased = await shoot(session, sessionId);
  const erasedMoved = movedFraction(typed, erased);
  check('dragging the eraser removes the text',
    erasedMoved > VISIBLE_FRACTION,
    `${(erasedMoved * 100).toFixed(2)}% of pixels moved during the drag`);

  // --- 5. the same works from touch --------------------------------------
  const touch = await evaluate(session, sessionId, `
    const input = document.getElementById('unlearning-input');
    input.value = 'Touch erases too';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__step(0);
    const sheet = document.getElementById('unlearning-sheet');
    const r = sheet.getBoundingClientRect();
    const before = window.__eraser.render.interaction.eraseQueue.length;
    const send = (type, x, y) => sheet.dispatchEvent(new PointerEvent(type,
      { clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', bubbles: true, isPrimary: true }));
    send('pointerdown', r.left + r.width * 0.2, r.top + r.height * 0.5);
    let queued = 0;
    for (let i = 1; i <= 10; i++) {
      send('pointermove', r.left + r.width * (0.2 + 0.6 * i / 10), r.top + r.height * 0.5);
      queued += window.__eraser.render.interaction.eraseQueue.length;
      window.__step(1 / 60);
    }
    send('pointerup', r.left + r.width * 0.8, r.top + r.height * 0.5);
    // The slider and the magnifier accept the same events.
    const slider = document.getElementById('hardness-slider');
    const sr = slider.getBoundingClientRect();
    slider.dispatchEvent(new PointerEvent('pointerdown',
      { clientX: sr.left + sr.width * 0.9, clientY: sr.top + sr.height / 2,
        pointerId: 8, pointerType: 'touch', bubbles: true, isPrimary: true }));
    const hardnessAfter = window.__eraser.render.interaction.hardness;
    slider.dispatchEvent(new PointerEvent('pointerup',
      { pointerId: 8, pointerType: 'touch', bubbles: true, isPrimary: true }));
    return { queued, hardnessAfter, before };`);
  check('touch drives the same interactions as a mouse',
    touch.queued > 0 && touch.hardnessAfter > 0.6,
    `${touch.queued} erase strokes queued from touch moves, ` +
    `slider reached ${touch.hardnessAfter.toFixed(2)} from a touch press`);
  await evaluate(session, sessionId, 'window.__thaw(); return true;');
  await hideDom(session, sessionId, false);

  // --- 6. every control is reachable and announced -----------------------
  const affordances = await evaluate(session, sessionId, `
    const rows = [];
    const add = (id, note) => {
      const el = document.getElementById(id);
      if (!el) return rows.push({ id, ok: false, why: 'missing' });
      const focusable = el.tabIndex >= 0 || ['INPUT','BUTTON','SELECT'].includes(el.tagName);
      const named = Boolean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
        document.querySelector('label[for="' + id + '"]'));
      const cursor = el.getAttribute('data-cursor');
      rows.push({ id, ok: focusable && named, focusable, named, cursor, note });
    };
    add('unlearning-input');
    add('unlearning-erase');
    add('hardness-slider');
    add('abrasion-zoom-box');
    return rows;`);
  const missing = affordances.filter((a) => !a.ok);
  check('every control is focusable and has an accessible name',
    missing.length === 0,
    missing.length ? missing.map((m) => `${m.id}: focusable=${m.focusable} named=${m.named}`).join(', ')
      : affordances.map((a) => a.id).join(', '));

  // --- 7. the drag springs rather than tracking linearly -----------------
  const spring = await evaluate(session, sessionId, `
    const rs = window.__eraser.render;
    rs.interaction.hardness = 0;
    rs.bridge.hardnessSpring.reset(0);
    rs.interaction.hardness = 1;
    const trace = [];
    for (let i = 0; i < 30; i++) { window.__step(1 / 60); trace.push(rs.bridge.hardnessSpring.value); }
    return trace;`);
  const firstStep = spring[0];
  const settled = spring[spring.length - 1];
  check('a control change springs instead of snapping',
    firstStep < 0.2 && settled > 0.9,
    `after one frame ${firstStep.toFixed(3)}, after 30 ${settled.toFixed(3)}`);

  // --- 8. typing does not hitch the frame --------------------------------
  await evaluate(session, sessionId, 'window.__thaw(); return true;');
  const typing = await evaluate(session, sessionId, `
    const input = document.getElementById('unlearning-input');
    const phrase = 'the quick brown fox jumps over it';
    // Warm up: the first frame after the loop restarts, and the worker's first
    // message, are startup costs and not what "hitch while typing" means.
    input.value = 'warm';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 700));

    const deltas = [];
    let last = performance.now();
    for (let i = 1; i <= phrase.length; i++) {
      input.value = phrase.slice(0, i);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    const worst = Math.max(...deltas);
    const worstAt = deltas.indexOf(worst);
    const sorted = [...deltas].sort((a, b) => a - b);
    return { median: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)],
             worst, worstAt, frames: deltas.length,
             over33: deltas.filter(d => d > 33.4).length };`);
  check('typing does not hitch the frame',
    typing.p95 < 34 && typing.over33 <= 1,
    `${typing.frames} keystrokes, median ${typing.median.toFixed(1)} ms, ` +
    `p95 ${typing.p95.toFixed(1)} ms, worst ${typing.worst.toFixed(1)} ms at keystroke ` +
    `${typing.worstAt}, ${typing.over33} frames over 33.4 ms`);

  // --- 9. budgets --------------------------------------------------------
  await goto(session, sessionId, 'abrasion');
  const info = await evaluate(session, sessionId, `
    const i = window.__eraser.render.renderer.gl.info;
    return { calls: i.render.calls, triangles: i.render.triangles };`);
  check('draw calls within budget with the magnifier open', info.calls <= 80,
    `${info.calls} calls, ${info.triangles} triangles`);

  check('zero console errors', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'clean');

  await chrome.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
