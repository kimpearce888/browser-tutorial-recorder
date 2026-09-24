import {
  dbPut, dbGet, dbDelete, dbDeleteAll, dbGetAll, dbGetSummaries,
  normalizeTutorial, toSummary
} from "./shared.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { createRecorder, isInternalUrl, nextScrollY } from "./recorder-core.js";

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
let keepAliveTimer = null;
let captureBlocked = false;
let lastCaptureAt = 0;

function armKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  if (!recorder.isRecording()) return;
  keepAliveTimer = setInterval(() => {
    if (!recorder.isRecording()) { clearInterval(keepAliveTimer); keepAliveTimer = null; return; }
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function respondOk(extra = {}) { return { ok: true, ...extra }; }
function respondErr(error) { return { ok: false, error: String((error && error.message) || error) }; }

async function broadcastUi() {
  armKeepAlive();
  const ui = { ...recorder.uiState(), captureBlocked };
  try { await chrome.storage.session.set({ [UI_KEY]: ui }); } catch { /* session store unavailable */ }
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
  flushTimer = setTimeout(doFlushDraft, 3000);
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

async function sendToTab(tabId, message, options) {
  try { await chrome.tabs.sendMessage(tabId, message, options); return true; }
  catch { return false; }
}

// chrome.tabs.captureVisibleTab is hard-limited by Chrome to ~2 calls per
// second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). Every capture in the
// extension MUST go through this gate: it enforces a global minimum gap
// between calls and retries once on a genuine quota error instead of
// failing the whole step / full-page stitch.
async function captureVisible(windowId, options) {
  for (let attempt = 0; ; attempt++) {
    const waitMs = lastCaptureAt + MIN_CAPTURE_GAP_MS - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      lastCaptureAt = Date.now();
      return dataUrl;
    } catch (e) {
      lastCaptureAt = Date.now();
      const msg = String((e && e.message) || e);
      if (attempt < 4 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 700 + attempt * 350));
        continue;
      }
      throw e;
    }
  }
}

async function attachToTab(tabId, frameId = null) {
  const settings = await getSettings();
  const ui = recorder.uiState();
  const session = ui.session;
  const options = typeof frameId === "number" ? { frameId } : undefined;
  await sendToTab(tabId, {
    type: "ATTACH_RECORDER",
    recording: Boolean(session),
    paused: session ? session.status === "paused" : false,
    excludedDomains: session ? session.excludedDomains || [] : [],
    sensitivePatterns: settings.sensitivePatterns,
    autoPauseIdleSec: settings.autoPauseIdleSec,
    showCursor: settings.showCursor !== false,
    stepCount: session ? session.stepCount : 0
  }, options);
  attachedTabIds.add(tabId);
}

async function notifyAttached() {
  for (const tabId of [...attachedTabIds]) {
    await attachToTab(tabId);
  }
}

async function startRecording() {
  if (recorder.isActive()) return respondErr("A recording is already in progress.");
  const tab = await getActiveTab();
  if (!validForRecording(tab)) {
    return respondErr("Open a regular website tab (http/https) to start recording.");
  }
  const settings = await getSettings();
  recorder.startRecording(tab, {
    excludedDomains: settings.excludedDomains,
    title: tab && tab.title ? `Tutorial — ${tab.title}`.slice(0, 120) : "Untitled browser tutorial"
  });
  captureBlocked = false;
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

function drawCursorArtifact(ctx, point, scale) {
  const px = point.x * scale;
  const py = point.y * scale;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(px, py, 11 * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,115,82,0.15)";
  ctx.fill();
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = "rgba(255,115,82,0.95)";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 16 * scale, 0, Math.PI * 2);
  ctx.lineWidth = 5 * scale;
  ctx.strokeStyle = "rgba(255,115,82,0.2)";
  ctx.stroke();
  ctx.translate((point.x - 2) * scale, (point.y - 2) * scale);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(2, 2);
  ctx.lineTo(2, 34);
  ctx.lineTo(10, 26);
  ctx.lineTo(17, 37);
  ctx.lineTo(23, 33);
  ctx.lineTo(16, 22);
  ctx.lineTo(28, 22);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#172238";
  ctx.stroke();
  ctx.restore();
}

