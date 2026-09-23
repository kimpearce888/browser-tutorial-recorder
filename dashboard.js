// Dashboard: list, search, filter, sort, bulk-select, export, duplicate and
// delete recorded tutorials. Reuses the exporter module for export logic.

import { $, escapeHtml, escapeAttr, sanitizeImageUrl, dbPut, normalizeTutorial } from "./shared.js";
import { exportTutorial } from "./exporter.js";
import { initTheme } from "./settings-store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tutorials = [];
let selected = new Set();     // tutorial ids selected for bulk actions
let viewMode = "grid";        // "grid" | "list"
let activeExportId = null;    // tutorial id whose export popover is open

const searchInput = $("searchInput");
const statusFilter = $("statusFilter");
const sortBy = $("sortBy");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(type, payload = {}, callback) {
  chrome.runtime.sendMessage({ type, ...payload }, callback);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const diff = (now - date) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function totalAnnotations(tutorial) {
  // P2-2 v1.5.1: GET_TUTORIALS_SUMMARY ships an `annotationCount` per step
  // instead of the full `annotations` array.
  // F5 fix: guard against missing steps array.
  const steps = Array.isArray(tutorial.steps) ? tutorial.steps : [];
  return steps.reduce((sum, step) => sum + (step.annotationCount ?? (step.annotations?.length || 0)), 0);
}

function firstScreenshot(tutorial) {
  // F5 fix: guard against missing steps array.
  const steps = Array.isArray(tutorial.steps) ? tutorial.steps : [];
  const step = steps.find((s) => s.screenshot?.image);
  return step?.screenshot?.image || "";
}

// ---------------------------------------------------------------------------
// Filtering + sorting
// ---------------------------------------------------------------------------

function visibleTutorials() {
  const query = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;

  let list = tutorials.filter((t) => {
    if (status && t.status !== status) return false;
    if (!query) return true;
    const haystack = [
      t.title,
      t.description,
      // F5 fix: guard against missing steps array.
      ...(Array.isArray(t.steps) ? t.steps.map((s) => s.description || "") : []),
      ...(Array.isArray(t.steps) ? t.steps.map((s) => s.action || "") : [])
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  const sort = sortBy.value;
  list = list.slice().sort((a, b) => {
    if (sort === "title") return (a.title || "").localeCompare(b.title || "");
    // A1 fix: guard against missing steps array (defense-in-depth — GET_TUTORIALS_SUMMARY
    //   always returns steps: [], but a corrupted SW response shouldn't crash the sort).
    if (sort === "steps") return (Array.isArray(b.steps) ? b.steps.length : 0) - (Array.isArray(a.steps) ? a.steps.length : 0);
    if (sort === "created") return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  return list;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function renderStats() {
  const total = tutorials.length;
  // F5 fix: guard against tutorials with missing steps array (e.g., corrupted records).
  // Previously t.steps.length would throw TypeError, poisoning the entire dashboard.
  const steps = tutorials.reduce((sum, t) => sum + (Array.isArray(t.steps) ? t.steps.length : 0), 0);
  const annotations = tutorials.reduce((sum, t) => sum + totalAnnotations(t), 0);
  const ready = tutorials.filter((t) => t.status === "ready").length;

  $("stats").innerHTML = `
    <div class="stat-card">
      <div class="label">TUTORIALS</div>
      <div class="value">${total}</div>
    </div>
    <div class="stat-card">
      <div class="label">TOTAL STEPS</div>
      <div class="value">${steps}</div>
    </div>
    <div class="stat-card">
      <div class="label">ANNOTATIONS</div>
      <div class="value">${annotations}</div>
    </div>
    <div class="stat-card">
      <div class="label">READY TO SHARE</div>
      <div class="value">${ready}<small>/ ${total}</small></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderGrid() {
  const list = visibleTutorials();
  const grid = $("grid");

  $("empty").classList.toggle("hidden", tutorials.length > 0);
  $("noResults").classList.toggle("hidden", tutorials.length === 0 || list.length > 0);
  grid.classList.toggle("hidden", list.length === 0);

  grid.classList.toggle("list-view", viewMode === "list");
  grid.innerHTML = list.map(cardHtml).join("");

  wireCards();
  updateBulkBar();
}

function cardHtml(tutorial) {
  const thumb = firstScreenshot(tutorial);
  const isReady = tutorial.status === "ready";
  const selectedClass = selected.has(tutorial.id) ? "selected" : "";
  const checked = selected.has(tutorial.id) ? "✓" : "";

  return `
    <article class="card ${selectedClass}" data-id="${escapeHtml(tutorial.id)}">
      <div class="card-check" data-action="select">${checked}</div>
      <div class="thumb" data-action="open">
        ${thumb ? `<img src="${escapeAttr(sanitizeImageUrl(thumb))}" alt="">` : `<div class="thumb-empty">◌</div>`}
        <span class="thumb-badge ${isReady ? "ready" : ""}">${escapeHtml(tutorial.status || "draft")}</span>
      </div>
      <div class="card-body">
        <div class="card-title" data-action="open" title="${escapeHtml(tutorial.title)}">
          ${escapeHtml(tutorial.title || "Untitled tutorial")}
        </div>
        <div class="card-meta">
          <span>${Array.isArray(tutorial.steps) ? tutorial.steps.length : 0} steps</span>
          <span>· ${formatDate(tutorial.updatedAt)}</span>
        </div>
        <div class="card-desc">${escapeHtml(tutorial.description || "Captured browser workflow")}</div>
        <div class="card-actions">
          <button data-action="edit">✎ Edit</button>
          <button data-action="preview">▶ Preview</button>
          <button data-action="duplicate">⧉ Duplicate</button>
          <button data-action="export" class="more">Export ⌄</button>
          <button data-action="delete" class="danger">🗑</button>
        </div>
      </div>
    </article>`;
}

function wireCards() {
  document.querySelectorAll(".card").forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        handleCardAction(id, el.dataset.action, card, event);
      });
    });
  });
}

function handleCardAction(id, action, card, event) {
  switch (action) {
    case "select":
      toggleSelect(id);
      break;
    case "open":
    case "edit":
      openEditor(id);
      break;
    case "preview":
      openPreview(id);
      break;
    case "duplicate":
      duplicateTutorial(id);
      break;
    case "export":
      toggleExportMenu(id, card);
      break;
    case "delete":
      deleteTutorial(id);
      break;
  }
}

// ---------------------------------------------------------------------------
// Selection / bulk bar
// ---------------------------------------------------------------------------

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderGrid();
}

function clearSelection() {
  selected.clear();
  renderGrid();
}

function updateBulkBar() {
  const count = selected.size;
  $("bulkBar").classList.toggle("hidden", count === 0);
  $("bulkCount").textContent = `${count} selected`;
}

// ---------------------------------------------------------------------------
// Actions: open editor / preview / duplicate / delete
// ---------------------------------------------------------------------------

function openEditor(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(id)}`) });
}

function openPreview(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(id)}`) });
}

function duplicateTutorial(id) {
  send("DUPLICATE_TUTORIAL", { id }, (result) => {
    if (!result?.ok) return alert(result?.error || "Could not duplicate.");
    load();
  });
}

function deleteTutorial(id) {
  const tutorial = tutorials.find((t) => t.id === id);
  const title = tutorial?.title || "this tutorial";
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  send("DELETE_TUTORIAL", { id }, (result) => {
    if (!result?.ok) return alert(result?.error || "Could not delete.");
    selected.delete(id);
    load();
  });
}

function bulkDelete() {
  const ids = [...selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} tutorial${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
  send("DELETE_TUTORIALS", { ids }, (result) => {
    if (!result?.ok) return alert(result?.error || "Could not delete.");
    selected.clear();
    load();
  });
}

// ---------------------------------------------------------------------------
// Export menu (per-card popover + bulk dialog)
// ---------------------------------------------------------------------------

function toggleExportMenu(id, card) {
  const menu = $("exportMenu");
  if (activeExportId === id) {
    closeExportMenu();
    return;
  }

  const rect = card.querySelector('[data-action="export"]').getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
  menu.classList.remove("hidden");
  activeExportId = id;
}

function closeExportMenu() {
  $("exportMenu").classList.add("hidden");
  activeExportId = null;
}

async function exportSingle(format) {
  const tutorialId = activeExportId;
  closeExportMenu();
  if (!tutorialId) return;
  // P0 v1.6.0 fix: the dashboard's `tutorials` array is populated from
  // GET_TUTORIALS_SUMMARY (v1.5.1), which excludes screenshot.image for all
  // steps except the first. Exporting directly from that array would produce
  // broken exports — steps 2+ have no screenshot. Fetch the FULL tutorial
  // via GET_TUTORIAL (singular, uses dbGet) before exporting.
  let tutorial = null;
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_TUTORIAL", id: tutorialId }, (result) => {
        tutorial = result?.tutorial || null;
        resolve();
      });
    });
  } catch (_) { tutorial = null; }
  if (!tutorial) {
    alert("Could not load the full tutorial for export. Please try again.");
    return;
  }
  try {
    // PDF uses "print" internally; map the dashboard label.
    const kind = format === "pdf" ? "print" : format;
    await exportTutorial(tutorial, kind, 0);
  } catch (error) {
    alert(error.message || "Export failed.");
  }
}

function openBulkExportDialog() {
  const count = selected.size;
  if (!count) return;
  $("bulkExportCount").textContent = count;
  $("bulkExportDialog").showModal();
}

async function bulkExport(format) {
  // PDF export opens a print dialog per tutorial — that requires interactive
  // user action and would flood the screen with print dialogs in a loop.
  // Short-circuit with a friendly explanation instead.
  // D4 fix: close the dialog BEFORE the alert so the user isn't stranded
  // with the dialog still open after dismissing the alert.
  if (format === "pdf") {
    $("bulkExportDialog").close();
    alert("PDF export opens a print dialog — please export tutorials one at a time for PDF.");
    return;
  }
  $("bulkExportDialog").close();
  const ids = [...selected];
  const kind = format;
  // P0 v1.6.0 fix: fetch the FULL tutorial for each id via GET_TUTORIAL
  // (singular, uses dbGet). The dashboard's `tutorials` array is from
  // GET_TUTORIALS_SUMMARY and lacks screenshots for steps 2+.
  // Small delay between downloads so the browser doesn't block them.
  for (const id of ids) {
    let tutorial = null;
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "GET_TUTORIAL", id }, (result) => {
          tutorial = result?.tutorial || null;
          resolve();
        });
      });
    } catch (_) { tutorial = null; }
    if (!tutorial) continue;
    try {
      await exportTutorial(tutorial, kind, 0);
    } catch (error) {
      console.warn(`Export failed for ${tutorial.title}:`, error.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function importTutorial() {
  $("importInput").click();
}

$("importInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      // v1.6.9 fix: handle JSON arrays (from Settings → Export All) in
      // addition to single tutorial objects. The previous code assumed
      // the file was always a single tutorial object — if it was an array
      // (the format Settings → Export All produces), normalizeTutorial
      // would silently produce a garbage tutorial with 0 steps, and the
      // user's actual tutorials would be silently lost.
      const parsed = JSON.parse(reader.result);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      let imported = 0;
      for (const item of list) {
        // v1.6.9: per-item try/catch so one bad entry doesn't skip the rest
        try {
          const data = normalizeTutorial(item);
          data.id = `tutorial-${crypto.randomUUID()}`;
          data.title = data.title || "Imported tutorial";
          data.createdAt = new Date().toISOString();
          data.updatedAt = new Date().toISOString();
          await dbPut(data);
          imported++;
        } catch (e) {
          console.warn("Failed to import one tutorial:", e.message);
        }
      }
      if (imported === 0) {
        alert("No valid tutorials found in the file.");
      }
      load();
    } catch (error) {
      alert(error.message || "Invalid tutorial file.");
    }
  };
  reader.readAsText(file);
  event.target.value = ""; // H10 — allow re-importing the same file
});

// ---------------------------------------------------------------------------
// New recording
// ---------------------------------------------------------------------------

function startNewRecording() {
  // C1 fix: the dashboard tab itself is always the active tab when the user
  // clicks "+ New recording". The previous code's chrome-extension: URL guard
  // always fired, blocking the primary CTA. Now we ask the background to find
  // the most recently active NON-extension tab and start recording there.
  // If no eligible tab exists, we open a new tab on a default URL.
  let excludedDomains = [];
  try {
    const raw = localStorage.getItem("btr-excluded-domains");
    if (raw) excludedDomains = JSON.parse(raw);
    if (!Array.isArray(excludedDomains)) excludedDomains = [];
  } catch (e) { excludedDomains = []; }

  // D13 fix: prefer tabs in the CURRENT window first, then fall back to any window.
  // The old code queried all tabs and sorted by active/lastAccessed without
  // considering which window the dashboard is in — so with multiple windows open,
  // it could choose a tab from another window even when a valid tab existed in
  // the dashboard's own window.
  chrome.tabs.query({ active: true, currentWindow: true }, (currentTabs) => {
    const extensionUrlRe = /^(chrome-extension|chrome|edge|about|devtools|chrome-untrusted|moz-extension):/i;
    const currentEligible = (currentTabs || []).filter((t) => t.url && !extensionUrlRe.test(t.url));
    if (currentEligible.length > 0) {
      const tab = currentEligible[0];
      send("START_RECORDING", { excludedDomains, tabId: tab.id }, (result) => {
        if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
        if (!result?.ok) return alert(result?.error || "Recording could not start.");
      });
      return;
    }
    // Fall back to querying ALL tabs across ALL windows.
    chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs) || tabs.length === 0) {
      alert("No tabs found. Open a webpage and try again.");
      return;
    }
    // G16 fix: get the current window ID so we can prefer tabs in the
    // dashboard's own window in the fallback sort.
    chrome.windows.getCurrent((currentWin) => {
      const currentWindowId = currentWin?.id;
      // Find the most-recently-active non-extension, non-chrome tab.
      // G16 fix: prefer tabs in the current window, then active, then lastAccessed.
      const extensionUrlRe = /^(chrome-extension|chrome|edge|about|devtools|chrome-untrusted|moz-extension):/i;
      const eligible = tabs
        .filter((t) => t.url && !extensionUrlRe.test(t.url))
        .sort((a, b) => {
          // Prefer tabs in the current window
          if (a.windowId === currentWindowId && b.windowId !== currentWindowId) return -1;
          if (a.windowId !== currentWindowId && b.windowId === currentWindowId) return 1;
          // Then prefer active tabs
          if (a.active && !b.active) return -1;
          if (!a.active && b.active) return 1;
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        });

    if (eligible.length === 0) {
      // No eligible tabs — open a new one on a sensible default.
      chrome.tabs.create({ url: "https://www.google.com/" }, (newTab) => {
        setTimeout(() => {
          // v1.7.3 fix: pass the explicit tabId so the background records
          // the NEW tab, not the dashboard tab.
          // A3 fix: check chrome.runtime.lastError for a dead SW.
          send("START_RECORDING", { excludedDomains, tabId: newTab.id }, (result) => {
            if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
            if (!result?.ok) return alert(result?.error || "Recording could not start.");
          });
        }, 1500); // wait for the new tab to load
      });
      return;
    }

    const tab = eligible[0];
    // Activate the tab and its window so the user sees the recording badge.
    chrome.tabs.update(tab.id, { active: true }, () => {
      if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true }, () => {});
      // C1 fix: pass the explicit tabId so the background doesn't fall back to
      // currentTab() which would return the dashboard tab itself.
      // A3 fix: check chrome.runtime.lastError for a dead SW.
      send("START_RECORDING", { excludedDomains, tabId: tab.id }, (result) => {
        if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
        if (!result?.ok) return alert(result?.error || "Recording could not start.");
      });
    });
  }); // close chrome.tabs.query({})
  }); // close chrome.windows.getCurrent
  }); // close chrome.tabs.query({active,currentWindow})
}

// ---------------------------------------------------------------------------
// Load + init
// ---------------------------------------------------------------------------

function load() {
  // P2-2 v1.5.1 fix: use GET_TUTORIALS_SUMMARY instead of GET_TUTORIALS
  // to avoid loading every step's base64 screenshot into memory just to
  // render the dashboard grid. The summary includes:
  //   - All top-level metadata (title, status, dates)
  //   - All step descriptions (for search) and counts
  //   - Only the FIRST step's screenshot (for the thumbnail)
  // When the user opens a tutorial for editing, the editor calls
  // GET_TUTORIAL (singular) which loads the full record lazily.
  send("GET_TUTORIALS_SUMMARY", {}, (result) => {
    // L6: surface connection errors instead of silently showing empty state.
    if (chrome.runtime.lastError) {
      $("grid").innerHTML = "";
      $("empty").classList.add("hidden");
      $("noResults").classList.remove("hidden");
      $("noResults").querySelector("strong").textContent = "Could not connect to the recorder";
      $("noResults").querySelector("p").textContent = chrome.runtime.lastError.message || "Please reload the page.";
      return;
    }
    // D10 fix: distinguish "no tutorials" from "transport error". Previously
    // a falsy result (e.g., SW restart mid-message) was treated as "no tutorials".
    if (!result) {
      $("grid").innerHTML = "";
      $("empty").classList.add("hidden");
      $("noResults").classList.remove("hidden");
      $("noResults").querySelector("strong").textContent = "Could not load tutorials";
      $("noResults").querySelector("p").textContent = "The recorder service returned no data. Please reload the page.";
      return;
    }
    tutorials = result?.tutorials || [];
    // H29 fix: reconcile `selected` with the current tutorial list so
    // deleted/stale IDs from another tab don't remain in the selection.
    const validIds = new Set(tutorials.map((t) => t.id));
    for (const id of [...selected]) {
      if (!validIds.has(id)) selected.delete(id);
    }
    renderStats();
    renderGrid();
  });
}

// M7: debounced search input so we don't re-render the grid on every keystroke.
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 180);
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

$("newRecording").addEventListener("click", startNewRecording);
$("importBtn").addEventListener("click", importTutorial);
$("emptyStart").addEventListener("click", startNewRecording);

statusFilter.addEventListener("change", renderGrid);
sortBy.addEventListener("change", renderGrid);

$("gridView").addEventListener("click", () => {
  viewMode = "grid";
  $("gridView").classList.add("active");
  $("listView").classList.remove("active");
  renderGrid();
});
$("listView").addEventListener("click", () => {
  viewMode = "list";
  $("listView").classList.add("active");
  $("gridView").classList.remove("active");
  renderGrid();
});

// Bulk actions
$("bulkDelete").addEventListener("click", bulkDelete);
$("bulkExport").addEventListener("click", openBulkExportDialog);
$("bulkClear").addEventListener("click", clearSelection);

// Export popover
$("exportMenu").querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => exportSingle(button.dataset.export));
});

// Bulk export dialog
document.querySelector("#bulkExportDialog .dialog-close").addEventListener("click", () => $("bulkExportDialog").close());
document.querySelectorAll("[data-bulk-export]").forEach((button) => {
  button.addEventListener("click", () => bulkExport(button.dataset.bulkExport));
});

// Clear filters button (no-results state)
$("clearFilters").addEventListener("click", () => {
  searchInput.value = "";
  statusFilter.value = "";
  // D3 fix: also reset the sortBy dropdown so "Clear filters" actually clears
  // all filters (previously it left the sort intact, which was confusing).
  sortBy.value = "updated";
  renderGrid();
});

// Close export popover on outside click / escape
document.addEventListener("click", (event) => {
  if (!activeExportId) return;
  const menu = $("exportMenu");
  if (!menu.contains(event.target) && !event.target.dataset.action) closeExportMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeExportMenu();
    $("bulkExportDialog").close();
  }
  // Select all with Ctrl/Cmd+A when not in an input and no dialog is open.
  // A2 fix: skip when a <dialog> is open (e.g., bulk export) — pressing Ctrl+A
  // inside the dialog would otherwise select all tutorials behind it.
  const tag = document.activeElement?.tagName;
  if ((event.metaKey || event.ctrlKey) && event.key === "a" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag) && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    // D7 fix: mutate the existing Set instead of replacing the reference.
    selected.clear();
    tutorials.forEach((t) => selected.add(t.id));
    renderGrid();
  }
});

// D5 fix: close the export popover when the user scrolls or resizes the window.
// Without this, the position:fixed popover floats detached from its anchor
// button after the user scrolls.
window.addEventListener("scroll", closeExportMenu, true);
window.addEventListener("resize", closeExportMenu);

// D2 fix: listen for TUTORIALS_CHANGED broadcasts so the dashboard re-loads
// when tutorials are deleted/imported/cleared from another tab (e.g., Settings).
// Without this, the dashboard shows ghost tutorials that 404 when opened.
chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === "TUTORIALS_CHANGED") {
    // Debounce in case multiple changes arrive in quick succession.
    clearTimeout(load._debounceTimer);
    load._debounceTimer = setTimeout(() => load(), 300);
  }
});

initTheme().then(() => load());
