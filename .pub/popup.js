/**
 * AgentBridge — popup UI.
 * Shows bridge status, pending request, approvals count.
 * Approve/Deny buttons message the service worker.
 */

const $ = (id) => document.getElementById(id);

function render(state) {
  const statusEl = $("status");
  if (state.connected) {
    statusEl.textContent = "Bridge: connected";
    statusEl.className = "status connected";
  } else {
    statusEl.textContent = "Bridge: disconnected";
    statusEl.className = "status disconnected";
  }

  $("approvals").textContent = `Approvals: ${state.approvals}`;

  const errEl = $("stateError");
  if (state.error) {
    errEl.hidden = false;
    errEl.textContent = state.error;
  } else {
    errEl.hidden = true;
  }

  // A second request is not dropped: it waits its turn, and the person can see
  // how many are behind this one.
  const queueEl = $("queueNote");
  const waiting = (state.queue?.length || 0) - 1;
  if (waiting > 0) {
    queueEl.hidden = false;
    queueEl.textContent = `${waiting} more request${waiting === 1 ? "" : "s"} waiting behind this one`;
  } else {
    queueEl.hidden = true;
  }

  const pending = state.pending;
  if (pending) {
    $("pendingWrap").hidden = false;
    $("noPending").hidden = true;
    $("pendingAction").textContent = `Action: ${pending.action}`;
    $("pendingFrom").textContent = `Requested by agent: ${pending.from || "unknown"}`;
    $("pendingDetail").textContent = pending.detail || "";

    // The page the action is about, and the whole payload. An approval is only
    // meaningful if it says where the text goes and shows all of it.
    const where = $("pendingWhere");
    if (pending.target?.host || pending.target?.url) {
      where.hidden = false;
      where.textContent = `Page: ${pending.target.url || pending.target.host}`;
      where.title = pending.target.url || "";
    } else {
      where.hidden = true;
    }
    const textEl = $("pendingText");
    if (pending.text) {
      textEl.hidden = false;
      textEl.textContent = pending.text;
    } else {
      textEl.hidden = true;
      textEl.textContent = "";
    }
  } else {
    $("pendingWrap").hidden = true;
    $("noPending").hidden = false;
  }

  // Token status: show a hint if no token is configured yet.
  const tokenInput = $("tokenInput");
  const tokenSave = $("tokenSaveBtn");
  if (!state.tokenSet) {
    tokenSave.textContent = "Save token";
  } else {
    tokenSave.textContent = "Update token";
  }
  tokenInput.placeholder = state.tokenSet ? "token saved — paste new one to rotate" : "paste token from bridge server";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "agentbridge:getState" }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    render(state);
  });
}

$("approveBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "agentbridge:approve" }, () => refresh());
});
$("denyBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "agentbridge:deny" }, () => refresh());
});

$("tokenSaveBtn").addEventListener("click", () => {
  const token = $("tokenInput").value.trim();
  if (!token) return;
  chrome.runtime.sendMessage({ type: "agentbridge:setToken", token }, () => {
    $("tokenInput").value = "";
    refresh();
  });
});

// Live-update when the SW broadcasts a state change.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "agentbridge:stateChanged") {
    refresh();
  }
});

refresh();
