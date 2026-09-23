import { dbPut, dbDelete, dbDeleteAll, dbGet, dbGetAll, dbGetAllSummaries, normalizeTutorial } from "./shared.js";
import { getSettings } from "./settings-store.js";

const SESSION_KEY = "activeSession";
const TAB_ACTIVATE_DELAY_MS = 80;

let fullPageCaptureInProgress = false;

chrome.storage?.onChanged?.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (changes["btr-excluded-domains"]) {
    await withSessionLock(async () => {
      const session = await getSession();

      if (!session || (session.status !== "recording" && session.status !== "paused")) return;
      const newDomains = Array.isArray(changes["btr-excluded-domains"].newValue) ? changes["btr-excluded-domains"].newValue : [];
      session.excludedDomains = newDomains;
      await saveSession(session);
      const settings = await getSettings();
      for (const tabId of session.tabIds) {
        await sendToTab(tabId, {
          type: "RECORDER_ATTACH",
          excludedDomains: newDomains,
          paused: session.status === "paused",
          settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
        });
      }
    });
  }

  if (changes["settings"]) {
    await withSessionLock(async () => {
      const session = await getSession();

      if (!session || (session.status !== "recording" && session.status !== "paused")) return;
      const settings = await getSettings();
      for (const tabId of session.tabIds) {
        await sendToTab(tabId, {
          type: "RECORDER_ATTACH",
          excludedDomains: session.excludedDomains || [],
          paused: session.status === "paused",
          settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
        });
      }
    });
  }
});

const MIN_CAPTURE_GAP_MS = 500;

const pendingEvents = new Map();

const pendingNewTabs = new Map();

const pendingClicks = new Map();
const CLICK_HOLD_MS = 150;

let captureQueue = Promise.resolve();
function serializeTransaction(fn) {
  const run = captureQueue.then(fn, () => fn());
  captureQueue = run.then(
    () => new Promise((r) => setTimeout(r, MIN_CAPTURE_GAP_MS)),
    () => new Promise((r) => setTimeout(r, MIN_CAPTURE_GAP_MS))
  );
  return run;
}

let sessionLock = Promise.resolve();
function withSessionLock(fn) {
  const run = sessionLock.then(fn, () => fn());
  sessionLock = run.then(() => undefined, () => undefined);
  return run;
}

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function saveSession(session) {
  session.updatedAt = Date.now();
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

function isValidPage(url) {

  return Boolean(url) && !/^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|file|moz-extension|extension):/i.test(url);
}

async function sendToTab(tabId, message, frameId, timeoutMs = 5000) {

  const options = frameId == null ? undefined : { frameId };

  const send = (opts) => new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
    const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };
    try {
      chrome.tabs.sendMessage(tabId, message, opts, (response) => {
        if (chrome.runtime.lastError) safeReject(new Error(chrome.runtime.lastError.message));
        else safeResolve(response);
      });
    } catch (e) {
      safeReject(e);
    }
  });
  const withTimeout = (p) => {

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("sendToTab timeout")), timeoutMs);
    });
    return Promise.race([
      p.finally(() => clearTimeout(timer)),
      timeout
    ]);
  };
  try {
    return await withTimeout(send(options));
  } catch {

    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
      return await withTimeout(send(options));
    } catch {
      return null;
    }
  }
}

function createSession(tab) {
  return {
    id: `session-${Date.now()}`,
    title: "Untitled browser tutorial",
    status: "recording",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    primaryTabId: tab.id,
    primaryWindowId: tab.windowId,
    tabIds: [tab.id],
    windowIds: [tab.windowId],
    excludedDomains: [],
    steps: []
  };
}

function sessionOwnsTab(session, tabId) {
  return session.tabIds.includes(tabId);
}

async function addTabToSession(session, tab) {
  if (!session || !tab?.id) return;

  await withSessionLock(async () => {
    const latest = await getSession();
    if (!latest || latest.id !== session.id) return;
    const target = latest;
    if (!target.tabIds.includes(tab.id)) target.tabIds.push(tab.id);
    if (tab.windowId != null && !target.windowIds.includes(tab.windowId)) {
      target.windowIds.push(tab.windowId);
    }
    await saveSession(target);
  });
}

async function captureVisibleTab(tab, format, quality) {

  const focusedWindows = await chrome.windows.getAll({ populate: false }).catch(() => []);
  const focusedWindow = focusedWindows.find((w) => w.focused);
  const activeTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const activeTab = activeTabs[0];
  const needsTabActivate = activeTab?.id && activeTab.id !== tab.id;
  const needsWindowFocus = !focusedWindow || focusedWindow.id !== tab.windowId;

  try {
    if (needsTabActivate) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (needsWindowFocus) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    if (needsTabActivate || needsWindowFocus) {
      await new Promise((r) => setTimeout(r, TAB_ACTIVATE_DELAY_MS));
    }

    const recheckTabs = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (recheckTabs[0]?.id && recheckTabs[0].id !== tab.id) {
      return { image: null, status: "FAILED" };
    }

    const fmt = format === "jpeg" ? "jpeg" : "png";
    const options = fmt === "jpeg" ? { format: "jpeg", quality: quality || 90 } : { format: "png" };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
    return { image: dataUrl, status: "OK" };
  } catch (error) {
    return { image: null, status: "FAILED", error: String(error?.message || error) };
  } finally {

    if (needsTabActivate && activeTab) {
      try { await chrome.tabs.update(activeTab.id, { active: true }); } catch (_) {}
    }
    if (needsWindowFocus && focusedWindow) {
      try { await chrome.windows.update(focusedWindow.id, { focused: true }); } catch (_) {}
    }
  }
}

async function prepareCapture(tabId, payload, frameId = 0) {

  const hideOk = await sendToTab(tabId, { type: "HIDE_STATUS" }, 0);
  if (hideOk === null) {
    throw new Error("Failed to hide recorder badge before capture.");
  }
  const prepareOk = await sendToTab(tabId, { type: "PREPARE_CAPTURE", ...payload }, frameId);
  if (prepareOk === null) {
    throw new Error("Failed to prepare capture overlay.");
  }

  const maskOk = await sendToTab(tabId, { type: "PREPARE_CAPTURE", ...payload, maskOnly: true }, null);
  if (maskOk === null) {
    throw new Error("Failed to mask sensitive fields in all frames.");
  }
  const { captureDelay } = await getSettings();
  await new Promise((r) => setTimeout(r, captureDelay));

  await sendToTab(tabId, { type: "REFRESH_MASKS" }, null).catch(() => {});
}

