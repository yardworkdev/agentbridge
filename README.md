# AgentBridge — Connect AI Agents to Your Browser

Free local bridge: AI agents attach to your Chrome browser and read the active tab,
read/write the clipboard, and inject text — with your explicit approval on every action.
Version 0.4.0. Made by YardWork (https://yardwork.dev).

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/agentbridge-%E2%80%94-connect-ai/empaehmlgclgkljpjeaemefoeafalfal)** ·
[MIT licensed](LICENSE) · [Protocol](PROTOCOL.md) · [Privacy](https://yardwork.dev/agentbridge/privacy.html)

## What it is

AgentBridge is a Chrome extension (MV3) plus a tiny, zero-dependency Node WebSocket
server. AI agents connect to the server, and the extension connects to the same server.
Once attached, an agent can:

- **readTab** — see the title and URL of the active tab.
- **readClipboard** — read the current clipboard text.
- **writeClipboard** — write text into your clipboard.
- **inject** — type text into the focused field of the page you were looking at, at the caret.

Every agent action requires an explicit human approval in the extension.
**No auto-execution. Ever.** This is the product's core value.

## How it works

```
[AI Agent]  --ws-->  [bridge-server.mjs]  --ws-->  [Chrome Extension (MV3)]
   (client)         (Node, port 8788)             (service worker = ws CLIENT)
```

- `bridge-server.mjs` — a zero-dependency Node WebSocket server on
  `ws://127.0.0.1:8788`. Agents **and** the extension connect to it. The server routes
  requests and responses by ID.
- The extension service worker connects **out** to the server as a WebSocket client.
  MV3 service workers can be WebSocket clients; they cannot be WebSocket servers —
  that is why the Node server exists.
- Every agent action flows through the approval gate in the extension. The human
  approves or denies each request. Nothing executes automatically.

## Install

Two ways in: the **Chrome Web Store** (normal use), or loading this folder unpacked (development).

1. **Load the unpacked extension**
   - Open `chrome://extensions`.
   - Enable **Developer mode** (top right).
   - Click **Load unpacked** and select the `agentbridge` folder.
2. **Start the bridge server**
   - Requires Node.js 20 or newer. No dependencies to install.
   - Run: `node bridge-server.mjs`
   - It prints `AgentBridge token: <hex>` — **copy this token**.
3. **Paste the token into the extension popup** (one-time) — open the AgentBridge
   popup, paste the token, click **Save token**. The extension reconnects and shows
   the bridge status. Without a token the extension stays disconnected on purpose.
4. **Confirm the connection** — the popup shows the bridge status and any pending
   approval requests.

## Connect an agent

Any WebSocket client can act as an agent. Connect to `ws://127.0.0.1:8788`, send a
`hello`, then send `action` requests. The extension answers each request with a
`result` — but only after a human approves it.

Minimal agent client (Node 22+, built-in WebSocket):

```js
const ws = new WebSocket("ws://127.0.0.1:8788");
const TOKEN = "paste the token printed by bridge-server.mjs";

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "hello", role: "agent", name: "my-agent", token: TOKEN }));
  ws.send(JSON.stringify({ type: "action", id: "req-123", action: "readTab", params: {} }));
};

ws.onmessage = (e) => {
  console.log(JSON.parse(e.data)); // the approval result
};
```

> **Token required.** Every client (agent AND extension) must present the
> shared-secret token in its `hello`. Start the server with
> `AGENTBRIDGE_TOKEN=my-token node bridge-server.mjs` to fix the token for
> automation; otherwise the server generates a fresh one each start and prints it.

### Message protocol (JSON text frames)

1. **Hello** — on connect (token required):

   Agent → Server:
   ```json
   {"type": "hello", "role": "agent", "name": "my-agent", "token": "<shared-secret>"}
   ```
   Extension → Server:
   ```json
   {"type": "hello", "role": "extension", "name": "AgentBridge", "token": "<shared-secret>"}
   ```

2. **Action request** (agent → server → extension; server injects `from` = agent name):
   ```json
   {"type": "action", "id": "req-123", "action": "readTab", "params": {}, "from": "my-agent"}
   ```

3. **Approval result** (extension → server → agent, forwarded verbatim):
   ```json
   {"type": "result", "id": "req-123", "ok": true, "data": {"title": "...", "url": "..."}}
   ```
   Denied:
   ```json
   {"type": "result", "id": "req-123", "ok": false, "error": "denied by user"}
   ```

4. **Status** (extension → server → agent, informational):
   ```json
   {"type": "status", "state": "connected", "ts": 1723600000000}
   ```
   `state` is `"connected"` or `"disconnected"`.

## Actions v1

| action | params | data on success |
|---|---|---|
| `readTab` | `{}` | `{"title": string, "url": string}` — active tab of the current window |
| `readClipboard` | `{}` | `{"text": string}` |
| `writeClipboard` | `{"text": string}` | `{"ok": true}` |
| `inject` | `{"text": string}` | `{"ok": true, "characters": n, "field": "input"}` — the text was verified in the field. Nothing focused, a changed page, or a field that keeps nothing answer `{"ok": false, "error": ...}` |

Errors return `{"ok": false, "error": "<message>"}`:

- `"denied by user"` — the human denied the request.
- `"busy"` — another request was already pending.
- `"timeout"` — no approval within 60 seconds.
- `"no extension connected"` — no extension is attached to the bridge.
- any other message — an execution failure.

## Approval flow

1. Every action shows an approval UI **first** — a Chrome notification with
   ✅/🚫 buttons, with the popup as fallback.
2. Execution happens **only after** explicit approval.
3. **One pending request at a time.** If a new action arrives while one is pending,
   it is auto-denied with `{"ok": false, "error": "busy"}`.
4. **60-second timeout.** If the human does not answer in 60 seconds, the request is
   auto-denied with `{"ok": false, "error": "timeout"}`.
5. The approval count is tracked in `chrome.storage.local` (`approvals`).

## Security model

- **Loopback only.** The bridge binds to `127.0.0.1:8788`. Nothing is exposed to the
  network or the internet.
- **Shared-secret token auth.** Every connection must present the token in its
  `hello`; the server rejects and closes otherwise. Web pages (browser Origins)
  cannot even complete the WebSocket handshake — only local processes without an
  Origin header or the extension itself may connect.
- **Requester identity.** The approval prompt shows exactly which agent is asking.
- **Approval gate in code.** The extension never executes an action without an
  explicit human approval. There is no auto-execution path.
- **Size caps + redacted logs.** Frames are capped at 1 MB, `params.text` at 256 KB,
  and the extension never logs clipboard/body content.
- **Why `host_permissions: ["<all_urls>"]`?** Agents act without a user gesture — they
  do not click or type themselves. The extension therefore needs broad host access to
  query the active tab, read/write the clipboard, and inject text into any page the
  user has open. The approval gate is the control that makes this safe.

## Troubleshooting

- **Bridge not running** — start it with `node bridge-server.mjs`. Expect
  `listening on ws://127.0.0.1:8788`. The server logs JSON lines
  (`connect`, `disconnect`, `action`, `result`, `approval`, `deny`) to stdout.
- **Extension not connecting** — the extension stays disconnected until you paste
  the bridge token in the popup (one-time). After saving, it reconnects immediately.
  Reload the extension in `chrome://extensions` if it still shows disconnected. The
  service worker auto-reconnects with backoff (1s, 5s, 15s, max 30s) and a 30s
  `chrome.alarms` tick keeps it alive.
- **Agent gets `invalid token`** — the agent's `hello` token does not match the
  server's. Restart the server with `AGENTBRIDGE_TOKEN=<token>` set (or copy the
  freshly printed token into the extension popup again).

