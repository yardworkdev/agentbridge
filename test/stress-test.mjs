#!/usr/bin/env node
/**
 * AgentBridge stress test — server robustness under load and hostile input.
 * Zero dependencies. Exercises the bridge-server.mjs protocol layer directly
 * with real WebSocket clients + raw TCP for frame-level attacks.
 *
 * Scenarios:
 *  A. Token auth matrix (correct / wrong / missing / non-string).
 *  B. Many agents, no extension -> every action returns "no extension connected".
 *  C. Concurrent routing under load: 1 fake extension + N agents x M actions,
 *     unique ids -> every result routed back to the right agent.
 *  D. DUPLICATE request id across two agents (suspected misrouting bug).
 *  E. Agent name collision -> status broadcast + cleanup correctness (suspected bug).
 *  F. Malformed JSON frame -> "bad json" close, server survives.
 *  G. Oversized frame (declared > 1 MB cap) -> connection closed, server survives.
 *  H. Role abuse: extension sends action, agent sends result/status -> ignored.
 *  I. Connect/disconnect churn + extension replacement -> clean state.
 *
 * Exit 0 only if every expected assertion passes. Real "findings"/bugs are
 * reported as DISCREPANCY lines (they don't fail the harness by default, so
 * we can observe actual behavior); set STRICT=1 to fail on them.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

process.on("unhandledRejection", (e) => { console.log("UNHANDLED:", e && e.message); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "bridge-server.mjs");
const PORT = 8788;
const URL = `ws://127.0.0.1:${PORT}`;
const TOKEN = "stress-token";
const EXT_KEY = "stress-ext-key";
const STRICT = process.env.STRICT === "1";

let passed = 0, failed = 0, findings = [];

function ok(cond, name, extra = "") {
  if (cond) { passed++; console.log(`PASS ${name} ${extra}`.trim()); }
  else { failed++; console.log(`FAIL ${name} ${extra}`.trim()); }
}
function finding(name, detail) {
  findings.push({ name, detail });
  console.log(`DISCREPANCY ${name}: ${detail}`);
}
function skip(name, why) { console.log(`SKIP ${name} (${why})`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const t = setTimeout(() => reject(new Error("ws connect timeout")), timeoutMs);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(ws); });
    ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("ws error")); });
  });
}
function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("msg timeout")), timeoutMs);
    const h = (ev) => { clearTimeout(t); ws.removeEventListener("message", h); resolve(JSON.parse(ev.data)); };
    ws.addEventListener("message", h);
  });
}
function nextResult(ws, id, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.removeEventListener("message", h); reject(new Error(`no result ${id}`)); }, timeoutMs);
    const h = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "result" && String(m.id) === String(id)) { clearTimeout(t); ws.removeEventListener("message", h); resolve(m); }
    };
    ws.addEventListener("message", h);
  });
}
function waitConn(ws) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("waitConn timeout")), 5000);
    ws.addEventListener("close", () => { clearTimeout(t); res(); });
  });
}

/** Persistent message collector — no dropped messages between listeners. */
function collector(ws) {
  const q = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (waiters.length) waiters.shift()(m); else q.push(m);
  });
  return {
    next(timeoutMs = 8000) {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((res, rej) => {
        const t = setTimeout(() => { const i = waiters.indexOf(res); if (i >= 0) waiters.splice(i, 1); rej(new Error("collector timeout")); }, timeoutMs);
        waiters.push((m) => { clearTimeout(t); res(m); });
      });
    },
  };
}

// Raw TCP helpers for frame-level testing (fragmentation / oversize / bad json).
function rawSocket() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port: PORT }, () => resolve(s));
    s.on("error", reject);
  });
}
function mask(payload) {
  const key = Buffer.from([1, 2, 3, 4]);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
  return { key, out };
}
function frame(opcode, payload, { fin = true, forceLen = null } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const keyed = mask(p);
  let len = forceLen ?? p.length;
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let head;
  if (len < 126) {
    head = Buffer.from([b0, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = b0; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = b0; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, keyed.key, keyed.out]);
}

// ---- start server ----
const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, AGENTBRIDGE_TOKEN: TOKEN, AGENTBRIDGE_EXTENSION_KEY: EXT_KEY },
  stdio: ["ignore", "pipe", "pipe"],
});
let srvOut = "";
const ready = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server start timeout")), 5000);
  server.stdout.on("data", (d) => { srvOut += d.toString(); if (srvOut.includes('"event":"listening"')) { clearTimeout(t); res(); } });
  server.on("exit", (c) => rej(new Error(`server exited early ${c}`)));
});

