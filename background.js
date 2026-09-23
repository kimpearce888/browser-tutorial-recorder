import {
  dbPut, dbGet, dbDelete, dbDeleteAll, dbGetAll, dbGetSummaries,
  normalizeTutorial, toSummary
} from "./shared.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { createRecorder, isInternalUrl } from "./recorder-core.js";

const DRAFT_ID = "draft-current";
const UI_KEY = "btr-ui-state";
const MIN_CAPTURE_GAP_MS = 560;
const QUEUE_LIMIT = 14;

const recorder = createRecorder();
let captureQueue = Promise.resolve();
let queuedCount = 0;
let fullPageInProgress = false;
let idleTimer = null;
let flushTimer = null;
let attachedTabIds = new Set();

function respondOk(extra = {}) { return { ok: true, ...extra }; }
function respondErr(error) { return { ok: false, error: String((error && error.message) || error) }; }

async function broadcastUi() {
  try { await chrome.storage.session.set({ [UI_KEY]: recorder.uiState() }); } catch { /* session store unavailable */ }
  const ui = recorder.uiState();
  if (!ui.session) {
    await chrome.action.setBadgeText({ text: "" }).catch(() => {});
    return;
  }
  if (ui.session.status === "recording") {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(() => {});
    await chrome.action.setBadgeText({ text: String(ui.session.stepCount) }).catch(() => {});
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: "#5f6368" }).catch(() => {});
    await chrome.action.setBadgeText({ text: "II" }).catch(() => {});
  }
}

function scheduleDraftFlush(immediate = false) {
  if (!recorder.isActive()) return;
  if (immediate) { doFlushDraft(); return; }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(doFlushDraft, 400);
}

async function doFlushDraft() {
  if (!recorder.isActive()) return;
  try {
    const draft = recorder.exportDraft();
    await dbPut({ id: DRAFT_ID, kind: "draft", ...draft });
  } catch (e) { console.error("[BTR] draft flush failed:", e); }
}

async function clearDraft() {
  try { await dbDelete(DRAFT_ID); } catch { /* ignore */ }
  try { await chrome.storage.session.remove(UI_KEY); } catch { /* ignore */ }
}

async function getUiSnapshot() {
  const stored = await chrome.storage.session.get(UI_KEY).catch(() => ({}));
  return stored[UI_KEY] || recorder.uiState();
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!recorder.isRecording()) return;
  getSettings().then((settings) => {
    const sec = settings.autoPauseIdleSec;
    if (!sec) return;
    idleTimer = setTimeout(async () => {
      if (!recorder.isRecording()) return;
      recorder.setPaused(true, "idle");
      await broadcastUi();
      await notifyAttached();
    }, sec * 1000);
  }).catch(() => {});
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length) return tabs[0];
  const any = await chrome.tabs.query({ active: true, currentWindow: true });
  return any[0] || null;
}

function validForRecording(tab) {
  return tab && typeof tab.id === "number" && !isInternalUrl(tab.url || "") && /^https?:/i.test(tab.url || "");
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    return true;
  } catch (e) {
    console.warn("[BTR] injection failed for tab", tabId, String(e && e.message || e));
    return false;
  }
}

async function sendToTab(tabId, message) {
  try { await chrome.tabs.sendMessage(tabId, message); return true; }
  catch { return false; }
}

async function attachToTab(tabId) {
  const settings = await getSettings();
  const ui = recorder.uiState();
  const session = ui.session;
  await sendToTab(tabId, {
    type: "ATTACH_RECORDER",
    recording: Boolean(session),
    paused: session ? session.status === "paused" : false,
    excludedDomains: session ? session.excludedDomains || [] : [],
    sensitivePatterns: settings.sensitivePatterns,
    autoPauseIdleSec: settings.autoPauseIdleSec
  });
  attachedTabIds.add(tabId);
}

async function notifyAttached() {
  for (const tabId of [...attachedTabIds]) {
    await attachToTab(tabId);
  }
}

async function startRecording() {
  if (recorder.isActive()) return respondErr("A recording is already in progress.");
  const settings = await getSettings();
  const tab = await getActiveTab();
  recorder.startRecording(tab, {
    excludedDomains: settings.excludedDomains,
    title: tab && tab.title ? `Tutorial — ${tab.title}`.slice(0, 120) : "Untitled browser tutorial"
  });
  attachedTabIds = new Set();
  if (validForRecording(tab)) {
    await injectContentScript(tab.id);
    await attachToTab(tab.id);
    recorder.addTab(tab);
  }
  armIdleTimer();
  await broadcastUi();
  scheduleDraftFlush(true);
  return respondOk({ uiState: recorder.uiState() });
}

