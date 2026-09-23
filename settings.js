import { bgCall } from "./common-ui.js";
import { formatBytes, downloadBlob } from "./shared.js";
import { EDITOR_ACTIONS, normalizeCombo, findShortcutConflicts } from "./settings-store.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let listeningAction = null;

async function load() {
  settings = (await bgCall({ type: "GET_SETTINGS" })).settings;
  fill();
  refreshStorage();
}

function fill() {
  $("capture-delay").value = settings.captureDelayMs;
  $("capture-delay-val").textContent = `${settings.captureDelayMs} ms`;
  $("shot-format").value = settings.screenshotFormat;
  $("shot-quality").value = settings.screenshotQuality;
  $("shot-quality-val").textContent = String(settings.screenshotQuality);
  $("quality-field").style.display = settings.screenshotFormat === "jpeg" ? "" : "none";
  $("idle-timeout").value = String(settings.autoPauseIdleSec);
  $("excluded").value = settings.excludedDomains.join("\n");
  $("sensitive").value = settings.sensitivePatterns.join("\n");
  $("theme").value = settings.theme;
  $("high-contrast").checked = settings.highContrast;
  $("gif-delay").value = settings.gifFrameDelayMs;
  $("gif-delay-val").textContent = `${settings.gifFrameDelayMs} ms`;
  $("preview-delay").value = settings.previewAutoAdvanceMs;
  $("preview-delay-val").textContent = `${settings.previewAutoAdvanceMs} ms`;
  renderShortcuts();
}

async function patch(update) {
  settings = (await bgCall({ type: "SAVE_SETTINGS", patch: update })).settings;
  fill();
}

function renderShortcuts() {
  const list = $("shortcut-list");
  list.innerHTML = "";
  const conflicts = new Set(
    findShortcutConflicts(settings.editorShortcuts).flatMap((c) => c.actions)
  );
  for (const action of EDITOR_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcut-row" + (conflicts.has(action) ? " conflict" : "");
    const label = document.createElement("span");
    label.textContent = action;
    const kbd = document.createElement("span");
    kbd.className = "kbd" + (listeningAction === action ? " listening" : "");
    kbd.textContent = listeningAction === action ? "press keys…" : settings.editorShortcuts[action];
    kbd.title = conflicts.has(action) ? "Conflict with another action" : "Click to rebind";
    kbd.addEventListener("click", () => {
      listeningAction = action;
      renderShortcuts();
    });
    row.appendChild(label);
    row.appendChild(kbd);
    list.appendChild(row);
  }
}

window.addEventListener("keydown", async (e) => {
  if (!listeningAction) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") { listeningAction = null; renderShortcuts(); return; }
  const combo = normalizeCombo([
    e.ctrlKey || e.metaKey ? "Ctrl" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    e.key === " " ? "Space" : e.key
  ].filter(Boolean).join("+"));
  if (!combo) return;
  settings.editorShortcuts[listeningAction] = combo;
  listeningAction = null;
  await patch({ editorShortcuts: settings.editorShortcuts });
}, true);

$("capture-delay").addEventListener("change", (e) => patch({ captureDelayMs: Number(e.target.value) }));
$("capture-delay").addEventListener("input", (e) => { $("capture-delay-val").textContent = `${e.target.value} ms`; });
$("shot-format").addEventListener("change", (e) => patch({ screenshotFormat: e.target.value }));
$("shot-quality").addEventListener("change", (e) => patch({ screenshotQuality: Number(e.target.value) }));
$("shot-quality").addEventListener("input", (e) => { $("shot-quality-val").textContent = e.target.value; });
$("idle-timeout").addEventListener("change", (e) => patch({ autoPauseIdleSec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) }));
$("excluded").addEventListener("change", (e) => {
  const domains = e.target.value.split(/\n+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  patch({ excludedDomains: domains });
});
$("sensitive").addEventListener("change", (e) => {
  const patterns = e.target.value.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  patch({ sensitivePatterns: patterns });
});
$("theme").addEventListener("change", (e) => patch({ theme: e.target.value }));
$("high-contrast").addEventListener("change", (e) => patch({ highContrast: e.target.checked }));
$("gif-delay").addEventListener("change", (e) => patch({ gifFrameDelayMs: Number(e.target.value) }));
$("gif-delay").addEventListener("input", (e) => { $("gif-delay-val").textContent = `${e.target.value} ms`; });
$("preview-delay").addEventListener("change", (e) => patch({ previewAutoAdvanceMs: Number(e.target.value) }));
$("preview-delay").addEventListener("input", (e) => { $("preview-delay-val").textContent = `${e.target.value} ms`; });

async function refreshStorage() {
  try {
    const res = await bgCall({ type: "GET_SUMMARIES" });
    const count = res.summaries.length;
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      $("storage-info").textContent = `${count} tutorial(s) stored · ~${formatBytes(usage)} used`;
    } else {
      $("storage-info").textContent = `${count} tutorial(s) stored`;
    }
  } catch (e) {
    $("storage-info").textContent = "Storage info unavailable.";
  }
}

$("btn-export-all").addEventListener("click", async () => {
  const res = await bgCall({ type: "GET_SUMMARIES" });
  const all = [];
  for (const s of res.summaries) {
    const t = (await bgCall({ type: "GET_TUTORIAL", id: s.id })).tutorial;
    all.push(t);
  }
  downloadBlob("browser-tutorial-recorder-export.json",
    new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }));
});

$("import-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let total = 0;
  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const res = await bgCall({ type: "IMPORT_TUTORIALS", tutorials: list });
      total += res.imported || 0;
    } catch (err) {
      alert(`Could not import ${file.name}: ${err.message}`);
    }
  }
  alert(`Imported ${total} tutorial(s).`);
  refreshStorage();
  e.target.value = "";
});

$("btn-delete-all").addEventListener("click", async () => {
  if (!confirm("Delete ALL tutorials? This cannot be undone.")) return;
  await bgCall({ type: "DELETE_ALL_TUTORIALS" });
  refreshStorage();
});

load().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p class="muted" style="padding:20px">Failed to load settings: ${e.message}</p>`);
});
