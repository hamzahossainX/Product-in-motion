/**
 * Cross-browser check: the same page, in Gecko.
 *
 * Firefox 129 dropped CDP in favour of WebDriver BiDi, so this speaks BiDi
 * over the same kind of raw WebSocket the Chrome harness uses. It is a
 * different engine, a different WebGL backend and a different font stack, and
 * "it works in Chrome" says nothing about any of them.
 *
 *   node tools/firefox.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const URL_BASE = process.env.URL_BASE ?? 'http://localhost:5178';
const OUT = process.env.OUT ?? '/tmp/firefox-eraser.png';
const LAUNCH_TIMEOUT_MS = 40000;
const SETTLE_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class Bidi {
  #ws; #id = 0; #pending = new Map();

  static async connect(url) {
    const session = new Bidi();
    session.#ws = new WebSocket(url);
    session.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = session.#pending.get(message.id);
      if (!entry) return;
      session.#pending.delete(message.id);
      message.type === 'error'
        ? entry.reject(new Error(`${entry.method}: ${message.error} ${message.message ?? ''}`))
        : entry.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener('open', () => resolve(), { once: true });
      session.#ws.addEventListener('error', () => reject(new Error('BiDi socket error')), { once: true });
    });
    return session;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.#ws.close(); }
}

const port = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'eraser-firefox-'));
const proc = spawn('firefox', [
  '--headless',
  '--no-remote',
  '--profile', profile,
  '--remote-debugging-port', String(port),
  // The Remote Agent rejects a WebSocket upgrade whose Host or Origin it does
  // not recognise, and Node's client sends one. Without these the socket is
  // refused before any BiDi command is sent.
  '--remote-allow-hosts', '127.0.0.1,localhost',
  '--remote-allow-origins', '*',
  '--window-size', '1440,900',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Firefox announces the endpoint on stderr and serves nothing at /json/version
// — that is a Chrome convention, and this is not Chrome.
let wsUrl = null;
const onOutput = (chunk) => {
  const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(String(chunk));
  if (match) wsUrl = match[1];
};
proc.stdout.on('data', onOutput);
proc.stderr.on('data', onOutput);

const reap = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
process.once('exit', reap);

const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
while (Date.now() < deadline && !wsUrl) await sleep(200);
if (!wsUrl) { proc.kill('SIGKILL'); throw new Error('Firefox did not announce a BiDi endpoint'); }

// The announced URL is the base; the socket itself is served at /session.
const session = await Bidi.connect(`${wsUrl.replace(/\/$/, '')}/session`);
await session.send('session.new', { capabilities: {} });
const { context } = await session.send('browsingContext.create', { type: 'tab' });
await session.send('browsingContext.navigate', {
  context, url: `${URL_BASE}/?probe=1`, wait: 'complete',
});
await sleep(SETTLE_MS);

const evaluate = async (expression) => {
  const result = await session.send('script.evaluate', {
    expression, target: { context }, awaitPromise: true, resultOwnership: 'none',
  });
  if (result.type === 'exception') throw new Error(result.exceptionDetails?.text ?? 'exception');
  return result.result;
};

const deserialise = (value) => {
  if (!value) return value;
  if (value.type === 'object') {
    return Object.fromEntries((value.value ?? []).map(([k, v]) => [k, deserialise(v)]));
  }
  if (value.type === 'array') return (value.value ?? []).map(deserialise);
  return value.value;
};

const report = deserialise(await evaluate(`(() => {
  const app = window.__eraser;
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = app && app.render ? app.render.renderer.gl.info : null;
  return {
    engine: navigator.userAgent.includes('Firefox') ? 'Gecko' : 'other',
    webgl2: !!gl,
    canvasMounted: !!document.getElementById('gl-canvas'),
    webglRunning: !!(app && app.render),
    preloaderGone: !document.querySelector('.preloader'),
    drawCalls: info ? info.render.calls : -1,
    triangles: info ? info.render.triangles : -1,
    splitWrappers: document.querySelectorAll('.split-line-mask, .split-word-mask').length,
    flippers: document.querySelectorAll('.is-flipper').length,
    headings: document.querySelectorAll('h1, h2, h3').length,
    documentHeight: document.documentElement.scrollHeight,
    heroFontSize: getComputedStyle(document.querySelector('.hero__title')).fontSize,
    scrollLimit: app ? Math.round(app.pane.limit) : -1,
  };
})()`));

console.log(JSON.stringify(report, null, 2));

const shot = await session.send('browsingContext.captureScreenshot', { context });
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${OUT}`);

session.close();
proc.kill('SIGTERM');
await sleep(300);
proc.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }

const ok = report.webgl2 && report.webglRunning && report.preloaderGone &&
  report.drawCalls > 5 && report.splitWrappers > 20;
console.log(ok ? 'Gecko: OK' : 'Gecko: FAILED');
process.exit(ok ? 0 : 1);
