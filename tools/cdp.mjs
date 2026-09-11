/**
 * Minimal Chrome DevTools Protocol client. Node built-ins only — no dependency.
 * Used by tools/shot.mjs and tools/audit.mjs to drive headless Chrome at an
 * exact viewport (--window-size includes browser chrome and cannot be trusted).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CHROME = process.env.CHROME_BIN ?? 'google-chrome';
const LAUNCH_TIMEOUT_MS = 20000;
const POLL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a free port. Deriving one from the pid collides across rapid
 *  sequential runs and attaches to a previous run's dying Chrome. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * `gpu: true` puts the render on the real device. Layout and pixel checks are
 * identical either way, but a frame time measured on SwiftShader says nothing
 * about whether the site holds 60fps, so the perf harness asks for hardware.
 */
export async function launchChrome({ port, gpu = false } = {}) {
  port = port ?? await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'eraser-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    ...(gpu
      ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan',
         '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
      : ['--disable-gpu']),
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--window-size=2200,1400',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
    // detached: Chrome becomes its own process-group leader, which is what
    // makes the whole tree killable below.
  ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
    await sleep(POLL_MS);
  }
  /**
   * Kill the browser — all of it.
   *
   * `proc` is one process; a running Chrome is six or seven. Signalling only
   * the one it was launched as leaves the GPU process, the zygote and every
   * renderer alive and reparented to init, and they keep holding the GPU.
   * Because the child is spawned detached it leads its own process group, so
   * the negative pid signals the entire group in one call.
   *
   * This is not hypothetical: a six-gate sweep leaked twenty-eight processes,
   * the machine went to a load average of 4.9 on 8 cores, and three
   * timing-sensitive checks failed that pass individually — which reads exactly
   * like a performance regression and is not one.
   */
  const killGroup = (signal) => {
    if (proc.pid === undefined) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // No group (already reaped, or a platform without them): fall back to
      // the single process rather than throwing out of an exit handler.
      try { proc.kill(signal); } catch { /* already gone */ }
    }
  };

  if (!wsUrl) { killGroup('SIGKILL'); throw new Error('Chrome did not expose a debugging port'); }

  // A harness that exits on a failed check never reaches its own close(), and
  // the browser it started keeps running. Exit handlers have to be synchronous,
  // so this kills rather than asks.
  const reap = () => killGroup('SIGKILL');
  process.once('exit', reap);
  process.once('SIGINT', () => { reap(); process.exit(130); });
  process.once('uncaughtException', (error) => { reap(); throw error; });

  return {
    wsUrl,
    port,
    async close() {
      process.off('exit', reap);
      killGroup('SIGTERM');
      await sleep(200);
      killGroup('SIGKILL');
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** One CDP websocket session. Handles id/response pairing and event waiting. */
export class Session {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();

  static async connect(url) {
    const s = new Session();
    await s.#open(url);
    return s;
  }

  #open(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(`${p.method} failed: ${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`))
          : p.resolve(msg.result);
      } else {
        for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    return new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', () => resolve(), { once: true });
      this.#ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const fn = (params) => { clearTimeout(timer); resolve(params); };
      this.on(method, fn);
    });
  }

  close() { this.#ws.close(); }
}

/**
 * Navigate and wait until the document is genuinely ready.
 * Page.loadEventFired cannot be trusted here: the about:blank target a fresh
 * page fires its own load event, which resolves the wait before the real
 * navigation has even started. Poll the document instead.
 */
export async function navigate(session, sessionId, url, { expect = 'true', timeoutMs = 30000 } = {}) {
  await session.send('Page.navigate', { url }, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { result } = await session.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && Boolean(${expect})`,
        returnByValue: true,
      }, sessionId);
      if (result.value === true) {
        await session.send('Runtime.evaluate', {
          expression: 'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))',
          awaitPromise: true,
        }, sessionId);
        return;
      }
    } catch { /* context is swapping mid-navigation */ }
    await sleep(POLL_MS);
  }
  throw new Error(`navigation to ${url} never satisfied: ${expect}`);
}

/** Attach a flat session to a fresh page target. Returns { session, sessionId }. */
export async function openPage(browserWsUrl) {
  const session = await Session.connect(browserWsUrl);
  const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  await session.send('Page.enable', {}, sessionId);
  await session.send('Runtime.enable', {}, sessionId);
  return { session, sessionId, targetId };
}
