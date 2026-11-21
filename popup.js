/**
 * AgentBridge — popup UI.
 *
 * Paints the state the service worker reports. Nothing here decides anything:
 * the gate lives in the service worker, and this surface only asks.
 *
 * Three rules, learned the hard way:
 *  - never state a fact before the worker answers (an honest "Checking" beats a
 *    wrong "disconnected" that the person acts on);
 *  - name the action in words the person can weigh, not in the protocol's words;
 *  - say where the text is going before the button that sends it.
 */

const $ = (id) => document.getElementById(id);

/** Protocol action → what it will actually do to the page in front of you. */
const IN_PLAIN_WORDS = {
  readTab: "Read this tab",
  readClipboard: "Read your clipboard",
  writeClipboard: "Write to your clipboard",
  inject: "Type into this tab",
};

const STATUS_WORDS = {
  connected: "Connected",
  disconnected: "Offline",
  checking: "Checking",
};

function paintStatus(state) {
  const el = $("status");
  const name = state.connected ? "connected" : "disconnected";
  el.dataset.state = name;
  el.querySelector(".label").textContent = STATUS_WORDS[name];
}

/** The page, with the host readable at a glance and the rest quiet. */
function paintWhere(target) {
  const el = $("pendingWhere");
  const url = target?.url || "";
  if (!url) {
    el.hidden = true;
    return;
  }
  let host = target.host || "";
  let rest = "";
  try {
    const u = new URL(url);
    host = u.host;
    rest = u.pathname + u.search + u.hash;
    if (rest === "/") rest = "";
  } catch {
    rest = url;
  }
  el.hidden = false;
  el.textContent = "";
  const strong = document.createElement("span");
  strong.className = "host";
  strong.textContent = host;
  const quiet = document.createElement("span");
  quiet.className = "rest";
  quiet.textContent = rest || "";
  el.append(strong, quiet);
}

function render(state) {
  paintStatus(state);
  $("approvals").textContent = `${state.approvals} approved here`;

  const errEl = $("stateError");
  errEl.hidden = !state.error;
  if (state.error) errEl.textContent = state.error;

  // Setup stays collapsed unless it is the only thing the person could need, and
  // it steps out of the way entirely while there is a decision to make.
  const setup = $("setup");
  setup.hidden = Boolean(state.pending);
  if (!state.tokenSet && !setup.open) setup.open = true;
  $("tokenNote").textContent = state.tokenSet
    ? "A key is saved. Paste a new one only to rotate it."
    : "No key saved yet — the extension stays offline until you paste one.";

  // The queue is not a statistic: it is how many people are behind this one.
  const waiting = (state.queue?.length || 0) - 1;
  const queueEl = $("queueNote");
  queueEl.hidden = !(state.pending && waiting > 0);
  if (state.pending && waiting > 0) {
    queueEl.textContent = `${waiting} more request${waiting === 1 ? "" : "s"} waiting behind this one`;
  }

  const pending = state.pending;
  $("pendingWrap").hidden = !pending;
  // On a first run the inbox has never had anything in it: saying "nothing is
  // waiting" above the only thing that can fix that is noise in the best spot.
  $("noPending").hidden = Boolean(pending) || (!state.tokenSet && !state.connected);
  if (!pending) return;

  $("pendingFrom").textContent = pending.from ? `from ${pending.from}` : "from an unnamed agent";
  $("pendingAction").textContent = IN_PLAIN_WORDS[pending.action] || pending.action;
  paintWhere(pending.target);

  $("pendingDetail").textContent = pending.detail || "";

  const textEl = $("pendingText");
  const metaEl = $("payloadMeta");
  const hasText = Boolean(pending.text);
  textEl.hidden = !hasText;
  metaEl.hidden = !hasText;
  // The payload is shown once, in the field below. Repeating it inside the
  // description made the person read the same sentence twice and trust neither.
  if (hasText) $("pendingDetail").textContent = "";
  if (hasText) {
    textEl.textContent = pending.text;
    $("payloadSize").textContent = `${pending.text.length.toLocaleString()} character${
      pending.text.length === 1 ? "" : "s"
    }`;
  } else {
    textEl.textContent = "";
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "agentbridge:getState" }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    render(state);
  });
}

function decide(message) {
  chrome.runtime.sendMessage({ type: message }, () => refresh());
}

$("approveBtn").addEventListener("click", () => decide("agentbridge:approve"));
$("denyBtn").addEventListener("click", () => decide("agentbridge:deny"));

$("tokenSaveBtn").addEventListener("click", () => {
  const token = $("tokenInput").value.trim();
  if (!token) return;
  chrome.runtime.sendMessage({ type: "agentbridge:setToken", token }, () => {
    $("tokenInput").value = "";
    refresh();
  });
});

// The command is here to be copied, not retyped.
$("copyCmd").addEventListener("click", async () => {
  const text = $("cmdText").textContent.trim();
  try {
    await navigator.clipboard.writeText(text);
    $("copyCmd").textContent = "Copied";
  } catch {
    $("copyCmd").textContent = "Select it";
  }
  setTimeout(() => ($("copyCmd").textContent = "Copy"), 1200);
});

// A decision should not need the mouse when the popup has the keyboard.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target instanceof HTMLInputElement;
  if ($("pendingWrap").hidden) return;
  const key = e.key.toLowerCase();
  if (key === "a" && !typing) {
    e.preventDefault();
    decide("agentbridge:approve");
  } else if (key === "d" && !typing) {
    e.preventDefault();
    decide("agentbridge:deny");
  } else if (e.key === "Enter") {
    e.preventDefault();
    decide("agentbridge:approve");
  } else if (e.key === "Escape") {
    e.preventDefault();
    decide("agentbridge:deny");
  }
});

// Live-update when the SW broadcasts a state change.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "agentbridge:stateChanged") refresh();
});

refresh();
