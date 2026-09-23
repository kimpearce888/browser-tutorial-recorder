import { $, escapeHtml, dbGetAll, dbDeleteAll, dbPut, normalizeTutorial } from "./shared.js";
import { getSettings, saveSettings, resetSettings, applyTheme, initTheme, DEFAULT_SHORTCUTS, GLOBAL_COMMANDS, eventToKey, subscribe } from "./settings-store.js";
import { download } from "./exporter.js";

let settings = null;
let rebindingAction = null;

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  });
});

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), 1500);
}

function renderShortcuts() {
  try {
    chrome.commands.getAll((commands) => {
      if (chrome.runtime.lastError || !commands) {
        $("globalShortcuts").innerHTML = "<div class='shortcut-item'><span class='shortcut-label'>Could not load — see chrome://extensions/shortcuts</span></div>";
        return;
      }
      $("globalShortcuts").innerHTML = GLOBAL_COMMANDS.map((cmd) => {
        const actual = commands.find((c) => c.name === cmd.name);
        const key = actual?.shortcut || "Not set";
        return `<div class="shortcut-item"><span class="shortcut-scope">${cmd.scope}</span><span class="shortcut-label">${escapeHtml(cmd.label)}</span><span class="shortcut-key">${formatKeyDisplay(key)}</span></div>`;
      }).join("");
    });
  } catch (error) {
    $("globalShortcuts").innerHTML = `<div class='shortcut-item'><span class='shortcut-label'>Error: ${escapeHtml(error.message)}</span></div>`;
  }
  $("editorShortcuts").innerHTML = Object.entries(DEFAULT_SHORTCUTS).map(([action, info]) => {
    const custom = settings.shortcuts?.[action]?.keys;
    const keys = custom || info.keys;
    return `<div class="shortcut-item"><span class="shortcut-scope">${info.scope}</span><span class="shortcut-label">${escapeHtml(info.label)}</span><span class="shortcut-key" data-action="${action}">${formatKeyDisplay(keys)}</span></div>`;
  }).join("");
  document.querySelectorAll(".shortcut-key[data-action]").forEach((el) => {
    el.addEventListener("click", () => startRebind(el));
  });
}

function formatKeyDisplay(keys) {
  if (!keys || keys === "Not set") return "Not set";
  // P2 fix: show ⌘ on macOS instead of Ctrl
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
  return keys.split("+").map((part) => {
    const label = part === "mod" ? (isMac ? "⌘" : "Ctrl")
      : part === "shift" ? (isMac ? "⇧" : "Shift")
      : part === "alt" ? (isMac ? "⌥" : "Alt")
      : part;
    return `<kbd>${label}</kbd>`;
  }).join("+");
}

function startRebind(el) {
  if (rebindingAction) document.querySelector(".shortcut-key.rebinding")?.classList.remove("rebinding");
  rebindingAction = el.dataset.action;
  el.classList.add("rebinding");
  el.innerHTML = "Press keys…";
}

document.addEventListener("keydown", (event) => {
  if (!rebindingAction) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") { rebindingAction = null; renderShortcuts(); return; }
  if (["Control", "Meta", "Shift", "Alt"].includes(event.key)) return;
  const keys = eventToKey(event);
  const conflict = Object.entries(DEFAULT_SHORTCUTS).find(([action, info]) => {
    if (action === rebindingAction) return false;
    const existing = settings.shortcuts?.[action]?.keys || info.keys;
    return existing === keys;
  });
  if (conflict) { toast(`Already used by "${conflict[1].label}"`); return; }
  // v1.0.3: don't hang if chrome.commands.getAll is unavailable. Was using
  // optional chaining which silently no-op'd the entire callback, leaving
  // rebindingAction stuck in "Press keys…" forever.
  const finishRebind = (commands) => {
    const cmds = commands || [];
    const globalConflict = cmds.find((c) => {
      const binding = c.shortcut;
      if (!binding) return false;
      // v1.2.1 #6: normalize both "Ctrl" and "Command"/"MacCtrl" to "mod"
      // B15 fix: replace "macctrl" BEFORE "ctrl" — "macctrl" contains "ctrl"
      // as a substring, so the old order turned "macctrl" into "macmod"
      // before the explicit "macctrl" → "mod" replacement could run. This
      // caused Mac users with MacCtrl+K to have their shortcut mis-normalized,
      // missing global conflict detection.
      const normalized = binding.toLowerCase()
        .replace("macctrl", "mod")
        .replace("ctrl", "mod")
        .replace("command", "mod")
        .split("+").sort().join("+");
      return normalized === keys.split("+").sort().join("+");
    });
    if (globalConflict) {
      toast(`Already used by global command "${globalConflict.description || globalConflict.name}"`);
      return;
    }
    const shortcuts = { ...settings.shortcuts, [rebindingAction]: { keys, label: DEFAULT_SHORTCUTS[rebindingAction].label, scope: "Editor" } };
    saveSettings({ shortcuts }).then((s) => { settings = s; rebindingAction = null; renderShortcuts(); toast("Shortcut saved"); });
  };
  if (chrome?.commands?.getAll) {
    chrome.commands.getAll(finishRebind);
  } else {
    finishRebind([]); // no global commands to check against
  }
});

