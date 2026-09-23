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

function syncExcludedDomainsToStorage(arr) {
  try { chrome.storage.local.set({ "btr-excluded-domains": arr }); } catch (_) {}
}

function send(type, callback) {





  chrome.runtime.sendMessage({ type }, (result) => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message || "The recorder service is unavailable. Please reload the extension.");
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
  $("stepCount").textContent = session.steps.length;
  $("recordingTitle").textContent = session.title;
  $("elapsed").textContent = formatTime(Date.now() - startedAt);
  show(session.status === "paused" ? "paused" : "recording");

  clearInterval(ticker);
  ticker = setInterval(() => {
    $("elapsed").textContent = formatTime(Date.now() - startedAt);
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

$("start").addEventListener("click", () => {
  const excludedDomains = readExcludedDomains();
  chrome.runtime.sendMessage({ type: "START_RECORDING", excludedDomains }, (result) => {



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

$("settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  window.close();
});

function refreshState() {
  renderExcludedList();


  syncExcludedDomainsToStorage(readExcludedDomains());
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
