/**
 * Capture one viewport-sized screenshot per section, at a given width.
 *   node tools/sections.mjs <url> <width> <height> [outDir]
 * Reviewing an 8-section page as one 10,000px strip is useless; this gives one
 * readable frame per section.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';

const url = process.argv[2] ?? 'http://localhost:5177/';
const width = Number(process.argv[3] ?? 1920);
const height = Number(process.argv[4] ?? 1024);
const outDir = process.argv[5] ?? 'screenshots/sections';
mkdirSync(outDir, { recursive: true });

const chrome = await launchChrome();
try {
  const { session, sessionId } = await openPage(chrome.wsUrl);
  await session.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }, sessionId);
  await navigate(session, sessionId, url, { expect: "document.querySelectorAll('section').length >= 8" });

  const { result } = await session.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('section, footer#footer')].map(s => ({
      id: s.id, top: Math.round(s.getBoundingClientRect().top + scrollY),
      h: Math.round(s.getBoundingClientRect().height) }))`,
    returnByValue: true,
  }, sessionId);

  for (const [i, s] of result.value.entries()) {
    // Tall sections get a second frame from their lower half.
    const frames = s.h > height * 1.55 ? [s.top, s.top + s.h - height] : [s.top];
    for (const [j, y] of frames.entries()) {
      await session.send('Runtime.evaluate', { expression: `scrollTo(0, ${Math.max(0, y)})` }, sessionId);
      await new Promise((r) => setTimeout(r, 220));
      const shot = await session.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const name = `${String(i).padStart(2, '0')}-${s.id}${frames.length > 1 ? `-${j + 1}` : ''}.png`;
      writeFileSync(`${outDir}/${name}`, Buffer.from(shot.data, 'base64'));
      console.log(`${name}  top=${s.top} h=${s.h}`);
    }
  }
  session.close();
} finally {
  await chrome.close();
}
