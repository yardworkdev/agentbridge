# Privacy Policy — AgentBridge

*Effective date: 2026-11-11 · Version 0.5.0*

This policy applies to the AgentBridge Chrome extension and its local bridge
server (`bridge-server.mjs`). It explains what data is collected, where it
goes, and how you stay in control.

## The short version

**AgentBridge collects nothing. It sends nothing to the internet. It stores
nothing about you.**

The extension runs entirely on your own computer. The bridge server runs on
your own computer. There is no cloud, no account, no telemetry, and no
third-party analytics. The only data involved are the browser actions you
explicitly approve, exchanged between your browser and the bridge on your
machine.

## What data is processed

AgentBridge processes data only when an AI agent requests a browser action
and **you approve it**. The possible data:

| Feature | Data involved | When |
|---|---|---|
| Read the page (`readTab`) | The title and URL of the page you were looking at when the request arrived | Only after your approval |
| Read clipboard (`readClipboard`) | The text currently on your clipboard | Only after your approval |
| Write clipboard (`writeClipboard`) | Text written to your clipboard | Only after your approval |
| Type into a field (`inject`) | The text typed into the focused field | Only after your approval |

**Every request shows an approval prompt** with Approve/Deny buttons.
Nothing is executed without your explicit approval. If you do not answer
within 60 seconds, the request is automatically denied.

## Where data goes

- **Loopback only.** The bridge binds to `127.0.0.1` (your own machine).
  No data leaves your computer. Nothing is transmitted over the internet.
- The extension and agents communicate exclusively through this local bridge.
- AgentBridge does **not** use remote servers, does not sync data, does not
  phone home, and does not include advertising or analytics code.

## What is stored

- A local counter of approved actions (`approvals`) in Chrome's
  `chrome.storage.local` — a single number, stored on your device, used only
  to display the approval count in the extension popup. It never leaves your
  machine.
- No logs of your clipboard contents, tabs, or typed text are retained.
  The bridge prints operational status lines (connect, disconnect, action,
  result, approval, deny) to its own console output — the action *name*, not
  its payload. You can stop the server to stop all output.

## Your control

- **Every action needs your approval.** Deny is final. There is no
  auto-execution path and no "trusted agent" bypass.
- **Uninstall anytime.** Removing the extension and stopping the bridge
  server deletes all runtime state. The local approval counter is removed
  with the extension.
- **Local by design.** Because nothing leaves your machine, there is nothing
  for you to request, export, or delete from any external service.

## Children's privacy

AgentBridge does not collect personal information from anyone, including
children, because it collects no information at all.

## Changes to this policy

If this policy changes, the updated version will be published at this URL
with a new effective date. Because the extension processes no personal data,
changes will concern the data-processing mechanics described above.

## Contact

Questions about this policy: **hello@vesivanov.net** (YardWork,
https://yardwork.dev).

## Where your keys live

`bridge-server.mjs` writes two secrets — an agent token and the extension key — to
`~/.agentbridge/keys.json` on this machine, readable only by your user account
(mode `600`). Nothing is uploaded anywhere. The extension stores its key in Chrome's
local extension storage. Either side can be replaced with `--rotate`, which
invalidates both.
