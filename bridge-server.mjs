#!/usr/bin/env node
/**
 * AgentBridge bridge-server.mjs
 * Zero-dependency Node WebSocket server (RFC 6455, hand-rolled).
 * Routes messages between AI agents and the Chrome extension.
 * Listen: 127.0.0.1:8788 (loopback only).
 *
 * Protocol: see PROTOCOL.md — hello / action / result / status.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8788;
const HOST = "127.0.0.1";
const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000; // 2 missed pongs -> drop
const MAX_FRAME_BYTES = 1_048_576; // 1 MB per message — frame-size DoS guard
const MAX_BUFFER_BYTES = 4 * MAX_FRAME_BYTES; // 4 MB in-flight buffer cap

// Two secrets, because one secret meant an agent could claim to be the browser:
// an agent token that agents present, and an extension key that only the person's
// extension has. They live in ~/.agentbridge/keys.json (mode 600) so a restart no
// longer invalidates the carried-over setup. --rotate replaces them, --show-keys
// prints them again.
const KEY_DIR = path.join(os.homedir(), ".agentbridge");
const KEY_FILE = path.join(KEY_DIR, "keys.json");

function randomKey() {
  return crypto.randomBytes(32).toString("hex");
}

function loadKeys() {
  const rotate = process.argv.includes("--rotate");
  const show = process.argv.includes("--show-keys");
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  } catch {
    saved = null;
  }
  const fresh = !saved || !saved.agentToken || !saved.extensionKey;
  if (rotate || fresh) {
    saved = { agentToken: randomKey(), extensionKey: randomKey() };
    try {
      fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(KEY_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
      fs.chmodSync(KEY_FILE, 0o600);
      fs.chmodSync(KEY_DIR, 0o700);
      console.log(`${rotate ? "Rotated" : "Created"} ${KEY_FILE}`);
    } catch (e) {
      console.log(`Could not save keys (${e.message}); they last only until this process ends`);
    }
  }
  if (rotate || fresh || show) {
    console.log(`  agent token:   ${saved.agentToken}`);
    console.log(`  extension key: ${saved.extensionKey}   <- paste this into the extension popup`);
  } else {
    console.log(`Using the saved keys in ${KEY_FILE}`);
  }
  if (process.env.AGENTBRIDGE_TOKEN) saved.agentToken = process.env.AGENTBRIDGE_TOKEN;
  if (process.env.AGENTBRIDGE_EXTENSION_KEY) saved.extensionKey = process.env.AGENTBRIDGE_EXTENSION_KEY;
  return saved;
}

const KEYS = loadKeys();
const AGENT_TOKEN = KEYS.agentToken;
const EXTENSION_KEY = KEYS.extensionKey;

/** Timing-safe comparison against an expected secret. */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The server proves it holds the extension key before the extension sends it.
 * A process that binds 8788 first cannot answer this, so it cannot harvest the key.
 */
function proofFor(nonce) {
  return crypto.createHmac("sha256", EXTENSION_KEY).update(String(nonce)).digest("hex");
}

function log(event, detail = {}) {
  const line = { ts: Date.now(), event, ...detail };
  console.log(JSON.stringify(line));
}

class WsConnection {
  static nextId = 0;
  constructor(socket) {
    this.socket = socket;
    this.connId = ++WsConnection.nextId;
    this.buffer = Buffer.alloc(0);
    this.role = null;
    this.name = null;
    this.alive = true;
    this.onMessage = null;
    this.onClose = null;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._close());
    socket.on("error", () => this._close());
  }

  sendText(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    this._sendFrame(0x1, payload);
  }

  sendPing() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  _sendFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._close();
        return null;
      }
      len = Number(big);
      offset = 10;
    }
    if (len > MAX_FRAME_BYTES) {
      // Declared payload larger than the cap — reject, never buffer it.
      this._close();
      return null;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return null;
    const mask = masked ? buf.subarray(offset, offset + 4) : null;
    offset += maskLen;
    let payload = buf.subarray(offset, offset + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    switch (frame.opcode) {
      case 0x1: // text
      case 0x2: // binary (treat as text)
        if (this.onMessage) {
          try {
            this.onMessage(JSON.parse(frame.payload.toString("utf8")));
          } catch {
            this._sendFrame(0x8, Buffer.from("bad json", "utf8"));
          }
        }
        break;
      case 0x8: // close
        this._sendFrame(0x8, frame.payload);
        this._close();
        break;
      case 0x9: // ping
        this._sendFrame(0xa, frame.payload);
        break;
      case 0xa: // pong
        this.alive = true;
        break;
      default:
        break;
    }
  }

  _close() {
    if (this.socket.destroyed) return;
    this.socket.destroy();
    if (this.onClose) this.onClose();
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("AgentBridge bridge server — WebSocket upgrade only (ws://127.0.0.1:8788)");
});

/** @type {Map<number, WsConnection>} agents by UNIQUE connection id (not name) */
const agents = new Map();
/** @type {Map<number, string>} agent display names keyed by connection id */
const agentNames = new Map();
/** @type {WsConnection | null} the extension connection */
let extension = null;
/** @type {Map<string, WsConnection>} request id -> originating agent */
const pendingByAgent = new Map();