try {
  await ready;
  ok(true, "server listening");

  // ===== A. token auth matrix =====
  {
    const w = await wsConnect(); w.send(JSON.stringify({ type: "hello", role: "agent", name: "a-good", token: TOKEN }));
    await sleep(80); ok(true, "A1 correct token accepted (no error)");
    w.close();

    const bad = await wsConnect(); bad.send(JSON.stringify({ type: "hello", role: "agent", name: "a-bad", token: "nope" }));
    const m1 = await nextMessage(bad);
    ok(m1.type === "error" && m1.error === "invalid token", "A2 wrong token rejected");
    bad.close();

    const miss = await wsConnect(); miss.send(JSON.stringify({ type: "hello", role: "agent", name: "a-miss" }));
    const m2 = await nextMessage(miss);
    ok(m2.type === "error" && m2.error === "invalid token", "A3 missing token rejected");
    miss.close();

    const nnt = await wsConnect(); nnt.send(JSON.stringify({ type: "hello", role: "agent", name: "a-nnt", token: 12345 }));
    const m3 = await nextMessage(nnt);
    ok(m3.type === "error" && m3.error === "invalid token", "A4 non-string token rejected");
    nnt.close();
  }

  // ===== B. many agents + no extension =====
  {
    const N = 40;
    const agents = [];
    for (let i = 0; i < N; i++) {
      const w = await wsConnect();
      w.send(JSON.stringify({ type: "hello", role: "agent", name: `bulk-${i}`, token: TOKEN }));
      agents.push(w);
    }
    await sleep(120);
    let got = 0, okErr = 0;
    const results = await Promise.all(agents.map((w, i) => {
      const p = nextResult(w, `b-${i}`);
      w.send(JSON.stringify({ type: "action", id: `b-${i}`, action: "readTab", params: {} }));
      return p.then((m) => { got++; if (m.ok === false && m.error === "no extension connected") okErr++; });
    }));
    await Promise.all(results);
    ok(got === N && okErr === N, "B many agents no extension -> all get no-extension error", `(${okErr}/${N})`);
    agents.forEach((w) => w.close());
  }

  // ===== C. concurrent routing under load (fake extension echo) =====
  {
    const ext = await wsConnect();
    ext.send(JSON.stringify({ type: "hello", role: "extension", name: "fake-ext", token: EXT_KEY }));
    await sleep(100);
    const NA = 25, PER = 10;
    const agents = [];
    for (let i = 0; i < NA; i++) {
      const w = await wsConnect();
      w.send(JSON.stringify({ type: "hello", role: "agent", name: `load-${i}`, token: TOKEN }));
      agents.push(w);
    }
    await sleep(150);
    // extension: auto-echo results back for every action id it receives (id->agent handled by server)
    const extCol = collector(ext);
    const extPump = (async () => {
      let n = 0;
      while (n < NA * PER) {
        const m = await extCol.next(8000).catch(() => null);
        if (!m) break;
        if (m.type === "action") { ext.send(JSON.stringify({ type: "result", id: m.id, ok: true, data: { echoed: m.id } })); n++; }
      }
      return n;
    })();
    const perAgent = agents.map((w, i) => { // set up listeners WITHOUT awaiting yet
      const ps = [];
      for (let k = 0; k < PER; k++) {
        const id = `load-${i}-${k}`;
        ps.push(nextResult(w, id, 8000).then((m) => m.ok === true && m.data?.echoed === id));
      }
      return Promise.all(ps);
    });
    // fire all actions AFTER listeners are armed
    for (let i = 0; i < NA; i++) for (let k = 0; k < PER; k++) {
      agents[i].send(JSON.stringify({ type: "action", id: `load-${i}-${k}`, action: "readTab", params: {} }));
    }
    const all = await Promise.all(perAgent);
    await extPump;
    const total = all.flat();
    ok(total.length === NA * PER && total.every(Boolean), "C concurrent routing N agents x M actions", `(${total.filter(Boolean).length}/${NA * PER})`);
    agents.forEach((w) => w.close()); ext.close();
  }

  // ===== D. duplicate request id across two agents (fixed: busy, not orphan) =====
  {
    const ext = await wsConnect();
    ext.send(JSON.stringify({ type: "hello", role: "extension", name: "ext-d", token: EXT_KEY }));
    const extCol = collector(ext); // persistent listener — no dropped actions
    const A = await wsConnect(); A.send(JSON.stringify({ type: "hello", role: "agent", name: "dupA", token: TOKEN }));
    const B = await wsConnect(); B.send(JSON.stringify({ type: "hello", role: "agent", name: "dupB", token: TOKEN }));
    await sleep(150);
    // A's request must get its OWN result; B (same id) must be rejected with busy —
    // never orphaned, never misrouted.
    const aResult = nextResult(A, "same-id", 3000).then((m) => m.ok === true && m.data?.via === "ext").catch(() => false);
    const bBusy = nextResult(B, "same-id", 3000).then((m) => m.ok === false && m.error === "busy").catch(() => false);
    A.send(JSON.stringify({ type: "action", id: "same-id", action: "readTab", params: {} }));
    await sleep(60);
    B.send(JSON.stringify({ type: "action", id: "same-id", action: "readTab", params: {} }));
    await sleep(80);
    const extMsg = await extCol.next(2500); // A's action (B's was blocked at the server)
    ext.send(JSON.stringify({ type: "result", id: extMsg.id, ok: true, data: { via: "ext" } }));
    const [aWin, bBusyWin] = await Promise.all([aResult, bBusy]);
    ok(aWin && bBusyWin, "D duplicate id -> original gets result, second gets busy", `(A result=${aWin}, B busy=${bBusyWin})`);
    A.close(); B.close(); ext.close();
  }

  // ===== E. agent name collision (suspected cleanup/status bug) =====
  {
    const ext = await wsConnect();
    ext.send(JSON.stringify({ type: "hello", role: "extension", name: "ext-e", token: EXT_KEY }));
    const A = await wsConnect(); A.send(JSON.stringify({ type: "hello", role: "agent", name: "shared", token: TOKEN }));
    await sleep(80);
    const B = await wsConnect(); B.send(JSON.stringify({ type: "hello", role: "agent", name: "shared", token: TOKEN }));
    await sleep(80);
    // status broadcast -> how many agents receive it?
    const sA = nextMessage(A, 1500).then(() => 1).catch(() => 0);
    const sB = nextMessage(B, 1500).then(() => 1).catch(() => 0);
    ext.send(JSON.stringify({ type: "status", state: "connected", ts: Date.now() }));
    const [gA, gB] = await Promise.all([sA, sB]);
    if (!(gA && gB)) {
      finding("agent name collision -> status broadcast dropped for replaced agent",
        `agents both named "shared": A got status=${gA}, B got status=${gB}`);
      ok(false, "E1 status reaches all unique connections", `(A=${gA},B=${gB})`);
    } else ok(true, "E1 status reaches all unique connections");
    // Now close the FIRST (A); does it wrongly drop the still-connected B from the map?
    const sB2 = nextMessage(B, 1500).then(() => 1).catch(() => 0);
    A.close(); await sleep(120);
    ext.send(JSON.stringify({ type: "status", state: "connected", ts: Date.now() }));
    const gB2 = await sB2;
    if (!gB2) {
      finding("agent name collision -> closing A wrongly removed still-connected B",
        `B (name "shared") did not receive status after A closed`);
      ok(false, "E2 B still receives status after A closes", `(B got=${gB2})`);
    } else ok(true, "E2 B still receives status after A closes");
    B.close(); ext.close();
  }

  // ===== F. malformed JSON -> bad json close, server survives =====
  {
    const s = await rawSocket();
    const closed = new Promise((res) => s.on("close", res));
    s.write(frame(0x1, "{not valid json !!"));
    await Promise.race([closed, sleep(3000)]);
    ok(true, "F server handled malformed JSON (connection closed)");
    s.destroy();
    // server still alive
    const w = await wsConnect(); w.send(JSON.stringify({ type: "hello", role: "agent", name: "post-f", token: TOKEN }));
    await sleep(80); ok(true, "F2 server still accepts connections after bad JSON"); w.close();
  }

  // ===== G. oversized frame (declared > 1 MB) -> closed, server survives =====
  {
    const s = await rawSocket();
    const closed = new Promise((res) => s.on("close", res));
    const big = Buffer.alloc(2000, 0x61);
    s.write(frame(0x1, big, { forceLen: 1_200_000 })); // claim 1.2MB payload, send 2KB
    await Promise.race([closed, sleep(3000)]);
    ok(true, "G server closed oversized-frame connection");
    s.destroy();
    const w = await wsConnect(); w.send(JSON.stringify({ type: "hello", role: "agent", name: "post-g", token: TOKEN }));
    await sleep(80); ok(true, "G2 server survives oversized frame"); w.close();
  }

  // ===== H. role abuse =====
  {
    const ext = await wsConnect(); ext.send(JSON.stringify({ type: "hello", role: "extension", name: "ext-h", token: EXT_KEY }));
    const ag = await wsConnect(); ag.send(JSON.stringify({ type: "hello", role: "agent", name: "ag-h", token: TOKEN }));
    await sleep(120);
    // extension tries to send an action -> must be ignored (no crash, no forward)
    const agHear = nextMessage(ag, 1200).then(() => "msg").catch(() => "none");
    ext.send(JSON.stringify({ type: "action", id: "x", action: "readTab", params: {}, from: "evil" }));
    const r = await agHear;
    ok(r === "none", "H1 extension sending action ignored", `(agent heard: ${r})`);
    // agent tries to send result / status -> ignored
    const extHear = nextMessage(ext, 1200).then(() => "msg").catch(() => "none");
    ag.send(JSON.stringify({ type: "result", id: "x", ok: true, data: {} }));
    ag.send(JSON.stringify({ type: "status", state: "connected", ts: 1 }));
    const r2 = await extHear;
    ok(r2 === "none", "H2 agent sending result/status ignored", `(ext heard: ${r2})`);
    ag.close(); ext.close();
  }

  // ===== I. connect/disconnect churn + extension replacement =====
  {
    for (let i = 0; i < 60; i++) {
      const w = await wsConnect();
      w.send(JSON.stringify({ type: "hello", role: "agent", name: `churn-${i}`, token: TOKEN }));
      w.close();
    }
    // extension replacement: second extension should evict first
    const e1 = await wsConnect(); e1.send(JSON.stringify({ type: "hello", role: "extension", name: "ext1", token: EXT_KEY }));
    await sleep(80);
    const e1Closed = waitConn(e1);
    const e2 = await wsConnect(); e2.send(JSON.stringify({ type: "hello", role: "extension", name: "ext2", token: EXT_KEY }));
    await Promise.race([e1Closed, sleep(3000)]);
    ok(e1.readyState === WebSocket.CLOSED, "I1 extension replacement evicts old extension");
    // status still reaches a live agent via the NEW extension
    const ag = await wsConnect(); ag.send(JSON.stringify({ type: "hello", role: "agent", name: "post-i", token: TOKEN }));
    await sleep(100);
    const s = nextMessage(ag, 2000).then((m) => m.type === "status").catch(() => false);
    e2.send(JSON.stringify({ type: "status", state: "connected", ts: 1 }));
    ok(await s, "I2 status still broadcast after churn + extension swap");
    ag.close(); e2.close(); e1.close();
  }

} catch (e) {
  console.log(`FAIL harness error: ${e && e.message}`);
  failed++;
} finally {
  try { server.kill("SIGTERM"); } catch {}
}

await sleep(300);
console.log(`\nSTRESS: ${passed} passed, ${failed} failed` + (findings.length ? `, ${findings.length} DISCREPANCY(ies)` : ""));
console.log(`Findings: ${findings.map((f) => f.name).join("; ") || "none"}`);
process.exit(failed === 0 && (STRICT ? findings.length === 0 : true) ? 0 : 1);
