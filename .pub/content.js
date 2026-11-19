/**
 * AgentBridge — content script.
 * Helper ONLY: clipboard read/write fallbacks for the service worker.
 * This script NEVER opens WebSocket connections — the SW owns the bridge.
 *
 * Injected on demand by the service worker, only into the tab an approved action
 * is about — it no longer runs on every page a person visits.
 */

if (!globalThis.__agentbridgeContentLoaded) {
  globalThis.__agentbridgeContentLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  // Only respond to messages from OUR OWN extension (SW/popup).
  if (!sender || sender.id !== chrome.runtime.id) return;

  switch (msg.type) {
    case "agentbridge:readClipboard": {
      readClipboardFallback()
        .then((text) => sendResponse({ ok: true, text }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async
    }
    case "agentbridge:writeClipboard": {
      writeClipboardFallback(String(msg.text ?? ""))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async
    }
    case "agentbridge:ping": {
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
  });
}

/**
 * Fallback clipboard read: try navigator.clipboard first (may fail without
 * focus/permission), then a hidden-textarea + execCommand('paste').
 */
async function readClipboardFallback() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const t = await navigator.clipboard.readText();
      if (t !== undefined) return t;
    }
  } catch {
    // fall through
  }
  return legacyRead();
}

/**
 * Legacy path: execCommand('paste') on a focused hidden textarea.
 * Returns the pasted text, or rejects if unavailable.
 */
function legacyRead() {
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    try {
      const ok = document.execCommand("paste");
      const value = ta.value;
      ta.remove();
      if (ok && value) {
        resolve(value);
      } else {
        reject(new Error("clipboard read unavailable"));
      }
    } catch (e) {
      ta.remove();
      reject(e);
    }
  });
}

/** Fallback clipboard write via execCommand('copy'). */
async function writeClipboardFallback(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  try {
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("clipboard write unavailable");
  } catch (e) {
    ta.remove();
    throw e;
  }
}