async function stopRecording(meta = {}) {
  if (!recorder.isActive()) return respondErr("No recording in progress.");
  recorder.setPaused(true, "stopping");
  clearTimeout(flushTimer);
  await captureQueue.catch(() => {});
  const tutorial = recorder.buildTutorial({ ...meta });
  recorder.reset();
  attachedTabIds = new Set();
  clearTimeout(idleTimer);
  try {
    await dbPut(normalizeTutorial(tutorial));
  } catch (e) {
    await broadcastUi();
    return respondErr(`Saving failed: ${e && e.message}`);
  }
  await clearDraft();
  await broadcastUi();
  await chrome.tabs.query({}).then(async (tabs) => {
    for (const t of tabs) {
      if (t.id != null) await sendToTab(t.id, { type: "DETACH_RECORDER" });
    }
  }).catch(() => {});
  return respondOk({ tutorialId: tutorial.id, stepCount: tutorial.steps.length });
}

async function discardRecording() {
  if (!recorder.isActive()) return respondErr("No recording in progress.");
  recorder.reset();
  attachedTabIds = new Set();
  clearTimeout(idleTimer);
  clearTimeout(flushTimer);
  await clearDraft();
  await broadcastUi();
  await chrome.tabs.query({}).then(async (tabs) => {
    for (const t of tabs) {
      if (t.id != null) await sendToTab(t.id, { type: "DETACH_RECORDER" });
    }
  }).catch(() => {});
  return respondOk();
}

function coalescable(evt) {
  return evt && ["SCROLL", "TYPE", "KEYBOARD", "SELECT", "CHANGE"].includes(evt.event);
}

function enqueueEvent(evt, senderInfo) {
  if (queuedCount >= QUEUE_LIMIT && coalescable(evt)) {
    return;
  }
  queuedCount++;
  captureQueue = captureQueue.then(async () => {
    queuedCount = Math.max(0, queuedCount - 1);
    try {
      await processEvent(evt, senderInfo);
    } catch (e) {
      console.error("[BTR] event processing failed:", e);
    }
    await new Promise((r) => setTimeout(r, MIN_CAPTURE_GAP_MS));
  }).catch(() => {});
}

async function processEvent(evt, senderInfo) {
  if (fullPageInProgress) return;
  if (recorder.isActive()) armIdleTimer();

  const verdict = recorder.handleEvent(evt, senderInfo);
  if (verdict.action !== "captured") {
    await broadcastUi();
    return;
  }

  const settings = await getSettings();
  if (settings.captureDelayMs > 0) {
    await new Promise((r) => setTimeout(r, settings.captureDelayMs));
  }

  let screenshot = null;
  try {
    const tab = await chrome.tabs.get(verdict.tabId).catch(() => null);
    if (tab) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: settings.screenshotFormat === "jpeg" ? "jpeg" : "png",
        quality: settings.screenshotQuality
      });
      screenshot = {
        image: dataUrl,
        width: (evt.viewport && evt.viewport.width) || 0,
        height: (evt.viewport && evt.viewport.height) || 0,
        dpr: (evt.viewport && evt.viewport.devicePixelRatio) || 1
      };
    }
  } catch (e) {
    console.warn("[BTR] capture failed:", String(e && e.message || e));
    screenshot = null;
  }

  const committed = recorder.commitStep(evt, screenshot);
  await broadcastUi();
  if (committed.action === "added") scheduleDraftFlush();
}

async function handleContentMessage(message, sender) {
  const tabId = sender.tab ? sender.tab.id : undefined;
  const senderInfo = {
    tabId,
    windowId: sender.tab ? sender.tab.windowId : undefined,
    frameId: sender.frameId
  };

  switch (message.type) {
    case "CS_HELLO": {
      if (recorder.isActive() && tabId != null) {
        recorder.addTab({ id: tabId, windowId: senderInfo.windowId });
        await attachToTab(tabId);
      }
      break;
    }
    case "HEARTBEAT": {
      if (recorder.isActive()) armIdleTimer();
      break;
    }
    case "REC_EVENT": {
      enqueueEvent(message.event ? message : null, senderInfo);
      break;
    }
    default:
      break;
  }
}