## Development

File layout (all under `agentbridge/`):

```
bridge-server.mjs      — WebSocket server (Node, port 8788)
manifest.json          — MV3 manifest
background.js          — service worker: WS client + approval gate + executors
content.js             — clipboard/inject helpers
popup.html, popup.js   — approval + status UI
icons/                 — icon16/48/128
test/agent-client.mjs  — E2E agent client
test/e2e.mjs           — orchestrator: server + Chrome + assertions
test/RESULTS.md        — PASS/FAIL per scenario
NEXT-STEPS.md          — onboarding + Web Store launch guide (for the human owner)
```

Running the E2E tests: start the server, launch Chrome with the extension loaded,
and run the `test/e2e.mjs` harness. It connects the agent client, exercises each
action, covers the deny and timeout paths, and reports PASS/FAIL per scenario in
`test/RESULTS.md`.

## For AI agents working on this repo

This section is written for other AI agents (coding agents, automation, contributors)
who pick up this codebase. Read it before changing anything.

### Ground rules

1. **The approval gate is the product.** Never introduce any path that executes an
   agent action without explicit human approval. No auto-execute, no silent bypass,
   no "trusted agent" exceptions. The 60s timeout auto-deny is intentional.
2. **Zero dependencies.** `bridge-server.mjs` runs on stock Node (20+, built-in
   WebSocket). Do not add npm packages. Tests run with the built-in `node:test`
   runner or plain scripts — no frameworks.