async function finishCapture(tabId, frameId = 0) {
  await sendToTab(tabId, { type: "CLEAR_CAPTURE" }, frameId);

  await sendToTab(tabId, { type: "CLEAR_CAPTURE" }, null);
  const session = await getSession();
  if (session?.status === "recording") {
    await sendToTab(tabId, { type: "SHOW_STATUS", count: session.steps.length }, 0);
  } else {

    await sendToTab(tabId, { type: "HIDE_STATUS" }, 0).catch(() => {});
  }
}

async function getLightweightSession() {
  const session = await getSession();
  if (!session) return null;

  return {
    id: session.id,
    title: session.title,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    totalPausedMs: session.totalPausedMs || 0,
    primaryTabId: session.primaryTabId,
    primaryWindowId: session.primaryWindowId,
    tabIds: session.tabIds,
    windowIds: session.windowIds,
    excludedDomains: session.excludedDomains,
    steps: session.steps.map((s) => ({
      id: s.id,
      number: s.number,
      action: s.action,
      description: s.description

    }))
  };
}

async function recordEvent(message, sender) {

  if (!message || typeof message.event !== "string") return { ok: false };
  const session = await getSession();
  if (!session || session.status !== "recording") return { ok: false };

  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };

  if (!sessionOwnsTab(session, tabId)) return { ok: false };

  const sessionId = session.id;

  if (message.event === "CLICK") {
    return recordClickWithDedup(message, sender, tabId, sessionId);
  }

  if (message.event === "DOUBLE_CLICK") {
    return recordDoubleClickWithRetract(message, sender, tabId, sessionId);
  }

  if (message.event === "SUBMIT") {
    return recordSubmitWithRetract(message, sender, tabId, sessionId);
  }

  if (message.event === "NAVIGATION" || message.event === "NEW_TAB" || message.event === "NEW_WINDOW") {
    flushPendingClicksForTab(tabId);
  }

  const current = await getSession();
  if (!current || current.status !== "recording") return { ok: false };

  const ts = Math.floor(Date.now() / 100);
  const frameId = sender?.frameId ?? 0;
  const key = `${message.event}|${tabId}|${frameId}|${message.target?.selectors?.[0] || message.target?.tag || ""}|${Math.round(message.target?.boundingBox?.x || 0)}|${Math.round(message.target?.boundingBox?.y || 0)}|${message.url || ""}|${ts}`;
  if (pendingEvents.has(key)) return pendingEvents.get(key);

  const promise = withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId)).finally(() => pendingEvents.delete(key));
  promise._ts = Date.now();
  pendingEvents.set(key, promise);

  if (pendingEvents.size > 200) {
    const now = Date.now();
    for (const [k, p] of pendingEvents) {
      if (p._ts && now - p._ts > 60000) {
        pendingEvents.delete(k);
      }
    }
    if (pendingEvents.size > 500) {

      const sorted = [...pendingEvents.entries()].sort((a, b) => (a[1]._ts || 0) - (b[1]._ts || 0));
      for (let i = 0; i < 100 && i < sorted.length; i++) {
        pendingEvents.delete(sorted[i][0]);
      }
    }
  }
  return promise;
}

async function recordClickWithDedup(message, sender, tabId, sessionId) {
  const key = clickDedupKey(message, sender, tabId);

  const pending = pendingClicks.get(key);
  if (pending) {

    clearTimeout(pending.timer);
    pendingClicks.delete(key);

    const dblMessage = {
      ...pending.message,
      event: "DOUBLE_CLICK",
      description: pending.message.doubleClickDescription || `Double-click ${pending.message.target?.text || "the element"}.`,

      cursor: message.cursor || pending.message.cursor
    };

    const resultPromise = withSessionLock(() => doRecordEvent(dblMessage, sender, tabId, pending.sessionId));

    resultPromise.then(pending.resolveRef, pending.rejectRef);
    return resultPromise;
  }

  let resolveRef, rejectRef;
  const outerPromise = new Promise((res, rej) => { resolveRef = res; rejectRef = rej; });

  const timer = setTimeout(() => {
    pendingClicks.delete(key);

    withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId))
      .then(resolveRef, rejectRef);
  }, CLICK_HOLD_MS);

  pendingClicks.set(key, { message, sender, tabId, timer, resolveRef, rejectRef, sessionId });
  return outerPromise;
}

function clickDedupKey(message, sender, tabId) {
  const sel = message.target?.selectors?.[0] || message.target?.tag || "";
  const x = Math.round(message.target?.boundingBox?.x || 0);
  const y = Math.round(message.target?.boundingBox?.y || 0);
  const frameId = sender?.frameId ?? 0;
  return `${tabId}|${frameId}|${sel}|${x}|${y}`;
}

function flushPendingClicksForTab(tabId) {
  const entries = [];
  for (const [key, pending] of pendingClicks) {
    if (pending.tabId === tabId) entries.push({ key, pending });
  }
  for (const { key, pending } of entries) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);

    withSessionLock(() => doRecordEvent(pending.message, pending.sender, pending.tabId, pending.sessionId))
      .then(pending.resolveRef, pending.rejectRef);
  }
}

async function recordDoubleClickWithRetract(message, sender, tabId, sessionId) {
  const key = clickDedupKey(message, sender, tabId);

  const pending = pendingClicks.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);
  }

  const result = await withSessionLock(async () => {
    const session = await getSession();
    if (session && session.status === "recording" && session.steps.length > 0) {
      const target = message.target || {};
      const sel = target.selectors?.[0] || target.tag || "";
      const bbox = target.boundingBox || {};
      const clickFrameId = sender?.frameId ?? 0;
      for (let i = session.steps.length - 1; i >= 0 && i >= session.steps.length - 5; i--) {
        const step = session.steps[i];
        if (step.action !== "CLICK") continue;
        const stepFrameId = step.frame?.id ?? 0;
        if (stepFrameId !== clickFrameId) continue;
        const stepSel = step.target?.selectors?.[0] || step.target?.tag || "";
        const stepBbox = step.target?.boundingBox || {};
        const sameElement = (sel && stepSel === sel) ||
          (Math.abs((stepBbox.x || 0) - (bbox.x || 0)) < 5 && Math.abs((stepBbox.y || 0) - (bbox.y || 0)) < 5);
        if (!sameElement) continue;
        const stepTime = step.screenshot?.timestamp || 0;
        if (Date.now() - stepTime > 1000) continue;
        session.steps.splice(i, 1);
        for (let j = i; j < session.steps.length; j++) session.steps[j].number = j + 1;
        await saveSession(session);
        break;
      }
    }
    return doRecordEvent(message, sender, tabId, sessionId);
  });

  if (pending) {
    try { pending.resolveRef(result); } catch (_) {  }
  }

  return result;
}

