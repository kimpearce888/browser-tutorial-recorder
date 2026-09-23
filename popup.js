// Popup UI: start/pause/stop recording, then hand off to the editor.

import { $, escapeHtml, escapeAttr, sanitizeImageUrl } from "./shared.js";
import { initTheme } from "./settings-store.js";

let activeSession = null;
let finishedTutorial = null;
let startedAt = 0;
let ticker = null;

const STATES = ["idle", "recording", "paused", "complete"];

function show(name) {
  STATES.forEach((id) => $(id).classList.toggle("hidden", id !== name));
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function readExcludedDomains() {
  try {
    const raw = localStorage.getItem("btr-excluded-domains");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Also sync to chrome.storage.local so the background service worker
// (keyboard shortcut handler) can read the excluded domains list.
function syncExcludedDomainsToStorage(arr) {
  try { chrome.storage.local.set({ "btr-excluded-domains": arr }); } catch (_) {}
}

function send(type, callback) {
  // P3 fix: check chrome.runtime.lastError in the send helper so every caller
  // gets a meaningful error message when the SW is dead/unreachable instead
  // of a generic "could not start/stop" alert. Without this, a dead SW shows
  // misleading alerts (e.g., "Recording could not start" when the actual
  // problem is the SW crashed).
  chrome.runtime.sendMessage({ type }, (result) => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message || "The recorder service is unavailable. Please reload the extension.");
      return;
    }
    callback && callback(result);
  });
}

// ---------------------------------------------------------------------------
// Render the active session (recording / paused) and start the ticker
// ---------------------------------------------------------------------------

function renderSession(session) {
  activeSession = session;
  if (!session) {
    show("idle");
    return;
  }

  startedAt = session.startedAt;
  $("stepCount").textContent = session.steps.length;
  $("recordingTitle").textContent = session.title;
  $("elapsed").textContent = formatTime(Date.now() - startedAt);
  show(session.status === "paused" ? "paused" : "recording");

  clearInterval(ticker);
  ticker = setInterval(() => {
    $("elapsed").textContent = formatTime(Date.now() - startedAt);
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (result) => {
      // C4 fix: when the session has ended externally (keyboard shortcut,
      // another popup instance, auto-stop, SW crash), GET_STATE returns
      // {session: null} (or undefined). Previously this branch was missing
      // and the popup stayed on "recording"/"paused" forever with the
      // elapsed timer ticking — the user saw a phantom recording state.
      if (chrome.runtime.lastError || !result?.session) {
        clearInterval(ticker);
        activeSession = null;
        finishedTutorial = null;
        show("idle");
        loadRecent();
        return;
      }
      activeSession = result.session;
      $("stepCount").textContent = result.session.steps.length;
      // P-4 fix: also refresh the title in case it changed mid-recording.
      $("recordingTitle").textContent = result.session.title || "";
      // C4 fix: also transition the popup UI if the session's status changed
      // externally (e.g., pause-resume keyboard shortcut). Check whether the
      // target state div is currently hidden to avoid redundant DOM toggles.
      const targetState = result.session.status === "paused" ? "paused" : "recording";
      if ($(targetState)?.classList.contains("hidden")) show(targetState);
    });
  }, 1000);
}

// P5 fix: register the unload listener ONCE at module top-level instead of
// inside renderSession (which is called on every pause/resume cycle and
// was accumulating listeners). The ticker variable is module-scoped so the
// listener always clears the latest one.
window.addEventListener("unload", () => { if (ticker) clearInterval(ticker); });

// ---------------------------------------------------------------------------
// Recent captures list
// ---------------------------------------------------------------------------

