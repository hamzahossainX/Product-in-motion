/**
 * Gate screenshot + layout audit harness.
 *   node tools/shot.mjs <url> [outDir]
 * Captures every gate breakpoint at an exact viewport and reports, per size:
 * horizontal overflow, offending elements, computed --screen-unit and type
 * scale, contrast-relevant colours, and full-page height.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';

const VIEWPORTS = [
  { name: '375',      width: 375,  height: 812,  mobile: false, dsf: 2 },
  { name: '768',      width: 768,  height: 1024, mobile: false, dsf: 2 },
  { name: '1024',     width: 1024, height: 768,  mobile: false, dsf: 2 },
  { name: '1440',     width: 1440, height: 900,  mobile: false, dsf: 2 },
  { name: '1920',     width: 1920, height: 1024, mobile: false, dsf: 1 },
  { name: '1440x700', width: 1440, height: 700,  mobile: false, dsf: 2 },
];

const url = process.argv[2] ?? 'http://localhost:5173/';
const outDir = process.argv[3] ?? 'screenshots';
mkdirSync(outDir, { recursive: true });

const AUDIT = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const px = (n) => { const d = document.createElement('div'); d.style.cssText='position:absolute;visibility:hidden;width:'+n;
    document.body.appendChild(d); const w = getComputedStyle(d).width; d.remove(); return w; };
  const de = document.documentElement;
  const overflow = de.scrollWidth - de.clientWidth;
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
    }
    return false;
  };
  const wide = [];
  if (overflow > 0) {
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (inScroller(el)) continue;
      if (r.right > de.clientWidth + 1 || r.left < -1) {
        wide.push({ tag: el.tagName.toLowerCase(), cls: el.className && String(el.className).slice(0,60),
                    id: el.id, left: Math.round(r.left), right: Math.round(r.right) });
      }
    }
  }
  const overlaps = [];
  const sections = [...document.querySelectorAll('section, header, footer')];
  for (const s of sections) {
    const r = s.getBoundingClientRect();
    overlaps.push({ id: s.id || s.tagName.toLowerCase(), top: Math.round(r.top + scrollY), h: Math.round(r.height) });
  }
  return {
    inner: { w: innerWidth, h: innerHeight },
    screenUnit: px('var(--screen-unit)'),
    h1: px('var(--h1)'), h2: px('var(--h2)'), body2: px('var(--body2)'), sub2: px('var(--sub2)'),
    gridColumn: px('var(--grid-column)'), gridGap: px('var(--grid-gap)'), span16: px('var(--grid-span-16)'),
    sitePaddingX: px('var(--site-padding-x)'),
    vhVar: cs.getPropertyValue('--vh').trim(),
    docHeight: de.scrollHeight,
    overflowX: overflow,
    offenders: wide.slice(0, 12),
    sections: overlaps,
    fontsLoaded: document.fonts.status,
    bodyFont: getComputedStyle(document.body).fontFamily,
  };
})()`;

const chrome = await launchChrome();
const results = {};
try {
  for (const vp of VIEWPORTS) {
    const { session, sessionId, targetId } = await openPage(chrome.wsUrl);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf,
      mobile: vp.mobile, screenWidth: vp.width, screenHeight: vp.height,
    }, sessionId);
    await navigate(session, sessionId, url, { expect: "document.querySelectorAll('section').length >= 8" });

    const { result } = await session.send('Runtime.evaluate',
      { expression: AUDIT, returnByValue: true }, sessionId);
    results[vp.name] = result.value;

    const viewportShot = await session.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false }, sessionId);
    writeFileSync(`${outDir}/${vp.name}.png`, Buffer.from(viewportShot.data, 'base64'));

    const full = await session.send('Page.captureScreenshot',
      { format: 'jpeg', quality: 78, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: vp.width, height: Math.min(result.value.docHeight, 30000), scale: 1 } }, sessionId);
    writeFileSync(`${outDir}/${vp.name}-full.jpg`, Buffer.from(full.data, 'base64'));

    session.close();
    await new Promise((r) => setTimeout(r, 60));
    const s2 = await openPage(chrome.wsUrl);
    await s2.session.send('Target.closeTarget', { targetId });
    s2.session.close();
  }
} finally {
  await chrome.close();
}

writeFileSync(`${outDir}/audit.json`, JSON.stringify(results, null, 2));
for (const [name, r] of Object.entries(results)) {
  const bad = r.overflowX > 0 ? `OVERFLOW ${r.overflowX}px` : 'no overflow';
  console.log(`${name.padEnd(9)} ${String(r.inner.w).padStart(4)}x${String(r.inner.h).padStart(4)}  unit=${r.screenUnit.padEnd(10)} h1=${r.h1.padEnd(9)} col=${r.gridColumn.padEnd(9)} gap=${r.gridGap.padEnd(8)} doc=${String(r.docHeight).padStart(6)}px  ${bad}`);
  if (r.offenders.length) for (const o of r.offenders) console.log(`            ↳ ${o.tag}${o.id ? '#' + o.id : ''}.${o.cls} [${o.left}..${o.right}]`);
}
console.log(`\nfonts: ${Object.values(results)[0]?.fontsLoaded}  family: ${Object.values(results)[0]?.bodyFont}`);
