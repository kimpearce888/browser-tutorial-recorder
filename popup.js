import { $, escapeHtml, escapeAttr, sanitizeImageUrl } from "./shared.js";
import { initTheme } from "./settings-store.js";

let activeSession = null;
let finishedTutorial = null;
let startedAt = 0;
let ticker = null;
let pausedAt = 0;
let totalPausedMs = 0;

const STATES = ["idle", "recording", "paused", "complete"];

function updateElapsed() {
  if (!activeSession) return;
  let elapsed = Date.now() - startedAt - totalPausedMs;
  if (activeSession.status === "paused" && pausedAt) {
    elapsed -= (Date.now() - pausedAt);
  }
  $("elapsed").textContent = formatTime(Math.max(0, elapsed));
}

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
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("btr-excluded-domains", (result) => {
        const arr = result?.["btr-excluded-domains"];
        if (Array.isArray(arr)) {
          try { localStorage.setItem("btr-excluded-domains", JSON.stringify(arr)); } catch (_) {}
          resolve(arr);
        } else {
          const raw = localStorage.getItem("btr-excluded-domains");
          const parsed = raw ? JSON.parse(raw) : [];
          const fallback = Array.isArray(parsed) ? parsed : [];
          if (fallback.length > 0) {
            try { chrome.storage.local.set({ "btr-excluded-domains": fallback }); } catch (_) {}
          }
          resolve(fallback);
        }
      });
    } catch (e) {
      const raw = localStorage.getItem("btr-excluded-domains");
      const parsed = raw ? JSON.parse(raw) : [];
      resolve(Array.isArray(parsed) ? parsed : []);
    }
  });
}

function syncExcludedDomainsToStorage(arr) {
  try {
    chrome.storage.local.set({ "btr-excluded-domains": arr });
    localStorage.setItem("btr-excluded-domains", JSON.stringify(arr));
  } catch (_) {}
}

function send(type, callback) {
  chrome.runtime.sendMessage({ type }, (result) => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message || "The recorder service is unavailable. Please reload the extension.");
      callback && callback({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }
    callback && callback(result);
  });
}

function renderSession(session) {
  activeSession = session;
  if (!session) {
    show("idle");
    return;
  }

  startedAt = session.startedAt;
  pausedAt = session.status === "paused" ? Date.now() : 0;
  totalPausedMs = session.totalPausedMs || 0;
  $("stepCount").textContent = session.steps.length;
  $("recordingTitle").textContent = session.title;
  updateElapsed();
  show(session.status === "paused" ? "paused" : "recording");

  clearInterval(ticker);
  ticker = setInterval(() => {
    updateElapsed();
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (result) => {

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

      $("recordingTitle").textContent = result.session.title || "";

      const targetState = result.session.status === "paused" ? "paused" : "recording";
      if ($(targetState)?.classList.contains("hidden")) show(targetState);
    });
  }, 1000);
}

window.addEventListener("unload", () => { if (ticker) clearInterval(ticker); });

function loadRecent() {

  send("GET_TUTORIALS_SUMMARY", (result) => {
    const tutorials = (result?.tutorials || [])
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 3);

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

    $("recentList").querySelectorAll(".recent-item[data-id]").forEach((item) => {
      item.addEventListener("click", () => openEditor(item.dataset.id));
      item.style.cursor = "pointer";
    });
  });
}

function openEditor(id) {
  const query = id ? `?id=${encodeURIComponent(id)}` : "";
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html${query}`) });
  window.close();
}

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
}

$("start").addEventListener("click", async () => {
  const excludedDomains = await readExcludedDomains();
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url || /^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|file|moz-extension|extension):/i.test(tab.url)) {
      alert("Open a webpage first, then try recording.");
      return;
    }
    chrome.runtime.sendMessage({ type: "START_RECORDING", excludedDomains, tabId: tab.id }, (result) => {
      if (chrome.runtime.lastError) {
        alert(chrome.runtime.lastError.message || "The recorder service is unavailable. Please reload the extension.");
        return;
      }
      if (!result?.ok) return alert(result?.error || "Recording could not start.");
      renderSession(result.session);
    });
  });
});

$("pause").addEventListener("click", () => {
  send("PAUSE_RECORDING", (result) => {
    if (result?.ok) {
      pausedAt = Date.now();
      renderSession(result.session || { ...activeSession, status: "paused" });
    }
  });
});

$("resume").addEventListener("click", () => {
  send("RESUME_RECORDING", (result) => {
    if (result?.ok) {
      if (pausedAt) totalPausedMs += Date.now() - pausedAt;
      pausedAt = 0;
      renderSession(result.session || { ...activeSession, status: "recording" });
    }
  });
});

function stop() {
  send("STOP_RECORDING", (result) => {
    clearInterval(ticker);
    if (!result?.ok) {
      alert(result?.error || "Recording could not stop.");

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

$("discardRecording")?.addEventListener("click", () => {
  if (!activeSession) return;
  if (!confirm("Discard this recording? Captured steps will not be saved.")) return;
  clearInterval(ticker);
  chrome.runtime.sendMessage({ type: "DISCARD_RECORDING" }, (result) => {

    if (chrome.runtime.lastError || !result?.ok) {
      alert(result?.error || chrome.runtime.lastError?.message || "Could not discard the recording. Please try again.");

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

  const json = JSON.stringify(finishedTutorial, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const rawName = (finishedTutorial.title || "tutorial").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 100).toLowerCase() || "tutorial";
  const filename = `${rawName || "tutorial"}.json`;
  if (chrome.downloads?.download) {
    chrome.downloads.download({ url, filename }, () => {

      if (chrome.runtime.lastError) {
        alert(chrome.runtime.lastError.message || "Download failed.");
      }

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

async function renderExcludedList() {
  const list = $("excludedList");
  if (!list) return;
  const domains = await readExcludedDomains();
  list.innerHTML = domains.length
    ? domains.map((d, i) => `
        <span class="excluded-chip">
          ${escapeHtml(d)}
          <button type="button" class="excluded-remove" data-i="${i}" aria-label="Remove">×</button>
        </span>`).join("")
    : `<span class="excluded-empty">No exclusions yet.</span>`;
  list.querySelectorAll(".excluded-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.i);
      const arr = await readExcludedDomains();
      arr.splice(idx, 1);
      try { localStorage.setItem("btr-excluded-domains", JSON.stringify(arr)); } catch (e) {}
      syncExcludedDomainsToStorage(arr);
      renderExcludedList();
    });
  });
}

$("excludedAdd")?.addEventListener("click", async () => {
  const input = $("excludedInput");

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
  const arr = await readExcludedDomains();
  if (!arr.includes(value)) arr.push(value);
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

$("settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  window.close();
});

async function refreshState() {
  renderExcludedList();
  const domains = await readExcludedDomains();
  syncExcludedDomainsToStorage(domains);
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (result) => {

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