async function recordSubmitWithRetract(message, sender, tabId, sessionId) {

  const submitTarget = message.target || {};
  const submitSel = submitTarget.selectors?.[0] || submitTarget.tag || "";
  const submitBbox = submitTarget.boundingBox || {};

  const matchesSubmitTarget = (clickStep) => {
    if (clickStep.action !== "CLICK") return false;
    const clickTarget = clickStep.target || {};
    const clickSel = clickTarget.selectors?.[0] || clickTarget.tag || "";
    const clickBbox = clickTarget.boundingBox || {};

    if (submitSel && clickSel && submitSel === clickSel) return true;

    if (Math.abs((clickBbox.x || 0) - (submitBbox.x || 0)) < 5 &&
        Math.abs((clickBbox.y || 0) - (submitBbox.y || 0)) < 5) return true;

    const submitText = (submitTarget.text || "").toLowerCase().trim();
    const clickText = (clickTarget.text || "").toLowerCase().trim();
    if (submitText && clickText && submitText === clickText) return true;
    return false;
  };

  const cancelledClicks = [];
  for (const [key, pending] of pendingClicks) {
    if (pending.tabId !== tabId) continue;

    const pseudoStep = { action: "CLICK", target: pending.message.target };
    if (matchesSubmitTarget(pseudoStep)) {
      clearTimeout(pending.timer);
      pendingClicks.delete(key);
      cancelledClicks.push(pending);
    }
  }

  const submitFrameId = sender?.frameId ?? 0;
  await withSessionLock(async () => {
    const session = await getSession();
    if (!session || session.status !== "recording" || session.steps.length === 0) return;

    for (let i = session.steps.length - 1; i >= 0 && i >= session.steps.length - 5; i--) {
      const step = session.steps[i];
      if (step.action !== "CLICK") continue;

      const stepFrameId = step.frame?.id ?? 0;
      if (stepFrameId !== submitFrameId) continue;
      if (!matchesSubmitTarget(step)) continue;

      const stepTime = step.screenshot?.timestamp || 0;
      if (Date.now() - stepTime > 1500) continue;

      session.steps.splice(i, 1);

      for (let j = i; j < session.steps.length; j++) {
        session.steps[j].number = j + 1;
      }
      await saveSession(session);
      break;
    }
  });

  const result = await withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId));

  for (const pending of cancelledClicks) {
    try { pending.resolveRef(result); } catch (_) {  }
  }

  return result;
}

async function doRecordEvent(message, sender, tabId, expectedSessionId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false };

  if (fullPageCaptureInProgress) return { ok: false, skipped: "full_page_capture_in_progress" };

  if (expectedSessionId) {
    const current = await getSession();
    if (!current || current.id !== expectedSessionId) {
      return { ok: false, stale: true };
    }
  }

  const target = message.target || null;
  const showCursor = message.event !== "NAVIGATION" && message.event !== "NEW_TAB" && message.event !== "NEW_WINDOW";
  const frameId = sender.frameId || 0;
  const settings = await getSettings();

  let frameTransform = message.frameTransform || null;

  if (!frameTransform && frameId !== 0 && (message.frameNonce || message.url)) {
    try {
      const response = await sendToTab(tabId, {
        type: "GET_IFRAME_OFFSET",
        nonce: message.frameNonce,
        url: message.url
      }, 0, 1500);
      if (response?.ok && response.offset) {
        frameTransform = { offsetX: response.offset.x, offsetY: response.offset.y, scale: 1 };
      }
    } catch (_) {  }
  }

  const transform = frameTransform || { offsetX: 0, offsetY: 0, scale: 1 };

  const tx = transform.offsetX || 0;
  const ty = transform.offsetY || 0;
  const sx = transform.scaleX || transform.scale || 1;
  const sy = transform.scaleY || transform.scale || 1;
  const applyTransform = (point) => point ? {
    x: tx + sx * point.x,
    y: ty + sy * point.y
  } : point;
  const applyTransformBox = (box) => box ? {
    ...box,
    x: tx + sx * box.x,
    y: ty + sy * box.y,
    width: sx * box.width,
    height: sy * box.height
  } : box;
  const storedTarget = target ? {
    ...target,
    point: applyTransform(target.point),
    boundingBox: applyTransformBox(target.boundingBox)
  } : target;
  const storedCursor = message.cursor ? {
    ...message.cursor,
    x: tx + sx * message.cursor.x,
    y: ty + sy * message.cursor.y
  } : message.cursor;

  const result = await serializeTransaction(async () => {

    try {
      await prepareCapture(tabId, {
        point: target?.point || null,
        boundingBox: target?.boundingBox || null,
        action: message.event,
        showCursor: showCursor && Boolean(target?.point)
      }, frameId);

      const screenshot = await captureVisibleTab(tab, settings.screenshotFormat, settings.screenshotQuality);

      if (!screenshot?.image) {
        return { ok: false, error: screenshot?.error || "Screenshot capture failed. The tab may have been closed or backgrounded." };
      }

      let session = await getSession();
      if (!session || session.status !== "recording") {
        return { ok: false };
      }

      const step = {
        id: `step-${crypto.randomUUID()}`,
        number: session.steps.length + 1,
        action: message.event,
        description: message.description,
        target: storedTarget,
        frame: { id: frameId, url: message.url || "", isTop: frameId === 0 },
        screenshot: {
          image: screenshot.image,
        status: screenshot.status,
        width: frameId === 0 ? (message.viewport?.width || 0) : (message.viewport?.width || message.topLevelViewport?.width || 0),
        height: frameId === 0 ? (message.viewport?.height || 0) : (message.viewport?.height || message.topLevelViewport?.height || 0),
        devicePixelRatio: message.viewport?.devicePixelRatio || 1,
        url: message.url || "",
        timestamp: Date.now()
      },
      annotations: []
    };

    if (storedCursor) step.cursor = storedCursor;

    if ((tx || ty) || (sx !== 1 || sy !== 1)) {
      step.frameTransform = { offsetX: tx, offsetY: ty, scaleX: sx, scaleY: sy, scale: transform.scale };
    }

    session.steps.push(step);
    await saveSession(session);

    return { ok: true, stepNumber: step.number };
    } finally {

      await finishCapture(tabId, frameId);
    }
  });

  return result;
}