async function captureFullPage(tabId) {
  if (fullPageInProgress) throw new Error("A full-page capture is already running.");
  fullPageInProgress = true;
  const captures = [];
  let cssWidth = 0, cssHeight = 0, dpr = 1;
  try {
    const [{ result: vp }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        w: document.documentElement.clientWidth,
        h: document.documentElement.clientHeight,
        total: document.documentElement.scrollHeight,
        y: window.scrollY,
        dpr: window.devicePixelRatio || 1
      })
    });
    cssWidth = vp.w; cssHeight = vp.h; dpr = vp.dpr || 1;
    const maxShots = 40;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const style = document.createElement("style");
        style.id = "__btr_fullpage_hide";
        style.textContent = "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none} *{scroll-behavior:auto!important}";
        document.documentElement.appendChild(style);
      }
    });
    let y = vp.y || 0;
    for (let shot = 0; shot < maxShots; shot++) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (scrollTo) => window.scrollTo(0, scrollTo),
        args: [y]
      });
      await new Promise((r) => setTimeout(r, 220));
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
      captures.push({ dataUrl, y });
      const [{ result: pos }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ y: window.scrollY, total: document.documentElement.scrollHeight, h: document.documentElement.clientHeight })
      });
      if (pos.y + pos.h >= pos.total - 2 || pos.y === y && shot > 0) break;
      y = Math.min(pos.y + pos.h, pos.total - pos.h);
      if (y <= pos.y) break;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (restoreY) => {
        window.scrollTo(0, restoreY);
        const style = document.getElementById("__btr_fullpage_hide");
        if (style) style.remove();
      },
      args: [vp.y || 0]
    });

    const images = await Promise.all(captures.map((c) => createImageBitmapFromUrl(c.dataUrl)));
    const totalHeight = captures[captures.length - 1].y + cssHeight;
    const canvas = new OffscreenCanvas(cssWidth, Math.min(totalHeight, cssHeight * maxShots));
    const ctx = canvas.getContext("2d");
    captures.forEach((c, i) => {
      ctx.drawImage(images[i], 0, c.y - captures[0].y, cssWidth, cssHeight);
    });
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await blobToDataUrl(blob);
    return {
      image: dataUrl,
      width: cssWidth,
      height: Math.min(totalHeight, cssHeight * maxShots),
      dpr
    };
  } finally {
    fullPageInProgress = false;
  }
}

async function createImageBitmapFromUrl(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Blob read failed"));
    reader.readAsDataURL(blob);
  });
}

