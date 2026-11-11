# Security

AgentBridge's core value is that **no action executes without explicit human approval**. The approval gate is enforced in code, not by convention. Treat anything that could bypass it as a critical issue.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately to: **ivanov@getyardwork.com** (include the word "security" in the subject). We'll respond and coordinate a fix before disclosure.

## Security model (as designed)

- **Loopback only.** The bridge binds to `127.0.0.1:8788`. Nothing is exposed to the network or internet.
- **Shared-secret token auth.** Every connection must present the token in its `hello`; the server rejects and closes otherwise.
- **Origin allowlist.** Browser page origins cannot complete the WebSocket handshake — only local processes without an Origin header or the extension itself (`chrome-extension://`).
- **Approval gate in code.** The extension never executes an action without an explicit human approval; there is no auto-execution path.
- **One pending request at a time** (`busy` auto-deny) and a **60s timeout** auto-denies unanswered requests.
- **Size caps + redacted logs.** Frames capped at 1 MB, `params.text` at 256 KB; clipboard/body content is never logged.

## Scope

The `host_permissions: <all_urls>` permission exists because agents act without a user gesture. The approval gate is the control that makes this safe. If you find a path that executes without approval, that is the highest-severity finding.

## Threat notes

- **Port squatting.** A local process that binds 8788 before the bridge used to receive
  the extension's key in the first frame. The extension now sends a nonce and verifies
  an HMAC proof of the key before sending anything; a squatter cannot produce it.
- **Role confusion.** With one shared secret, an agent could claim `role:"extension"`
  and displace the real extension. The roles now use separate secrets, so it cannot.
- **Agent names** are self-declared labels; the token is the identity. Run one bridge
  per agent if you need a real distinction.
- **Keys at rest** live in `~/.agentbridge/keys.json`, mode `600`, written by the server
  on first run. `--rotate` replaces them.
