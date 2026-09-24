import { formatDuration } from "./shared.js";
import { bgCall as bg } from "./common-ui.js";

const els = {
  statusCard: document.getElementById("status-card"),
  idleCard: document.getElementById("idle-card"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  statusTimer: document.getElementById("status-timer"),
  stepCount: document.getElementById("step-count"),
  tabCount: document.getElementById("tab-count"),
  pausedNote: document.getElementById("paused-note"),
  captureWarn: document.getElementById("capture-warn"),
  btnStart: document.getElementById("btn-start"),
  btnPause: document.getElementById("btn-pause"),
  btnResume: document.getElementById("btn-resume"),
  btnStop: document.getElementById("btn-stop"),
  btnDiscard: document.getElementById("btn-discard"),
  error: document.getElementById("error-line")
};

let startedAt = 0;
let timerHandle = null;

function showError(message) {
  els.error.textContent = message || "";
  els.error.classList.toggle("hidden", !message);
}

function render(ui) {
  const session = ui && ui.session;
  const recording = Boolean(session);
  els.statusCard.classList.toggle("hidden", !recording);
  els.idleCard.classList.toggle("hidden", recording);
  els.btnStart.classList.toggle("hidden", recording);
  els.btnPause.classList.toggle("hidden", !recording || session.status !== "recording");
  els.btnResume.classList.toggle("hidden", !recording || session.status !== "paused");
  els.btnStop.classList.toggle("hidden", !recording);
  els.btnDiscard.classList.toggle("hidden", !recording);
  if (!recording) {
    stopTimer();
    return;
  }
  const isRec = session.status === "recording";
  els.statusDot.className = `dot ${isRec ? "rec" : "paused"}`;
  els.statusText.textContent = isRec ? "Recording" : "Paused";
  els.pausedNote.classList.toggle("hidden", isRec);
  els.captureWarn.classList.toggle("hidden", !ui || !ui.captureBlocked);
  els.stepCount.textContent = `${session.stepCount} step${session.stepCount === 1 ? "" : "s"}`;
  els.tabCount.textContent = session.tabCount > 1 ? `${session.tabCount} tabs` : "";
  startedAt = session.startedAt;
  if (isRec) startTimer(); else stopTimer();
}

function startTimer() {
  stopTimer();
  const tick = () => {
    els.statusTimer.textContent = formatDuration(Date.now() - startedAt);
  };
  tick();
  timerHandle = setInterval(tick, 500);
}

function stopTimer() {
  clearInterval(timerHandle);
  timerHandle = null;
}

async function refresh() {
  try {
    const res = await bg({ type: "GET_UI_STATE" });
    render(res.uiState);
    showError("");
  } catch (e) {
    showError(e.message);
  }
}

els.btnStart.addEventListener("click", async () => {
  try { await bg({ type: "START_RECORDING" }); await refresh(); window.close(); }
  catch (e) { showError(e.message); }
});
els.btnPause.addEventListener("click", async () => {
  try { await bg({ type: "PAUSE_RECORDING" }); await refresh(); } catch (e) { showError(e.message); }
});
els.btnResume.addEventListener("click", async () => {
  try { await bg({ type: "RESUME_RECORDING" }); await refresh(); window.close(); }
  catch (e) { showError(e.message); }
});
els.btnStop.addEventListener("click", async () => {
  try {
    const res = await bg({ type: "STOP_RECORDING" });
    if (res.tutorialId) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(res.tutorialId)}`) });
      window.close();
      return;
    }
    await refresh();
  } catch (e) { showError(e.message); }
});
els.btnDiscard.addEventListener("click", async () => {
  try { await bg({ type: "DISCARD_RECORDING" }); await refresh(); } catch (e) { showError(e.message); }
});
document.getElementById("nav-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
document.getElementById("nav-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["btr-ui-state"]) {
    render(changes["btr-ui-state"].newValue);
  }
});

refresh();
