/**
 * AgentBridge — background service worker (MV3).
 * WebSocket CLIENT to ws://127.0.0.1:8788 (the local bridge server).
 * Receives action requests from AI agents, shows a human approval gate,
 * executes approved actions, and sends results back.
 *
 * Core value: NO action executes without explicit human approval.
 */

const BRIDGE_URL = "ws://127.0.0.1:8788";
const APPROVAL_TIMEOUT_MS = 60_000; // 60s -> auto-deny
const RECONNECT_BACKOFFS = [1000, 5000, 15000, 30000]; // then stays at 30s max
const KEEPALIVE_ALARM = "agentbridge-keepalive";
const APPROVALS_KEY = "approvals";
const TOKEN_KEY = "bridgeToken";
const MAX_TEXT_BYTES = 256 * 1024; // cap on writeClipboard/inject payloads

/** @type {WebSocket|null} */
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

/** @type {{id: string, action: string, params: object, from: string}|null} */
let pendingApproval = null;
let approvalTimeoutTimer = null;

/**
 * Send a message to the bridge server.
 * @param {object} msg
 */
function sendToBridge(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Broadcast extension state to any attached agent. */
function broadcastStatus(state) {
  sendToBridge({ type: "status", state, ts: Date.now() });
}

/**
 * Connect (or reconnect) to the bridge server.
 * Requires a configured token — the bridge rejects unauthenticated clients.
 */
async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  if (!token) {
    // No token configured yet — tell the popup, retry later (keepalive
    // alarm + storage.onChanged will re-trigger connect()).
    updatePopup();
    return;
  }

  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    sendToBridge({ type: "hello", role: "extension", name: "AgentBridge", token });
    broadcastStatus("connected");
    updatePopup();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleBridgeMessage(msg);
  });

  ws.addEventListener("close", () => {
    ws = null;
    broadcastStatus("disconnected");
    updatePopup();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close event follows; nothing to do here.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = RECONNECT_BACKOFFS[Math.min(reconnectAttempt, RECONNECT_BACKOFFS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Handle a message from the bridge.
 * @param {object} msg
 */
async function handleBridgeMessage(msg) {
  // Log metadata only — NEVER message bodies (clipboard/inject text).
  console.log("[trace] bridge msg:", msg?.type || "?", msg?.id || "", msg?.action || "", msg?.from || "");
  if (msg.type === "action") {
    await handleActionRequest(msg);
  }
}

/**
 * Approval gate entry point.
 * One pending at a time; busy -> auto-deny; 60s timeout -> auto-deny.
 * @param {{id: string, action: string, params: object}} req
 */
async function handleActionRequest(req) {
  if (pendingApproval) {
    // Busy: a request is already awaiting approval.
    sendResult(req.id, false, "busy");
    return;
  }

  // Cap text payloads before they go anywhere near storage/logs/UI.
  const params = { ...(req.params || {}) };
  if (typeof params.text === "string" && params.text.length > MAX_TEXT_BYTES) {
    params.text = params.text.slice(0, MAX_TEXT_BYTES);
  }
  // Pin the page the person is being asked about. Without this the action ran
  // against whatever tab was in front when they clicked Approve, so approving
  // while looking at page A could type into page B.
  const target = await captureTarget();
  pendingApproval = {
    id: req.id,
    action: req.action,
    params,
    from: req.from || "unknown",
    target,
  };
  console.log("[trace] pending set:", req.id, req.action, "from", pendingApproval.from);
  startApprovalTimeout(req.id);
  showApprovalNotification(req);
  updatePopup();

  // Fallback: also open the popup so the user sees the request.
  // E2E test mode (storage flag set by the test harness) skips this — the
  // action popup steals focus and breaks the harness's active-tab targeting.
  chrome.storage.local.get({ e2eMode: false }, (res) => {
    if (res.e2eMode) return;
    try {
      chrome.action.openPopup().catch(() => {});
    } catch {
      // openPopup may fail if a popup is already open or in some contexts.
    }
  });
}

/**
 * The tab a request is about, captured when the request arrives.
 * @returns {Promise<{tabId:number,url:string,title:string,host:string}|null>}
 */
async function captureTarget() {
  try {
    const tab = await getActiveTab();
    let host = "";
    try {
      host = new URL(tab.url || "").host || "";
    } catch {
      host = tab.url || "";
    }
    return { tabId: tab.id, url: tab.url || "", title: tab.title || "", host };
  } catch {
    return null;
  }
}

function startApprovalTimeout(id) {
  clearTimeout(approvalTimeoutTimer);
  approvalTimeoutTimer = setTimeout(() => {
    if (pendingApproval && pendingApproval.id === id) {
      const req = pendingApproval;
      pendingApproval = null;
      clearTimeout(approvalTimeoutTimer);
      sendResult(req.id, false, "timeout");
      hideNotification();
      updatePopup();
    }
  }, APPROVAL_TIMEOUT_MS);
}

/** Show the approval notification with Approve/Deny buttons. */
function showApprovalNotification(req) {
  const actionLabel = req.action || "unknown action";
  const detail = describeAction(req);
  chrome.notifications.create(
    "agentbridge-approval",
    {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `AgentBridge: ${actionLabel}?`,
      message: `Agent "${req.from || "unknown"}" requests: ${detail}`,
      buttons: [{ title: "✅ Approve" }, { title: "🚫 Deny" }],
      priority: 2,
      requireInteraction: true,
    },
    () => {
      if (chrome.runtime.lastError) {
        // Notification failed (e.g. permission) — popup fallback still visible.
      }
    }
  );
}

/** Human-readable description of what the agent wants. */
/**
 * A payload is shown whole up to PREVIEW_CHARS and counted beyond it. A person
 * used to see the first eighty characters of a payload and then approve the rest.
 */
const PREVIEW_CHARS = 200;

function preview(text) {
  const value = String(text ?? "");
  const head = value.slice(0, PREVIEW_CHARS);
  if (value.length <= head.length) return `"${value}"`;
  return `"${head}" … (${value.length.toLocaleString()} characters)`;
}

function describeAction(req) {
  const where = req.target?.host ? ` at ${req.target.host}` : "";
  switch (req.action) {
    case "readTab":
      return `Read the title and URL of the page${where}`;
    case "readClipboard":
      return `Read your clipboard text${where}`;
    case "writeClipboard":
      return `Write to clipboard${where}: ${preview(req.params?.text)}`;
    case "inject":
      return `Type into the focused field of the page${where}: ${preview(req.params?.text)}`;
    default:
      return `Unknown action "${req.action}"`;
  }
}

function hideNotification() {
  try {
    chrome.notifications.clear("agentbridge-approval");
  } catch {
    // ignore
  }
}

/**
 * Notification button click: index 0 = approve, 1 = deny.
 */
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== "agentbridge-approval") return;
  if (buttonIndex === 0) {
    approvePending();
  } else {
    denyPending();
  }
});

/**
 * Notification body click: open the popup showing the pending request.
 */
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== "agentbridge-approval") return;
  try {
    chrome.action.openPopup().catch(() => {});
  } catch {
    // ignore
  }
});