async function _finalizeSessionLocked(session) {
  if (!session) return null;

  if (session.finalizedTutorialId) {
    const existing = await dbGet(session.finalizedTutorialId).catch(() => null);
    if (existing) {
      await chrome.storage.local.remove(SESSION_KEY);
      pendingNewTabs.clear();
      pendingNavUrls.clear();
      lastNavUrlByTab.clear();
      await persistLastNavUrls().catch(() => {});
      await persistPendingNewTabs().catch(() => {});
      return existing;
    }
    const tutorial = {
      id: session.finalizedTutorialId,
      version: 4,
      title: session.title,
      description: "Captured browser workflow",
      status: "draft",
      isDemo: false,
      createdAt: new Date(session.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      steps: session.steps.map((step, index) => ({ ...step, number: index + 1 }))
    };
    try {
      await dbPut(tutorial);
    } catch (e) {
      console.error("[BTR] Failed to save tutorial on recovery:", e);
      return null;
    }
    await chrome.storage.local.remove(SESSION_KEY);
    pendingNewTabs.clear();
    pendingNavUrls.clear();
    lastNavUrlByTab.clear();
    await persistLastNavUrls().catch(() => {});
    await persistPendingNewTabs().catch(() => {});
    return tutorial;
  }

  const tabIds = [...new Set([session.primaryTabId, ...session.tabIds])].filter(Boolean);
  await Promise.all(tabIds.map((tabId) => sendToTab(tabId, { type: "RECORDER_STOP" })));

  const tutorial = {
    id: `tutorial-${crypto.randomUUID()}`,
    version: 4,
    title: session.title,
    description: "Captured browser workflow",
    status: "draft",
    isDemo: false,
    createdAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    steps: session.steps.map((step, index) => ({ ...step, number: index + 1 }))
  };

  session.finalizedTutorialId = tutorial.id;
  await saveSession(session);
  await dbPut(tutorial);
  await chrome.storage.local.remove(SESSION_KEY);
  pendingNewTabs.clear();
  pendingNavUrls.clear();
  lastNavUrlByTab.clear();
  await persistLastNavUrls().catch(() => {});
  await persistPendingNewTabs().catch(() => {});
  return tutorial;
}

async function stopSession() {
  flushAllPendingClicks();
  return withSessionLock(async () => {
    const session = await getSession();
    return _finalizeSessionLocked(session);
  });
}

function flushAllPendingClicks() {
  for (const [key, pending] of pendingClicks) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);

    withSessionLock(() => doRecordEvent(pending.message, pending.sender, pending.tabId, pending.sessionId))
      .then(pending.resolveRef, pending.rejectRef);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_STATE":

      return { session: await getLightweightSession() };

    case "START_RECORDING": {

      return await withSessionLock(async () => {
        const existing = await getSession();
        if (existing) {

          await _finalizeSessionLocked(existing);
        }

        let tab;
        if (message.tabId) {
          tab = await chrome.tabs.get(message.tabId).catch(() => null);
        } else {
          tab = await currentTab();
        }
        if (!tab?.id || !isValidPage(tab.url)) {
          return { ok: false, error: "This page cannot be recorded by Chrome." };
        }

        const rechecked = await getSession();
        if (rechecked) {
          return { ok: false, error: "A recording is still being finalized. Please try again." };
        }

        const settings = await getSettings();
        const session = createSession(tab);
        session.excludedDomains = Array.isArray(message.excludedDomains) ? message.excludedDomains : [];
        await saveSession(session);

        const ack = await sendToTab(tab.id, {
          type: "RECORDER_START",
          excludedDomains: session.excludedDomains,
          sessionId: session.id,
          settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
        });
        if (!ack) {
          await chrome.storage.local.remove(SESSION_KEY).catch(() => {});
          return { ok: false, error: "Could not attach recorder to this tab. Try reloading the page." };
        }
        return { ok: true, session };
      });
    }

    case "CAPTURE_FULL_PAGE": {

      if (!message.tabId) return { ok: false, error: "No tab specified." };

      if (fullPageCaptureInProgress) return { ok: false, error: "A full-page capture is already in progress. Please wait for it to finish." };
      fullPageCaptureInProgress = true;
      const targetTab = await chrome.tabs.get(message.tabId).catch(() => null);
      if (!targetTab) { fullPageCaptureInProgress = false; return { ok: false, error: "Tab not found." }; }
      if (!isValidPage(targetTab.url)) { fullPageCaptureInProgress = false; return { ok: false, error: "This page cannot be captured." }; }

      const editorTabId = sender.tab?.id;
      const editorWindowId = sender.tab?.windowId;

      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));

      let result;
      try {
        result = await captureFullPage(targetTab);
      } finally {
        fullPageCaptureInProgress = false;
        if (editorTabId) {
          await chrome.tabs.update(editorTabId, { active: true }).catch(() => {});
          if (editorWindowId) await chrome.windows.update(editorWindowId, { focused: true }).catch(() => {});
        }
      }

      if (Array.isArray(result)) {
        return { ok: true, captures: result, nestedCaptures: [], truncated: false, captureError: null };
      }
      const captureError = result.captureError || null;
      return {
        ok: !captureError,
        captures: result.captures || [],
        nestedCaptures: result.nestedCaptures || [],
        truncated: result.truncated === true,
        captureError
      };
    }

    case "PAUSE_RECORDING":
    case "RESUME_RECORDING": {

      return withSessionLock(async () => {
        const session = await getSession();
        if (!session) return { ok: false, error: "No active recording." };
        if (message.type === "PAUSE_RECORDING" && session.status === "recording") {
          session.status = "paused";
          session.pausedAt = Date.now();
        } else if (message.type === "RESUME_RECORDING" && session.status === "paused") {
          if (session.pausedAt) {
            session.totalPausedMs = (session.totalPausedMs || 0) + (Date.now() - session.pausedAt);
            session.pausedAt = 0;
          }
          session.status = "recording";
        }
        await saveSession(session);
        const note = message.type === "PAUSE_RECORDING" ? "RECORDER_PAUSE" : "RECORDER_RESUME";
        for (const tabId of session.tabIds) {
          await sendToTab(tabId, { type: note });
        }
        return { ok: true, session };
      });
    }

    case "STOP_RECORDING": {
      const tutorial = await stopSession();
      return tutorial ? { ok: true, tutorial } : { ok: false, error: "No active recording." };
    }

    case "DISCARD_RECORDING": {

      for (const [, pending] of pendingClicks) {
        clearTimeout(pending.timer);

        try { pending.resolveRef({ ok: false, discarded: true }); } catch (_) {  }
      }
      pendingClicks.clear();
      return withSessionLock(async () => {
        const session = await getSession();
        if (!session) return { ok: false, error: "No active recording." };
        const tabIds = [...new Set([session.primaryTabId, ...session.tabIds])].filter(Boolean);
        await Promise.all(tabIds.map((tabId) => sendToTab(tabId, { type: "RECORDER_STOP" })));
        await chrome.storage.local.remove(SESSION_KEY);
        pendingNewTabs.clear();
        lastNavUrlByTab.clear();
        await persistLastNavUrls().catch(() => {});
        await persistPendingNewTabs().catch(() => {});
        return { ok: true };
      });
    }

    case "RECORD_EVENT":
      return recordEvent(message, sender);

    case "GET_TUTORIALS":
      return { tutorials: await dbGetAll() };

    case "GET_TUTORIALS_SUMMARY": {

      const summaries = await dbGetAllSummaries();
      return { tutorials: summaries };
    }

    case "GET_TUTORIAL": {

      const tutorial = await dbGet(message.id);
      return { tutorial: tutorial || null };
    }

    case "SAVE_TUTORIAL":

      if (message.tutorial) {
        try { await dbPut(normalizeTutorial(message.tutorial)); }
        catch (e) { return { ok: false, error: String(e?.message || e) }; }
      }
      return { ok: true };

    case "DUPLICATE_TUTORIAL": {
      if (!message.id) return { ok: false, error: "Missing tutorial id." };

      const source = await dbGet(message.id);
      if (!source) return { ok: false, error: "Tutorial not found." };

      const normalizedSource = normalizeTutorial(source);
      const copy = {
        ...JSON.parse(JSON.stringify(normalizedSource)),
        id: `tutorial-${crypto.randomUUID()}`,
        title: `${normalizedSource.title} (copy)`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await dbPut(copy);
      return { ok: true, tutorial: copy };
    }

    case "DELETE_TUTORIAL":
      if (message.id) await dbDelete(message.id);

      chrome.runtime.sendMessage({ type: "TUTORIALS_CHANGED" }).catch(() => {});
      return { ok: true };

    case "DELETE_TUTORIALS": {
      const ids = Array.isArray(message.ids) ? message.ids : [];

      try {
        const deleted = await dbDeleteAll(ids);
        chrome.runtime.sendMessage({ type: "TUTORIALS_CHANGED" }).catch(() => {});
        return { ok: true, deleted };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }

    case "PAUSE_FROM_IDLE": {

      return withSessionLock(async () => {
        const session = await getSession();
        if (!session || session.status !== "recording") return { ok: false };
        session.status = "paused";
        await saveSession(session);
        for (const tabId of session.tabIds) await sendToTab(tabId, { type: "RECORDER_PAUSE" });
        return { ok: true };
      });
    }

    default:
      return { ok: false, error: "Unknown message type." };
  }
}

chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    const session = await getSession();

    if (!session || !tab.id) return;

    if (!tab.openerTabId || !session.tabIds.includes(tab.openerTabId)) return;

  const isNewWindow = tab.windowId != null && !session.windowIds.includes(tab.windowId);
  await addTabToSession(session, tab);

  await withSessionLock(async () => {
    const currentSession = await getSession();

    if (!currentSession || currentSession.id !== session.id) return;

    const kind = isNewWindow ? "NEW_WINDOW" : "NEW_TAB";
    pendingNewTabs.set(tab.id, kind);
    await persistPendingNewTabs();

    if (isValidPage(tab.url)) {
      const settings = await getSettings();
      await sendToTab(tab.id, {
        type: "RECORDER_ATTACH",
        excludedDomains: currentSession.excludedDomains || [],
        paused: currentSession.status === "paused",
        settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
      });
    }
  });
  } catch (e) { console.warn("[BTR] onCreated handler failed:", e); }
});

const lastNavUrlByTab = new Map();

const pendingNavUrls = new Map();

async function persistLastNavUrls() {
  try {
    await chrome.storage.session.set({ lastNavUrls: [...lastNavUrlByTab] });
  } catch (_) {}
}

try {
  chrome.storage.session.get("lastNavUrls", (result) => {
    if (result?.lastNavUrls && Array.isArray(result.lastNavUrls)) {
      for (const [tabId, url] of result.lastNavUrls) lastNavUrlByTab.set(tabId, url);
    }
  });
} catch (_) {}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {

  try {

  await withSessionLock(async () => {
    const session = await getSession();
    if (!session || !session.tabIds.includes(tabId)) return;

    const pendingNavUrl = pendingNavUrls.get(tabId);
    if (changeInfo.url && changeInfo.status === "loading") {

      pendingNavUrls.set(tabId, changeInfo.url);
      return;
    }
    if (changeInfo.url && changeInfo.status !== "complete" && !pendingNavUrl) {

      if (!isValidPage(changeInfo.url)) {
        pendingNewTabs.delete(tabId);
        lastNavUrlByTab.delete(tabId); persistLastNavUrls();
        await persistPendingNewTabs();
        return;
      }
      const lastUrl = lastNavUrlByTab.get(tabId);
      if (lastUrl !== changeInfo.url && !pendingNewTabs.has(tabId)) {

        await new Promise((r) => setTimeout(r, 200));
        await sendToTab(tabId, { type: "RECORDER_NAVIGATION", url: changeInfo.url });
        lastNavUrlByTab.set(tabId, changeInfo.url); persistLastNavUrls();
      }
      return;
    }

    if (changeInfo.status !== "complete") return;

    if (pendingNavUrl) {
      pendingNavUrls.delete(tabId);
      if (isValidPage(pendingNavUrl)) {
        const lastUrl = lastNavUrlByTab.get(tabId);
        if (lastUrl !== pendingNavUrl && !pendingNewTabs.has(tabId)) {
          await sendToTab(tabId, { type: "RECORDER_NAVIGATION", url: pendingNavUrl });
          lastNavUrlByTab.set(tabId, pendingNavUrl); persistLastNavUrls();
        }
      }
    }

    if (!isValidPage(tab.url)) {
      pendingNewTabs.delete(tabId);
      lastNavUrlByTab.delete(tabId); persistLastNavUrls();
      await persistPendingNewTabs();
      return;
    }

    const settings = await getSettings();
    await sendToTab(tabId, {
      type: "RECORDER_ATTACH",
      excludedDomains: session.excludedDomains || [],
      paused: session.status === "paused",
      settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
    });

    if (pendingNewTabs.has(tabId)) {
      const kind = pendingNewTabs.get(tabId);
      pendingNewTabs.delete(tabId);
      lastNavUrlByTab.delete(tabId); persistLastNavUrls();
      await persistPendingNewTabs();
      await sendToTab(tabId, { type: kind === "NEW_WINDOW" ? "RECORDER_NEW_WINDOW" : "RECORDER_NEW_TAB", url: tab.url });
      lastNavUrlByTab.set(tabId, tab.url); persistLastNavUrls();
    } else {
      const lastUrl = lastNavUrlByTab.get(tabId);
      if (lastUrl !== tab.url) {
        await sendToTab(tabId, { type: "RECORDER_NAVIGATION", url: tab.url });
        lastNavUrlByTab.set(tabId, tab.url); persistLastNavUrls();
      }
    }
  });
  } catch (e) { console.warn("[BTR] onUpdated handler failed:", e); }
});

