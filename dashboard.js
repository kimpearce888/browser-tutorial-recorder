import { $, escapeHtml, escapeAttr, sanitizeImageUrl, dbPut, normalizeTutorial } from "./shared.js";
import { exportTutorial } from "./exporter.js";
import { initTheme } from "./settings-store.js";

let tutorials = [];
let selected = new Set();
let viewMode = "grid";
let activeExportId = null;

const searchInput = $("searchInput");
const statusFilter = $("statusFilter");
const sortBy = $("sortBy");

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



  const steps = Array.isArray(tutorial.steps) ? tutorial.steps : [];
  return steps.reduce((sum, step) => sum + (step.annotationCount ?? (step.annotations?.length || 0)), 0);
}

function firstScreenshot(tutorial) {

  const steps = Array.isArray(tutorial.steps) ? tutorial.steps : [];
  const step = steps.find((s) => s.screenshot?.image);
  return step?.screenshot?.image || "";
}

function visibleTutorials() {
  const query = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;

  let list = tutorials.filter((t) => {
    if (status && t.status !== status) return false;
    if (!query) return true;
    const haystack = [
      t.title,
      t.description,

      ...(Array.isArray(t.steps) ? t.steps.map((s) => s.description || "") : []),
      ...(Array.isArray(t.steps) ? t.steps.map((s) => s.action || "") : [])
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  const sort = sortBy.value;
  list = list.slice().sort((a, b) => {
    if (sort === "title") return (a.title || "").localeCompare(b.title || "");


    if (sort === "steps") return (Array.isArray(b.steps) ? b.steps.length : 0) - (Array.isArray(a.steps) ? a.steps.length : 0);
    if (sort === "created") return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  return list;
}

function renderStats() {
  const total = tutorials.length;


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





  if (format === "pdf") {
    $("bulkExportDialog").close();
    alert("PDF export opens a print dialog — please export tutorials one at a time for PDF.");
    return;
  }
  $("bulkExportDialog").close();
  const ids = [...selected];
  const kind = format;




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

function importTutorial() {
  $("importInput").click();
}

$("importInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {






      const parsed = JSON.parse(reader.result);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      let imported = 0;
      for (const item of list) {

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
  event.target.value = "";
});

function startNewRecording() {





  let excludedDomains = [];
  try {
    const raw = localStorage.getItem("btr-excluded-domains");
    if (raw) excludedDomains = JSON.parse(raw);
    if (!Array.isArray(excludedDomains)) excludedDomains = [];
  } catch (e) { excludedDomains = []; }






  chrome.tabs.query({ active: true, currentWindow: true }, (currentTabs) => {
    const extensionUrlRe = /^(chrome-extension|chrome|edge|about|devtools|chrome-untrusted|moz-extension|file):/i;
    const currentEligible = (currentTabs || []).filter((t) => t.url && !extensionUrlRe.test(t.url));
    if (currentEligible.length > 0) {
      const tab = currentEligible[0];
      send("START_RECORDING", { excludedDomains, tabId: tab.id }, (result) => {
        if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
        if (!result?.ok) return alert(result?.error || "Recording could not start.");
      });
      return;
    }

    chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs) || tabs.length === 0) {
      alert("No tabs found. Open a webpage and try again.");
      return;
    }


    chrome.windows.getCurrent((currentWin) => {
      const currentWindowId = currentWin?.id;


      const extensionUrlRe = /^(chrome-extension|chrome|edge|about|devtools|chrome-untrusted|moz-extension|file):/i;
      const eligible = tabs
        .filter((t) => t.url && !extensionUrlRe.test(t.url))
        .sort((a, b) => {

          if (a.windowId === currentWindowId && b.windowId !== currentWindowId) return -1;
          if (a.windowId !== currentWindowId && b.windowId === currentWindowId) return 1;

          if (a.active && !b.active) return -1;
          if (!a.active && b.active) return 1;
          return (b.lastAccessed || 0) - (a.lastAccessed || 0);
        });

    if (eligible.length === 0) {

      chrome.tabs.create({ url: "https://www.google.com/" }, (newTab) => {
        setTimeout(() => {



          send("START_RECORDING", { excludedDomains, tabId: newTab.id }, (result) => {
            if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
            if (!result?.ok) return alert(result?.error || "Recording could not start.");
          });
        }, 1500);
      });
      return;
    }

    const tab = eligible[0];

    chrome.tabs.update(tab.id, { active: true }, () => {
      if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true }, () => {});



      send("START_RECORDING", { excludedDomains, tabId: tab.id }, (result) => {
        if (chrome.runtime.lastError) return alert(chrome.runtime.lastError.message || "The recorder service is unavailable.");
        if (!result?.ok) return alert(result?.error || "Recording could not start.");
      });
    });
  });
  });
  });
}

function load() {








  send("GET_TUTORIALS_SUMMARY", {}, (result) => {

    if (chrome.runtime.lastError) {
      $("grid").innerHTML = "";
      $("empty").classList.add("hidden");
      $("noResults").classList.remove("hidden");
      $("noResults").querySelector("strong").textContent = "Could not connect to the recorder";
      $("noResults").querySelector("p").textContent = chrome.runtime.lastError.message || "Please reload the page.";
      return;
    }


    if (!result) {
      $("grid").innerHTML = "";
      $("empty").classList.add("hidden");
      $("noResults").classList.remove("hidden");
      $("noResults").querySelector("strong").textContent = "Could not load tutorials";
      $("noResults").querySelector("p").textContent = "The recorder service returned no data. Please reload the page.";
      return;
    }
    tutorials = result?.tutorials || [];


    const validIds = new Set(tutorials.map((t) => t.id));
    for (const id of [...selected]) {
      if (!validIds.has(id)) selected.delete(id);
    }
    renderStats();
    renderGrid();
  });
}

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 180);
});

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

$("bulkDelete").addEventListener("click", bulkDelete);
$("bulkExport").addEventListener("click", openBulkExportDialog);
$("bulkClear").addEventListener("click", clearSelection);

$("exportMenu").querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => exportSingle(button.dataset.export));
});

document.querySelector("#bulkExportDialog .dialog-close").addEventListener("click", () => $("bulkExportDialog").close());
document.querySelectorAll("[data-bulk-export]").forEach((button) => {
  button.addEventListener("click", () => bulkExport(button.dataset.bulkExport));
});

$("clearFilters").addEventListener("click", () => {
  searchInput.value = "";
  statusFilter.value = "";


  sortBy.value = "updated";
  renderGrid();
});

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



  const tag = document.activeElement?.tagName;
  if ((event.metaKey || event.ctrlKey) && event.key === "a" && !["INPUT", "TEXTAREA", "SELECT"].includes(tag) && !document.querySelector("dialog[open]")) {
    event.preventDefault();

    selected.clear();
    tutorials.forEach((t) => selected.add(t.id));
    renderGrid();
  }
});

window.addEventListener("scroll", closeExportMenu, true);
window.addEventListener("resize", closeExportMenu);

chrome.runtime.onMessage?.addListener((message) => {
  if (message?.type === "TUTORIALS_CHANGED") {

    clearTimeout(load._debounceTimer);
    load._debounceTimer = setTimeout(() => load(), 300);
  }
});

initTheme().then(() => load());