/** Approve the pending request (from notification button or popup). */
function approvePending() {
  console.log("[trace] approvePending called, pending =", pendingApproval ? pendingApproval.id : null);
  if (!pendingApproval) return;
  const req = pendingApproval;
  pendingApproval = null;
  clearTimeout(approvalTimeoutTimer);
  hideNotification();
  updatePopup();

  executeAction(req)
    .then((data) => {
      incrementApprovals();
      sendResult(req.id, true, data);
    })
    .catch((err) => {
      sendResult(req.id, false, err?.message || "execution failed");
    });
}

/** Deny the pending request. */
function denyPending() {
  console.log("[trace] denyPending called, pending =", pendingApproval ? pendingApproval.id : null);
  if (!pendingApproval) return;
  const req = pendingApproval;
  pendingApproval = null;
  clearTimeout(approvalTimeoutTimer);
  hideNotification();
  updatePopup();
  sendResult(req.id, false, "denied by user");
}

/**
 * Execute an approved action.
 * @returns {Promise<object>} data for the result message
 */
async function executeAction(req) {
  const target = req.target;
  switch (req.action) {
    case "readTab":
      return readTab(target);
    case "readClipboard":
      return readClipboard(target);
    case "writeClipboard":
      await writeClipboard(String(req.params?.text ?? ""), target);
      return { ok: true };
    case "inject": {
      const text = String(req.params?.text ?? "");
      const result = await injectText(text, target);
      // The answer is the measurement, not the intention: the field is checked
      // after the write, and the agent is told what the page actually holds.
      return { ok: true, characters: text.length, field: result.field };
    }
    default:
      throw new Error(`unknown action: ${req.action}`);
  }
}

