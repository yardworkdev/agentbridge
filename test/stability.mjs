/**
 * A connection that stays up.
 *
 *   node test/stability.mjs
 *
 * Needs `playwright` resolvable and a Chromium (PLAYWRIGHT_BROWSERS_PATH or the
 * default cache). This exists because the extension reconnected every three
 * seconds for weeks and no test noticed: every suite finished inside the window
 * where the socket was still open. The person saw "the bridge did not prove it is
 * AgentBridge" while the bridge was working, and the fix was one missing
 * clearTimeout. A gate has to outlive the timeout it is testing.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const HOME = fs.mkdtempSync('/tmp/ab-stability-');
const WATCH_MS = 12000;

const failures = [];
const ok = (m) => console.log(`ok    ${m}`);
const bad = (m) => {
  failures.push(m);
  console.log(`FAIL  ${m}`);
};

// A bridge left running from another test holds the port, answers the handshake
// with a different key, and this gate then blames the extension for it. Say so.
const taken = await new Promise((res) => {
  const probe = new net.Socket();
  probe.once('connect', () => {
    probe.destroy();
    res(true);
  });
  probe.once('error', () => res(false));
  probe.connect(8788, '127.0.0.1');
});
if (taken) {
  console.error('something is already listening on 127.0.0.1:8788 — stop it and run this again.');
  process.exit(2);
}

const server = spawn('node', ['bridge-server.mjs'], { cwd: REPO, env: { ...process.env, HOME } });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const keysPath = path.join(HOME, '.agentbridge', 'keys.json');
for (let i = 0; i < 60 && !fs.existsSync(keysPath); i++) await new Promise((r) => setTimeout(r, 100));
if (!fs.existsSync(keysPath)) {
  console.error('the server never wrote keys.json:\n' + log);
  process.exit(1);
}
const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

const ctx = await chromium.launchPersistentContext(path.join(HOME, 'profile'), {
  headless: false,
  chromiumSandbox: false,
  executablePath:
    process.env.CHROME_BIN || '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  args: [
    `--disable-extensions-except=${REPO}`,
    `--load-extension=${REPO}`,
    '--no-sandbox',
  ],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
const id = sw.url().split('/')[2];
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.fill('#tokenInput', keys.extensionKey);
await popup.click('#tokenSaveBtn');
await popup.waitForTimeout(2500);

const state = () =>
  popup.evaluate(async () => {
    const s = await chrome.runtime.sendMessage({ type: 'agentbridge:getState' });
    return { connected: s.connected, error: s.error };
  });
const before = await state();
before.connected ? ok('connected after the key is saved') : bad(`not connected after saving: ${before.error}`);

// Watch longer than the auth timeout: that window is where the churn lived.
const eventsBefore = log.split('\n').filter((l) => l.includes('"event"')).length;
await popup.waitForTimeout(WATCH_MS);
const events = log
  .split('\n')
  .filter((l) => l.includes('"event"'))
  .slice(eventsBefore)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
if (process.env.SHOW_EVENTS) for (const e of events) console.log('  event', JSON.stringify(e));
const drops = events.filter((e) => e.event === 'disconnect' && e.role === 'extension');
const reconnects = events.filter((e) => e.event === 'connect' && e.role === 'extension');

drops.length === 0
  ? ok(`no disconnect in ${WATCH_MS / 1000}s (the auth timeout is gone from the healthy path)`)
  : bad(`${drops.length} disconnect(s) in ${WATCH_MS / 1000}s while idle — the socket is churning`);
reconnects.length === 0
  ? ok('no reconnect was needed')
  : bad(`${reconnects.length} reconnect(s) in ${WATCH_MS / 1000}s`);

const after = await state();
after.connected ? ok('still connected after the window') : bad(`dropped out: ${after.error}`);
after.error ? bad(`the popup is showing an error: ${after.error}`) : ok('no error is being shown');

// An agent must still reach it at the end of the window, not only at the start.
const agent = new WebSocket('ws://127.0.0.1:8788');
const answered = await new Promise((res) => {
  agent.onopen = () => {
    agent.send(JSON.stringify({ type: 'hello', role: 'agent', name: 'stability', token: keys.agentToken }));
    setTimeout(() => agent.send(JSON.stringify({ type: 'action', id: 'st1', action: 'readTab', params: {} })), 250);
  };
  agent.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'result') res(true);
  };
  setTimeout(() => res(false), 4000);
});
answered ? bad('the request was answered without approval — the gate is open') : ok('the request waits for approval; nothing executed');
const queued = await popup.evaluate(async () => {
  const s = await chrome.runtime.sendMessage({ type: 'agentbridge:getState' });
  return Boolean(s.pending);
});
queued ? ok('the popup is showing the request') : bad('the request never reached the popup');

agent.close();
server.kill();
await ctx.close();
fs.rmSync(HOME, { recursive: true, force: true });

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS — the connection holds for ${WATCH_MS / 1000}s and the approval gate still stops an agent.`);
