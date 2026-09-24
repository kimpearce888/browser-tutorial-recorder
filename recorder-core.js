import { makeId } from "./shared.js";

export const INTERNAL_URL_RE = /^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|view-source|file|moz-extension|extension):/i;

export const EVENTS_NEEDING_CURSOR = new Set([
  "CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "MIDDLE_CLICK", "DROP"
]);

export function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function nextScrollY(pos, requested) {
  if (!pos || !(pos.total > pos.h)) return null;
  if (pos.y + pos.h >= pos.total - 2) return null;
  if (requested >= pos.total - pos.h) return null;
  const next = Math.min(pos.y + pos.h, pos.total - pos.h);
  if (next <= pos.y + 1) return null;
  return next;
}

export function isInternalUrl(url) {
  return !url || INTERNAL_URL_RE.test(url);
}

export function describeUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname}${path.length > 40 ? path.slice(0, 40) + "…" : path}`;
  } catch {
    return url || "unknown page";
  }
}

export function sameTarget(a, b) {
  if (!a || !b) return false;
  const selA = a.selector || "";
  const selB = b.selector || "";
  if (selA && selB && selA === selB) return true;
  const txtA = (a.text || "").trim();
  const txtB = (b.text || "").trim();
  if (txtA && txtB && txtA === txtB) {
    const boxA = a.boundingBox, boxB = b.boundingBox;
    if (!boxA || !boxB) return true;
    return Math.abs((boxA.x || 0) - (boxB.x || 0)) < 8 && Math.abs((boxA.y || 0) - (boxB.y || 0)) < 8;
  }
  return false;
}

// Element auto-crop — the Scribe/Tango signature. Each action step is zoomed
// to the region the user actually interacted with instead of shipping a full
// viewport nobody asked for. Pure so it can be unit-tested.
export const CROP_PAD = 56;
export const CROP_MIN_W = 360;
export const CROP_MIN_H = 280;

export function planCrop(bbox, point, cssW, cssH) {
  if (!(cssW > 0) || !(cssH > 0)) return null;
  if (point && !(Number.isFinite(point.x) && Number.isFinite(point.y))) point = null;
  if (bbox && !(Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && bbox.width > 0 && bbox.height > 0)) bbox = null;
  if (!bbox && !point) return null;
  let x1, y1, x2, y2;
  if (bbox) {
    x1 = bbox.x - CROP_PAD;
    y1 = bbox.y - CROP_PAD;
    x2 = bbox.x + bbox.width + CROP_PAD;
    y2 = bbox.y + bbox.height + CROP_PAD;
  } else {
    x1 = point.x - CROP_MIN_W / 2;
    y1 = point.y - CROP_MIN_H / 2;
    x2 = point.x + CROP_MIN_W / 2;
    y2 = point.y + CROP_MIN_H / 2;
  }
  if (x2 - x1 < CROP_MIN_W) {
    const cx = (x1 + x2) / 2;
    x1 = cx - CROP_MIN_W / 2; x2 = cx + CROP_MIN_W / 2;
  }
  if (y2 - y1 < CROP_MIN_H) {
    const cy = (y1 + y2) / 2;
    y1 = cy - CROP_MIN_H / 2; y2 = cy + CROP_MIN_H / 2;
  }
  x1 = Math.max(0, x1); y1 = Math.max(0, y1);
  x2 = Math.min(cssW, x2); y2 = Math.min(cssH, y2);
  const w = x2 - x1, h = y2 - y1;
  if (w < 40 || h < 40) return null;
  // A "crop" covering ~the whole viewport is not a crop.
  if (w >= cssW * 0.94 && h >= cssH * 0.94) return null;
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(w), h: Math.round(h) };
}

export function createRecorder(deps = {}) {
  const now = deps.now || (() => Date.now());
  const newId = deps.newId || ((p) => makeId(p));

  const state = {
    session: null,
    steps: [],
    lastNavUrlByTab: new Map(),
    lastStepAt: 0
  };

  function isRecording() { return !!state.session && state.session.status === "recording"; }
  function isActive() { return !!state.session && state.session.status !== "idle"; }

  function uiState() {
    return {
      session: state.session ? {
        id: state.session.id,
        title: state.session.title,
        status: state.session.status,
        startedAt: state.session.startedAt,
        pausedReason: state.session.pausedReason || null,
        stepCount: state.steps.length,
        tabCount: state.session.tabIds.length
      } : null
    };
  }

  function startRecording(tab, meta = {}) {
    const tabId = tab && typeof tab.id === "number" ? tab.id : -1;
    state.session = {
      id: newId("session"),
      title: meta.title || "Untitled browser tutorial",
      status: "recording",
      startedAt: now(),
      primaryTabId: tabId,
      tabIds: tabId >= 0 ? [tabId] : [],
      windowIds: tab && typeof tab.windowId === "number" ? [tab.windowId] : [],
      excludedDomains: meta.excludedDomains || [],
      pausedReason: null
    };
    state.steps = [];
    state.lastNavUrlByTab = new Map();
    state.lastStepAt = now();
    return state.session;
  }

  function addTab(tab) {
    if (!state.session || !tab || typeof tab.id !== "number") return;
    if (!state.session.tabIds.includes(tab.id)) state.session.tabIds.push(tab.id);
    if (typeof tab.windowId === "number" && !state.session.windowIds.includes(tab.windowId)) {
      state.session.windowIds.push(tab.windowId);
    }
  }

  function setPaused(paused, reason = null) {
    if (!state.session) return;
    state.session.status = paused ? "paused" : "recording";
    state.session.pausedReason = paused ? reason : null;
  }

  function setExcludedDomains(domains) {
    if (!state.session) return;
    state.session.excludedDomains = Array.isArray(domains) ? domains : [];
  }

  function makeStepFields(evt) {
    return {
      id: newId("step"),
      action: evt.event,
      description: evt.description || "",
      url: evt.url || "",
      target: evt.target ? { ...evt.target } : null,
      frameUrl: evt.frameUrl || (evt.url || ""),
      isIframe: Boolean(evt.isIframe)
    };
  }

  function lastStep() { return state.steps[state.steps.length - 1] || null; }

  function pushStep(evt, screenshot) {
    const step = makeStepFields(evt);
    step.number = state.steps.length + 1;
    step.screenshot = screenshot ? {
      image: screenshot.image || "",
      width: screenshot.width || 0,
      height: screenshot.height || 0,
      timestamp: now(),
      ...(screenshot.crop ? { crop: { ...screenshot.crop } } : {})
    } : { image: "", width: 0, height: 0, timestamp: now(), status: "FAILED" };
    step.annotations = [];
    state.steps.push(step);
    state.lastStepAt = now();
    return step;
  }

  function renumberFrom(index) {
    for (let i = index; i < state.steps.length; i++) state.steps[i].number = i + 1;
  }

  function handleEvent(evt, senderInfo = {}) {
    if (!isRecording()) return { action: "ignored", reason: "not-recording" };
    if (!evt || typeof evt.event !== "string") return { action: "ignored", reason: "malformed" };

    const tabId = senderInfo.tabId;
    if (typeof tabId === "number") addTab({ id: tabId, windowId: senderInfo.windowId });

    const url = evt.url || "";
    if (isInternalUrl(url)) return { action: "ignored", reason: "internal-page" };

    const hostname = hostnameOf(url);
    const excluded = (state.session.excludedDomains || []).some(
      (d) => hostname === d || hostname.endsWith(`.${d}`)
    );
    if (excluded) return { action: "ignored", reason: "excluded-domain" };

    const event = evt.event;

    if (event === "NAVIGATION" && !evt.system) {
      const prev = state.lastNavUrlByTab.get(tabId) || "";
      if (prev === url) return { action: "ignored", reason: "nav-duplicate" };
      state.lastNavUrlByTab.set(tabId, url);
    }

    if (event === "DOUBLE_CLICK") {
      // The content script reports a double-click twice (second click with
      // detail>=2, then the dblclick event) — keep only the first one.
      const prevDbl = lastStep();
      if (prevDbl && prevDbl.action === "DOUBLE_CLICK" && sameTarget(prevDbl.target, evt.target) && now() - prevDbl.screenshot.timestamp < 1500) {
        return { action: "ignored", reason: "dblclick-duplicate" };
      }
      const prev = lastStep();
      if (prev && prev.action === "CLICK" && sameTarget(prev.target, evt.target) && now() - prev.screenshot.timestamp < 1500) {
        state.steps.pop();
        renumberFrom(state.steps.length);
      }
    }

    if (event === "SUBMIT") {
      for (let i = state.steps.length - 1; i >= 0 && i >= state.steps.length - 5; i--) {
        const prev = state.steps[i];
        if (prev.action !== "CLICK") continue;
        if (!sameTarget(prev.target, evt.target)) continue;
        if (now() - prev.screenshot.timestamp > 1500) continue;
        state.steps.splice(i, 1);
        renumberFrom(i);
        break;
      }
    }

    if (event === "SCROLL") {
      const prev = lastStep();
      if (prev && prev.action === "SCROLL" && prev.url === url) {
        const prevY = prev.target && prev.target.scrollY || 0;
        const nextY = evt.target && evt.target.scrollY || 0;
        if (Math.abs(nextY - prevY) < 300) return { action: "ignored", reason: "scroll-duplicate" };
      }
    }

    return { action: "captured", event, tabId, url, needsCursor: EVENTS_NEEDING_CURSOR.has(event) };
  }

  function commitStep(evt, screenshot) {
    const step = pushStep(evt, screenshot);
    return { action: "added", step, uiState: uiState() };
  }

  function addSystemStep(event, tabId, url) {
    if (!isRecording()) return null;
    if (event === "NAVIGATION") {
      const prev = state.lastNavUrlByTab.get(tabId) || "";
      if (prev === url) return null;
      state.lastNavUrlByTab.set(tabId, url);
    }
    // system: true — the dedupe already ran here, so handleEvent must not
    // re-check the map and silently drop the event (this exact double-dedupe
    // used to kill every page-load navigation step).
    const evt = {
      event,
      system: true,
      url,
      description: event === "NAVIGATION" ? `Navigate to ${describeUrl(url)}`
        : event === "NEW_TAB" ? "Open a new tab"
        : "Open a new window",
      target: null,
      frameUrl: url
    };
    return evt;
  }

  function rehydrate(draft) {
    if (!draft || !Array.isArray(draft.steps)) return false;
    state.session = draft.session || null;
    state.steps = draft.steps.filter((s) => s && typeof s === "object");
    renumberFrom(0);
    state.lastNavUrlByTab = new Map(draft.lastNavUrlByTab || []);
    if (state.session) state.session.status = "paused";
    return isActive();
  }

  function exportDraft() {
    return {
      session: state.session,
      steps: state.steps,
      lastNavUrlByTab: [...state.lastNavUrlByTab.entries()]
    };
  }

  function buildTutorial(meta = {}) {
    if (!state.session) return null;
    const startedAt = state.session.startedAt;
    const endedAt = meta.endedAt || now();
    return {
      id: meta.tutorialId || newId("tut"),
      schemaVersion: 1,
      title: meta.title || state.session.title,
      description: meta.description || "Captured browser workflow",
      createdAt: startedAt,
      updatedAt: endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      steps: state.steps
    };
  }

  function reset() {
    state.session = null;
    state.steps = [];
    state.lastNavUrlByTab = new Map();
  }

  return {
    state, isRecording, isActive, uiState, startRecording, addTab, setPaused,
    setExcludedDomains, handleEvent, commitStep, addSystemStep, rehydrate,
    exportDraft, buildTutorial, reset
  };
}
