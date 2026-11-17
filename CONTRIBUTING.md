# Contributing

Thanks for helping with AgentBridge. Please read the **"For AI agents working on this repo"** section of README.md first — it has the ground rules.

## Ground rules

1. **The approval gate is the product.** Never introduce any path that executes an action without explicit human approval. No auto-execute, no silent bypass, no "trusted agent" exceptions.
2. **Zero dependencies.** The server runs on stock Node (20+, built-in WebSocket). No npm packages, no test frameworks.
3. **Loopback only.** The bridge stays bound to `127.0.0.1`. Remote access is a deliberate, separate feature.
4. **One pending request at a time** (`busy` auto-deny).
5. **Protocol compatibility.** Message shapes in PROTOCOL.md are the contract — extend additive-only, never rename existing fields without a major version bump.

## Before opening a PR

- Additive protocol changes only (new action types are fine).
- Extend `test/e2e.mjs` for new actions and keep the suite green; keep `test/RESULTS.md` in sync.
- Server changes must keep `test/server-self-test.mjs` (8/8) and `test/stress-test.mjs` (18/18, `STRICT=1`, 0 findings) green.
- Document new actions in README's action table and PROTOCOL.md.

## Definition of done

Suites that drive a real browser need a display and, in a container running as
root, the Chromium sandbox turned off:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright   # wherever the browser is
export CHROME_BIN=/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome
AGENTBRIDGE_NO_SANDBOX=1 xvfb-run -a node test/gate-integrity.mjs
```

Server self-test 8/8 **and** stress 18/18 **and** E2E green — never claim green without running the suite.