function loadRecent() {
  // v1.7.1 fix: use GET_TUTORIALS_SUMMARY instead of GET_TUTORIALS.
  // The popup only shows 3 recent tutorials with a small thumbnail —
  // GET_TUTORIALS loads every tutorial's every step's full base64 screenshot
  // into memory, which is extremely wasteful. GET_TUTORIALS_SUMMARY returns
  // metadata + first screenshot only, which is exactly what the popup needs.
  // v1.7.2 fix: the popup's send() takes (type, callback) — 2 args, not 3.
  // The previous fix accidentally passed an empty {} payload as a third arg,
  // which was treated as the callback, dropping the real callback.
  send("GET_TUTORIALS_SUMMARY", (result) => {
    const tutorials = (result?.tutorials || [])
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 3);

    // v1.0.1: include a thumbnail from the first step's screenshot.
    // v1.0.2 #6: sanitize the image URL (defense-in-depth, matching dashboard/editor).
    $("recentList").innerHTML = tutorials.length
      ? tutorials.map((t) => {
          const rawShot = t.steps?.find((s) => s.screenshot?.image)?.screenshot?.image || "";
          const safeShot = sanitizeImageUrl(rawShot);
          const thumbHtml = safeShot
            ? `<img src="${escapeAttr(safeShot)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:6px;background:#edf1f6">`
            : `<div class="recent-thumb"></div>`;
          return `
            <div class="recent-item" data-id="${escapeHtml(t.id)}">
              ${thumbHtml}
              <div class="recent-copy">
                <strong>${escapeHtml(t.title)}</strong>
                <span>${t.steps.length} steps · ${t.status}</span>
              </div>
            </div>`;
        }).join("")
      : `<div class="recent-item">
          <div class="recent-copy">
            <strong>No captures yet</strong>
            <span>Start with any website workflow</span>
          </div>
        </div>`;

    // H1: wire up recent items so clicking opens them in the editor.
    $("recentList").querySelectorAll(".recent-item[data-id]").forEach((item) => {
      item.addEventListener("click", () => openEditor(item.dataset.id));
      item.style.cursor = "pointer";
    });
  });
}

// ---------------------------------------------------------------------------
// Open the full-page editor (optionally for a specific tutorial id)
// ---------------------------------------------------------------------------