$("chromeShortcutsLink").addEventListener("click", (event) => { event.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); });

function renderRecording() {
  $("captureDelay").value = settings.captureDelay;
  $("captureDelayValue").textContent = `${settings.captureDelay} ms`;
  $("screenshotFormat").value = settings.screenshotFormat;
  $("screenshotQuality").value = settings.screenshotQuality;
  $("screenshotQualityValue").textContent = settings.screenshotQuality;
  $("qualityRow").style.display = settings.screenshotFormat === "jpeg" ? "flex" : "none";
  $("autoPauseIdle").value = settings.autoPauseIdle;
  $("sensitivePatterns").value = settings.sensitivePatterns;
}

function bindRecordingControls() {
  $("captureDelay").addEventListener("input", (e) => {
    const v = Math.max(50, Math.min(2000, Number(e.target.value) || 220));
    $("captureDelayValue").textContent = `${v} ms`;
    saveSettings({ captureDelay: v });
  });
  $("screenshotFormat").addEventListener("change", (e) => { saveSettings({ screenshotFormat: e.target.value }); $("qualityRow").style.display = e.target.value === "jpeg" ? "flex" : "none"; });
  $("screenshotQuality").addEventListener("input", (e) => { $("screenshotQualityValue").textContent = e.target.value; saveSettings({ screenshotQuality: Number(e.target.value) }); });
  $("autoPauseIdle").addEventListener("change", (e) => saveSettings({ autoPauseIdle: Math.max(0, Math.min(600, Number(e.target.value) || 0)) }));
  $("sensitivePatterns").addEventListener("change", (e) => {
    const value = e.target.value;
    // M14: validate the regex so a typo doesn't silently disable detection.
    try {
      new RegExp(value, "i");
      saveSettings({ sensitivePatterns: value });
    } catch (err) {
      toast("Invalid regex — keeping previous patterns");
      e.target.value = settings.sensitivePatterns;
    }
  });
}

function renderAppearance() {
  document.querySelectorAll("#themeToggle button").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === settings.theme));
  $("highContrast").checked = !!settings.highContrast;
  $("gifSpeed").value = settings.gifSpeed;
  $("gifSpeedValue").textContent = `${settings.gifSpeed} ms`;
  $("autoplaySpeed").value = settings.autoplaySpeed;
  $("autoplaySpeedValue").textContent = `${settings.autoplaySpeed} ms`;
}

function bindAppearanceControls() {
  document.querySelectorAll("#themeToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme;
      saveSettings({ theme }).then((s) => { settings = s; applyTheme(theme); renderAppearance(); toast("Theme saved"); });
    });
  });
  $("highContrast").addEventListener("change", (e) => {
    saveSettings({ highContrast: e.target.checked }).then((s) => {
      settings = s;
      document.documentElement.classList.toggle("high-contrast", e.target.checked);
      toast(e.target.checked ? "High contrast on" : "High contrast off");
    });
  });
  $("gifSpeed").addEventListener("input", (e) => { $("gifSpeedValue").textContent = `${e.target.value} ms`; saveSettings({ gifSpeed: Number(e.target.value) }); });
  $("autoplaySpeed").addEventListener("input", (e) => { $("autoplaySpeedValue").textContent = `${e.target.value} ms`; saveSettings({ autoplaySpeed: Number(e.target.value) }); });
}

