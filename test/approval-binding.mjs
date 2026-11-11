/**
 * An approval must mean what it says.
 *
 * Four promises, checked against the real extension in real Chrome and the real
 * bridge server — the things the old suite could not see, because its page was
 * plain HTML with the field already focused and only one tab open:
 *
 *   1. nothing focused   -> the agent is told it failed, not `ok`
 *   2. a field with text -> the text is inserted, not replaced
 *   3. a long payload    -> the prompt counts every character it will type
 *   4. a tab switch      -> refused, and nothing typed into the other page
 *
 * Run: node test/approval-binding.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = "binding-test-token"; // agent token
const EXT_KEY = "binding-ext-key"; // extension key, stored in the extension

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of ["playwright", "/workspace/promi/work/canonote/node_modules/playwright"]) {
    try {
      return require(candidate);
    } catch {
      // try the next one
    }
  }
  throw new Error("playwright not found — npm i -D playwright, or point the path at an install");
}

const { chromium } = loadPlaywright();

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(58)} ${detail}`);
}

const server = spawn(process.execPath, ["bridge-server.mjs"], {
  cwd: EXT,
  env: { ...process.env, AGENTBRIDGE_TOKEN: TOKEN, AGENTBRIDGE_EXTENSION_KEY: EXT_KEY },
});
server.stdout.resume();

const site = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  const which = req.url === "/b" ? "B" : "A";
  res.end(`<html><body>
    <h1>Page ${which}</h1>
    <input id="field" value="${which}-value">
    ${which === "B" ? "" : '<p id="plain">no fields here</p>'}
  </body></html>`);
});
await new Promise((r) => site.listen(8799, "127.0.0.1", r));
await new Promise((r) => setTimeout(r, 400));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ab-binding-")), {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 20000 }));
const extId = worker.url().split("/")[2];

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.evaluate((t) => chrome.storage.local.set({ bridgeToken: t }), EXT_KEY);
const state = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:getState" }));
for (let i = 0; i < 40; i += 1) {
  if ((await state()).connected) break;
  await popup.waitForTimeout(250);
}
check((await state()).connected, "the bridge answers the extension");

const ws = new WebSocket("ws://127.0.0.1:8788");
const results = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "result") results.set(String(m.id), m);
};
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
ws.send(JSON.stringify({ type: "hello", role: "agent", name: "Claude", token: TOKEN }));

let seq = 0;
async function ask(action, params, { beforeApprove } = {}) {
  const id = `binding-${++seq}`;
  ws.send(JSON.stringify({ type: "action", id, action, params }));
  let pending = null;
  for (let i = 0; i < 60; i += 1) {
    const s = await state();
    if (s.pending && s.pending.id === id) {
      pending = s.pending;
      break;
    }
    await popup.waitForTimeout(100);
  }
  if (pending && beforeApprove) await beforeApprove();
  if (pending) await popup.evaluate(() => chrome.runtime.sendMessage({ type: "agentbridge:approve" }));
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (results.has(id)) return { result: results.get(id), pending };
    await popup.waitForTimeout(100);
  }
  return { result: { timeout: true }, pending };
}

// 1 — nothing to type into
const tabA = await context.newPage();
await tabA.goto("http://127.0.0.1:8799/a");
await tabA.bringToFront();
await tabA.evaluate(() => document.activeElement?.blur());
const nothing = await ask("inject", { text: "NOWHERE" });
check(nothing.result?.ok === false, "no focused field is reported as a failure", JSON.stringify(nothing.result?.error));
check(
  (await tabA.evaluate(() => document.body.innerText)).includes("no fields here") &&
    !(await tabA.evaluate(() => document.body.innerText)).includes("NOWHERE"),
  "and the page is untouched"
);

// 2 — a field that already holds text
await tabA.click("#field");
await tabA.evaluate(() => {
  const el = document.getElementById("field");
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
});
const inserted = await ask("inject", { text: " plus" });
const after2 = await tabA.evaluate(() => document.getElementById("field").value);
check(inserted.result?.ok === true, "an insertion reports success", JSON.stringify(inserted.result?.data));
check(after2 === "A-value plus", "and the field keeps what it had", JSON.stringify(after2));
check(
  /A-value/.test(after2) && after2.includes(" plus"),
  "typing inserted at the caret instead of replacing the field"
);

// 3 — a payload longer than the preview
const big = "x".repeat(1024);
const long = await ask("inject", { text: big });
const after3 = await tabA.evaluate(() => document.getElementById("field").value);
check(
  /\b1,024 characters\b/.test(long.pending?.detail || ""),
  "the prompt counts every character it will type",
  JSON.stringify(long.pending?.detail || "").slice(0, 90)
);
check(after3.endsWith(big), "and the whole payload reached the field", `${after3.length} chars in field`);
check(long.result?.data?.characters === 1024, "the result states the size", JSON.stringify(long.result?.data));

// 4 — a tab switch between the question and the answer
const tabB = await context.newPage();
await tabB.goto("http://127.0.0.1:8799/b");
await tabA.bringToFront();
const beforeB = await tabB.evaluate(() => document.getElementById("field").value);
const switched = await ask(
  "inject",
  { text: "LANDED-WRONG" },
  {
    beforeApprove: async () => {
      await tabB.bringToFront();
      await popup.waitForTimeout(300);
    },
  }
);
const afterB = await tabB.evaluate(() => document.getElementById("field").value);
const afterA = await tabA.evaluate(() => document.getElementById("field").value);
check(switched.result?.ok === false, "a page that changed is refused", JSON.stringify(switched.result?.error));
check(afterB === beforeB, "the other page did not receive the text", JSON.stringify(afterB));
check(!afterA.includes("LANDED-WRONG"), "and neither did the page it was asked about");
check(
  /page/i.test(switched.pending?.detail || ""),
  "the prompt names the page it is about",
  JSON.stringify(switched.pending?.detail || "").slice(0, 90)
);

ws.close();
await context.close();
site.close();
server.kill();
console.log(failures === 0 ? "\nPASS  an approval means what it says\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
