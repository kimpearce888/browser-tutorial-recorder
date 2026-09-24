import {
  dbPut, dbGet, dbDelete, dbDeleteAll, dbGetAll, dbGetSummaries,
  normalizeTutorial, toSummary
} from "./shared.js";
import { getSettings, saveSettings } from "./settings-store.js";
import { drawCursorMarker } from "./cursor-marker.js";
import { createRecorder, isInternalUrl, nextScrollY, planCrop } from "./recorder-core.js";

const DRAFT_ID = "draft-current";
const UI_KEY = "btr-ui-state";
const MIN_CAPTURE_GAP_MS = 560;
const QUEUE_LIMIT = 14;
const MAX_CANVAS_HEIGHT = 24000;
const MAX_CANVAS_WIDTH = 3840;

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

// Click steps must show the page EXACTLY as the user saw it when the mouse
// went down — not after the click's consequences (navigation, SPA route
// change, menu closing) have already rendered. The content script asks for a
// pre-capture at mousedown; the landed frame is held per tab and consumed by
// the click-family step that follows. If nothing consumes it (text
// selection, a drag, a non-recording click) it expires and costs nothing.
const PRE_SHOT_TTL_MS = 2500;
const PRE_SHOT_EVENTS = new Set(["CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "MIDDLE_CLICK", "SUBMIT"]);
let preShots = new Map();   // tabId -> { dataUrl, at }
let preFlights = new Map(); // tabId -> Promise<shot> — in-flight pre-captures

function armKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  if (!recorder.isRecording()) return;
  keepAliveTimer = setInterval(() => {
    if (!recorder.isRecording()) { clearInterval(keepAliveTimer); keepAliveTimer = null; return; }
    try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch { /* SW API unavailable */ }
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
// between calls and retries on a genuine quota error instead of failing the
// whole step / full-page stitch.
//
// Professional recorders never show their own UI inside screenshots. When a
// tabId is provided, the recorder toolbar and click rings are hidden for the
// instant the frame is grabbed (BTR_CAPTURE_UI handshake) and restored right
// after — the marker the reader sees is the one WE draw, always consistent.
async function setTabCaptureUi(tabId, visible) {
  if (typeof tabId !== "number") return false;
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "BTR_CAPTURE_UI", visible }),
      new Promise((r) => setTimeout(() => r(null), 220))
    ]);
    return Boolean(res && res.applied);
  } catch { return false; }
}

async function captureVisible(windowId, options, tabId) {
  let hidden = false;
  try {
    if (typeof tabId === "number") {
      hidden = await setTabCaptureUi(tabId, false);
      // Give the compositor a frame to actually paint the hidden UI before
      // the frame is grabbed, otherwise the capture can race the style change.
      await new Promise((r) => setTimeout(r, hidden ? 60 : 0));
    }
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
  } finally {
    if (hidden) await setTabCaptureUi(tabId, true);
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
    cursorMarker: settings.cursorMarker,
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
  preShots.clear();
  attachedTabIds = new Set();
  if (validForRecording(tab)) {
    await injectContentScript(tab.id);
    await attachToTab(tab.id);
    recorder.addTab(tab);
    // Professional guides open with the starting page as step 1 — Scribe and
    // Tango both do this. Capture a "Navigate to …" step immediately so the
    // tutorial never begins with the user's first click.
    const first = recorder.addSystemStep("NAVIGATION", tab.id, tab.url);
    if (first) enqueueEvent(first, { tabId: tab.id, windowId: tab.windowId, frameId: 0 });
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
  preShots.clear();
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
    // No trailing sleep: captureVisible() already paces ALL captures
    // globally, so an extra 560ms here just made every step feel sluggish.
  }).catch(() => {});
}

function drawCursorArtifact(ctx, point, scale, marker) {
  // One source of truth with the settings-page preview: cursor-marker.js.
  drawCursorMarker(ctx, point, scale, marker);
}