async function renderStorage() {
  const tutorials = await dbGetAll();
  // F5/A1 fix: guard against corrupted DB records with missing steps array.
  // dbGetAll() returns raw records — a hand-edited or partially-migrated record
  // could have steps: undefined, which would throw TypeError here and crash
  // the entire settings → Storage tab.
  const steps = tutorials.reduce((sum, t) => sum + (Array.isArray(t.steps) ? t.steps.length : 0), 0);
  const bytes = new Blob([JSON.stringify(tutorials)]).size;
  const sizeStr = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  $("tutorialCount").textContent = tutorials.length;
  $("stepCount").textContent = steps;
  $("storageSize").textContent = sizeStr;
}

function bindStorageControls() {
  $("exportAll").addEventListener("click", async () => {
    const tutorials = await dbGetAll();
    download(`browser-tutorial-recorder-export-${Date.now()}.json`, new Blob([JSON.stringify(tutorials, null, 2)], { type: "application/json" }), "application/json");
    toast("Exported all tutorials");
  });
  $("importMultiple").addEventListener("click", () => $("importInput").click());
  $("importInput").addEventListener("change", async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    let imported = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : [data];
        // v1.6.9 fix: per-item try/catch so one bad entry doesn't skip the
        // rest of the items in the same file. Previously the try/catch
        // wrapped the entire inner loop — a single null/malformed entry
        // would abort processing of all remaining entries.
        for (const item of list) {
          try {
            const tutorial = normalizeTutorial(item);
            tutorial.id = `tutorial-${crypto.randomUUID()}-${imported}`;
            tutorial.createdAt = new Date().toISOString();
            tutorial.updatedAt = new Date().toISOString();
            await dbPut(tutorial);
            imported++;
          } catch (e) {
            console.warn(`Failed to import one tutorial from ${file.name}:`, e.message);
            skipped++;
          }
        }
      } catch (error) { console.warn(`Failed to import ${file.name}:`, error.message); }
    }
    event.target.value = "";
    await renderStorage();
    if (skipped > 0) {
      toast(`Imported ${imported} tutorial${imported === 1 ? "" : "s"}, skipped ${skipped} invalid ${skipped === 1 ? "entry" : "entries"}`);
    } else {
      toast(`Imported ${imported} tutorial${imported === 1 ? "" : "s"}`);
    }
  });
  $("clearAll").addEventListener("click", async () => {
    if (!confirm("Delete ALL tutorials? This cannot be undone.")) return;
    const tutorials = await dbGetAll();
    // F6 fix: use atomic dbDeleteAll (single transaction) instead of N
    // separate dbDelete calls. Previously SW termination midway left a
    // partial library with a success toast.
    const ids = tutorials.map(t => t.id).filter(Boolean);
    await dbDeleteAll(ids);
    await renderStorage();
    // S3 fix: notify other extension pages (e.g., an open dashboard) that
    // tutorials changed, so they can re-load instead of showing ghost tutorials.
    try { chrome.runtime.sendMessage({ type: "TUTORIALS_CHANGED" }).catch(() => {}); } catch (_) {}
    toast("All tutorials deleted");
  });
}

$("resetAll").addEventListener("click", async () => {
  if (!confirm("Reset all settings to defaults? Your tutorials are not affected.")) return;
  settings = await resetSettings();
  applyTheme(settings.theme);
  document.documentElement.classList.toggle("high-contrast", settings.highContrast);
  renderAll();
  toast("Settings reset");
});

function renderAll() {
  renderShortcuts();
  renderRecording();
  renderAppearance();
  renderStorage().catch((error) => console.warn("Storage render failed:", error));
}

async function init() {
  try {
    await initTheme();
    settings = await getSettings();
    bindRecordingControls();
    bindAppearanceControls();
    bindStorageControls();
    renderAll();
    // S1 fix: re-render when settings change in another tab so this settings
    // page doesn't show stale values (and silently overwrite the other tab's
    // changes when the user interacts with a stale control).
    subscribe((newSettings) => {
      settings = newSettings;
      renderAll();
    });
  } catch (error) {
    console.error("Settings init failed:", error);
    alert(`Could not load settings: ${error.message}`);
  }
}

init();