async function captureFullPage(tab) {

  const captures = [];
  const nestedCaptures = [];
  let viewportHeight = 720;
  let docHeight = viewportHeight;
  let originalScrollY = 0;
  try {
    const [vpResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [window.innerHeight, document.documentElement.scrollHeight, window.scrollY]
    });
    if (Array.isArray(vpResult?.result)) {
      [viewportHeight, docHeight, originalScrollY] = vpResult.result;
    }
  } catch (e) {  }

  await sendToTab(tab.id, { type: "CAPTURE_SCROLL_START" }, null).catch(() => {});

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(r => setTimeout(r, 500));
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 300));
        const imgs = [...document.images];
        await Promise.all(imgs.map(img => {
          if (img.complete) return Promise.resolve();
          return new Promise(r => { img.onload = img.onerror = r; });
        }));
      }
    });
  } catch (e) {  }

  try {
    const [dhResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.scrollHeight
    });
    if (typeof dhResult?.result === "number") docHeight = dhResult.result;
  } catch (e) {  }

  await sendToTab(tab.id, { type: "HIDE_STATUS" }, 0).catch(() => {});

  await sendToTab(tab.id, {
    type: "PREPARE_CAPTURE",
    maskOnly: true,
    point: null,
    boundingBox: null,
    action: "FULL_PAGE",
    showCursor: false
  }, null).catch(() => {});

  const fpSettings = await getSettings();
  await new Promise((r) => setTimeout(r, Math.max(50, fpSettings.captureDelay || 220)));
  await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {

        const hidden = [];
        const visit = (root, label) => {
          if (!root) return;

          const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
          for (const el of allEls) {

            if (!el.style) continue;
            const style = getComputedStyle(el);
            if ((style.position === "fixed" || style.position === "sticky") && el !== document.body) {
              hidden.push({ el, visibility: el.style.visibility, label });
              el.style.visibility = "hidden";
            }

            if (el.shadowRoot) {
              visit(el.shadowRoot, `${label} > #shadow-root`);
            }

            if (el.tagName === "IFRAME") {
              try {
                const doc = el.contentDocument;
                if (doc) visit(doc, `${label} > iframe`);
              } catch (_) {  }
            }
          }
        };
        visit(document, "document");
        window.__btr_hidden_fixed = hidden;
      }
    });
  } catch (_) {  }

  await sendToTab(tab.id, { type: "HIDE_FIXED_ELEMENTS" }, null).catch(() => {});

  let truncated = false;

  try {
    const step = Math.max(100, Math.floor(viewportHeight * 0.7));
    let safetyCounter = 0;

    const MAX_CAPTURES = 200;
    const NO_PROGRESS_WAIT_MS = 800;
    const NO_PROGRESS_THRESHOLD = 3;
    let lastScrollY = -1;
    let lastDocHeight = docHeight;
    let noProgressCount = 0;
    for (let y = 0; y <= docHeight && safetyCounter < MAX_CAPTURES; y += step, safetyCounter++) {
      let actualY = y;
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },

          func: (yVal) => {
            const html = document.documentElement;
            const origBehavior = html.style.scrollBehavior;
            html.style.scrollBehavior = "auto";
            window.scrollTo(0, yVal);
            const sy = window.scrollY;
            html.style.scrollBehavior = origBehavior;
            return sy;
          },
          args: [y]
        });
        if (typeof result?.[0]?.result === "number") actualY = result[0].result;
      } catch (e) { break; }

      if (actualY === lastScrollY) {

        await new Promise((r) => setTimeout(r, NO_PROGRESS_WAIT_MS));

        try {
          const [dhResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.scrollHeight
          });
          if (typeof dhResult?.result === "number") {
            docHeight = Math.max(docHeight, dhResult.result);
          }
        } catch (_) {  }
        if (docHeight > lastDocHeight) {

          noProgressCount = 0;
          lastDocHeight = docHeight;

        } else {
          noProgressCount++;
          if (noProgressCount >= NO_PROGRESS_THRESHOLD) break;

          lastScrollY = actualY;
          continue;
        }
      } else {
        noProgressCount = 0;
      }
      lastScrollY = actualY;
      await new Promise((r) => setTimeout(r, 350));

      await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});
      const shot = await serializeTransaction(() => captureVisibleTab(tab, "png"));

      if (!shot.image) {
        return { captures, nestedCaptures: [], truncated: false, captureError: shot.error || "Screenshot capture failed during full-page capture." };
      }
      captures.push({ image: shot.image, scrollY: actualY, viewportHeight });

      try {
        const [dhResult] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.scrollHeight
        });
        if (typeof dhResult?.result === "number") {
          docHeight = Math.max(docHeight, dhResult.result);
          lastDocHeight = docHeight;
        }
      } catch (_) {  }
    }

    {

      try {
        const [finalCheck] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({ scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight })
        });
        const finalScrollY = finalCheck?.result?.scrollY ?? 0;
        const finalScrollHeight = finalCheck?.result?.scrollHeight ?? docHeight;
        if (finalScrollY + viewportHeight < finalScrollHeight - 10) {
          truncated = true;
          console.warn(`[Browser Tutorial Recorder] Full-page capture truncated: page is ${finalScrollHeight}px tall but only ~${finalScrollY + viewportHeight}px was captured.`);
        }
      } catch (_) {  }
    }
  } finally {

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scrollY) => window.scrollTo(0, scrollY),
        args: [originalScrollY]
      });
    } catch (e) {  }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (window.__btr_hidden_fixed) {
            for (const { el, visibility } of window.__btr_hidden_fixed) {
              try { el.style.visibility = visibility; } catch (_) {  }
            }
            delete window.__btr_hidden_fixed;
          }
        }
      });
    } catch (_) {  }

    await sendToTab(tab.id, { type: "RESTORE_FIXED_ELEMENTS" }, null).catch(() => {});

    await sendToTab(tab.id, { type: "CLEAR_CAPTURE" }, null).catch(() => {});

    const session = await getSession();
    if (session?.status === "recording") {
      await sendToTab(tab.id, { type: "SHOW_STATUS", count: session.steps.length }, 0).catch(() => {});
    }
  }

  try {

    await sendToTab(tab.id, { type: "HIDE_STATUS" }, 0).catch(() => {});

    await sendToTab(tab.id, {
      type: "PREPARE_CAPTURE",
      maskOnly: true,
      point: null,
      boundingBox: null,
      action: "FULL_PAGE_NESTED",
      showCursor: false
    }, null).catch(() => {});
    await new Promise((r) => setTimeout(r, Math.max(50, fpSettings.captureDelay || 220)));
    await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});

    await sendToTab(tab.id, { type: "HIDE_FIXED_ELEMENTS" }, null).catch(() => {});
    const [nestedResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const candidates = [];
        let counter = 0;

        const visit = (root, offsetX, offsetY, scaleX, scaleY) => {
          if (!root || !root.querySelectorAll) return;
          const all = root.querySelectorAll("*");
          for (const el of all) {
            if (!el.style) continue;
            const style = getComputedStyle(el);
            if (style.overflowY === "auto" || style.overflowY === "scroll") {
              if (el.clientHeight <= 0 || el.scrollHeight <= el.clientHeight + 4) continue;
              const localRect = el.getBoundingClientRect();
              if (localRect.width < 200 || localRect.height < 200) continue;
              if (el === document.scrollingElement || el === document.documentElement || el === document.body) continue;
              const scrollerId = `btr-scroller-${Date.now()}-${counter++}`;
              el.setAttribute("data-btr-scroller-id", scrollerId);

              const topX = offsetX + scaleX * localRect.left;
              const topY = offsetY + scaleY * localRect.top;
              const topW = scaleX * localRect.width;
              const topH = scaleY * localRect.height;
              candidates.push({
                scrollerId,
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                rect: { x: topX, y: topY, width: topW, height: topH }
              });
            }

            if (el.shadowRoot) visit(el.shadowRoot, offsetX, offsetY, scaleX, scaleY);

            if (el.tagName === "IFRAME") {
              try {
                const doc = el.contentDocument;
                if (doc) {
                  const iframeRect = el.getBoundingClientRect();

                  visit(doc, offsetX + scaleX * iframeRect.left, offsetY + scaleY * iframeRect.top, scaleX, scaleY);
                }
              } catch (_) {  }
            }
          }
        };
        visit(document, 0, 0, 1, 1);
        return candidates.slice(0, 5);
      }
    });
    const nestedScrollers = Array.isArray(nestedResult?.result) ? nestedResult.result : [];

    for (const scroller of nestedScrollers) {

      const scrollerSequence = [];
      const nestedStep = Math.max(100, Math.floor(scroller.clientHeight * 0.7));

      let nestedMax = Math.min(20, Math.ceil(scroller.scrollHeight / nestedStep));
      try {
        for (let i = 0; i < nestedMax; i++) {
          const yTarget = i * nestedStep;

          const scrollResult = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (scrollerId, yVal) => {
              const findScroller = (root, id) => {
                if (!root || !root.querySelectorAll) return null;
                const el = root.querySelector(`[data-btr-scroller-id="${id}"]`);
                if (el) return el;
                for (const e of root.querySelectorAll("*")) {
                  if (e.shadowRoot) { const f = findScroller(e.shadowRoot, id); if (f) return f; }
                  if (e.tagName === "IFRAME") {
                    try { const f = findScroller(e.contentDocument, id); if (f) return f; } catch (_) {}
                  }
                }
                return null;
              };
              const el = findScroller(document, scrollerId);
              if (!el) return yVal;
              const origBehavior = el.style.scrollBehavior;
              el.style.scrollBehavior = "auto";
              el.scrollTop = yVal;
              const actualY = el.scrollTop;
              el.style.scrollBehavior = origBehavior;
              return actualY;
            },
            args: [scroller.scrollerId, yTarget]
          });
          const actualNestedY = typeof scrollResult?.[0]?.result === "number" ? scrollResult[0].result : yTarget;
          await new Promise((r) => setTimeout(r, 250));

          await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});
          const shot = await serializeTransaction(() => captureVisibleTab(tab, "png"));
          if (shot.image) scrollerSequence.push({ image: shot.image, scrollY: actualNestedY, viewportHeight: scroller.clientHeight });

          try {
            const [recheck] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (scrollerId) => {
                const findScroller = (root, id) => {
                  if (!root || !root.querySelectorAll) return null;
                  const el = root.querySelector(`[data-btr-scroller-id="${id}"]`);
                  if (el) return el;
                  for (const e of root.querySelectorAll("*")) {
                    if (e.shadowRoot) { const f = findScroller(e.shadowRoot, id); if (f) return f; }
                    if (e.tagName === "IFRAME") {
                      try { const f = findScroller(e.contentDocument, id); if (f) return f; } catch (_) {}
                    }
                  }
                  return null;
                };
                const el = findScroller(document, scrollerId);
                return el ? el.scrollHeight : 0;
              },
              args: [scroller.scrollerId]
            });
            const currentScrollHeight = typeof recheck?.result === "number" ? recheck.result : 0;
            if (currentScrollHeight > scroller.scrollHeight) {
              scroller.scrollHeight = currentScrollHeight;
              nestedMax = Math.min(20, Math.ceil(currentScrollHeight / nestedStep));
            }
          } catch (_) {  }
        }
      } catch (_) {  }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (scrollerId, yVal) => {
            const findScroller = (root, id) => {
              if (!root || !root.querySelectorAll) return null;
              const el = root.querySelector(`[data-btr-scroller-id="${id}"]`);
              if (el) return el;
              for (const e of root.querySelectorAll("*")) {
                if (e.shadowRoot) { const f = findScroller(e.shadowRoot, id); if (f) return f; }
                if (e.tagName === "IFRAME") {
                  try { const f = findScroller(e.contentDocument, id); if (f) return f; } catch (_) {}
                }
              }
              return null;
            };
            const el = findScroller(document, scrollerId);
            if (el) el.scrollTop = yVal;
          },
          args: [scroller.scrollerId, scroller.scrollTop]
        });
      } catch (_) {  }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (scrollerId) => {
            const findScroller = (root, id) => {
              if (!root || !root.querySelectorAll) return null;
              const el = root.querySelector(`[data-btr-scroller-id="${id}"]`);
              if (el) return el;
              for (const e of root.querySelectorAll("*")) {
                if (e.shadowRoot) { const f = findScroller(e.shadowRoot, id); if (f) return f; }
                if (e.tagName === "IFRAME") {
                  try { const f = findScroller(e.contentDocument, id); if (f) return f; } catch (_) {}
                }
              }
              return null;
            };
            const el = findScroller(document, scrollerId);
            if (el) el.removeAttribute("data-btr-scroller-id");
          },
          args: [scroller.scrollerId]
        });
      } catch (_) {  }

      if (scrollerSequence.length > 0) {
        nestedCaptures.push({
          scrollerId: scroller.scrollerId,
          rect: scroller.rect,
          captures: scrollerSequence
        });
      }
    }
  } catch (_) {  }

  for (const cleanupMsg of [
    { type: "RESTORE_FIXED_ELEMENTS" },
    { type: "CLEAR_CAPTURE" },
    { type: "CAPTURE_SCROLL_END" }
  ]) {
    const cleanupOk = await sendToTab(tab.id, cleanupMsg, null).catch(() => null);
    if (cleanupOk === null) {

      await new Promise((r) => setTimeout(r, 100));
      await sendToTab(tab.id, cleanupMsg, null).catch(() => {});
    }
  }

  const sessionAfterNested = await getSession();
  if (sessionAfterNested?.status === "recording") {
    await sendToTab(tab.id, { type: "SHOW_STATUS", count: sessionAfterNested.steps.length }, 0).catch(() => {});
  }

  await sendToTab(tab.id, { type: "CAPTURE_SCROLL_END" }, null).catch(() => {});

  return { captures, nestedCaptures, truncated, captureError: null };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {

  try {
    if (pendingNewTabs.delete(tabId)) await persistPendingNewTabs();

    pendingNavUrls.delete(tabId);

    if (lastNavUrlByTab.delete(tabId)) await persistLastNavUrls();

    await withSessionLock(async () => {
      const session = await getSession();
      if (!session) return;
      session.tabIds = session.tabIds.filter((id) => id !== tabId);
      await saveSession(session);
    });
  } catch (e) { console.warn("[BTR] onRemoved handler failed:", e); }
});

