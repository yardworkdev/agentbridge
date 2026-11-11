# AgentBridge Protocol v1 — Contract for ALL fleet agents

The single source of truth. Every agent codes against THIS. Do not invent message shapes.

## Architecture

```
[AI Agent]  --ws-->  [bridge-server.mjs]  --ws-->  [Chrome Extension (MV3)]
   (client)         (Node, port 8788)             (service worker = ws CLIENT)
```

- `bridge-server.mjs` — zero-dependency Node WebSocket server on `127.0.0.1:8788`.
  Agents AND the extension connect to it. Server routes requests/responses by ID.
  **Authentication:** every client must present the shared-secret token in its
  `hello` (server prints it at startup; override with `AGENTBRIDGE_TOKEN` env).
  Connections from browser web pages (Origin not `chrome-extension://`) are
  rejected before the handshake.
- Extension service worker connects OUT to the server as a WS client
  (MV3 service workers CAN be WS clients; they CANNOT be WS servers — hence the Node server).
- Every agent action requires an explicit human approval in the extension.
  No auto-execution. Ever. This is the product's core value.

## Message protocol (JSON text frames)

### 1. Hello (on connect)
Every hello MUST include the shared-secret `token` (set `AGENTBRIDGE_TOKEN` for
agents; paste the server's printed token into the extension popup once).
Missing/invalid token → server replies `{"type":"error","error":"invalid token"}`
and closes the connection.

Agent → Server:
```json
{"type": "hello", "role": "agent", "name": "my-agent", "token": "<shared-secret>"}
```
Extension → Server:
```json
{"type": "hello", "role": "extension", "name": "AgentBridge", "token": "<shared-secret>"}
```

### 2. Action request (agent → server → extension)
Agent → Server:
```json
{"type": "action", "id": "req-123", "action": "readTab", "params": {}}
```
Server → Extension (forward; server injects the requesting agent's name as `from`):
```json
{"type": "action", "id": "req-123", "action": "readTab", "params": {}, "from": "my-agent"}
```
The extension shows `from` in the approval prompt — the human always sees WHO is asking.

### 3. Approval response (extension → server → agent)
Extension → Server:
```json
{"type": "result", "id": "req-123", "ok": true, "data": {"title": "...", "url": "..."}}
```
or on denial:
```json
{"type": "result", "id": "req-123", "ok": false, "error": "denied by user"}
```
Server → Agent (verbatim forward of the result).

### 4. Status (extension → server → agent, informational)
```json
{"type": "status", "state": "connected" | "disconnected", "ts": 1723600000000}
```

## Actions (v1 — exact names, exact data shapes)

| action | params | data on success |
|---|---|---|
| `readTab` | `{}` | `{"title": string, "url": string}` (active tab of current window) |
| `readClipboard` | `{}` | `{"text": string}` |
| `writeClipboard` | `{"text": string}` | `{"ok": true}` |
| `inject` | `{"text": string}` | `{"ok": true}` (type text into focused element) |

**An approval is bound to the page it was asked about.** The request carries the tab and its URL,
captured when the action arrives, and the prompt names that page. At approval time the extension
checks that the tab still exists, still shows that URL, and is still the tab in front — a person who
switched pages gets `{"ok": false, "error": "you switched to another page before approving; nothing
was done — ask again"}` and no action runs anywhere. `inject` answers `{"ok": true, "characters": n,
"field": "input"}` only after reading the field back and finding the text in it.

**Requests queue.** A second action arriving while one is waiting is not denied:
both wait, in order, each with its own 60 s limit, and the badge shows the count.

Error responses: `{"ok": false, "error": "denied by user"}` for denials,
`{"ok": false, "error": "<message>"}` for execution failures,
`{"ok": false, "error": "no extension connected"}` if no extension is attached.

## Approval gate rules (extension side — non-negotiable)

1. Every action → show approval UI FIRST (notification with ✅/🚫 buttons + popup fallback).
   The prompt must show the requesting agent's name (`from`).
2. Execute ONLY after explicit approval.
3. One pending request at a time. If a new action arrives while one is pending → auto-deny it with `{"ok": false, "error": "busy"}`.
4. 60-second approval timeout → auto-deny `{"ok": false, "error": "timeout"}`.
5. Track approvals count in chrome.storage.local (`approvals`).

## Security invariants (v0.2.0 — non-negotiable)

1. **Shared-secret token** — every `hello` (agent AND extension) must present the
   token; the server rejects and closes otherwise. Server generates a fresh
   256-bit token per start; override with `AGENTBRIDGE_TOKEN` env for automation.
2. **Origin allowlist** — WebSocket upgrades with a browser-page Origin (anything
   not absent / not `chrome-extension://`) are rejected with HTTP 403 before the
   handshake. Websites cannot drive the bridge.
3. **Requester identity** — the approval prompt always shows the requesting
   agent's name; the server injects `from` into forwarded actions.
4. **Size caps** — server rejects frames > 1 MB; extension caps `params.text`
   at 256 KB.
5. **Log redaction** — the extension never logs message bodies (clipboard text);
   only ids/actions/requester names.
6. **Content script sender check** — `content.js` only answers messages from the
   extension's own runtime id.

## Extension service worker lifecycle (MV3)

- Connect to `ws://127.0.0.1:8788` on startup (`chrome.runtime.onInstalled` + `onStartup`).
- Auto-reconnect with backoff (1s, 5s, 15s, max 30s) while bridge is reachable.
- `chrome.alarms` every 30s → if socket closed, reconnect (keeps SW alive).
- Keep `pendingApproval` in SW memory; notification button index 0 = approve, 1 = deny.
- On notification click (body) → open popup showing pending request.

## Implementation notes

- Server: single file, zero deps (Node ≥20 built-ins only: `http`, `crypto`, `fs`).
  Hand-rolled WS handshake (Sec-WebSocket-Accept = base64(sha1(key + magic GUID))),
  frame parse (FIN/opcode/mask/len), ping/pong keepalive every 30s, drop dead sockets.
- Extension manifest: MV3, permissions `["activeTab","clipboardRead","clipboardWrite","storage","scripting","notifications","alarms"]`,
  host_permissions `["<all_urls>"]`, service_worker `background.js`, action popup `popup.html`.
- Clipboard: `navigator.clipboard.readText()/writeText()` in page context via `chrome.scripting.executeScript`
  (needs focus; fallback to `document.execCommand('paste'/'copy')` in content script context).
- readTab: `chrome.tabs.query({active: true, currentWindow: true})`.
- inject: `chrome.scripting.executeScript` on active tab → set `document.activeElement.value` + dispatch input event.
- Server stdout: JSON lines `{"ts":..., "event":"connect|disconnect|action|result|approval|deny", "detail":...}` for testability.

## Testing contract (E2E harness, `test/` dir)

1. Start server (`node bridge-server.mjs`) → assert `listening on ws://127.0.0.1:8788`.
2. Launch Chrome with extension loaded (headful under xvfb OR Chrome for Testing headless).
3. Connect agent client (`test/agent-client.mjs`) → assert hello + attach.
4. Send `readTab` → approve via CDP click on notification button / popup button → assert result shape.
5. Send `deny` scenario → assert `{"ok": false, "error": "denied by user"}`.
6. Send `writeClipboard` then `readClipboard` → assert roundtrip text.
7. Send `inject` → assert page field contains text.
8. Report PASS/FAIL per scenario in `test/RESULTS.md`.

## File layout (all under `businesses/yardwork/work/t4-build/agentbridge/`)

```
bridge-server.mjs      — server (LANE A)
manifest.json          — extension manifest (LANE B)
background.js          — SW: ws client + approval gate + executors (LANE B)
content.js             — clipboard/inject helpers if needed (LANE B)
popup.html, popup.js   — approval + status UI (LANE B)
icons/icon16/48/128.png— icons (LANE C)
test/agent-client.mjs  — E2E agent client (LANE D)
test/e2e.mjs           — orchestrator: server+chrome+assert (LANE D)
test/RESULTS.md        — PASS/FAIL per scenario (LANE D)
README.md              — user docs (LANE E)
STORE-LISTING.md       — Chrome Web Store copy (LANE E)
```
