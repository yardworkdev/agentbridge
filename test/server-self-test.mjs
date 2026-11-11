#!/usr/bin/env node
/**
 * AgentBridge server self-test.
 * Zero dependencies: uses Node's built-in global WebSocket client (Node >= 22).
 *
 * Scenarios:
 *  1. Start server -> assert listening line.
 *  2. Connect fake agent -> hello.
 *  3. Connect fake extension -> hello.
 *  4. Agent sends action -> extension receives it verbatim.
 *  5. Extension sends result -> agent receives it routed by id.
 *  6. Action with NO extension -> agent gets "no extension connected" error.
 *
 * Exit 0 + PASS lines on success; non-zero on failure.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "bridge-server.mjs");
const URL = "ws://127.0.0.1:8788";
const TOKEN = "self-test-token"; // agent token — deterministic for the harness
const EXT_KEY = "self-test-ext-key"; // extension key; an agent token must not work here

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`PASS ${name} ${extra}`.trim());
  } else {
    failed++;
    console.log(`FAIL ${name} ${extra}`.trim());
  }
}

// Start the server with the token, wait for "listening" on stdout.
const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, AGENTBRIDGE_TOKEN: TOKEN, AGENTBRIDGE_EXTENSION_KEY: EXT_KEY },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start in 5s")), 5000);
  server.stdout.on("data", (d) => {
    serverOutput += d.toString();
    if (serverOutput.includes('"event":"listening"')) {
      clearTimeout(t);
      resolve();
    }
  });
  server.on("exit", (code) => reject(new Error(`server exited early: code ${code}`)));
});

function connect(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(new Error(`ws error: ${e.message || "unknown"}`));
    });
  });
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("message timeout")), timeoutMs);
    const handler = (ev) => {
      clearTimeout(t);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(ev.data));
    };
    ws.addEventListener("message", handler);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  await ready;
  check("server listening", serverOutput.includes(`ws://127.0.0.1:8788`), `(${serverOutput.trim().split("\n").pop()})`);

  // 0. Wrong token -> rejected and closed.
  const bad = await connect();
  bad.send(JSON.stringify({ type: "hello", role: "agent", name: "bad", token: "wrong-token" }));
  const badMsg = await nextMessage(bad);
  check("wrong token rejected", badMsg.type === "error" && badMsg.error === "invalid token", `(${JSON.stringify(badMsg)})`);

  // 0b. Missing token -> rejected and closed.
  const noTok = await connect();
  noTok.send(JSON.stringify({ type: "hello", role: "agent", name: "notok" }));
  const noTokMsg = await nextMessage(noTok);
  check("missing token rejected", noTokMsg.type === "error" && noTokMsg.error === "invalid token", `(${JSON.stringify(noTokMsg)})`);

  // 6. No extension attached -> action errors immediately.
  const loneAgent = await connect();
  loneAgent.send(JSON.stringify({ type: "hello", role: "agent", name: "lone", token: TOKEN }));
  const errP = nextMessage(loneAgent);
  loneAgent.send(JSON.stringify({ type: "action", id: "req-0", action: "readTab", params: {} }));
  const errMsg = await errP;
  check("action without extension -> error", errMsg.ok === false && errMsg.error === "no extension connected", `(${JSON.stringify(errMsg)})`);
  loneAgent.close();

  // 2+3. Agent + extension attach.
  const agent = await connect();
  agent.send(JSON.stringify({ type: "hello", role: "agent", name: "self-test-agent", token: TOKEN }));
  await sleep(100);

  const ext = await connect();
  ext.send(JSON.stringify({ type: "hello", role: "extension", name: "AgentBridge", token: EXT_KEY }));
  await sleep(100);

  // 4. Action routed agent -> extension verbatim (with requester identity).
  const extP = nextMessage(ext);
  agent.send(JSON.stringify({ type: "action", id: "req-1", action: "readTab", params: {} }));
  const fwd = await extP;
  check(
    "action forwarded verbatim with from",
    fwd.type === "action" && fwd.id === "req-1" && fwd.action === "readTab" && fwd.from === "self-test-agent" && JSON.stringify(fwd.params) === "{}",
    `(${JSON.stringify(fwd)})`
  );

  // 5. Result routed extension -> agent by id.
  const resP = nextMessage(agent);
  ext.send(JSON.stringify({ type: "result", id: "req-1", ok: true, data: { title: "Test", url: "https://example.com" } }));
  const res = await resP;
  check(
    "result routed to agent",
    res.type === "result" && res.id === "req-1" && res.ok === true && res.data.url === "https://example.com",
    `(${JSON.stringify(res)})`
  );

  // Denied result path.
  const denP = nextMessage(agent);
  agent.send(JSON.stringify({ type: "action", id: "req-2", action: "readClipboard", params: {} }));
  await nextMessage(ext);
  ext.send(JSON.stringify({ type: "result", id: "req-2", ok: false, error: "denied by user" }));
  const den = await denP;
  check("denied result routed", den.ok === false && den.error === "denied by user", `(${JSON.stringify(den)})`);

  // Status broadcast extension -> agent.
  const stP = nextMessage(agent);
  ext.send(JSON.stringify({ type: "status", state: "connected", ts: Date.now() }));
  const st = await stP;
  check("status broadcast", st.type === "status" && st.state === "connected", `(${JSON.stringify(st)})`);

  agent.close();
  ext.close();
} catch (e) {
  console.log(`FAIL harness error: ${e.message}`);
  failed++;
} finally {
  server.kill("SIGTERM");
}

await sleep(300);
console.log(`\nSELF-TEST: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
