// Settings store: wraps chrome.storage.local with typed defaults, pub/sub,
// theme application, and keyboard shortcut matching.

const STORAGE_KEY = "settings";

const DEFAULT_SETTINGS = {
  captureDelay: 220,
  screenshotFormat: "png",
  screenshotQuality: 90,
  autoPauseIdle: 0,
  sensitivePatterns: "password|passcode|secret|token|api.?key|authorization|credit.?card|card.?number|cvv|cvc|csc|cc-|security.?code|otp|one.?time",
  theme: "system",
  highContrast: false,
  gifSpeed: 1200,
  autoplaySpeed: 3000,
  shortcuts: {}
};

export const DEFAULT_SHORTCUTS = {
  undo:            { keys: "mod+z",       label: "Undo",                       scope: "Editor" },
  redo:            { keys: "mod+shift+z", label: "Redo",                       scope: "Editor" },
  save:            { keys: "mod+s",       label: "Save",                       scope: "Editor" },
  newStep:         { keys: "mod+n",       label: "Add new step",               scope: "Editor" },
  duplicateStep:   { keys: "mod+d",       label: "Duplicate step",             scope: "Editor" },
  deleteStep:      { keys: "mod+backspace", label: "Delete step",              scope: "Editor" },
  preview:         { keys: "mod+shift+p", label: "Open preview",               scope: "Editor" },
  exportMenu:      { keys: "mod+e",       label: "Open export menu",           scope: "Editor" },
  tool1:           { keys: "1",           label: "Highlight tool",             scope: "Editor" },
  tool2:           { keys: "2",           label: "Rectangle tool",             scope: "Editor" },
  tool3:           { keys: "3",           label: "Circle tool",                scope: "Editor" },
  tool4:           { keys: "4",           label: "Arrow tool",                 scope: "Editor" },
  tool5:           { keys: "5",           label: "Text tool",                  scope: "Editor" },
  tool6:           { keys: "6",           label: "Blur tool",                  scope: "Editor" },
  tool7:           { keys: "7",           label: "Redaction tool",             scope: "Editor" },
  tool8:           { keys: "8",           label: "Spotlight tool",             scope: "Editor" },
  tool9:           { keys: "9",           label: "Marker tool",                scope: "Editor" },
  deselect:        { keys: "escape",      label: "Deselect annotation",        scope: "Editor" },
  nextStep:        { keys: "mod+j",       label: "Next step",                  scope: "Editor" },
  prevStep:        { keys: "mod+k",       label: "Previous step",              scope: "Editor" },
  copyAnnotation:  { keys: "mod+c",       label: "Copy annotation",            scope: "Editor" },
  pasteAnnotation: { keys: "mod+v",       label: "Paste annotation",           scope: "Editor" },
  mergeNext:       { keys: "mod+m",       label: "Merge with next step",       scope: "Editor" },
  splitStep:       { keys: "mod+shift+k", label: "Split step",                 scope: "Editor" },
  showShortcuts:   { keys: "?",           label: "Show shortcut cheat sheet",  scope: "Editor" },
  backToDashboard: { keys: "mod+shift+h", label: "Back to dashboard",          scope: "Editor" }
};

export const GLOBAL_COMMANDS = [
  { name: "start-recording",  label: "Start recording", scope: "Global" },
  { name: "stop-recording",   label: "Stop recording",  scope: "Global" },
  { name: "pause-resume",     label: "Pause / resume",  scope: "Global" },
  { name: "open-dashboard",   label: "Open dashboard",  scope: "Global" }
];

let cache = null;
const listeners = new Set();

function updateThemeCache(settings) {
  try { localStorage.setItem("btr-theme", (settings.theme || "system") + "|" + (settings.highContrast ? "1" : "0")); } catch (e) {}
}

