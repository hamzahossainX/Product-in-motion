/**
 * Minimal Chrome DevTools Protocol client. Node built-ins only — no dependency.
 * Used by tools/shot.mjs and tools/audit.mjs to drive headless Chrome at an
 * exact viewport (--window-size includes browser chrome and cannot be trusted).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN ?? 'google-chrome';
const LAUNCH_TIMEOUT_MS = 20000;
const POLL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome(port = 9333 + (process.pid % 500)) {
  const profile = mkdtempSync(join(tmpdir(), 'eraser-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
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
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
    await sleep(POLL_MS);
  }
  if (!wsUrl) { proc.kill('SIGKILL'); throw new Error('Chrome did not expose a debugging port'); }

  return {
    wsUrl,
    port,
    async close() {
      proc.kill('SIGTERM');
      await sleep(200);
      proc.kill('SIGKILL');
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
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.method ?? ''})`)) : p.resolve(msg.result);
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
      this.#pending.set(id, { resolve, reject });
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

/** Attach a flat session to a fresh page target. Returns { session, sessionId }. */
export async function openPage(browserWsUrl) {
  const session = await Session.connect(browserWsUrl);
  const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  await session.send('Page.enable', {}, sessionId);
  await session.send('Runtime.enable', {}, sessionId);
  return { session, sessionId, targetId };
}