// Live progress for full-page captures — GoFullPage-style "Capturing 3/8"
// instead of a silent freeze. Best-effort: nobody may be listening.
function reportFullPageProgress(tabId, done, pageTotal, cssHeight, maxShots) {
  try {
    const total = Math.max(done, Math.min(maxShots, Math.ceil((pageTotal || 0) / Math.max(1, cssHeight))));
    const p = chrome.runtime.sendMessage({ type: "BTR_CAPTURE_PROGRESS", done, total });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch { /* no listeners */ }
}

// One decode, one encode: crop the shot to the clicked element (the Scribe /
// Tango signature) and draw the professional click marker onto the CLEAN
// image — the DOM ring is hidden during the capture, so the marker in the
// step is always ours: same style, same size, exactly on the click point.
async function finishScreenshot(dataUrl, evt, verdict, settings) {
  const needsMarker = Boolean(
    verdict.needsCursor && settings.showCursor !== false
    && evt.target && evt.target.point
    && Number.isFinite(evt.target.point.x) && Number.isFinite(evt.target.point.y)
  );
  // Off by default: users expect the CURRENT VIEW in every step (exactly what
  // standard recorders ship). The Scribe-style close-up is an explicit opt-in
  // in Settings → Recording.
  const wantsCrop = settings.autoElementCrop === true
    && Boolean(evt.target && (evt.target.boundingBox || evt.target.point));
  if (!needsMarker && !wantsCrop) {
    return {
      image: dataUrl,
      width: (evt.viewport && evt.viewport.width) || 0,
      height: (evt.viewport && evt.viewport.height) || 0,
      dpr: (evt.viewport && evt.viewport.devicePixelRatio) || 1
    };
  }
  try {
    const bitmap = await createImageBitmapFromUrl(dataUrl);
    const scale = Number(evt.viewport && evt.viewport.devicePixelRatio) > 0 ? Number(evt.viewport.devicePixelRatio) : 1;
    const cssW = bitmap.width / scale, cssH = bitmap.height / scale;
    const crop = wantsCrop
      ? planCrop(evt.target.boundingBox || null, evt.target.point || null, cssW, cssH)
      : null;
    const cw = crop ? crop.w : cssW, ch = crop ? crop.h : cssH;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(cw * scale)), Math.max(1, Math.round(ch * scale)));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, crop ? -Math.round(crop.x * scale) : 0, crop ? -Math.round(crop.y * scale) : 0);
    if (needsMarker) {
      drawCursorArtifact(ctx, {
        x: evt.target.point.x - (crop ? crop.x : 0),
        y: evt.target.point.y - (crop ? crop.y : 0)
      }, scale, settings.cursorMarker);
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const out = { image: await blobToDataUrl(blob), width: Math.round(cw), height: Math.round(ch), dpr: scale };
    if (crop) out.crop = crop;
    return out;
  } catch (e) {
    // A failed crop/stamp must never cost the step its screenshot — degrade
    // to the raw, uncropped frame instead.
    console.warn("[BTR] crop/stamp failed (kept plain shot):", String(e && e.message || e));
    return {
      image: dataUrl,
      width: (evt.viewport && evt.viewport.width) || 0,
      height: (evt.viewport && evt.viewport.height) || 0,
      dpr: (evt.viewport && evt.viewport.devicePixelRatio) || 1
    };
  }
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
    if (verdict.adoptScreenshot) {
      // SUBMIT replaced the recent CLICK step on the same target and adopted
      // its pre-click screenshot — no capture needed, no navigation race.
      screenshot = verdict.adoptScreenshot;
    } else {
      const tab = await chrome.tabs.get(verdict.tabId).catch(() => null);
      if (tab) {
        // Click-family steps reuse the mousedown pre-shot — the frame grabbed
        // BEFORE the click could navigate or re-render the page, so the marker
        // sits on the exact state the user acted on. Everything else (TYPE,
        // SELECT, …) still captures live: it wants the post-action state.
        let dataUrl = null;
        if (PRE_SHOT_EVENTS.has(verdict.event)) {
          let held = preShots.get(verdict.tabId);
          if (!held && preFlights.has(verdict.tabId)) {
            await preFlights.get(verdict.tabId).catch(() => null);
            held = preShots.get(verdict.tabId);
          }
          preShots.delete(verdict.tabId); // one-shot, whatever the outcome
          if (held && (Date.now() - held.at) <= PRE_SHOT_TTL_MS) dataUrl = held.dataUrl;
        }
        if (!dataUrl) {
          dataUrl = await captureVisible(tab.windowId, {
            format: settings.screenshotFormat === "jpeg" ? "jpeg" : "png",
            quality: settings.screenshotQuality
          }, tab.id);
        }
        screenshot = await finishScreenshot(dataUrl, evt, verdict, settings);
        captureBlocked = false;
      }
    }
  } catch (e) {
    console.warn("[BTR] capture failed:", String(e && e.message || e));
    screenshot = null;
    captureBlocked = true;
    await broadcastUi();
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
      message.receivedAt = Date.now();
      enqueueEvent(message.event ? message : null, senderInfo);
      break;
    }
    case "BTR_PRE_CAPTURE": {
      if (!recorder.isRecording() || fullPageInProgress || tabId == null) break;
      if (preFlights.has(tabId)) break; // one grab per mousedown is enough
      // Register the flight SYNCHRONOUSLY — the click REC_EVENT may arrive a
      // few milliseconds later and must find the in-flight capture, never a
      // gap where it would fall back to a racy live grab.
      const flight = (async () => {
        try {
          const preSettings = await getSettings();
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab) return null;
          const dataUrl = await captureVisible(tab.windowId, {
            format: preSettings.screenshotFormat === "jpeg" ? "jpeg" : "png",
            quality: preSettings.screenshotQuality
          }, tab.id);
          captureBlocked = false;
          return { dataUrl, at: Date.now() };
        } catch (e) {
          // A failed pre-capture must never break recording — the step will
          // simply fall back to the live capture below.
          console.warn("[BTR] pre-capture failed (step will capture live):", String(e && e.message || e));
          return null;
        }
      })();
      preFlights.set(tabId, flight);
      try {
        const landed = await flight;
        if (landed) {
          preShots.set(tabId, landed);
          for (const [k, v] of preShots) {
            if (Date.now() - v.at > PRE_SHOT_TTL_MS) preShots.delete(k);
          }
        }
      } finally {
        preFlights.delete(tabId);
      }
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