function openEditor(id) {
  const query = id ? `?id=${encodeURIComponent(id)}` : "";
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html${query}`) });
  window.close();
}

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
}

// ---------------------------------------------------------------------------
// Button wiring
// ---------------------------------------------------------------------------

$("start").addEventListener("click", () => {
  const excludedDomains = readExcludedDomains();
  chrome.runtime.sendMessage({ type: "START_RECORDING", excludedDomains }, (result) => {
    // A3 fix: check chrome.runtime.lastError so a dead SW shows a helpful message
    // instead of the generic "Recording could not start" (which doesn't tell the
    // user the SW crashed — they'd retry and get the same unhelpful error).
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message || "The recorder service is unavailable. Please reload the extension.");
      return;
    }
    if (!result?.ok) return alert(result?.error || "Recording could not start.");
    renderSession(result.session);
  });
});

$("pause").addEventListener("click", () => {
  send("PAUSE_RECORDING", (result) => {
    if (result?.ok) renderSession(result.session || { ...activeSession, status: "paused" });
  });
});

$("resume").addEventListener("click", () => {
  send("RESUME_RECORDING", (result) => {
    if (result?.ok) renderSession(result.session || { ...activeSession, status: "recording" });
  });
});

function stop() {
  send("STOP_RECORDING", (result) => {
    clearInterval(ticker);
    if (!result?.ok) {
      alert(result?.error || "Recording could not stop.");
      // P6 fix: re-sync the popup with the actual background state instead
      // of leaving it stuck on the "recording"/"paused" view with a frozen
      // timer. The user was previously trapped in a dead recording view.
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (state) => {
        if (chrome.runtime.lastError || !state?.session) {
          activeSession = null;
          show("idle");
          loadRecent();
        } else {
          renderSession(state.session);
        }
      });
      return;
    }
    finishedTutorial = result.tutorial;
    $("completeTitle").textContent = finishedTutorial.title;
    $("completeSummary").textContent =
      `${finishedTutorial.steps.length} steps captured. Your tutorial is saved locally and ready to polish.`;
    show("complete");
  });
}

// v1.0.1: explicit discard option — removes the active session without saving.
$("discardRecording")?.addEventListener("click", () => {
  if (!activeSession) return;
  if (!confirm("Discard this recording? Captured steps will not be saved.")) return;
  clearInterval(ticker);
  chrome.runtime.sendMessage({ type: "DISCARD_RECORDING" }, (result) => {
    // H13 fix: surface the failure instead of silently resetting the UI.
    // Previously the `if (!result?.ok)` block was empty (just a comment),
    // and the popup always showed "idle" even if the SW was unreachable or
    // the discard failed — leaving the recording running invisibly.
    if (chrome.runtime.lastError || !result?.ok) {
      alert(result?.error || chrome.runtime.lastError?.message || "Could not discard the recording. Please try again.");
      // Re-enter the recording view so the user can retry.
      // (Don't call show("idle") — that would hide the failure.)
      return;
    }
    activeSession = null;
    finishedTutorial = null;
    show("idle");
    loadRecent();
  });
});

$("stop").addEventListener("click", stop);
$("stopPaused").addEventListener("click", stop);
$("edit").addEventListener("click", () => openEditor(finishedTutorial?.id));
$("dashboard").addEventListener("click", openDashboard);
$("openDashboard").addEventListener("click", openDashboard);
$("export").addEventListener("click", () => {
  if (!finishedTutorial) return;
  // C13 fix: use a Blob URL instead of a base64 data: URL. The old code did
  // JSON → UTF-8 → binary string → base64 → data: URL, creating several large
  // in-memory copies. A Blob is a single streaming handle and is much more
  // memory-efficient for large tutorials with many screenshots.
  const json = JSON.stringify(finishedTutorial, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  // Unicode-aware filename sanitizer (duplicated from exporter.js's safeName()
  // to avoid an extra import in the popup context).
  const rawName = (finishedTutorial.title || "tutorial").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 100).toLowerCase() || "tutorial";
  const filename = `${rawName || "tutorial"}.json`;
  if (chrome.downloads?.download) {
    chrome.downloads.download({ url, filename }, () => {
      // H28 fix: check chrome.runtime.lastError so a failed download doesn't
      // look like a successful export.
      if (chrome.runtime.lastError) {
        alert(chrome.runtime.lastError.message || "Download failed.");
      }
      // Revoke after the download starts — 30s is a safe upper bound.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
  } else {
    window.open(url);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
});

$("discard").addEventListener("click", () => {
  if (!finishedTutorial || !confirm("Delete this recording?")) return;
  chrome.runtime.sendMessage({ type: "DELETE_TUTORIAL", id: finishedTutorial.id }, (result) => {
    if (!result?.ok) return alert(result?.error || "Could not delete the recording.");
    finishedTutorial = null;
    show("idle");
    loadRecent();
  });
});

// ---------------------------------------------------------------------------
// Excluded-domains manager (stored in localStorage `btr-excluded-domains`)
// ---------------------------------------------------------------------------

function renderExcludedList() {
  const list = $("excludedList");
  if (!list) return;
  const domains = readExcludedDomains();
  list.innerHTML = domains.length
    ? domains.map((d, i) => `
        <span class="excluded-chip">
          ${escapeHtml(d)}
          <button type="button" class="excluded-remove" data-i="${i}" aria-label="Remove">×</button>
        </span>`).join("")
    : `<span class="excluded-empty">No exclusions yet.</span>`;
  list.querySelectorAll(".excluded-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.i);
      const arr = readExcludedDomains();
      arr.splice(idx, 1);
      try { localStorage.setItem("btr-excluded-domains", JSON.stringify(arr)); } catch (e) {}
      syncExcludedDomainsToStorage(arr);
      renderExcludedList();
    });
  });
}

$("excludedAdd")?.addEventListener("click", () => {
  const input = $("excludedInput");
  // v1.0.1: validate the domain — reject empty, malformed, or oversized input.
  // Also strip anything that's not a hostname character.
  const value = (input.value || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.-]/g, "")
    .slice(0, 200);
  if (!value || !/\.[a-z]{2,}$/.test(value)) {
    input.style.borderColor = "#d9573b";
    setTimeout(() => { input.style.borderColor = ""; }, 1500);
    return;
  }
  const arr = readExcludedDomains();
  if (!arr.includes(value)) arr.push(value);
  try { localStorage.setItem("btr-excluded-domains", JSON.stringify(arr)); } catch (e) {}
  syncExcludedDomainsToStorage(arr);
  input.value = "";
  renderExcludedList();
});

$("excludedInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("excludedAdd").click();
  }
});

// Open the settings page (separate tab) — replaces the v2 behaviour where
// the gear icon opened an empty editor.
$("settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  window.close();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

function refreshState() {
  renderExcludedList();
  // Sync excluded domains to chrome.storage.local so the keyboard shortcut
  // handler in the background service worker can read them.
  syncExcludedDomainsToStorage(readExcludedDomains());
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (result) => {
    // H27 fix: check chrome.runtime.lastError so a dead SW is distinguished
    // from "no active recording".
    if (chrome.runtime.lastError) {
      activeSession = null;
      show("idle");
      loadRecent();
      return;
    }
    if (result?.session) {
      renderSession(result.session);
    } else {
      show("idle");
      loadRecent();
    }
  });
}

initTheme().then(refreshState);