3. **Loopback only.** The bridge must stay bound to `127.0.0.1`. Remote access is
   a deliberate, separate feature (encrypted `wss://` + auth) that requires the
   owner's explicit go-ahead. Do not widen the bind without it.
4. **One pending request at a time** (`busy` auto-deny). The approval queue is
   serialized in `background.js`.
5. **Protocol compatibility.** Agents are third parties. Message shapes in
   PROTOCOL.md are the contract — extend additive-only, never rename existing
   fields without a major version bump.

### How to run everything

```bash
# 1. Server (no install needed)
node bridge-server.mjs          # ws://127.0.0.1:8788

# 2. Server self-test (6/6)
node test/server-self-test.mjs

# 3. Demo agent (sends a readTab action; approve via popup)
node test/agent-client.mjs

# 4. Full E2E (needs Chrome for Testing + xvfb on headless boxes)
E2E_SHOT_DIR=/tmp/ab-shots timeout 400 xvfb-run -a node test/e2e.mjs
```

### E2E harness mechanics (read before touching test/e2e.mjs)

- The harness drives a **real Chrome** over CDP: launches Chrome with the extension
  loaded, attaches to the service worker, opens the popup as a **tab** (via CDP
  HTTP `PUT /json/new?url=chrome-extension://<id>/popup.html?e2e=<ts>` — never via
  `chrome.windows.create` SW evals, which hang under xvfb).
- **Fresh popup tab per decision.** A reused background tab gets frozen by Chrome;
  its CDP evals queue until unfreeze and the 60s approval timeout wins. Always
  close the previous popup tab and create a new one.
- After attaching, send `Page.setWebLifecycleState({state:"active"})` (best-effort)
  to unfreeze the backgrounded popup tab without activating it (`bringToFront`
  would break `getActiveTab()`).
- **Every CDP eval must be raced with `withTimeout`.** Nothing may hang the
  harness. Screenshots are best-effort proof artifacts (5s cap) — never part of
  the correctness path.
- The service worker can freeze when idle under xvfb; socket writes flush on the
  next 30s keepalive wake (observed ~20–26s delays). Wait up to 40s for results.
- Select the extension service worker by **manifest name** (`AgentBridge`) —
  Chrome ships a built-in "Contextual Tasks" component extension; never
  first-match on extension id.
- Kill orphans by port (`fuser -k <port>/tcp`), never `pkill -f` patterns that
  match the harness's own cmdline. `zip` is absent in the sandbox — build the
  package with `python3 -m zipfile -c dist/agentbridge.zip <files>`.

### Extension architecture notes

- `background.js` is the service worker: it is the WS **client** to the bridge
  (MV3 SWs cannot be WS servers), owns the approval queue, and executes approved
  actions via `chrome.tabs`, `navigator.clipboard` (with `chrome.scripting`
  fallback), and content-script messaging.
- `e2eMode` storage flag (`chrome.storage.local.get('e2eMode')`) skips
  `chrome.action.openPopup()` so the harness can drive the popup as a tab.
  Production-safe no-op; leave the flag unset in real use.
- `host_permissions: ["<all_urls>"]` is required because agents act without a user
  gesture. The approval gate is the control that makes this safe.

### What a good change looks like

- Additive protocol changes only (new action types are fine).
- Tests: extend `test/e2e.mjs` with the new scenario and keep 9/9 (or more) green;
  keep `test/RESULTS.md` in sync.
- Document new actions in README's action table + PROTOCOL.md.
- Verify the store package: rebuild `dist/agentbridge.zip` and confirm the file
  list matches the manifest (icons, popup, background, content, README).

### Definition of done

Server self-test 6/6 **and** full E2E green (exit 0) **and** evidence updated in
`businesses/yardwork/work/t4-build/evidence/` when working from the workspace copy.
Never claim green without running the suite.
