#!/usr/bin/env node
/**
 * AgentBridge E2E — end-to-end test harness. Zero dependencies.
 *
 * Flow:
 *  1. Start bridge-server.mjs (child) -> assert listening on ws://127.0.0.1:8788.
 *  2. Launch Chrome for Testing with the extension loaded
 *     (--load-extension + --remote-debugging-port, headful under xvfb-run).
 *  3. Connect an agent client over WS.
 *  4. Navigate the main tab to a real local test page (content scripts only
 *     inject into real http(s) pages — about:blank/data: block them), and
 *     grant clipboard permissions via CDP for that origin.
 *  5. readTab    -> approve via popup UI path -> assert shape.
 *  6. deny path  -> assert {ok:false, error:"denied by user"}.
 *  7. writeClipboard -> readClipboard -> assert roundtrip.
 *  8. inject     -> assert page field contains text.
 *  9. Report PASS/FAIL per scenario in test/RESULTS.md. Exit 0 only if all pass.
 *
 * Approvals are triggered by evaluating chrome.runtime.sendMessage
 * ({type:"agentbridge:approve"|"agentbridge:deny"}) in the popup PAGE context
 * via CDP — the EXACT same call the popup buttons make. This exercises the
 * real approval gate (busy/timeout rules) through the real popup page.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(__dirname, "..");
const SERVER = path.join(__dirname, "..", "bridge-server.mjs");
const SERVER_PORT = 8788;
const BRIDGE_URL = `ws://127.0.0.1:${SERVER_PORT}`;
const BRIDGE_TOKEN = "e2e-token"; // agent token
const EXT_KEY = "e2e-ext-key"; // extension key, stored in the extension
const CDP_PORT = 9223;
const TEST_PAGE_PORT = 8799;
const TEST_PAGE_URL = `http://127.0.0.1:${TEST_PAGE_PORT}/`;
const CHROME = process.env.CHROME_BIN || "/tmp/chrome-cft/chrome/linux-152.0.7977.42/chrome-linux64/chrome";
const PROFILE = "/tmp/agentbridge-chrome-profile";

const RESULTS_PATH = path.join(__dirname, "RESULTS.md");
const results = []; // {name, ok, detail}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`.trim());
}

// Optional proof screenshots: only active when E2E_SHOT_DIR is set.
// Without it the harness behaves exactly as before (zero behavior change).
// Best-effort ONLY: a frozen/throttled tab can block Page.captureScreenshot
// until Chrome unfreezes it (observed: ~60s), so every shot races a 5s
// timeout — the decision path must never wait on a screenshot.
const SHOT_DIR = process.env.E2E_SHOT_DIR || null;
async function shot(cdp, name) {
  if (!SHOT_DIR) return;
  try {
    const { data } = await withTimeout(
      cdp.send("Page.captureScreenshot", { format: "png" }),
      5000,
      `screenshot ${name}`
    );
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`[diag] screenshot: ${name}.png`);
  } catch (e) {
    console.log(`[diag] screenshot ${name} skipped: ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Race a promise against a timeout — nothing in the harness may hang forever. */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/** PUT /json/new?<url> — open a new tab. */
function openNewTab(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: CDP_PORT,
        path: `/json/new?${encodeURIComponent(url)}`,
        method: "PUT",
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** Connect a WebSocket and resolve once open. */
function wsConnect(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
}

/** Wait for the next message on a WS, parse JSON. */
function nextMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    const h = (ev) => {
      clearTimeout(t);
      ws.removeEventListener("message", h);
      resolve(JSON.parse(ev.data));
    };
    ws.addEventListener("message", h);
  });
}

/**
 * Wait for the RESULT message for a specific action id, ignoring any
 * interleaved status broadcasts from the bridge (they race with results).
 */
function nextResult(ws, id, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeEventListener("message", h);
      reject(new Error(`no result for ${id}`));
    }, timeoutMs);
    const h = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "result" && msg.id === id) {
        clearTimeout(t);
        ws.removeEventListener("message", h);
        resolve(msg);
      }
    };
    ws.addEventListener("message", h);
  });
}

