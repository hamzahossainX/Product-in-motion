/**
 * Run every gate harness against a production build.
 *
 *   npm run gates              # all of them
 *   npm run gates -- 5 7       # just those
 *
 * The harnesses each expect a server already listening on 5178, and each one
 * launches its own browser. Starting the server once here — rather than in six
 * separate shells — is the difference between a check you run and a check you
 * mean to run.
 *
 * Node built-ins only, like the harnesses themselves.
 */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const PORT = 5178;
const ORIGIN = `http://localhost:${PORT}/`;
/** Long enough for a cold Chrome launch on a loaded machine, short enough that
 *  a hung harness fails the run instead of stalling it. */
const GATE_TIMEOUT_MS = 10 * 60 * 1000;
const SERVER_TIMEOUT_MS = 60 * 1000;
const POLL_MS = 250;

const ALL = [
  { id: '3', file: 'gate3.mjs', what: 'renderer, post chain, banding, grade' },
  { id: '4', file: 'gate4.mjs', what: 'hero, gobo, particles, allocation' },
  { id: '5', file: 'gate5.mjs', what: 'camera continuity, weighted claims' },
  { id: '6', file: 'gate6.mjs', what: 'text reveals, flippers, preloader, cursor' },
  { id: '7', file: 'gate7.mjs', what: 'the four interactions' },
  { id: '8', file: 'gate8.mjs', what: 'mobile tier, accessibility, budgets' },
];

const wanted = process.argv.slice(2);
const gates = wanted.length ? ALL.filter((g) => wanted.includes(g.id)) : ALL;
if (!gates.length) {
  console.error(`no gate matches ${wanted.join(', ')} — known ids: ${ALL.map((g) => g.id).join(', ')}`);
  process.exit(2);
}

const run = (command, args, options = {}) =>
  spawn(command, args, { stdio: 'inherit', ...options });

async function waitForServer(signal) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('preview server exited before it listened');
    try {
      const response = await fetch(ORIGIN);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`preview server never answered on ${ORIGIN}`);
}

console.log('building…');
const build = run('npm', ['run', 'build']);
const [buildCode] = await once(build, 'exit');
if (buildCode !== 0) process.exit(buildCode ?? 1);

console.log(`serving ${ORIGIN}`);
const server = run('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const gone = new AbortController();
server.once('exit', () => gone.abort());

// The server is a child of this process; if this process dies the port stays
// bound and the next run fails on --strictPort. Kill it on every exit path.
const stop = () => { try { server.kill('SIGKILL'); } catch { /* already gone */ } };
process.once('exit', stop);
process.once('SIGINT', () => { stop(); process.exit(130); });

/**
 * How many browsers the harnesses have left behind.
 *
 * Every gate launches Chrome into a fresh `eraser-cdp-` profile directory, so
 * counting that string in the process table counts leaked browsers and nothing
 * else — not the developer's own Chrome, not the editor.
 *
 * This is reported rather than merely cleaned up because a leak is not a
 * cosmetic problem here: strays keep holding the GPU, and the checks that then
 * fail are the timing-sensitive ones, which reads exactly like a performance
 * regression. Seeing the count next to the result is what tells the two apart.
 */
function strayBrowsers() {
  try {
    const table = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    return table.split('\n').filter((line) =>
      // Both conditions matter. The profile path alone also matches this
      // harness's own `ps` pipeline and anything else quoting the string; the
      // browser binary alone matches the developer's own Chrome.
      line.includes('eraser-cdp-') && /chrom(e|ium)/i.test(line)).length;
  } catch {
    return -1;   // no ps; not worth failing a run over
  }
}

const results = [];
try {
  await waitForServer(gone.signal);

  const before = strayBrowsers();
  if (before > 0) {
    console.log(`\nwarning: ${before} browser processes are already running from a previous run.`);
    console.log('They compete for the GPU and will skew every frame-time check.\n');
  }

  for (const gate of gates) {
    console.log(`\n${'─'.repeat(72)}\ngate ${gate.id} — ${gate.what}\n${'─'.repeat(72)}`);
    const child = run('node', [`tools/${gate.file}`]);
    const timer = setTimeout(() => child.kill('SIGKILL'), GATE_TIMEOUT_MS);
    const [code] = await once(child, 'exit');
    clearTimeout(timer);
    // The gate kills its browser group from its own exit handler, and the
    // kernel needs a moment to reap the tree. Counting immediately reports a
    // leak that clears itself a few milliseconds later.
    await new Promise((r) => setTimeout(r, 500));
    const stray = strayBrowsers();
    if (stray > 0) console.log(`\n  ⚠ gate ${gate.id} leaked ${stray} browser processes`);
    results.push({ ...gate, code, stray });
  }
} finally {
  stop();
}

console.log(`\n${'═'.repeat(72)}`);
for (const r of results) {
  const leak = r.stray > 0 ? `   (leaked ${r.stray} browser processes)` : '';
  console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  gate ${r.id} — ${r.what}${leak}`);
}
const failed = results.filter((r) => r.code !== 0);
console.log(`${'═'.repeat(72)}\n${results.length - failed.length}/${results.length} gates passed`);
process.exit(failed.length ? 1 : 0);