async function load() {
  if (!chrome?.storage?.local) {
    cache = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
    return cache;
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  cache = { ...DEFAULT_SETTINGS, ...stored[STORAGE_KEY] };
  cache.shortcuts = { ...DEFAULT_SHORTCUTS, ...cache.shortcuts };
  updateThemeCache(cache);
  return cache;
}

chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  cache = { ...DEFAULT_SETTINGS, ...changes[STORAGE_KEY].newValue };
  cache.shortcuts = { ...DEFAULT_SHORTCUTS, ...cache.shortcuts };
  updateThemeCache(cache);
  listeners.forEach((fn) => fn(cache));
});

export async function getSettings() {
  if (cache) return cache;
  return load();
}

// F9 fix: serialize settings writes through a queue. The old saveSettings()
// had a read-modify-write race — multiple rapid calls (e.g. dragging a slider)
// could all read the same stale cache before earlier writes completed, then
// each write would overwrite the others' changes.
let settingsWriteQueue = Promise.resolve();
function serializeSettingsWrite(fn) {
  const result = settingsWriteQueue.then(fn, fn);
  // Swallow rejections so one failed write doesn't break the queue for future writes.
  settingsWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function saveSettings(patch) {
  return serializeSettingsWrite(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    if (patch.shortcuts) next.shortcuts = { ...current.shortcuts, ...patch.shortcuts };
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    cache = next;
    updateThemeCache(next);
    return next;
  });
}

export async function resetSettings() {
  return serializeSettingsWrite(async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
    cache = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
    updateThemeCache(cache);
    return cache;
  });
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function getShortcut(action) {
  return (cache?.shortcuts?.[action]?.keys) || DEFAULT_SHORTCUTS[action]?.keys || null;
}

export function eventToKey(event) {
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  let key = event.key.toLowerCase();
  if (key === " ") key = "space";
  if (["control", "meta", "shift", "alt"].includes(key)) {
    if (event.shiftKey) parts.push("shift");
    return parts.join("+");
  }
  // H22: shift+a letter produces event.key="A" (uppercase). We lowercased it
  // above, so we need to check if shift was held and add it explicitly.
  // Without this, binding "shift+a" was impossible because the shift was lost.
  if (event.shiftKey && key.length === 1 && /[a-z0-9]/.test(key)) {
    parts.push("shift");
  }
  // Non-letter keys (punctuation, etc.) — these come as their symbol already
  // (e.g. "?", "/"). Shift state is implicit in the symbol, so we don't add
  // "shift" for those.
  parts.push(key);
  return parts.join("+");
}

export function matchesShortcut(event, action) {
  const binding = getShortcut(action);
  if (!binding) return false;
  return eventToKey(event) === binding;
}

function resolveTheme(theme) {
  if (theme === "system") return (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false) ? "dark" : "light";
  return theme;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", resolveTheme(theme));
}

export function applyHighContrast(enabled) {
  document.documentElement.classList.toggle("high-contrast", Boolean(enabled));
}

let _mediaListenerRegistered = false;
let _subscribed = false;

export async function initTheme() {
  try {
    const settings = await getSettings();
    applyTheme(settings.theme);
    applyHighContrast(settings.highContrast);
    // B14 fix: always register the matchMedia listener, regardless of the
    // current theme. The old code only registered it when `theme === "system"`
    // at init time — so if the user later switched from "dark" to "system",
    // the OS theme change listener was never attached and OS Light↔Dark
    // transitions weren't observed until page reload. The listener itself
    // checks `(cache || {}).theme === "system"` before applying, so it's a
    // no-op when the user has explicitly chosen light or dark.
    if (!_mediaListenerRegistered) {
      _mediaListenerRegistered = true;
      window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
        if ((cache || {}).theme === "system") applyTheme("system");
      });
    }
    // v1.0.5: use a separate flag for subscribe() — the single-flag approach
    // (introduced in v1.0.3) meant subscribe() was skipped whenever theme
    // was "system" (the default), breaking cross-tab theme/high-contrast sync.
    if (!_subscribed) {
      _subscribed = true;
      subscribe((s) => { applyTheme(s.theme); applyHighContrast(s.highContrast); });
    }
  } catch (e) {
    applyTheme("system");
  }
}
