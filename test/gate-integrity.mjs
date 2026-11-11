/**
 * The gate underneath the gate: who may speak, who may listen, and what happens
 * to the requests that arrive while one is already waiting.
 *
 *   1. an agent token cannot take the browser's place at the gate
 *   2. a server on 8788 that does not hold the extension key never receives it
 *   3. the keys survive a restart, and only the owner can read the file
 *   4. a second request queues instead of being denied as "busy"
 *   5. nothing of this extension sits on a page until an approved action needs it
 *
 * Run: node test/gate-integrity.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_TOKEN = "gate-agent-token";
const EXT_KEY = "gate-extension-key";
const IMPOSTOR_KEY = "not-the-key";

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of ["playwright", "/workspace/promi/work/canonote/node_modules/playwright"]) {
    try {
      return require(candidate);
    } catch {
      // next
    }
  }
  throw new Error("playwright not found");
}
const { chromium } = loadPlaywright();

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(56)} ${detail}`);
}

function startBridge(env) {
  const child = spawn(process.execPath, ["bridge-server.mjs"], {
    cwd: EXT,
    env: { ...process.env, AGENTBRIDGE_TOKEN: AGENT_TOKEN, ...env },
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 3. keys
{
  const file = join(homedir(), ".agentbridge", "keys.json");
  if (!statSync(file, { throwIfNoEntry: false })) {
    const first = startBridge({});
    await wait(1500);
    first.kill();
    await wait(700);
  }
  const before = JSON.parse(readFileSync(file, "utf8"));
  const mode = statSync(file).mode & 0o777;
  check(mode === 0o600, "the key file is readable only by its owner", `mode ${mode.toString(8)}`);
  const again = startBridge({ AGENTBRIDGE_TOKEN: "", AGENTBRIDGE_EXTENSION_KEY: "" });
  await wait(1200);
  again.kill();
  await wait(700); // let go of 8788 before the next server asks for it
  const after = JSON.parse(readFileSync(file, "utf8"));
  check(
    after.agentToken === before.agentToken && after.extensionKey === before.extensionKey,
    "a restart keeps the same keys",
    `${after.agentToken === before.agentToken ? "agent token same" : "agent token CHANGED"}`
  );
}

// ------------------------------------------- 1. an agent cannot be the browser
{
  const server = startBridge({ AGENTBRIDGE_EXTENSION_KEY: EXT_KEY });
  await wait(900);
  const ws = new WebSocket("ws://127.0.0.1:8788");
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "hello", role: "extension", name: "AgentBridge", token: AGENT_TOKEN }));
  const reply = await new Promise((resolve) => {
    ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true });
    setTimeout(() => resolve(null), 4000);
  });
  check(
    reply?.type === "error" && /extension key/.test(reply.error || ""),
    "an agent token is refused for the browser role",
    JSON.stringify(reply)
  );
  ws.close();
  server.kill();
  await wait(500);
}

// ------------------------- 2. a server without the key never gets the key
{
  const impostor = startBridge({ AGENTBRIDGE_EXTENSION_KEY: IMPOSTOR_KEY });
  await wait(900);
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ab-gate-")), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const extId = worker.url().split("/")[2];
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.evaluate((k) => chrome.storage.local.set({ bridgeToken: k }), EXT_KEY);
  const state = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }));
  let refused = null;
  for (let i = 0; i < 40; i += 1) {
    const s = await state();
    if (s.error) {
      refused = s;
      break;
    }
    await popup.waitForTimeout(200);
  }
  check(!!refused && !refused.connected, "a server that cannot prove itself is refused", refused?.error || "no error");
  check(/not AgentBridge/i.test(refused?.error || ""), "and says why", JSON.stringify(refused?.error || ""));
  await context.close();
  impostor.kill();
  await wait(600);

  // ...and the genuine server still works, so the check did not just break the client
  const real = startBridge({ AGENTBRIDGE_EXTENSION_KEY: EXT_KEY });
  await wait(900);
  const context2 = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ab-gate2-")), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const worker2 = context2.serviceWorkers()[0] || (await context2.waitForEvent("serviceworker", { timeout: 20000 }));
  const popup2 = await context2.newPage();
  await popup2.goto(`chrome-extension://${worker2.url().split("/")[2]}/popup.html`);
  await popup2.evaluate((k) => chrome.storage.local.set({ bridgeToken: k }), EXT_KEY);
  let connected = false;
  for (let i = 0; i < 40; i += 1) {
    if ((await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }))).connected) {
      connected = true;
      break;
    }
    await popup2.waitForTimeout(200);
  }
  check(connected, "the genuine bridge connects after the impostor is gone");

  // ------------------------------------ 4. a second request queues
  const site = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<html><body><input id="field" value="start"><p id="marker">plain page</p></body></html>');
  });
  await new Promise((r) => site.listen(8799, "127.0.0.1", r));
  const page = await context2.newPage();
  await page.goto("http://127.0.0.1:8799/");
  await page.bringToFront();
  await page.click("#field");
  await page.evaluate(() => {
    const el = document.getElementById("field");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  // 5. nothing of the extension is declared to run on every page
  const declared = await context2.newPage();
  await declared.goto(`chrome-extension://${worker2.url().split("/")[2]}/manifest.json`);
  const manifest = JSON.parse(await declared.evaluate(() => document.body.innerText));
  check(!manifest.content_scripts, "the manifest declares no always-on content script");
  check(
    ((await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }))).fallbackTabs || [])
      .length === 0,
    "and none has been loaded into a tab"
  );
  await declared.close();
  await page.bringToFront(); // the manifest page was in front; the requests are about this one

  const ws = new WebSocket("ws://127.0.0.1:8788");
  const results = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "result") results.set(String(m.id), m);
  };
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.send(JSON.stringify({ type: "hello", role: "agent", name: "Claude", token: AGENT_TOKEN }));
  await wait(300);

  ws.send(JSON.stringify({ type: "action", id: "q-1", action: "inject", params: { text: " ONE" } }));
  await wait(400);
  ws.send(JSON.stringify({ type: "action", id: "q-2", action: "inject", params: { text: " TWO" } }));
  await wait(600);

  const queued = await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }));
  check(queued.queue?.length === 2, "both requests are waiting", `${queued.queue?.length} in queue`);
  check(queued.queue?.[0]?.id === "q-1", "in the order they arrived");

  const approve = (id) =>
    popup2.evaluate(() => {
      // Approve the request the person is being asked about.
      return chrome.runtime.sendMessage({ type: "agentbridge:approve" });
    });

  await approve("q-1");
  for (let i = 0; i < 40 && !results.has("q-1"); i += 1) await popup2.waitForTimeout(100);
  check(results.get("q-1")?.ok === true, "the first request runs", JSON.stringify(results.get("q-1")?.data));
  check(!results.has("q-2"), "and the second is still waiting, not denied as busy");

  await wait(200);
  await approve("q-2");
  for (let i = 0; i < 40 && !results.has("q-2"); i += 1) await popup2.waitForTimeout(100);
  check(results.get("q-2")?.ok === true, "the second request runs when its turn comes", JSON.stringify(results.get("q-2")?.data));
  check(
    (await page.evaluate(() => document.getElementById("field").value)) === "start ONE TWO",
    "both insertions landed, in order",
    JSON.stringify(await page.evaluate(() => document.getElementById("field").value))
  );

  // ...and the clipboard path that works directly loads nothing extra
  ws.send(JSON.stringify({ type: "action", id: "q-3", action: "readClipboard", params: {} }));
  for (let i = 0; i < 40; i += 1) {
    const s = await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }));
    if (s.pending?.id === "q-3") break;
    await popup2.waitForTimeout(100);
  }
  await approve("q-3");
  await wait(1500);
  const afterClipboard = await popup2.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }));
  check(
    (afterClipboard.fallbackTabs || []).length === 0,
    "a clipboard the page answers directly loads nothing extra",
    JSON.stringify(afterClipboard.fallbackTabs)
  );

  // The fallback itself, injected the way the background injects it: into one tab,
  // when it is needed, and answering afterwards.
  const injected = await popup2.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const pong = await chrome.tabs.sendMessage(tab.id, { type: "agentbridge:ping" });
    return pong;
  });
  check(injected?.ok === true, "the on-demand fallback answers once injected", JSON.stringify(injected));

  ws.close();
  await context2.close();
  site.close();
  real.kill();
}

console.log(failures === 0 ? "\nPASS  the gate holds\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