function route(msg, conn) {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "auth-challenge": {
      if (typeof msg.nonce !== "string" || msg.nonce.length > 200) break;
      conn.nonce = msg.nonce;
      conn.sendText({ type: "server-hello", nonce: msg.nonce, proof: proofFor(msg.nonce) });
      break;
    }

    case "hello": {
      // An agent cannot hold the extension key, so it cannot take the browser's
      // place at the gate — the single shared token allowed exactly that.
      const wantsExtension = msg.role === "extension";
      const expected = wantsExtension ? EXTENSION_KEY : AGENT_TOKEN;
      if (!tokenMatches(msg.token, expected)) {
        conn.sendText({
          type: "error",
          error: wantsExtension ? "invalid extension key" : "invalid token",
        });
        conn._close();
        return;
      }
      conn.role = msg.role;
      conn.name = msg.name || "unknown";
      if (msg.role === "extension") {
        if (extension && extension !== conn) {
          try { extension._close(); } catch {}
        }
        extension = conn;
        log("hello", { role: "extension", name: conn.name });
      } else if (msg.role === "agent") {
        agents.set(conn.connId, conn);
        agentNames.set(conn.connId, conn.name);
        log("hello", { role: "agent", name: conn.name });
      }
      // Informational status broadcast to agent
      break;
    }

    case "action": {
      if (conn.role !== "agent") break;
      if (!extension || extension.socket.destroyed) {
        conn.sendText({ type: "result", id: msg.id, ok: false, error: "no extension connected" });
        break;
      }
      // Collision-safe: never overwrite an in-flight request id for a DIFFERENT
      // sender. If an id is already pending (from any agent), reject the new one
      // instead of orphaning/misrouting the original (fixes duplicate-id bug).
      const key = String(msg.id);
      if (pendingByAgent.has(key)) {
        conn.sendText({ type: "result", id: msg.id, ok: false, error: "busy" });
        break;
      }
      pendingByAgent.set(key, conn);
      log("action", { id: msg.id, action: msg.action, from: conn.name });
      // Include the requesting agent's name so the extension can show WHO asks.
      extension.sendText({
        type: "action",
        id: msg.id,
        action: msg.action,
        params: msg.params || {},
        from: conn.name || "unknown",
      });
      break;
    }

    case "result": {
      if (conn.role !== "extension") break;
      const agent = pendingByAgent.get(String(msg.id));
      pendingByAgent.delete(String(msg.id));
      log("result", { id: msg.id, ok: msg.ok });
      if (agent && !agent.socket.destroyed) {
        agent.sendText({ type: "result", id: msg.id, ok: msg.ok, data: msg.data, error: msg.error });
      }
      break;
    }

    case "status": {
      if (conn.role !== "extension") break;
      for (const a of agents.values()) {
        if (!a.socket.destroyed) {
          a.sendText({ type: "status", state: msg.state, ts: msg.ts || Date.now() });
        }
      }
      break;
    }

    default:
      break;
  }
}

server.on("upgrade", (req, socket) => {
  // Origin allowlist: web pages must NOT reach the bridge (drive-by WS
  // attacks). Allowed: no Origin header (Node/CLI agents) or
  // chrome-extension:// (the extension's own service worker). Everything
  // else (browser page origins) is rejected before the handshake.
  const origin = req.headers["origin"];
  if (origin && !origin.startsWith("chrome-extension://")) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  const proto = req.headers["sec-websocket-protocol"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + MAGIC)
    .digest("base64");

  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (proto) headers.push(`Sec-WebSocket-Protocol: ${proto}`);
  socket.write(headers.join("\r\n") + "\r\n\r\n");

  const conn = new WsConnection(socket);
  log("connect", { address: req.socket.remoteAddress });
  conn.onMessage = (msg) => route(msg, conn);
  conn.onClose = () => {
    if (extension === conn) extension = null;
    if (conn.role === "agent") {
      // Delete by UNIQUE connection id — never by name, so a same-named agent
      // that disconnects cannot drop a still-connected one (fixes name-collision).
      agents.delete(conn.connId);
      agentNames.delete(conn.connId);
    }
    // Drop this agent's pending requests — no zombie results later.
    for (const [id, c] of pendingByAgent) {
      if (c === conn) pendingByAgent.delete(id);
    }
    log("disconnect", { role: conn.role || "unknown" });
  };
});

// Keepalive: ping every connection every 30s; drop after 2 missed pongs.
const keepalive = setInterval(() => {
  for (const conn of [extension, ...agents.values()]) {
    if (!conn || conn.socket.destroyed) continue;
    if (conn.alive === false) {
      conn._close();
      continue;
    }
    conn.alive = false;
    conn.sendPing();
  }
}, PING_INTERVAL_MS);

function shutdown() {
  log("shutdown", {});
  clearInterval(keepalive);
  for (const conn of [extension, ...agents.values()]) {
    try { conn._close(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  log("listening", { url: `ws://${HOST}:${PORT}` });
  console.log(`AgentBridge ready. Agent token and extension key: ${KEY_FILE} (--show-keys to print)`);
});
