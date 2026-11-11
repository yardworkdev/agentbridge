# AgentBridge — Chrome Web Store Listing

- **Version:** 0.5.0
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

## Screenshot plan (3–5 shots)

1. **Extension popup — connected state:** bridge status (connected) + approval count.
2. **Approval notification:** Chrome notification with Approve / Deny buttons for an incoming request — the human gate.
3. **Agent client terminal:** a small WebSocket client sending a `readTab` request and printing the approved result.
4. *(optional)* **Clipboard roundtrip:** agent writes text, reads it back.
5. *(optional)* **Inject demo:** agent text typed into a focused form field after approval.

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
