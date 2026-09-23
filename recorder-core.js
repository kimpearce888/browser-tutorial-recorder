import { makeId } from "./shared.js";

export const INTERNAL_URL_RE = /^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|view-source|file|moz-extension|extension):/i;

export const EVENTS_NEEDING_CURSOR = new Set([
  "CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "MIDDLE_CLICK", "DROP"
]);

export function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
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
      timestamp: now()
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

    if (event === "NAVIGATION") {
      const prev = state.lastNavUrlByTab.get(tabId) || "";
      if (prev === url) return { action: "ignored", reason: "nav-duplicate" };
      state.lastNavUrlByTab.set(tabId, url);
    }

    if (event === "DOUBLE_CLICK") {
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
    const evt = {
      event,
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