/** Simple CDP client over WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`evaluate exception: ${JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text)}`);
    }
    return res.result?.value;
  }
}

async function waitForTarget(predicate, timeoutMs = 30_000, label = "target") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const hit = targets.find(predicate);
      if (hit) return hit;
    } catch {
      // chrome not up yet
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Find the service worker of OUR extension by asking each candidate for its
// manifest name. A stale copy of the extension (reloaded from a leftover
// profile) can register a second background.js SW with a different ID; the
// first-match approach attaches to the wrong one.
async function findAgentBridgeSw() {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < 30_000) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const candidates = targets.filter(
        (t) => t.type === "service_worker" && t.url.includes("background.js")
      );
      for (const t of candidates) {
        try {
          const ws = await wsConnect(t.webSocketDebuggerUrl);
          const cdp = new Cdp(ws);
          await cdp.send("Runtime.enable");
          const name = await cdp
            .evaluate(`chrome.runtime.getManifest().name`)
            .catch(() => "");
          ws.close();
          if (typeof name === "string" && name.toLowerCase().includes("agentbridge")) {
            console.log(`[diag] SW ${t.url.slice(0, 70)} -> name "${name}"`);
            return t;
          }
          console.log(`[diag] SW ${t.url.slice(0, 70)} -> name "${String(name).slice(0, 40)}" (skip)`);
        } catch (e) {
          lastErr = e;
        }
      }
    } catch {
      // chrome not up yet
    }
    await sleep(500);
  }
  throw new Error(`timeout finding AgentBridge SW${lastErr ? ": " + lastErr.message : ""}`);
}

async function main() {
  // ---- 0. Pre-flight: hermetic environment ----
  // Kill any stale bridge server AND leftover Chrome from a crashed run.
  // (A crashed run's unhandled rejection can bypass the finally cleanup,
  // leaving the server holding 8788 and/or Chrome holding 9223 — the stale
  // Chrome then answers /json/list with ITS targets and breaks the run.)
  try {
    const busy = await new Promise((res) => {
      const probe = net.createConnection({ host: "127.0.0.1", port: SERVER_PORT, timeout: 500 });
      probe.on("connect", () => {
        probe.destroy();
        res(true);
      });
      probe.on("error", () => {
        probe.destroy();
        res(false);
      });
    });
    if (busy) {
      console.log("[preflight] port 8788 in use — killing stale bridge-server");
      spawnSync("pkill", ["-f", "bridge-server.mjs"]);
      await sleep(800);
    }
  } catch {}
  try {
    spawnSync("pkill", ["-f", "agentbridge-chrome-profile"]);
    spawnSync("pkill", ["-f", "remote-debugging-port=9223"]);
    // Orphaned test-page server from a killed run holds 8799 — kill by port
    // only (pkill -f e2e.mjs would match this harness itself).
    spawnSync("fuser", ["-k", `${TEST_PAGE_PORT}/tcp`]);
    await sleep(800);
  } catch {}
  fs.rmSync(PROFILE, { recursive: true, force: true });
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome for Testing not found at ${CHROME}`);
  }

  // ---- 0b. Local test page server (real origin for content scripts) ----
  // Content scripts only inject into real http(s) pages; about:blank and
  // data: URLs are not scriptable by executeScript without host permission.
  const testServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><title>AgentBridge E2E Test Page</title></head>
<body><input id="field"><p id="status">ready</p></body></html>`);
  });
  await new Promise((resolve, reject) => {
    testServer.on("error", reject);
    testServer.listen(TEST_PAGE_PORT, "127.0.0.1", resolve);
  });

  // ---- 1. Start the bridge server (with shared-secret token) ----
  const server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AGENTBRIDGE_TOKEN: BRIDGE_TOKEN, AGENTBRIDGE_EXTENSION_KEY: EXT_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  const serverReady = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), 5000);
    server.stdout.on("data", (d) => {
      serverOut += d.toString();
      if (serverOut.includes('"event":"listening"')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.on("exit", (c) => reject(new Error(`server exited code ${c}`)));
  });

  let chrome = null;
  let agentWs = null;
  let swCdp = null;
  let pageCdp = null; // main tab CDP (test page)

  try {
    await serverReady;
    record("server listening", serverOut.includes(`ws://127.0.0.1:${SERVER_PORT}`));

    // ---- 2. Launch Chrome for Testing with the extension ----
    chrome = spawn(
      "xvfb-run",
      [
        "-a",
        CHROME,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        `--load-extension=${EXT_DIR}`,
        `--disable-extensions-except=${EXT_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    chrome.stderr.on("data", () => {});

    // ---- 3. Find the extension service worker target ----
    // Select by manifest name, not first-match: a stale copy of the extension
    // (loaded from a leftover profile) can appear as a SECOND background.js SW
    // with a different ID — attaching to that one breaks everything.
    const swTarget = await findAgentBridgeSw();
    const extId = new URL(swTarget.url).hostname;
    swCdp = new Cdp(await wsConnect(swTarget.webSocketDebuggerUrl));
    // Capture SW console output (background.js console.log) for diagnostics.
    swCdp.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.consoleAPICalled") {
        const args = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        console.log(`[SW] ${args}`);
      }
    });
    await swCdp.send("Runtime.enable");
    record("extension SW attached", true, swTarget.url);

    // Configure the extension BEFORE it connects to the bridge: shared-secret
    // token (the bridge rejects unauthenticated clients) + E2E test mode
    // (tells the SW not to open its action popup — it steals focus). The SW's
    // storage.onChanged listener triggers connect() on the token write.
    await withTimeout(
      swCdp.evaluate(`chrome.storage.local.set({e2eMode: true, bridgeToken: ${JSON.stringify(EXT_KEY)}})`),
      3000,
      "set e2eMode+token"
    ).catch((e) => {
      console.log(`[diag] e2eMode/token set failed: ${e.message}`);
    });

    // ---- 4. Connect agent client + WAIT for extension hello on the server ----
    agentWs = await wsConnect(BRIDGE_URL);
    agentWs.send(JSON.stringify({ type: "hello", role: "agent", name: "e2e-agent", token: BRIDGE_TOKEN }));

    // The extension SW connects asynchronously after Chrome boots. Wait until the
    // server has registered it (visible in the server log) before sending actions.
    const extAttached = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 20_000) {
        if (serverOut.includes('"event":"hello"') && serverOut.includes('"role":"extension"')) return true;
        await sleep(250);
      }
      return false;
    })();
    record("extension hello on bridge", extAttached);

    // ---- 4b. Navigate the main tab to the test page + grant clipboard ----
    // The initial tab is about:blank. Navigate it to the real local page so the
    // content script injects and executeScript has host permission. Then grant
    // clipboard read/write for that origin (headless Chrome does not prompt).
    const mainTab = await waitForTarget(
      (t) => t.type === "page" && !t.url.includes("chrome-extension://"),
      15_000,
      "main tab"
    );
    pageCdp = new Cdp(await wsConnect(mainTab.webSocketDebuggerUrl));
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.navigate", { url: TEST_PAGE_URL });
    const pageLoaded = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        try {
          const st = await pageCdp.evaluate(`document.readyState`);
          if (st === "complete") return true;
        } catch {}
        await sleep(250);
      }
      return false;
    })();
    record("main tab navigated to test page", pageLoaded, TEST_PAGE_URL);
    try {
      await pageCdp.send("Browser.grantPermissions", {
        origin: TEST_PAGE_URL,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      });
      console.log("[diag] clipboard permissions granted");
    } catch (e) {
      console.log(`[diag] grantPermissions failed (non-fatal): ${e.message}`);
    }
    // Make sure the main window stays the focused one (see ensurePopup).
    await pageCdp.send("Page.bringToFront").catch(() => {});

    // E2E test mode: tell the SW not to open its action popup (it steals
    // focus and closes on focus loss — both break the harness). Gated by a
    // storage flag the harness sets; production users never see it.
    // (Already set above together with bridgeToken — this is a belt-and-
    // suspenders re-assert in case the earlier write raced SW startup.)
    await withTimeout(
      swCdp.evaluate(`chrome.storage.local.set({e2eMode: true})`),
      3000,
      "set e2eMode"
    ).catch(() => console.log("[diag] e2eMode set failed (non-fatal)"));

    // Helper: open the extension popup as a TAB in the main window via the
    // CDP HTTP endpoint (a tab can never hang, unlike an SW-eval windows.create
    // under xvfb). The unique ?e2e=<ts> marker distinguishes OUR popup tab from
    // any SW-opened action popup. After opening, re-activate the test page tab
    // so the SW's getActiveTab() keeps returning the test page.
    let popupTabId = null;
    async function ensurePopup() {
      // Always open a FRESH popup tab per decision. A reused tab sits
      // background-throttled by Chrome; its CDP evals can be queued until the
      // tab unfreezes, letting the SW 60s approval timeout win (observed).
      if (popupTabId) {
        try {
          await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/close/${popupTabId}`);
        } catch {}
        popupTabId = null;
      }
      const ts = Date.now();
      const popupUrl = `chrome-extension://${extId}/popup.html?e2e=${ts}`;
      console.log(`[diag] opening popup tab: ${popupUrl}`);
      const created = await openNewTab(popupUrl);
      popupTabId = created.id;
      // The new tab is now the ACTIVE tab — flip back to the test page so
      // getActiveTab() returns it (tabs stay open on deactivation).
      await pageCdp.send("Page.bringToFront").catch(() => {});
      await sleep(300);
      return waitForTarget(
        (t) => t.type === "page" && t.url.includes("popup.html?e2e=") && t.url.includes(extId),
        10_000,
        "popup tab"
      );
    }

    // Attach to the popup, wait for its buttons, drive approve/deny from the
    // popup PAGE context (exactly what the popup buttons do).
    async function popupDecision(decision) {
      const popupTarget = await ensurePopup();
      console.log(`[diag] attached to popup target: ${popupTarget.url.slice(0, 100)}`);
      const popupCdp = new Cdp(await wsConnect(popupTarget.webSocketDebuggerUrl));
      // Counter Chrome's background-tab freezing: the popup tab sits
      // backgrounded (test page is the active tab) and Chrome throttles/
      // freezes backgrounded extension pages under xvfb, deferring evals up
      // to ~60s (which would let the SW approval timeout win). Explicitly
      // resume the page WITHOUT activating it (activation would break
      // getActiveTab()). Best-effort.
      try {
        await popupCdp.send("Page.setWebLifecycleState", { state: "active" });
      } catch {}
      try {
        await popupCdp.send("Runtime.enable");
      } catch {}
      // Diagnostic: what page is this target actually showing?
      const ctx = await withTimeout(
        popupCdp
          .evaluate(`JSON.stringify({href: location.href, ready: document.readyState, hasChrome: typeof chrome !== 'undefined', hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime})`)
          .catch(() => "(eval failed)"),
        4000,
        "popup ctx eval"
      );
      console.log(`[diag] popup context: ${ctx}`);
      // Wait until the popup page has actually loaded as an extension page
      // (chrome.runtime present) and rendered its buttons. Each eval is
      // timeout-guarded: a throttled tab must never hang the harness.
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const ready = await withTimeout(
          popupCdp
            .evaluate(`(typeof chrome !== 'undefined' && !!chrome.runtime && !!document.getElementById('approveBtn') && document.readyState === 'complete') ? true : false`)
            .catch(() => false),
          1500,
          "popup ready eval"
        ).catch(() => false);
        if (ready) break;
        await sleep(250);
      }
      await shot(popupCdp, `popup-${decision}-request`);
      const msgType = decision === "approve" ? "agentbridge:approve" : "agentbridge:deny";
      await withTimeout(
        popupCdp.evaluate(`chrome.runtime.sendMessage({type:"${msgType}"})`),
        4000,
        `send ${decision}`
      ).catch(() => console.log(`[diag] ${decision} eval failed (non-fatal)`));
      // Diagnostic: ask the SW for its state right after the decision.
      const postState = await withTimeout(
        popupCdp
          .evaluate(`chrome.runtime.sendMessage({type:"agentbridge:getState"}).then(s => JSON.stringify(s))`)
          .catch(() => "(no response)"),
        4000,
        "post-decision state eval"
      );
      console.log(`[diag] post-${decision} state: ${postState}`);
      return popupCdp;
    }

    // Send action and approve/deny via the REAL popup UI path: the popup page's
    // chrome.runtime.sendMessage — exactly what its Approve/Deny button does
    // (popup button -> sendMessage -> SW onMessage -> approvePending).
    async function act(action, params, decision) {
      const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      // 40s: under xvfb Chrome may freeze the idle service worker between
      // events and flush its socket write on the next wake (keepalive alarm
      // 0.5min). The 15s window proved racy; the result ALWAYS arrives.
      const resP = nextResult(agentWs, id, 40_000);
      // Guard: never leave resP unhandled if a later step throws.
      resP.catch(() => {});
      try {
        agentWs.send(JSON.stringify({ type: "action", id, action, params: params || {} }));
        await sleep(500); // let the extension receive + set pending

        await popupDecision(decision);
        return await resP;
      } catch (e) {
        // Swallow the guarded promise so it never crashes the process.
        await resP.catch(() => {});
        throw e;
      }
    }

    // ---- 5. readTab ----
    const readRes = await act("readTab", {}, "approve");
    record(
      "readTab approved -> {title,url}",
      readRes.ok === true &&
        readRes.data?.title === "AgentBridge E2E Test Page" &&
        readRes.data?.url === TEST_PAGE_URL,
      `(${JSON.stringify(readRes.data || readRes.error)})`
    );

    // ---- 6. deny path ----
    const denyRes = await act("readClipboard", {}, "deny");
    record(
      "deny -> denied by user",
      denyRes.ok === false && denyRes.error === "denied by user",
      `(${JSON.stringify(denyRes)})`
    );

    // ---- 7. clipboard roundtrip ----
    const wRes = await act("writeClipboard", { text: "agentbridge-e2e-roundtrip" }, "approve");
    record("writeClipboard approved -> ok", wRes.ok === true && wRes.data?.ok === true, `(${JSON.stringify(wRes.data || wRes.error)})`);

    const rRes = await act("readClipboard", {}, "approve");
    record(
      "readClipboard roundtrip matches",
      rRes.ok === true && rRes.data?.text === "agentbridge-e2e-roundtrip",
      `(${JSON.stringify(rRes.data || rRes.error)})`
    );

    // ---- 8. inject into the test page ----
    await pageCdp.evaluate(`document.getElementById('field').focus()`);
    const injRes = await act("inject", { text: "agentbridge-injected" }, "approve");
    const fieldVal = await pageCdp.evaluate(`document.getElementById('field').value`);
    await shot(pageCdp, "test-page-after-inject");
    record(
      "inject -> field contains text",
      injRes.ok === true && injRes.data?.ok === true && fieldVal === "agentbridge-injected",
      `(field="${fieldVal}", res=${JSON.stringify(injRes.data || injRes.error)})`
    );

    // ---- 9. Write RESULTS.md ----
    const lines = [
      "# AgentBridge E2E Results — 2026-08-14",
      "",
      `Chrome: ${CHROME}`,
      `Extension: ${EXT_DIR}`,
      `Bridge: ${BRIDGE_URL}`,
      "",
      "| Scenario | Result | Detail |",
      "|---|---|---|",
      ...results.map((r) => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replaceAll("|", "\\|")} |`),
      "",
      `**TOTAL: ${results.filter((r) => r.ok).length}/${results.length} passed**`,
      "",
    ];
    fs.writeFileSync(RESULTS_PATH, lines.join("\n"));

    const allPass = results.every((r) => r.ok);
    console.log(`\nE2E: ${results.filter((r) => r.ok).length}/${results.length} passed`);
    process.exit(allPass ? 0 : 1);
  } finally {
    console.log("\n=== SERVER LOG ===");
    console.log(serverOut.trim() || "(empty)");
    try { testServer.close(); } catch {}
    try { agentWs?.close(); } catch {}
    try { swCdp?.ws.close(); } catch {}
    try { pageCdp?.ws.close(); } catch {}
    try { chrome?.kill("SIGTERM"); } catch {}
    try { server.kill("SIGTERM"); } catch {}
    await sleep(500);
    // Nuke any leftover Chrome using our profile (keeps runs hermetic).
    try { spawn("pkill", ["-f", "agentbridge-chrome-profile"]); } catch {}
    try { spawn("pkill", ["-f", "remote-debugging-port=9223"]); } catch {}
    await sleep(300);
  }
}

main().catch((e) => {
  console.log(`E2E FAIL: ${e.message}`);
  fs.writeFileSync(
    RESULTS_PATH,
    ["# AgentBridge E2E Results — 2026-08-14", "", "**HARNESS FAILED**", "", `\`\`\`\n${e.message}\n\`\`\``, ""].join("\n")
  );
  process.exit(1);
});
