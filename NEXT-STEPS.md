# AgentBridge — Status & Next Steps

## Status

- **v0.5.0.** Two secrets instead of one, a server that proves itself before the key is sent, keys persisted in `~/.agentbridge/keys.json` (600), approvals queued with a badge, and no always-on content script.
- **v0.4.0.** An approval is bound to a page: `inject` types at the caret through the input pipeline and is verified before `ok`, the prompt names the page and counts the whole payload.
- **v0.3.0.** Server concurrency fixes (agents and pending requests keyed by unique connection id; duplicate request id → `busy` instead of misrouting).
- **Tested:** server self-test 8/8 · stress suite 18/18 (strict, 0 findings) · E2E in real Chrome 9/9.
- Published on the Chrome Web Store.

## Run & test

```bash
node bridge-server.mjs              # ws://127.0.0.1:8788 (token printed on stdout)
node test/server-self-test.mjs      # 8/8
node test/approval-binding.mjs      # 13/13 (real Chrome + xvfb-run, desktop only)
node test/gate-integrity.mjs        # 14/14 (who may speak, queue, key file)
node test/agent-client.mjs          # demo agent (readTab)
STRICT=1 node test/stress-test.mjs  # concurrency + hostile input, 18/18
E2E_SHOT_DIR=/tmp/shots timeout 400 xvfb-run -a node test/e2e.mjs  # 9/9 (real Chrome)
```

Build the store package:

```bash
python3 -m zipfile -c dist/agentbridge.zip manifest.json background.js content.js popup.html popup.js icons/icon16.png icons/icon48.png icons/icon128.png README.md STORE-LISTING.md
```

## Roadmap ideas

- **More actions** — mouse clicks, navigation, scrolling (easy, additive to the protocol; see PROTOCOL.md).
- **Remote bridge** — let an agent on another machine control a browser, via encrypted `wss://` + auth keys. This is a deliberate security step and must stay opt-in.

## Contributing

See CONTRIBUTING.md (ground rules, test expectations) and SECURITY.md (how to report).
