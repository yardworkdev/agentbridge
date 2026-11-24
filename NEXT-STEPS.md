# AgentBridge — Status & Next Steps

## Status

- **v0.6.0.** Current GitHub release and extension manifest. Download the extension-only store asset below; do not upload an older package or the bridge bundle.

- **v0.5.1.** the same product as 0.5.0, packaged after the copy pass — the two
  most important buttons no longer carry emoji — so the store upload matches the repo.
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

Build the store package from the current source tree:

```bash
node pack.mjs
node test/package.mjs
```

Use the path printed by the packer. Do not zip individual icon files with
`python3 -m zipfile`: that flattens their paths and Chrome cannot load the result.

## Pending — the store upload (owner's step)

The current GitHub package is **0.6.0**. Store submission remains the owner's
step; this document does not establish the live store's current version.

1. Download [agentbridge-0.6.0.zip](https://github.com/yardworkdev/agentbridge/releases/download/v0.6.0/agentbridge-0.6.0.zip).
   This is the extension-only asset, **not** `agentbridge-0.6.0-bundle.zip`.
   SHA-256: `a0546a9dcb79735ae0f635b44724100723bafb886a85450bb5b3abe104b02b25`.
   The downloaded manifest declares `0.6.0`; every member matches source commit
   `7d0d78520d1c8013dd0ef6ca507cc261bb0f4a64` and every manifest-referenced icon, worker and popup exists.
2. Upload that ZIP as the new package. Do not upload 0.5.1 or 0.5.2.
3. Paste the **What's new** block from the v0.6.0 `STORE-LISTING.md`.
4. Upload `shots/store/01-approval.png`, `02-setup.png`, `03-done.png`,
   in that order (1280×800), from the same source commit.
5. Review the store's permission/privacy fields and submit for review. This
   handoff does not submit anything or grant new publication permission.

The local bridge is still required for use. `bridge-server.mjs` is available
separately on the v0.6.0 release; it does not belong in the store upload.
This handoff checks packaging and screenshot dimensions, not a new browser
behavior test. The direct v0.6.0 browser/liveness proof remains separate.

## Roadmap ideas

- **More actions** — mouse clicks, navigation, scrolling (easy, additive to the protocol; see PROTOCOL.md).
- **Remote bridge** — let an agent on another machine control a browser, via encrypted `wss://` + auth keys. This is a deliberate security step and must stay opt-in.

## Contributing

See CONTRIBUTING.md (ground rules, test expectations) and SECURITY.md (how to report).