async function stampCursor(dataUrl, point, dpr) {
  const bitmap = await createImageBitmapFromUrl(dataUrl);
  const scale = Number(dpr) > 0 ? Number(dpr) : 1;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  drawCursorArtifact(ctx, point, scale);
  bitmap.close ? bitmap.close() : null;
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
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
      const dataUrl = await captureVisible(tab.windowId, {
        format: settings.screenshotFormat === "jpeg" ? "jpeg" : "png",
        quality: settings.screenshotQuality
      });
      screenshot = {
        image: dataUrl,
        width: (evt.viewport && evt.viewport.width) || 0,
        height: (evt.viewport && evt.viewport.height) || 0,
        dpr: (evt.viewport && evt.viewport.devicePixelRatio) || 1
      };
      captureBlocked = false;
    }
  } catch (e) {
    console.warn("[BTR] capture failed:", String(e && e.message || e));
    screenshot = null;
    captureBlocked = true;
    await broadcastUi();
  }

  // The live in-page cursor overlay (content.js) draws the click ring and
  // cursor follower directly into the rendered page, so the screenshot
  // already contains the cursor at the exact live position — stamping again
  // would double-draw it and, on pages that scrolled after the click, put
  // the stamp in a stale spot. Only stamp for events reported WITHOUT an
  // active overlay (e.g. a click that raced the attach).
  if (screenshot && verdict.needsCursor && settings.showCursor !== false && evt.overlayActive !== true) {
    const point = evt.target && evt.target.point;
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      try {
        screenshot.image = await stampCursor(screenshot.image, point, screenshot.dpr);
      } catch (e) {
        console.warn("[BTR] cursor stamp failed (kept plain shot):", String(e && e.message || e));
      }
    }
  }

  const committed = recorder.commitStep(evt, screenshot);
  await broadcastUi();
  if (committed.action === "added") {
    scheduleDraftFlush();
    if (typeof verdict.tabId === "number") {
      const ui = recorder.uiState();
      await sendToTab(verdict.tabId, { type: "BTR_STEP_COUNT", count: ui.session ? ui.session.stepCount : 0 });
    }
  }
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
        await attachToTab(tabId, senderInfo.frameId);
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
    case "TOOLBAR_TOGGLE_PAUSE": {
      if (!recorder.isActive()) break;
      if (recorder.isRecording()) recorder.setPaused(true, "manual");
      else recorder.setPaused(false);
      armIdleTimer();
      await broadcastUi();
      await notifyAttached();
      break;
    }
    case "TOOLBAR_STOP": {
      const res = await stopRecording({ endedAt: Date.now() });
      if (res && res.ok && res.tutorialId) {
        const editorUrl = chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(res.tutorialId)}`);
        await chrome.tabs.create({ url: editorUrl }).catch(() => {});
      }
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
  let restoreY = 0;
  let scrolled = false;
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
    if (!vp || !(vp.h > 0)) throw new Error("Could not read the page size for a full-page capture.");
    cssWidth = vp.w; cssHeight = Math.max(1, vp.h); dpr = vp.dpr || 1;
    restoreY = vp.y || 0;
    const MAX_CANVAS_HEIGHT = 12000;
    const MAX_CANVAS_WIDTH = 3840;
    const maxShots = Math.max(1, Math.min(40, Math.floor(MAX_CANVAS_HEIGHT / cssHeight)));
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const style = document.createElement("style");
        style.id = "__btr_fullpage_hide";
        style.textContent = "html::-webkit-scrollbar,body::-webkit-scrollbar{display:none} *{scroll-behavior:auto!important}";
        document.documentElement.appendChild(style);
      }
    });
    scrolled = true;
    let requested = 0;
    let lastActualY = -1;
    let pageTotal = vp.total || 0;
    for (let shot = 0; shot < maxShots; shot++) {
      // Scroll and WAIT for the viewport to actually land on the requested
      // offset (smooth-scroll pages, lazy layout shifts) before capturing,
      // then give the compositor a beat to paint. Each captureVisible call
      // below is rate-limited by the global capture gate.
      const [{ result: pos }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (scrollToY) => {
          window.scrollTo(0, scrollToY);
          const deadline = performance.now() + 900;
          await new Promise((r) => setTimeout(r, 140));
          while (performance.now() < deadline && Math.abs(window.scrollY - scrollToY) > 2) {
            await new Promise((r) => setTimeout(r, 90));
          }
          await new Promise((r) => setTimeout(r, 150));
          return {
            y: window.scrollY,
            total: document.documentElement.scrollHeight,
            h: document.documentElement.clientHeight
          };
        },
        args: [requested]
      });
      if (!pos) break;
      if (shot > 0 && pos.y <= lastActualY) break;
      lastActualY = pos.y;
      pageTotal = Math.max(pageTotal, pos.total);
      const dataUrl = await captureVisible(undefined, { format: "png" });
      captures.push({ dataUrl, y: pos.y });
      const next = nextScrollY(pos, requested);
      if (next == null) break;
      requested = next;
    }

    if (!captures.length) throw new Error("Could not capture the page for a full-page screenshot.");
    const images = await Promise.all(captures.map((c) => createImageBitmapFromUrl(c.dataUrl)));
    const lastShot = captures[captures.length - 1];
    const totalHeight = Math.min(lastShot.y + cssHeight, pageTotal || lastShot.y + cssHeight);
    const canvasWidth = Math.min(cssWidth, MAX_CANVAS_WIDTH);
    const canvasHeight = Math.max(1, Math.min(totalHeight, MAX_CANVAS_HEIGHT));
    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext("2d");
    captures.forEach((c, i) => {
      ctx.drawImage(images[i], 0, c.y - captures[0].y, canvasWidth, cssHeight);
    });
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const dataUrl = await blobToDataUrl(blob);
    return {
      image: dataUrl,
      width: canvasWidth,
      height: canvasHeight,
      dpr
    };
  } finally {
    fullPageInProgress = false;
    // ALWAYS restore the page, even when the stitch threw mid-loop — the old
    // code left pages scrolled to the bottom with their scrollbars hidden.
    if (scrolled) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => {
          window.scrollTo(0, y);
          const style = document.getElementById("__btr_fullpage_hide");
          if (style) style.remove();
        },
        args: [restoreY]
      }).catch(() => {});
    }
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
            const dataUrl = await captureVisible(tab.windowId, {
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

const EXT_BASE = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  // Extension pages opened in a browser tab (editor/dashboard/settings/preview)
  // DO have sender.tab set — only the popup and the service worker lack it.
  // Route by sender URL, never by the absence of sender.tab: content scripts
  // always carry the host page URL, extension pages always carry our own
  // chrome-extension://<id>/ URL.
  const fromExtensionPage = sender.id === chrome.runtime.id
    && (typeof sender.url !== "string" || sender.url.startsWith(EXT_BASE));

  if (fromExtensionPage) {
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
      if (recorder.isActive()) {
        recorder.setPaused(false);
        armIdleTimer();
        const ids = recorder.state.session ? [...recorder.state.session.tabIds] : [];
        for (const tabId of ids) await attachToTab(tabId);
      }
      await broadcastUi();
      console.warn("[BTR] recovered draft after service worker restart — recording resumed.");
      return;
    }
  }
  if (!recorder.isActive()) dbDelete(DRAFT_ID).catch(() => {});
  await broadcastUi();
})();
