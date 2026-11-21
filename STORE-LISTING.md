# AgentBridge — Chrome Web Store Listing

- **Version:** 0.5.2
- **Price:** Free
- **Developer:** YardWork — https://yardwork.dev

## Link fields

- **Website:** `https://yardwork.dev`
- **Privacy policy:** `https://yardwork.dev/agentbridge/privacy.html` (live)

## Name

**AgentBridge — Connect AI Agents to Your Browser**

## Short description (132 chars max)

```
Connect AI agents to your browser: read the tab, read/write the clipboard, inject text — every action needs your approval.
```

## Detailed description

```
AgentBridge is a free, local bridge between AI agents and your Chrome browser.

It gives your AI assistant a safe, approved way to see and act in your browser:

• Read the page you are on — its title and URL
• Read the clipboard — grab the text you copied
• Write the clipboard — put text there ready to paste
• Inject text — type into the focused field on any page

Every single action needs your approval. Nothing runs automatically. When an agent asks for something, you get a notification with Approve and Deny buttons. No approval, no action — ever.

Why you would want it: your AI agent can check which page you are on, prepare an email, a form answer, or a code snippet, and place it into the right field — with you approving each step.

How it works: the extension connects to a tiny local bridge server on your own machine (127.0.0.1:8788). Your agent connects to the same server. The server only routes messages between the two — it never sends anything to the internet.

Private by design: all traffic stays on your computer, on the loopback interface. No accounts, no cloud, no telemetry, no data collection.

Free, and compatible with any agent that speaks WebSocket — the message protocol is simple and documented.
```

## Category

**Productivity**

## Tags (max 5)

1. AI
2. browser automation
3. clipboard
4. productivity
5. agents

## Screenshots (upload these)

Upload these three, in this order. They are real captures of version 0.5.1 (the UI is unchanged in 0.5.2) — the popup
drove a real bridge and a real WebSocket agent — composed at 1280×800.

| File | What it shows |
|---|---|
| `shots/store/01-connected.png` | The popup connected to the local bridge, nothing pending. |
| `shots/store/02-approval.png` | The gate: an agent named Claude asks to read a page; who asked, which page, what it does, Approve/Deny. |
| `shots/store/03-executed.png` | After approval: the agent's words in the field, at the caret. |

## What's new (paste into the store's "What's new" field)

```
Version 0.5.2 — every approval now means exactly what it says.

• The prompt names the page and the tab it was asked for. If you switch tabs before
answering, nothing runs — you are told, instead of the action landing somewhere else.
• You see the whole text before you approve it, with a character count; it used to
show the first eighty characters and run the rest.
• Typing inserts at your cursor in the field you were in. It no longer replaces what
the field held, and a field that kept nothing is reported as a failure, not a success.
• Your agent and your extension now hold separate secrets, so an agent cannot pose as
the browser. A bridge that cannot prove itself is refused before any key is sent.
• A second request waits in a queue instead of being denied as "busy".
• The always-on content script is gone: nothing of the extension runs on a page until
an approved action needs it. No new permissions were requested.
```

## Review notes

- **No new permissions since 0.3.0.** The permission list and host permissions are
  unchanged; the `<all_urls>` content script that shipped in 0.3.0 is **removed** in
  0.5.2, so the extension's footprint on pages is smaller than in the version already
  published.
- The bridge is a local Node process on `127.0.0.1:8788` that the user starts
  themselves; the extension never opens a listening socket and never contacts a remote
  host.

## Single-purpose statement

AgentBridge exists for one purpose: to let AI agents read your active tab and clipboard and inject text into a page, with your explicit approval on every action. It does nothing else — no ads, no accounts, no tracking, no other features.

## Permissions justification

| Permission | Why it is needed |
|---|---|
| `activeTab` | Read the active tab's title/URL for an approved `readTab`. |
| `clipboardRead` | Read clipboard text for the approved `readClipboard`. |
| `clipboardWrite` | Write text to the clipboard for the approved `writeClipboard`. |
| `scripting` | Inject text into the focused element for the approved `inject`. |
| `storage` | Store the approval count and bridge status locally. |
| `notifications` | Show the approval notification with Approve/Deny buttons. |
| `alarms` | Keep the service worker alive so the extension stays connected. |
| `host_permissions: <all_urls>` | Agents act without a user gesture, so the extension must reach any page the user has open. The approval gate is the control that makes this safe. No content script is declared on these pages: nothing of the extension runs until an approved action needs it. |

## Privacy

- Data stays local: bridge binds to `127.0.0.1` (loopback only). No cloud, no accounts.
- No telemetry, no data collection.
- Touches tab titles/URLs, clipboard text, and injected text — all processed on your machine only.
- Approval count stored in local browser storage, on your device only.