/** Send a result back to the bridge (which routes it to the agent). */
function sendResult(id, ok, dataOrError) {
  // Log metadata only; data may contain clipboard text — never log it.
  console.log("[trace] sendResult:", id, ok, ok ? "(data redacted)" : dataOrError);
  if (ok) {
    sendToBridge({ type: "result", id, ok: true, data: dataOrError });
  } else {
    sendToBridge({ type: "result", id, ok: false, error: dataOrError });
  }
}

/** The active tab of the last focused normal window. */
async function getActiveTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tabs || tabs.length === 0) throw new Error("no active tab");
  return tabs[0];
}

/**
 * The tab the person was asked about, still showing the page it showed then.
 * Without this check an approval answered after a tab switch acted on the new
 * page — the prompt never named one, so the person had no way to know.
 */
async function targetTab(target) {
  if (!target || typeof target.tabId !== "number") {
    throw new Error("this request was not about a page; nothing was done");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(target.tabId);
  } catch {
    throw new Error("that tab was closed; nothing was done");
  }
  if (target.url && tab.url !== target.url) {
    throw new Error("the page changed since you were asked; nothing was done — ask again");
  }
  // Acting on a tab the person has since left is the same problem one step later:
  // they approved while looking at one thing and the text lands in another.
  const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active?.length || active[0].id !== tab.id) {
    throw new Error("you switched to another page before approving; nothing was done — ask again");
  }
  return tab;
}

async function readTab(target) {
  const tab = await targetTab(target);
  return { title: tab.title || "", url: tab.url || "" };
}

/**
 * Read clipboard text from the page the request was made about.
 * Fallback: execCommand('paste') in the content script.
 */
async function readClipboard(target) {
  const tab = await targetTab(target);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        return new Promise((resolve) => {
          try {
            navigator.clipboard
              .readText()
              .then((t) => resolve({ ok: true, text: t }))
              .catch(() => resolve({ ok: false }));
          } catch {
            resolve({ ok: false });
          }
        });
      },
    });
    if (results?.[0]?.result?.ok) {
      return { text: results[0].result.text };
    }
  } catch {
    // fall through to content script path
  }
  // Fallback via content script (execCommand paste).
  const res = await chrome.tabs.sendMessage(tab.id, { type: "agentbridge:readClipboard" });
  if (res?.ok) return { text: res.text };
  throw new Error("clipboard read failed");
}

/**
 * Write text to the clipboard from the page the request was made about.
 * Fallback: execCommand('copy') in the content script.
 */
async function writeClipboard(text, target) {
  const tab = await targetTab(target);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => {
        return new Promise((resolve) => {
          try {
            navigator.clipboard
              .writeText(value)
              .then(() => resolve({ ok: true }))
              .catch(() => resolve({ ok: false }));
          } catch {
            resolve({ ok: false });
          }
        });
      },
      args: [text],
    });
    if (results?.[0]?.result?.ok) return;
  } catch {
    // fall through
  }
  const res = await chrome.tabs.sendMessage(tab.id, { type: "agentbridge:writeClipboard", text });
  if (res?.ok) return;
  throw new Error("clipboard write failed");
}

/**
 * Type text into the focused field of the page the request was made about.
 * `execCommand("insertText")` is the closest thing to typing: the page gets the
 * same input event a keyboard produces, so React and friends update. It inserts
 * at the caret and keeps the text already in the field, which `el.value =` did
 * not — that overwrote the field.
 */