async function persistPendingNewTabs() {
  try {
    await chrome.storage.session.set({ pendingNewTabs: [...pendingNewTabs] });
  } catch (e) {  }
}

try {
  chrome.storage.session.get("pendingNewTabs", (result) => {
    if (result?.pendingNewTabs && Array.isArray(result.pendingNewTabs)) {
      for (const [tabId, kind] of result.pendingNewTabs) pendingNewTabs.set(tabId, kind);
    }
  });
} catch (e) {  }

chrome.runtime.onStartup?.addListener(async () => {
  try {
    const session = await getSession();
    if (!session || (session.status !== "recording" && session.status !== "paused")) return;
    const settings = await getSettings();
    for (const tabId of session.tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !isValidPage(tab.url)) continue;
        await sendToTab(tabId, {
          type: "RECORDER_ATTACH",
          excludedDomains: session.excludedDomains || [],
          paused: session.status === "paused",
          settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
        });
      } catch (e) {  }
    }
  } catch (e) { console.warn("[BTR] onStartup handler failed:", e); }
});

chrome.runtime.onInstalled?.addListener(async () => {
  try {
    const session = await getSession();
    if (!session || (session.status !== "recording" && session.status !== "paused")) return;
    const settings = await getSettings();
    for (const tabId of session.tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !isValidPage(tab.url)) continue;
        await sendToTab(tabId, {
          type: "RECORDER_ATTACH",
          excludedDomains: session.excludedDomains || [],
          paused: session.status === "paused",
          settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
        });
      } catch (e) {  }
    }
  } catch (e) { console.warn("[BTR] onInstalled handler failed:", e); }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case "start-recording": {

        await withSessionLock(async () => {
          const existingKb = await getSession();
          if (existingKb) {
            await _finalizeSessionLocked(existingKb);
          }
          const tab = await currentTab();

          if (!tab?.id) {
            chrome.notifications?.create?.({
              type: "basic", iconUrl: "icons/icon-48.png",
              title: "Browser Tutorial Recorder", message: "No active tab to record."
            });
            return;
          }
          if (!isValidPage(tab.url)) {
            chrome.notifications?.create?.({
              type: "basic", iconUrl: "icons/icon-48.png",
              title: "Browser Tutorial Recorder",
              message: "This page cannot be recorded. Open a real webpage first."
            });
            return;
          }
          const session = createSession(tab);

          const stored = await chrome.storage.local.get("btr-excluded-domains");
          session.excludedDomains = Array.isArray(stored["btr-excluded-domains"]) ? stored["btr-excluded-domains"] : [];
          await saveSession(session);
          const settings = await getSettings();

          const ack = await sendToTab(tab.id, {
            type: "RECORDER_START",
            excludedDomains: session.excludedDomains,
            sessionId: session.id,
            settings: { autoPauseIdle: settings.autoPauseIdle, sensitivePatterns: settings.sensitivePatterns }
          });
          if (!ack) {
            await chrome.storage.local.remove(SESSION_KEY).catch(() => {});
            chrome.notifications?.create?.({
              type: "basic", iconUrl: "icons/icon-48.png",
              title: "Browser Tutorial Recorder",
              message: "Could not start recording on this page. Try reloading it first."
            });
            return;
          }
        });
        break;
      }
    case "stop-recording":
      await stopSession();
      break;
    case "pause-resume": {

      await withSessionLock(async () => {
        const session = await getSession();
        if (!session) return;
        session.status = session.status === "paused" ? "recording" : "paused";
        await saveSession(session);
        const msg = session.status === "paused" ? "RECORDER_PAUSE" : "RECORDER_RESUME";
        for (const tabId of session.tabIds) await sendToTab(tabId, { type: msg });
      });
      break;
    }
    case "open-dashboard":
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      break;
  }
  } catch (e) { console.warn("[BTR] onCommand handler failed:", e); }
});