async function handlePageMessage(message) {
  switch (message.type) {
    case "PING": return respondOk();
    case "GET_UI_STATE": return respondOk({ uiState: await getUiSnapshot() });
    case "START_RECORDING": return startRecording();
    case "STOP_RECORDING": return stopRecording(message.meta || {});
    case "PAUSE_RECORDING":
      if (!recorder.isRecording()) return respondErr("Not recording.");
      recorder.setPaused(true, "manual");
      await broadcastUi(); await notifyAttached();
      return respondOk({ uiState: recorder.uiState() });
    case "RESUME_RECORDING": {
      if (!recorder.isActive()) return respondErr("No recording in progress.");
      recorder.setPaused(false);
      armIdleTimer();
      await broadcastUi(); await notifyAttached();
      const tab = await getActiveTab();
      if (validForRecording(tab)) {
        await injectContentScript(tab.id);
        await attachToTab(tab.id);
        recorder.addTab(tab);
      }
      return respondOk({ uiState: recorder.uiState() });
    }
    case "DISCARD_RECORDING": return discardRecording();
    case "GET_SETTINGS": return respondOk({ settings: await getSettings() });
    case "SAVE_SETTINGS": {
      const next = await saveSettings(message.patch || {});
      recorder.setExcludedDomains(next.excludedDomains);
      await notifyAttached();
      return respondOk({ settings: next });
    }
    case "GET_TUTORIAL": {
      const t = await dbGet(message.id);
      if (!t) return respondErr("Tutorial not found.");
      return respondOk({ tutorial: t });
    }
    case "GET_SUMMARIES": return respondOk({ summaries: await dbGetSummaries() });
    case "SAVE_TUTORIAL": {
      const saved = normalizeTutorial(message.tutorial);
      await dbPut(saved);
      return respondOk({ tutorial: saved });
    }
    case "DELETE_TUTORIAL":
      await dbDelete(message.id);
      return respondOk();
    case "DELETE_ALL_TUTORIALS":
      await dbDeleteAll();
      return respondOk();
    case "IMPORT_TUTORIALS": {
      const list = Array.isArray(message.tutorials) ? message.tutorials : [];
      let count = 0;
      for (const raw of list.slice(0, 200)) {
        try { await dbPut(normalizeTutorial(raw)); count++; } catch { /* skip bad record */ }
      }
      return respondOk({ imported: count });
    }
    case "CAPTURE_FULL_PAGE": {
      try {
        const shot = await captureFullPage(message.tabId);
        return respondOk({ screenshot: shot });
      } catch (e) {
        return respondErr(e);
      }
    }
    case "RECAPTURE": {
      try {
        const url = String(message.url || "");
        if (!/^https?:/i.test(url)) return respondErr("Only http(s) pages can be recaptured.");
        const original = await getActiveTab();
        const tab = await chrome.tabs.create({ url, active: true });
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(resolve, 14000);
        });
        await new Promise((r) => setTimeout(r, 600));
        try {
          const settings = await getSettings();
          let shot;
          if (message.mode === "full") {
            shot = await captureFullPage(tab.id);
          } else {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
              format: settings.screenshotFormat === "jpeg" ? "jpeg" : "png",
              quality: settings.screenshotQuality
            });
            const [{ result: vp }] = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight, dpr: window.devicePixelRatio || 1 })
            });
            shot = { image: dataUrl, width: vp.w, height: vp.h, dpr: vp.dpr };
          }
          if (original && typeof original.id === "number") {
            await chrome.tabs.update(original.id, { active: true }).catch(() => {});
          }
          await chrome.tabs.remove(tab.id).catch(() => {});
          return respondOk({ screenshot: shot });
        } finally {
          await chrome.tabs.remove(tab.id).catch(() => {});
        }
      } catch (e) {
        return respondErr(e);
      }
    }
    default:
      return respondErr(`Unknown message type: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  if (!sender.tab && sender.id === chrome.runtime.id) {
    handlePageMessage(message)
      .then(sendResponse)
      .catch((e) => sendResponse(respondErr(e)));
    return true;
  }

  handleContentMessage(message, sender).catch((e) => {
    console.error("[BTR] content message failed:", e);
  });
  return undefined;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !recorder.isActive()) return;
  if (!validForRecording(tab)) return;
  (async () => {
    if (recorder.isActive() && !recorder.state.lastNavUrlByTab.has(tabId) || changeInfo.url) {
      const evt = recorder.addSystemStep("NAVIGATION", tabId, tab.url);
      if (evt) enqueueEvent(evt, { tabId, windowId: tab.windowId, frameId: 0 });
    }
    await injectContentScript(tabId);
    await attachToTab(tabId);
  })().catch((e) => console.warn("[BTR] onUpdated failed:", e));
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!recorder.isActive()) return;
  (async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!validForRecording(tab)) return;
    recorder.addTab(tab);
    await injectContentScript(tabId);
    await attachToTab(tabId);
  })().catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!recorder.isActive()) return;
  if (tab.openerTabId == null) return;
  const evt = recorder.addSystemStep("NEW_TAB", tab.id, tab.url || "about:blank");
  if (evt) enqueueEvent(evt, { tabId: tab.id, windowId: tab.windowId, frameId: 0 });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!recorder.isActive()) return;
  const session = recorder.state.session;
  session.tabIds = session.tabIds.filter((id) => id !== tabId);
  attachedTabIds.delete(tabId);
  if (session.tabIds.length === 0) {
    await stopRecording();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "start-recording") await startRecording();
    else if (command === "stop-recording") await stopRecording();
    else if (command === "pause-resume") {
      if (recorder.isRecording()) {
        recorder.setPaused(true, "manual");
      } else if (recorder.isActive()) {
        recorder.setPaused(false);
      } else return;
      await broadcastUi();
      await notifyAttached();
    } else if (command === "open-dashboard") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    }
  } catch (e) {
    console.error("[BTR] command failed:", e);
  }
});

(async () => {
  const stored = await chrome.storage.session.get(UI_KEY).catch(() => ({}));
  const ui = stored[UI_KEY];
  if (ui && ui.session) {
    const draft = await dbGet(DRAFT_ID).catch(() => null);
    if (draft) {
      recorder.rehydrate(draft);
      await broadcastUi();
      console.warn("[BTR] recovered draft after service worker restart — recording is paused; resume to continue.");
      return;
    }
  }
  await broadcastUi();
})();