async function injectText(text, target) {
  const tab = await targetTab(target);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (value) => {
        const el = document.activeElement;
        const hasValue = el && typeof el.value === "string";
        if (!el || (!hasValue && !el.isContentEditable)) {
          return { ok: false, reason: "no text field is focused on that page" };
        }
        const read = () => (hasValue ? el.value : el.innerText || "");
        const before = read();
        el.focus();
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, value);
        } catch {
          inserted = false;
        }
        if (!inserted || read() === before) {
          // The page refused the command: fall back to writing at the caret with
          // the native setter, then dispatch the input event the page listens for.
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLInputElement
              ? HTMLInputElement.prototype
              : null;
          const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (!setter || !hasValue) {
            return { ok: false, reason: "that field cannot take text" };
          }
          const startPos = el.selectionStart ?? el.value.length;
          const endPos = el.selectionEnd ?? startPos;
          setter.call(el, el.value.slice(0, startPos) + value + el.value.slice(endPos));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          el.selectionStart = el.selectionEnd = startPos + value.length;
        }
        const after = read();
        const ok = after.includes(value);
        return {
          ok,
          field: el.tagName.toLowerCase(),
          characters: value.length,
          reason: ok ? "" : "the field did not keep the text",
        };
      },
      args: [text],
    });
  } catch (e) {
    throw new Error(`the page refused the text: ${e.message}`);
  }
  const result = results?.[0]?.result;
  if (!result?.ok) throw new Error(result?.reason || "the text was not inserted");
  return result;
}

/** Increment the approvals counter in chrome.storage.local. */
async function incrementApprovals() {
  try {
    const { [APPROVALS_KEY]: count = 0 } = await chrome.storage.local.get(APPROVALS_KEY);
    await chrome.storage.local.set({ [APPROVALS_KEY]: (count || 0) + 1 });
  } catch {
    // storage failure is non-fatal
  }
}

/**
 * Popup communication: popup asks for state / sends approve-deny.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "agentbridge:getState":
      chrome.storage.local.get([APPROVALS_KEY, TOKEN_KEY]).then(({ [APPROVALS_KEY]: approvals = 0, [TOKEN_KEY]: token = "" }) => {
        sendResponse({
          connected: !!(ws && ws.readyState === WebSocket.OPEN),
          tokenSet: !!token,
          pending: pendingApproval
            ? {
                id: pendingApproval.id,
                action: pendingApproval.action,
                from: pendingApproval.from,
                detail: describeAction(pendingApproval),
                // The page it is about, and the whole payload — the popup shows
                // both, because a person approves what they can read.
                target: pendingApproval.target
                  ? { host: pendingApproval.target.host, url: pendingApproval.target.url }
                  : null,
                text: typeof pendingApproval.params?.text === "string" ? pendingApproval.params.text : "",
              }
            : null,
          approvals: approvals || 0,
        });
      });
      return true; // async response
    case "agentbridge:approve":
      approvePending();
      sendResponse({ ok: true });
      return false;
    case "agentbridge:deny":
      denyPending();
      sendResponse({ ok: true });
      return false;
    case "agentbridge:setToken":
      chrome.storage.local.set({ [TOKEN_KEY]: String(msg.token || "") }).then(() => {
        // Token changed — reconnect immediately (old socket, if any, was
        // rejected by the bridge).
        if (ws) {
          try { ws.close(); } catch {}
          ws = null;
        }
        reconnectAttempt = 0;
        connect();
        sendResponse({ ok: true });
      });
      return true; // async response
    default:
      return false;
  }
});

/** Reconnect promptly when the user saves a new token in the popup. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[TOKEN_KEY]) {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    reconnectAttempt = 0;
    connect();
  }
});

/** Keep the service worker alive; reconnect if the socket dropped. */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

function updatePopup() {
  try {
    chrome.runtime.sendMessage({ type: "agentbridge:stateChanged" }).catch(() => {});
  } catch {
    // popup may not be open
  }
}

// Startup: connect + keepalive alarm.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  connect();
});

// Try to connect immediately (SW may be woken by an event).
connect();
