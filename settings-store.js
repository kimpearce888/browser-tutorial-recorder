export const EDITOR_ACTIONS = [
  "undo", "redo", "save", "preview", "export", "addStep", "duplicateStep",
  "deleteStep", "nextStep", "prevStep", "mergeStep", "splitStep",
  "copyAnnotation", "pasteAnnotation", "deselect", "shortcuts", "dashboard"
];

export const DEFAULT_SHORTCUTS = {
  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  save: "Ctrl+S",
  preview: "Ctrl+Shift+P",
  export: "Ctrl+E",
  addStep: "Ctrl+N",
  duplicateStep: "Ctrl+D",
  deleteStep: "Ctrl+Backspace",
  nextStep: "Ctrl+J",
  prevStep: "Ctrl+K",
  mergeStep: "Ctrl+M",
  splitStep: "Ctrl+Shift+K",
  copyAnnotation: "Ctrl+C",
  pasteAnnotation: "Ctrl+V",
  deselect: "Escape",
  shortcuts: "?",
  dashboard: "Ctrl+Shift+H"
};

export const DEFAULT_SETTINGS = {
  captureDelayMs: 250,
  screenshotFormat: "png",
  screenshotQuality: 90,
  autoPauseIdleSec: 0,
  sensitivePatterns: ["password", "passwd", "pin", "cvv", "ssn", "credit-card", "card-number", "one-time-code"],
  excludedDomains: [],
  theme: "system",
  highContrast: false,
  gifFrameDelayMs: 500,
  previewAutoAdvanceMs: 2500,
  editorShortcuts: { ...DEFAULT_SHORTCUTS },
  annotationPresets: []
};

const KEY = "btr-settings";

function normalizeShortcutMap(shortcuts) {
  const out = {};
  for (const action of EDITOR_ACTIONS) {
    const v = shortcuts && typeof shortcuts === "object" ? shortcuts[action] : undefined;
    out[action] = typeof v === "string" && v.trim() ? v.trim() : DEFAULT_SHORTCUTS[action];
  }
  return out;
}

export function normalizeSettings(raw) {
  const s = (raw && typeof raw === "object") ? raw : {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  return {
    captureDelayMs: clamp(s.captureDelayMs, 0, 3000, DEFAULT_SETTINGS.captureDelayMs),
    screenshotFormat: s.screenshotFormat === "jpeg" ? "jpeg" : "png",
    screenshotQuality: clamp(s.screenshotQuality, 30, 100, DEFAULT_SETTINGS.screenshotQuality),
    autoPauseIdleSec: clamp(s.autoPauseIdleSec, 0, 600, DEFAULT_SETTINGS.autoPauseIdleSec),
    sensitivePatterns: Array.isArray(s.sensitivePatterns)
      ? s.sensitivePatterns.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim().slice(0, 100)).slice(0, 30)
      : [...DEFAULT_SETTINGS.sensitivePatterns],
    excludedDomains: Array.isArray(s.excludedDomains)
      ? s.excludedDomains.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim().toLowerCase().slice(0, 200)).slice(0, 100)
      : [],
    theme: ["light", "dark", "system"].includes(s.theme) ? s.theme : "system",
    highContrast: Boolean(s.highContrast),
    gifFrameDelayMs: clamp(s.gifFrameDelayMs, 100, 2000, DEFAULT_SETTINGS.gifFrameDelayMs),
    previewAutoAdvanceMs: clamp(s.previewAutoAdvanceMs, 500, 10000, DEFAULT_SETTINGS.previewAutoAdvanceMs),
    editorShortcuts: normalizeShortcutMap(s.editorShortcuts),
    annotationPresets: Array.isArray(s.annotationPresets)
      ? s.annotationPresets.filter((p) => p && typeof p === "object" && p.name).slice(0, 30)
      : []
  };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return normalizeSettings(stored[KEY]);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function findShortcutConflicts(shortcuts) {
  const seen = new Map();
  const conflicts = [];
  for (const action of EDITOR_ACTIONS) {
    const combo = normalizeCombo(shortcuts[action] || "");
    if (!combo) continue;
    if (seen.has(combo)) {
      conflicts.push({ combo, actions: [seen.get(combo), action] });
    } else {
      seen.set(combo, action);
    }
  }
  return conflicts;
}

export function normalizeCombo(combo) {
  if (typeof combo !== "string") return "";
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const mods = parts.filter((p) => /^(Ctrl|Alt|Shift|Meta)$/i.test(p)).map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
  const keys = parts.filter((p) => !/^(Ctrl|Alt|Shift|Meta)$/i.test(p));
  if (keys.length !== 1) return "";
  mods.sort((a, b) => {
    const order = { Ctrl: 0, Alt: 1, Shift: 2, Meta: 3 };
    return order[a] - order[b];
  });
  const key = keys[0].length === 1 ? keys[0].toUpperCase() : keys[0];
  return [...mods, key].join("+");
}

const CHANGE_LISTENERS = new Set();

export function onSettingsChanged(listener) {
  CHANGE_LISTENERS.add(listener);
  return () => CHANGE_LISTENERS.delete(listener);
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const next = normalizeSettings(changes[KEY].newValue);
    for (const listener of CHANGE_LISTENERS) {
      try { listener(next); } catch (e) { console.error("[BTR] settings listener failed:", e); }
    }
  });
}
