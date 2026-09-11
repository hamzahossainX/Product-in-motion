/**
 * Generate the social image and the touch icon from the real render.
 *
 * A stock OG image would be a picture of something that is not the site. These
 * are the site, captured at the sizes the platforms crop to:
 *   node tools/gen-social.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launchChrome, openPage, navigate } from './cdp.mjs';
import { decodePng, encodePng } from './png.mjs';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const ICON_SIZE = 180;

async function evaluate(session, sessionId, expression) {
  const { result } = await session.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`, returnByValue: true, awaitPromise: true,
  }, sessionId);
  return result.value;
}

const chrome = await launchChrome({ gpu: true });
const { session, sessionId } = await openPage(chrome.wsUrl);
await session.send('Emulation.setDeviceMetricsOverride', {
  width: OG_WIDTH, height: OG_HEIGHT, deviceScaleFactor: 1, mobile: false,
}, sessionId);
await navigate(session, sessionId, `${URL_BASE}/?probe=1`,
  { expect: 'window.__eraser && window.__eraser.render.stage.scene.environment' });
await evaluate(session, sessionId, `
  return new Promise(r => { let n = 120;
    const f = () => (--n <= 0) ? r(true) : requestAnimationFrame(f); requestAnimationFrame(f); });`);

const { data } = await session.send('Page.captureScreenshot',
  { format: 'png', captureBeyondViewport: false }, sessionId);
const png = Buffer.from(data, 'base64');
mkdirSync('public', { recursive: true });
writeFileSync('public/og.png', png);
console.log(`wrote public/og.png ${OG_WIDTH}x${OG_HEIGHT} ${(png.length / 1024).toFixed(0)} kB`);

// The touch icon is the centre of the same frame, box-filtered down.
const source = decodePng(png);
const side = Math.min(source.width, source.height);
const left = Math.round((source.width - side) / 2);
const top = Math.round((source.height - side) / 2);
const step = side / ICON_SIZE;
const icon = Buffer.alloc(ICON_SIZE * ICON_SIZE * 3);
for (let y = 0; y < ICON_SIZE; y++) {
  for (let x = 0; x < ICON_SIZE; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = Math.floor(y * step); sy < Math.floor((y + 1) * step); sy++) {
      for (let sx = Math.floor(x * step); sx < Math.floor((x + 1) * step); sx++) {
        const o = ((top + sy) * source.width + left + sx) * source.channels;
        r += source.data[o]; g += source.data[o + 1]; b += source.data[o + 2];
        n++;
      }
    }
    const d = (y * ICON_SIZE + x) * 3;
    icon[d] = Math.round(r / n);
    icon[d + 1] = Math.round(g / n);
    icon[d + 2] = Math.round(b / n);
  }
}
const iconPng = encodePng(ICON_SIZE, ICON_SIZE, 3, icon);
writeFileSync('public/apple-touch-icon.png', iconPng);
console.log(`wrote public/apple-touch-icon.png ${ICON_SIZE}x${ICON_SIZE} ${(iconPng.length / 1024).toFixed(0)} kB`);

await chrome.close();