async function captureFullPage(tabId, onShotsDone) {
  if (fullPageInProgress) throw new Error("A full-page capture is already running.");
  fullPageInProgress = true;
  preShots.clear();
  const captures = [];
  let cssWidth = 0, cssHeight = 0, dpr = 1;
  let restoreY = 0;
  let scrolled = false;
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const windowId = tab && typeof tab.windowId === "number" ? tab.windowId : undefined;
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
    const maxShots = Math.max(1, Math.min(72, Math.floor(MAX_CANVAS_HEIGHT / cssHeight)));
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
      // offset (smooth-scroll pages, lazy layout shifts) before capturing.
      // From the second shot on, fixed/sticky elements (cookie banners, nav
      // bars, headers) are hidden: otherwise they repeat in every stitched
      // strip, which is what made full-page shots look non-standard. They
      // are restored once, at the end, together with the scroll position.
      const [{ result: pos }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (scrollToY, hideFixed) => {
          if (hideFixed) {
            try {
              for (const el of document.querySelectorAll("body *")) {
                if (el.__btrFixedSeen) continue;
                const cs = getComputedStyle(el);
                if ((cs.position === "fixed" || cs.position === "sticky") && el.offsetWidth > 0 && el.offsetHeight > 0) {
                  el.__btrFixedSeen = true;
                  el.__btrFixedVis = el.style.visibility || "";
                  el.style.visibility = "hidden";
                  el.setAttribute("data-btr-fixed", "1");
                }
              }
            } catch { /* page defends itself — capture without hiding */ }
          }
          window.scrollTo(0, scrollToY);
          const deadline = performance.now() + 900;
          await new Promise((r) => setTimeout(r, 140));
          while (performance.now() < deadline && Math.abs(window.scrollY - scrollToY) > 2) {
            await new Promise((r) => setTimeout(r, 90));
          }
          await new Promise((r) => setTimeout(r, 280));
          return {
            y: window.scrollY,
            total: document.documentElement.scrollHeight,
            h: document.documentElement.clientHeight
          };
        },
        args: [requested, shot > 0]
      });
      if (!pos) break;
      if (shot > 0 && pos.y <= lastActualY) break;
      lastActualY = pos.y;
      pageTotal = Math.max(pageTotal, pos.total);
      const dataUrl = await captureVisible(windowId, { format: "png" }, tabId);
      captures.push({ dataUrl, y: pos.y });
      reportFullPageProgress(tabId, captures.length, pageTotal, cssHeight, maxShots);
      const next = nextScrollY(pos, requested);
      if (next == null) break;
      requested = next;
    }

    if (!captures.length) throw new Error("Could not capture the page for a full-page screenshot.");
    // Shots are on disk (as data URLs) — the visible tab can go back to the
    // editor before the slower canvas stitching starts.
    if (typeof onShotsDone === "function") { try { await onShotsDone(); } catch { /* best effort */ } }
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
          try {
            for (const el of document.querySelectorAll("[data-btr-fixed]")) {
              el.style.visibility = el.__btrFixedVis || "";
              delete el.__btrFixedVis;
              delete el.__btrFixedSeen;
              el.removeAttribute("data-btr-fixed");
            }
          } catch { /* best effort */ }
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
            shot = await captureFullPage(tab.id, () => {
              if (original && typeof original.id === "number") {
                return chrome.tabs.update(original.id, { active: true }).catch(() => {});
              }
            });
          } else {
            const dataUrl = await captureVisible(tab.windowId, {
              format: settings.screenshotFormat === "jpeg" ? "jpeg" : "png",
              quality: settings.screenshotQuality
            }, tab.id);
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
