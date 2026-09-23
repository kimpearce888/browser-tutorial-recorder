// Service worker: owns the recording session, captures screenshots and
// persists finished tutorials. Uses shared.js for IndexedDB access.

import { dbPut, dbDelete, dbDeleteAll, dbGet, dbGetAll, dbGetAllSummaries, normalizeTutorial } from "./shared.js";
import { getSettings } from "./settings-store.js";

const SESSION_KEY = "activeSession";
const TAB_ACTIVATE_DELAY_MS = 80;

// H6 fix: mutual-exclusion guard for CAPTURE_FULL_PAGE. Two concurrent calls
// would interleave scroll positioning and produce corrupted screenshots.
let fullPageCaptureInProgress = false;

// v1.2.1 #4: listen for excluded-domains AND settings changes so they apply mid-recording
// P0-4 fix: use session lock
chrome.storage?.onChanged?.addListener(async (changes, area) => {
  if (area !== "local") return;
  // Handle excluded-domains changes
  if (changes["btr-excluded-domains"]) {
    await withSessionLock(async () => {
      const session = await getSession();
      // C7 fix: allow BOTH "recording" AND "paused" sessions. The old check
      // (`status !== "recording"`) meant settings changed while paused weren't
      // propagated to content scripts — the user would resume with old settings.
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
  // P1-4 fix: handle settings changes (sensitivePatterns, autoPauseIdle)
  // v1.6.7 fix: use session lock + session-ID re-check to prevent the same
  // lifecycle race that onCreated/onUpdated had. If the session is stopped
  // and a new one starts while the settings-change callback runs, the old
  // session's settings would be broadcast to the new recording's tabs.
  if (changes["settings"]) {
    await withSessionLock(async () => {
      const session = await getSession();
      // C7 fix: allow BOTH "recording" AND "paused" sessions.
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
// Chrome caps chrome.tabs.captureVisibleTab at 2 calls/sec. We enforce a
// minimum gap between captures so rapid events don't exceed the limit (B6).
const MIN_CAPTURE_GAP_MS = 500;

// In-flight recordEvent promises, deduplicated by event key.
const pendingEvents = new Map();
// Tabs created during a recording, waiting for their first navigation.
const pendingNewTabs = new Map();

// P0-2 v2 (v1.5.1): pending CLICK events held in the BACKGROUND for
// double-click detection. Keyed by `${tabId}|${frameId}|${selector}|${bbox.x}|${bbox.y}`.
// Moving this state out of content means clicks that cause immediate
// navigation are no longer lost — the message is sent IMMEDIATELY by
// content, and the background's 150ms timer is independent of page lifecycle.
const pendingClicks = new Map();
const CLICK_HOLD_MS = 150;

// Capture serialization queue. The ENTIRE prepare→capture→cleanup
// transaction is serialized — not just the screenshot — so event B's
// overlay can't overwrite event A's overlay while A is waiting for
// captureVisibleTab (P0 fix from external audit).
let captureQueue = Promise.resolve();
function serializeTransaction(fn) {
  const run = captureQueue.then(fn, () => fn());
  captureQueue = run.then(
    () => new Promise((r) => setTimeout(r, MIN_CAPTURE_GAP_MS)),
    () => new Promise((r) => setTimeout(r, MIN_CAPTURE_GAP_MS))
  );
  return run;
}

// Session operation lock — ensures stopSession waits for in-flight
// recordEvent transactions to complete before finalizing (P0 fix).
let sessionLock = Promise.resolve();
function withSessionLock(fn) {
  const run = sessionLock.then(fn, () => fn());
  sessionLock = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Session persistence (chrome.storage.local is the source of truth)
// ---------------------------------------------------------------------------

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function saveSession(session) {
  session.updatedAt = Date.now();
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isValidPage(url) {
  // v1.0.3: reject empty/undefined URLs (was returning true for "" and undefined).
  // Also block chrome-untrusted:// and file:// pages.
  return Boolean(url) && !/^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|file|moz-extension|extension):/i.test(url);
}

async function sendToTab(tabId, message, frameId, timeoutMs = 5000) {
  // Wrap chrome.tabs.sendMessage with a timeout so a hung listener (e.g.
  // content script that returned true but never called sendResponse) can't
  // stall the entire pipeline (B10).
  const options = frameId == null ? undefined : { frameId };
  // B13: settle-once pattern — once the timeout fires, the late sendMessage
  // callback is ignored so it doesn't double-resolve or log a console warning.
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
    // NM5 fix: clear the timeout timer when the promise settles so the SW
    // isn't kept alive for up to 5s after a successful sendToTab.
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
    // Content script not yet injected — inject and retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
      return await withTimeout(send(options));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

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
  // P0-4 fix: use session lock so addTabToSession is atomic with recording
  // v1.6.4 fix: if the session was stopped/discarded while we waited for the
  // lock, getSession() returns null. Bail out — don't resurrect.
  // v1.6.7 fix: also verify the session ID matches. If Recording A was
  // stopped and Recording B started while waiting for the lock, getSession()
  // returns B — adding A's tab to B would contaminate the new recording.
  await withSessionLock(async () => {
    const latest = await getSession();
    if (!latest || latest.id !== session.id) return; // session changed — don't contaminate
    const target = latest;
    if (!target.tabIds.includes(tab.id)) target.tabIds.push(tab.id);
    if (tab.windowId != null && !target.windowIds.includes(tab.windowId)) {
      target.windowIds.push(tab.windowId);
    }
    await saveSession(target);
  });
}

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

async function captureVisibleTab(tab, format, quality) {
  // P2-1 v1.5.1 fix: captureVisibleTab previously restored the previous
  // active tab/window only on the success path. If captureVisibleTab threw,
  // execution jumped to catch and returned {image:null, status:"FAILED"}
  // WITHOUT restoring — leaving the user unexpectedly switched to another
  // tab/window. Now restoration runs in a finally block, so the user's
  // previous focus is always restored, even on failure.
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
    // NM2 fix: re-check that the target tab is still the active tab right
    // before captureVisibleTab. If the user switched tabs during the 80ms
    // activation delay, we'd capture the wrong tab. Bail with FAILED status
    // instead of capturing a screenshot of the wrong page.
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
    // P2-1 v1.5.1 fix: ALWAYS restore the previously-active tab/window,
    // even if captureVisibleTab threw an exception. Without this, a failed
    // screenshot would leave the user unexpectedly switched to another tab.
    if (needsTabActivate && activeTab) {
      try { await chrome.tabs.update(activeTab.id, { active: true }); } catch (_) {}
    }
    if (needsWindowFocus && focusedWindow) {
      try { await chrome.windows.update(focusedWindow.id, { focused: true }); } catch (_) {}
    }
  }
}

async function prepareCapture(tabId, payload, frameId = 0) {
  // F3 fix: treat privacy-preparation failure as a capture failure. The old
  // code ignored sendToTab results — if masking failed, the screenshot was
  // still captured, potentially exposing sensitive fields.
  const hideOk = await sendToTab(tabId, { type: "HIDE_STATUS" }, 0);
  if (hideOk === null) {
    throw new Error("Failed to hide recorder badge before capture.");
  }
  const prepareOk = await sendToTab(tabId, { type: "PREPARE_CAPTURE", ...payload }, frameId);
  if (prepareOk === null) {
    throw new Error("Failed to prepare capture overlay.");
  }
  // P1 fix: mask sensitive fields in ALL frames, not just the event's frame.
  // G2 fix: treat failure of the all-frame masking broadcast as a capture
  // failure — if a frame can't be reached for masking, sensitive content in
  // that frame would appear in the screenshot.
  const maskOk = await sendToTab(tabId, { type: "PREPARE_CAPTURE", ...payload, maskOnly: true }, null);
  if (maskOk === null) {
    throw new Error("Failed to mask sensitive fields in all frames.");
  }
  const { captureDelay } = await getSettings();
  await new Promise((r) => setTimeout(r, captureDelay));
  // P1-6 v1.5.1 fix: re-anchor masks at the LATEST possible moment before
  // captureVisibleTab. Layout shifts during captureDelay (validation
  // messages, banners, animations, responsive layout) could leave masks
  // misaligned with the elements they cover, exposing sensitive values.
  // Send REFRESH_MASKS to ALL frames so masks in every frame are re-queried.
  await sendToTab(tabId, { type: "REFRESH_MASKS" }, null).catch(() => {});
}

async function finishCapture(tabId, frameId = 0) {
  await sendToTab(tabId, { type: "CLEAR_CAPTURE" }, frameId);
  // P1 fix: also clear masks in all frames
  await sendToTab(tabId, { type: "CLEAR_CAPTURE" }, null);
  const session = await getSession();
  if (session?.status === "recording") {
    await sendToTab(tabId, { type: "SHOW_STATUS", count: session.steps.length }, 0);
  } else {
    // M6 fix: if the session was stopped mid-capture (status is null or
    // not "recording"), explicitly hide the badge rather than leaving it
    // in whatever state prepareCapture left it (HIDE_STATUS). Previously
    // the badge stayed hidden for the rest of the page's life.
    await sendToTab(tabId, { type: "HIDE_STATUS" }, 0).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Event recording
// ---------------------------------------------------------------------------

async function getLightweightSession() {
  const session = await getSession();
  if (!session) return null;
  // Return only the fields the popup/editor need for display.
  // Exclude steps[].screenshot.image (multi-MB base64 data URLs).
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
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
      // screenshot.image intentionally excluded
    }))
  };
}

async function recordEvent(message, sender) {
  // M17: validate message shape so a malformed message can't crash the SW.
  if (!message || typeof message.event !== "string") return { ok: false };
  const session = await getSession();
  if (!session || session.status !== "recording") return { ok: false };

  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };
  // P0 fix: do NOT auto-add arbitrary tabs to the session. Only tabs that
  // were explicitly attached via RECORDER_ATTACH (from onCreated/onUpdated)
  // should be part of the recording. This prevents unrelated tabs from
  // injecting events into an active session.
  if (!sessionOwnsTab(session, tabId)) return { ok: false };

  // D1 fix: capture the session ID at enqueue time. A pending click/event
  // can fire AFTER this session is stopped and a new one started — without
  // this check, the old event would be saved into the new recording.
  // doRecordEvent and the click-dedup timers now verify the session ID
  // before committing.
  const sessionId = session.id;

  // P0-2 v2 (v1.5.1): for CLICK events, route through the click-dedup
  // state machine. The existing dedup (which merges identical events within
  // 100ms) would otherwise collapse the two CLICKs of a double-click into
  // one, breaking DOUBLE_CLICK detection.
  if (message.event === "CLICK") {
    return recordClickWithDedup(message, sender, tabId, sessionId);
  }

  // P2-1 v1.5.2: when a DOUBLE_CLICK arrives (sent directly by content.js
  // when event.detail >= 2 — the browser itself confirmed the double-click),
  // we need to RETRACT any prior CLICK step that was recorded for click #1
  // of the same sequence. This handles the case where the OS double-click
  // interval > CLICK_HOLD_MS (150ms) — click #1's hold timer fired and
  // committed a CLICK step before click #2 (detail=2) arrived.
  if (message.event === "DOUBLE_CLICK") {
    return recordDoubleClickWithRetract(message, sender, tabId, sessionId);
  }

  // P0-1 v1.5.3 fix: when a SUBMIT arrives, the browser event order is
  // mousedown → mouseup → click → submit. The CLICK listener fires BEFORE
  // the submit listener, so the CLICK has already been sent to background
  // and may have been committed as a CLICK step. The content.js
  // `suppressClickForSubmit` flag is set too late to suppress it.
  //
  // Fix: when a SUBMIT arrives, RETRACT any prior CLICK step on the same
  // element (or any submit-type button inside the same form) within the
  // last 1000ms. Also cancel any held pending CLICK on the same element.
  // This mirrors the DOUBLE_CLICK retract pattern.
  if (message.event === "SUBMIT") {
    return recordSubmitWithRetract(message, sender, tabId, sessionId);
  }

  // P0-2 v2: when a navigation event arrives, flush any pending CLICKs for
  // that tab first — otherwise the NAVIGATION step would be recorded before
  // the CLICK step that triggered it (the pending CLICK's 150ms timer hasn't
  // fired yet). The CLICK should always precede its resulting NAVIGATION.
  if (message.event === "NAVIGATION" || message.event === "NEW_TAB" || message.event === "NEW_WINDOW") {
    flushPendingClicksForTab(tabId);
  }

  const current = await getSession();
  if (!current || current.status !== "recording") return { ok: false };

  // Deduplicate identical events arriving from multiple frames / rapid clicks.
  // Use a content-derived key (kind + tabId + selector + coords rounded to
  // 100ms) so genuinely duplicate events across frames are merged, while
  // distinct events are not (L4 — the old eventId key was always unique).
  // v1.1.0: include message.url in the dedup key so rapid distinct-URL
  // navigations (redirects, fast SPA pushState) aren't merged into one.
  // C12 fix: include sender.frameId in the dedup key. Two separate iframe
  // events in the same 100ms bucket with the same selector/coords/URL would
  // collide without this. The click-specific dedup (clickDedupKey) already
  // includes frameId — this brings the general path in line.
  const ts = Math.floor(Date.now() / 100);
  const frameId = sender?.frameId ?? 0;
  const key = `${message.event}|${tabId}|${frameId}|${message.target?.selectors?.[0] || message.target?.tag || ""}|${Math.round(message.target?.boundingBox?.x || 0)}|${Math.round(message.target?.boundingBox?.y || 0)}|${message.url || ""}|${ts}`;
  if (pendingEvents.has(key)) return pendingEvents.get(key);

  // D1 fix: pass sessionId into doRecordEvent so it can verify it belongs to
  // the CURRENT session before committing. Without this, an event enqueued
  // during recording A can fire after recording B starts and be saved into B.
  const promise = withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId)).finally(() => pendingEvents.delete(key));
  promise._ts = Date.now();
  pendingEvents.set(key, promise);
  // B12: bound the Map size so a runaway recording can't leak memory
  // indefinitely. Old entries (older than 60s) are pruned on every insert.
  // M8 fix: also cap by absolute size — if >500 entries, drop oldest regardless
  // of age (prevents unbounded growth under burst when storage is slow).
  if (pendingEvents.size > 200) {
    const now = Date.now();
    for (const [k, p] of pendingEvents) {
      if (p._ts && now - p._ts > 60000) {
        pendingEvents.delete(k);
      }
    }
    if (pendingEvents.size > 500) {
      // Drop the oldest 100 entries to get under the hard cap.
      const sorted = [...pendingEvents.entries()].sort((a, b) => (a[1]._ts || 0) - (b[1]._ts || 0));
      for (let i = 0; i < 100 && i < sorted.length; i++) {
        pendingEvents.delete(sorted[i][0]);
      }
    }
  }
  return promise;
}

// P0-2 v2 (v1.5.1): hold each CLICK for CLICK_HOLD_MS (150ms). If a second
// CLICK on the same element (same tab + frame + selector + bbox) arrives
// within that window, convert BOTH into a single DOUBLE_CLICK step.
// Otherwise commit the original CLICK when the timer fires.
//
// The state machine lives in the BACKGROUND service worker, which is
// independent of any page's lifecycle. Even if the click caused immediate
// navigation and the document was torn down, the background's timer still
// fires and the CLICK step is still recorded.
//
// Returns a Promise that resolves with the step result (whether committed as
// CLICK after 150ms or as DOUBLE_CLICK if a second click arrives).
async function recordClickWithDedup(message, sender, tabId, sessionId) {
  const key = clickDedupKey(message, sender, tabId);

  const pending = pendingClicks.get(key);
  if (pending) {
    // Second CLICK on the same element within 150ms → convert to DOUBLE_CLICK.
    clearTimeout(pending.timer);
    pendingClicks.delete(key);

    // Build a DOUBLE_CLICK message. Use the pre-computed double-click
    // description that content attached to the FIRST click (so the label
    // logic in describe() runs once, in content, where it has access to
    // the live DOM element).
    const dblMessage = {
      ...pending.message,
      event: "DOUBLE_CLICK",
      description: pending.message.doubleClickDescription || `Double-click ${pending.message.target?.text || "the element"}.`,
      // Use the second click's cursor position (it's the most recent point).
      cursor: message.cursor || pending.message.cursor
    };

    // D1 fix: use the original pending click's sessionId, not the current
    // session — the click was captured during that session.
    const resultPromise = withSessionLock(() => doRecordEvent(dblMessage, sender, tabId, pending.sessionId));
    // Both the original CLICK1's promise and the current CLICK2 return the
    // same DOUBLE_CLICK result.
    resultPromise.then(pending.resolveRef, pending.rejectRef);
    return resultPromise;
  }

  // First CLICK — store and set timer. Return a promise that resolves when
  // the click is actually committed (either as CLICK after timer, or as
  // DOUBLE_CLICK if a second click arrives within 150ms).
  let resolveRef, rejectRef;
  const outerPromise = new Promise((res, rej) => { resolveRef = res; rejectRef = rej; });

  const timer = setTimeout(() => {
    pendingClicks.delete(key);
    // D1 fix: pass sessionId so doRecordEvent can verify the session is still
    // the same one the click was captured in.
    withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId))
      .then(resolveRef, rejectRef);
  }, CLICK_HOLD_MS);

  pendingClicks.set(key, { message, sender, tabId, timer, resolveRef, rejectRef, sessionId });
  return outerPromise;
}

// v1.6.5 fix: use sender.frameId (the actual frame ID from Chrome's runtime)
// instead of message.frame.id (which was hard-coded to 0 in content.js).
// Without this, two iframes with the same selector+bbox would collide in
// the dedup key, causing the second iframe's click to be treated as a
// double-click of the first.
function clickDedupKey(message, sender, tabId) {
  const sel = message.target?.selectors?.[0] || message.target?.tag || "";
  const x = Math.round(message.target?.boundingBox?.x || 0);
  const y = Math.round(message.target?.boundingBox?.y || 0);
  const frameId = sender?.frameId ?? 0;
  return `${tabId}|${frameId}|${sel}|${x}|${y}`;
}

// P0-2 v2: commit any pending CLICK for the given tab IMMEDIATELY as a
// CLICK step (not waiting for the 150ms timer to fire). Called when a
// NAVIGATION/NEW_TAB/NEW_WINDOW event arrives so the CLICK step precedes
// the navigation step. Also called on STOP_RECORDING so no clicks are lost.
function flushPendingClicksForTab(tabId) {
  const entries = [];
  for (const [key, pending] of pendingClicks) {
    if (pending.tabId === tabId) entries.push({ key, pending });
  }
  for (const { key, pending } of entries) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);
    // D1 fix: pass the pending click's sessionId.
    withSessionLock(() => doRecordEvent(pending.message, pending.sender, pending.tabId, pending.sessionId))
      .then(pending.resolveRef, pending.rejectRef);
  }
}

// P2-1 v1.5.2: record a DOUBLE_CLICK step, retracting any prior CLICK step
// for the same element within the last 1000ms. This handles the case where
// the OS double-click interval > CLICK_HOLD_MS (150ms) — click #1 was
// already committed as a CLICK step before click #2 (event.detail=2) arrived.
//
// Also: if there's a HELD CLICK in pendingClicks for the same element, cancel
// it (we don't need it — the DOUBLE_CLICK supersedes it).
async function recordDoubleClickWithRetract(message, sender, tabId, sessionId) {
  const key = clickDedupKey(message, sender, tabId);

  // Cancel any held CLICK for the same element — it's superseded.
  const pending = pendingClicks.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);
  }

  // Look back in session.steps for a recent CLICK on the same element.
  // If found, remove it (the DOUBLE_CLICK supersedes the CLICK).
  // v1.6.3 fix: wrap the read-modify-save in withSessionLock to prevent
  // a race where another concurrently-processed event (which correctly goes
  // through withSessionLock) reads/mutates/saves the session in between
  // our read and save, causing one of the writes to be silently lost.
  await withSessionLock(async () => {
    const session = await getSession();
    if (!session || session.status !== "recording" || session.steps.length === 0) return;
    const target = message.target || {};
    const sel = target.selectors?.[0] || target.tag || "";
    const bbox = target.boundingBox || {};
    // v1.6.7 fix: include frame ID in the retract match to prevent
    // cross-frame false positives. Two iframes can have elements with the
    // same selector and bbox — without the frame ID check, a double-click
    // in iframe B could retract a CLICK from iframe A.
    const clickFrameId = sender?.frameId ?? 0;
    // Search backwards from the most recent step (up to 5 steps back).
    for (let i = session.steps.length - 1; i >= 0 && i >= session.steps.length - 5; i--) {
      const step = session.steps[i];
      if (step.action !== "CLICK") continue;
      // v1.6.7: frame ID must match — don't retract a CLICK from a different frame
      const stepFrameId = step.frame?.id ?? 0;
      if (stepFrameId !== clickFrameId) continue;
      // Same element check: matching selector OR matching bbox (rounded).
      const stepSel = step.target?.selectors?.[0] || step.target?.tag || "";
      const stepBbox = step.target?.boundingBox || {};
      const sameElement = (sel && stepSel === sel) ||
        (Math.abs((stepBbox.x || 0) - (bbox.x || 0)) < 5 && Math.abs((stepBbox.y || 0) - (bbox.y || 0)) < 5);
      if (!sameElement) continue;
      // Within 1000ms?
      const stepTime = step.screenshot?.timestamp || 0;
      if (Date.now() - stepTime > 1000) continue;
      // Found it — remove the prior CLICK step.
      session.steps.splice(i, 1);
      // Renumber subsequent steps.
      for (let j = i; j < session.steps.length; j++) {
        session.steps[j].number = j + 1;
      }
      await saveSession(session);
      break;
    }
  });

  // Record the DOUBLE_CLICK step.
  // D1 fix: pass sessionId so doRecordEvent can verify the session.
  const result = await withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId));

  // If we cancelled a held CLICK above, resolve its promise with the DOUBLE_CLICK result.
  if (pending) {
    try { pending.resolveRef(result); } catch (_) { /* ignore */ }
  }

  return result;
}

// P0-1 v1.5.3 fix: record a SUBMIT step, retracting any prior CLICK step
// for the same element (or a submit-type button in the same form) within
// the last 1500ms. The browser fires `click` BEFORE `submit`, so by the
// time the SUBMIT event arrives, the click has already been sent to
// background. The click may be:
//   (a) HELD in pendingClicks (within the 150ms double-click hold window)
//   (b) ALREADY COMMITTED as a CLICK step in session.steps
//
// We handle both:
//   (a) Cancel the held CLICK (resolve its promise with the SUBMIT result).
//   (b) Splice the prior CLICK step out of session.steps and renumber.
//
// "Same element" check: matching selector OR matching bbox OR the prior
// CLICK's target was a submit-type button inside a form whose submit was
// triggered. We search back up to 5 steps and within 1500ms (longer than
// CLICK_HOLD_MS because the submit event may take a few extra ms to fire
// after the click).
async function recordSubmitWithRetract(message, sender, tabId, sessionId) {
  // Look up the submitter's element info from the message.
  const submitTarget = message.target || {};
  const submitSel = submitTarget.selectors?.[0] || submitTarget.tag || "";
  const submitBbox = submitTarget.boundingBox || {};

  // Helper: does a CLICK step's target match the SUBMIT's target?
  const matchesSubmitTarget = (clickStep) => {
    if (clickStep.action !== "CLICK") return false;
    const clickTarget = clickStep.target || {};
    const clickSel = clickTarget.selectors?.[0] || clickTarget.tag || "";
    const clickBbox = clickTarget.boundingBox || {};
    // Match by selector (most reliable).
    if (submitSel && clickSel && submitSel === clickSel) return true;
    // Match by bbox (within 5px tolerance — handles slight layout shifts).
    if (Math.abs((clickBbox.x || 0) - (submitBbox.x || 0)) < 5 &&
        Math.abs((clickBbox.y || 0) - (submitBbox.y || 0)) < 5) return true;
    // Match by tag+text: a submit button click followed by a submit event
    // on the same form. The click's target is typically a <button> or
    // <input type="submit">; the submit's target may be the form or the
    // submitter button. Check if either's text matches.
    const submitText = (submitTarget.text || "").toLowerCase().trim();
    const clickText = (clickTarget.text || "").toLowerCase().trim();
    if (submitText && clickText && submitText === clickText) return true;
    return false;
  };

  // (a) Cancel any held CLICK in pendingClicks that matches.
  const cancelledClicks = [];
  for (const [key, pending] of pendingClicks) {
    if (pending.tabId !== tabId) continue;
    // Synthesize a step-like object to test against the matcher.
    const pseudoStep = { action: "CLICK", target: pending.message.target };
    if (matchesSubmitTarget(pseudoStep)) {
      clearTimeout(pending.timer);
      pendingClicks.delete(key);
      cancelledClicks.push(pending);
    }
  }

  // (b) Retract any committed CLICK step that matches.
  // v1.6.3 fix: wrap the read-modify-save in withSessionLock to prevent
  // a race where another concurrently-processed event (which correctly goes
  // through withSessionLock) reads/mutates/saves the session in between
  // our read and save, causing one of the writes to be silently lost.
  // v1.6.7 fix: also check frame ID to prevent cross-frame false positives.
  const submitFrameId = sender?.frameId ?? 0;
  await withSessionLock(async () => {
    const session = await getSession();
    if (!session || session.status !== "recording" || session.steps.length === 0) return;
    // Search backwards from the most recent step (up to 5 steps back).
    for (let i = session.steps.length - 1; i >= 0 && i >= session.steps.length - 5; i--) {
      const step = session.steps[i];
      if (step.action !== "CLICK") continue;
      // v1.6.7: frame ID must match — don't retract a CLICK from a different frame
      const stepFrameId = step.frame?.id ?? 0;
      if (stepFrameId !== submitFrameId) continue;
      if (!matchesSubmitTarget(step)) continue;
      // Within 1500ms?
      const stepTime = step.screenshot?.timestamp || 0;
      if (Date.now() - stepTime > 1500) continue;
      // Found it — remove the prior CLICK step.
      session.steps.splice(i, 1);
      // Renumber subsequent steps.
      for (let j = i; j < session.steps.length; j++) {
        session.steps[j].number = j + 1;
      }
      await saveSession(session);
      break; // only retract one
    }
  });

  // Record the SUBMIT step.
  // D1 fix: pass sessionId so doRecordEvent can verify the session.
  const result = await withSessionLock(() => doRecordEvent(message, sender, tabId, sessionId));

  // Resolve any cancelled held-CLICK promises with the SUBMIT result so
  // their callers don't hang.
  for (const pending of cancelledClicks) {
    try { pending.resolveRef(result); } catch (_) { /* ignore */ }
  }

  return result;
}

async function doRecordEvent(message, sender, tabId, expectedSessionId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false };

  // F1 fix: don't capture events while a full-page capture is in progress.
  // Full-page capture scrolls the page, hides/shows overlays, and captures
  // screenshots — a concurrent event capture would interfere with the scroll
  // position, masks, cursor overlay, and badge. The event is silently
  // dropped (returns ok:false) so the content script's send() resolves
  // without hanging. The user's click was real but capturing its screenshot
  // during full-page scroll would produce a corrupted image.
  if (fullPageCaptureInProgress) return { ok: false, skipped: "full_page_capture_in_progress" };

  // D1 fix: verify the event belongs to the CURRENT session. Without this,
  // a pending click/event from recording A could fire after recording B
  // starts and be saved into B. expectedSessionId is captured at enqueue time.
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

  // P1-2 v1.5.2 fix: use the cumulative frame transform from the message
  // (computed by the iframe's content script via the BTR_FRAME_HANDSHAKE_ACK
  // protocol with its parent). This handles arbitrary nesting depth AND CSS
  // scaling/transforms on iframes. Falls back to the v1.5.1 GET_IFRAME_OFFSET
  // lookup path if the transform isn't present (e.g., the handshake hasn't
  // completed yet).
  //
  // The PREPARE_CAPTURE message still uses the ORIGINAL frame-local coords
  // because the iframe's content script paints the cursor/halo inside the
  // iframe document, which appears at the right viewport position naturally.
  let frameTransform = message.frameTransform || null;
  // Fallback: if the iframe sent a frameNonce but no transform (handshake
  // hasn't completed yet), query the top-level frame for the offset.
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
    } catch (_) { /* ignore — fall back to no offset (frame-local coords) */ }
  }
  // Default: identity transform (top frame or no transform available).
  const transform = frameTransform || { offsetX: 0, offsetY: 0, scale: 1 };

  // Apply the transform to stored target / cursor (NOT to PREPARE_CAPTURE).
  // For non-uniform scaling, we use the per-axis scaleX/scaleY if present,
  // else fall back to the uniform `scale` field.
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

  // P0-5 fix: wrap capture in try/finally so cleanup is unconditional.
  // C2 fix: prepareCapture MUST be inside the try block so that if it throws
  // (e.g. sendToTab fails, getSettings rejects, scripting.executeScript
  // rejects), finishCapture still runs and removes any overlays already
  // painted by PREPARE_CAPTURE. Without this, a prepareCapture failure
  // leaves cursor/halo/mask overlays stuck on the page.
  const result = await serializeTransaction(async () => {
    // PREPARE_CAPTURE uses ORIGINAL frame-local coords — the iframe's
    // content script paints the cursor/halo inside its own document,
    // which appears at the right viewport position naturally.
    try {
      await prepareCapture(tabId, {
        point: target?.point || null,
        boundingBox: target?.boundingBox || null,
        action: message.event,
        showCursor: showCursor && Boolean(target?.point)
      }, frameId);

      const screenshot = await captureVisibleTab(tab, settings.screenshotFormat, settings.screenshotQuality);
      // C4 fix: don't create a step if the screenshot capture failed. The old
      // code stored {image:null, status:"FAILED"} and returned {ok:true},
      // producing a broken step that looked successful to the user.
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
        width: message.viewport?.width || 0,
        height: message.viewport?.height || 0,
        devicePixelRatio: message.viewport?.devicePixelRatio || 1,
        url: message.url || "",
        timestamp: Date.now()
      },
      annotations: []
    };
    // P1-2 v1.5.1: store the viewport-adjusted cursor (not the frame-local one).
    if (storedCursor) step.cursor = storedCursor;
    // P1-2 v1.5.2: also record the frame transform so the editor / preview
    // can know the click came from an iframe and was translated. Includes
    // the scale (useful for editor to render annotations correctly on
    // CSS-scaled iframes).
    if ((tx || ty) || (sx !== 1 || sy !== 1)) {
      step.frameTransform = { offsetX: tx, offsetY: ty, scaleX: sx, scaleY: sy, scale: transform.scale };
    }

    session.steps.push(step);
    await saveSession(session);

    return { ok: true, stepNumber: step.number };
    } finally {
      // P0-5 fix: always clean up capture overlays, even if an error occurred
      await finishCapture(tabId, frameId);
    }
  });

  return result;
}

// ---------------------------------------------------------------------------
// Stop + finalise
// ---------------------------------------------------------------------------

// F2 fix: extracted finalization body. This assumes the caller already holds
// withSessionLock — so stopSession() wraps it in the lock, and START_RECORDING
// can call it inside its own lock without re-entrant deadlock.
async function _finalizeSessionLocked(session) {
  if (!session) return null;
  // NM10/M2 fix: if this session was already finalized (SW died between
  // dbPut and storage.local.remove), the tutorial is already in IDB.
  // Don't create a duplicate — just clean up the session and return the
  // already-saved tutorial.
  // E2 fix: if the tutorial is NOT in IDB (because the earlier dbPut failed),
  // reconstruct it from session.steps and retry the save before deleting
  // the session. The old code returned null and deleted the session —
  // permanently losing all captured steps.
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

// P0-2 v2 (v1.5.1): flush ALL pending CLICKs across ALL tabs. Used by
// stopSession and DISCARD_RECORDING so no clicks are lost when the user
// stops recording during the 150ms double-click hold window.
function flushAllPendingClicks() {
  for (const [key, pending] of pendingClicks) {
    clearTimeout(pending.timer);
    pendingClicks.delete(key);
    // D1 fix: pass the pending click's sessionId.
    withSessionLock(() => doRecordEvent(pending.message, pending.sender, pending.tabId, pending.sessionId))
      .then(pending.resolveRef, pending.rejectRef);
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "GET_STATE":
      // v1.0.3: return lightweight session metadata WITHOUT screenshot data.
      // The popup polls this every 1s and only needs title/status/stepCount.
      // Returning full screenshots caused multi-MB transfers every second.
      return { session: await getLightweightSession() };

    case "START_RECORDING": {
      // F2 fix: the entire start operation (including stopping any existing
      // session) is now inside withSessionLock. The old code called getSession()
      // and stopSession() OUTSIDE the lock — two concurrent START_RECORDING
      // calls could both see no session and both create one. Now
      // _finalizeSessionLocked() replaces stopSession() inside the lock,
      // avoiding re-entrant deadlock (stopSession itself calls withSessionLock).
      return await withSessionLock(async () => {
        const existing = await getSession();
        if (existing) {
          // F2 fix: finalize the old session inside the lock (no deadlock).
          await _finalizeSessionLocked(existing);
        }
        // C1 fix: allow the dashboard to pass an explicit tabId (since the
        // dashboard tab itself is "active" in the dashboard's window). Fall
        // back to currentTab() for the popup / keyboard-shortcut paths.
        let tab;
        if (message.tabId) {
          tab = await chrome.tabs.get(message.tabId).catch(() => null);
        } else {
          tab = await currentTab();
        }
        if (!tab?.id || !isValidPage(tab.url)) {
          return { ok: false, error: "This page cannot be recorded by Chrome." };
        }
        // Re-check: another START_RECORDING may have created a session while
        // we were finalizing the old one. If so, bail.
        const rechecked = await getSession();
        if (rechecked) {
          return { ok: false, error: "A recording is still being finalized. Please try again." };
        }

        const settings = await getSettings();
        const session = createSession(tab);
        session.excludedDomains = Array.isArray(message.excludedDomains) ? message.excludedDomains : [];
        await saveSession(session);
        // H1 fix: validate sendToTab result. If the content script can't be
        // reached (injection failure, tab navigated to chrome://, etc.),
        // remove the session and surface an error so the popup doesn't show
        // "Recording…" while no content.js is actually listening.
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
      // The editor sends a specific tabId to capture.
      if (!message.tabId) return { ok: false, error: "No tab specified." };
      // H6 fix: mutual exclusion on CAPTURE_FULL_PAGE. Two concurrent calls
      // (double-click, editor retry) would interleave scroll positioning and
      // produce corrupted stitched screenshots. The guard is in-memory —
      // acceptable because the SW rarely dies mid-capture and a stale guard
      // just blocks one extra request.
      if (fullPageCaptureInProgress) return { ok: false, error: "A full-page capture is already in progress. Please wait for it to finish." };
      fullPageCaptureInProgress = true;
      const targetTab = await chrome.tabs.get(message.tabId).catch(() => null);
      if (!targetTab) { fullPageCaptureInProgress = false; return { ok: false, error: "Tab not found." }; }
      if (!isValidPage(targetTab.url)) { fullPageCaptureInProgress = false; return { ok: false, error: "This page cannot be captured." }; }
      // Remember the sender (editor) tab so we can restore focus after capture.
      const editorTabId = sender.tab?.id;
      const editorWindowId = sender.tab?.windowId;
      // Focus the target tab and its window so captureVisibleTab works.
      await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      // P2-2 v1.5.2 fix: wrap captureFullPage in try/finally so editor focus
      // is ALWAYS restored, even if captureFullPage throws (e.g., tab closed
      // mid-capture, scripting permission revoked, etc.). Without this the
      // user is left on the captured tab instead of returned to the editor.
      // P0-1 v1.5.2 fix: captureFullPage now returns {captures, nestedCaptures}
      // instead of a flat array. Spread both into the response so editor.js
      // can keep using response.captures (image-only) and optionally consume
      // response.nestedCaptures in the future.
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
      // Backwards-compat: if captureFullPage returned a bare array (older
      // code path), wrap it. Otherwise use the new {captures, nestedCaptures} shape.
      if (Array.isArray(result)) {
        return { ok: true, captures: result, nestedCaptures: [], truncated: false, captureError: null };
      }
      return {
        ok: true,
        captures: result.captures || [],
        nestedCaptures: result.nestedCaptures || [],
        // B5 fix: surface truncation to editor.js so it can warn the user.
        truncated: result.truncated === true,
        // C2 fix: surface capture failure to editor.js
        captureError: result.captureError || null
      };
    }

    case "PAUSE_RECORDING":
    case "RESUME_RECORDING": {
      // P1-5 fix: use session lock
      return withSessionLock(async () => {
        const session = await getSession();
        if (!session) return { ok: false, error: "No active recording." };
        session.status = message.type === "PAUSE_RECORDING" ? "paused" : "recording";
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
      // P0-4 fix: use session lock so discard waits for in-flight events
      // P0-2 v2 (v1.5.1): also clear pending CLICKs — discarded recordings
      // shouldn't leave dangling timers that could fire after the session
      // is gone (they'd no-op anyway, but clearing is cleaner).
      // v1.6.5 fix: clearTimeout on each pending click's timer BEFORE
      // clearing the Map. Map.clear() removes references but doesn't cancel
      // the timers — they'd still fire and call doRecordEvent, which would
      // no-op (session gone) but still waste CPU and leave dangling promises.
      for (const [, pending] of pendingClicks) {
        clearTimeout(pending.timer);
        // C9 fix: resolve the pending click's promise so the originating
        // content-script send() call doesn't hang indefinitely. The old
        // code cleared timers but never called resolveRef/rejectRef, leaving
        // dangling promises in the content script's runtime.
        try { pending.resolveRef({ ok: false, discarded: true }); } catch (_) { /* ignore */ }
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
      // P2-2 v1.5.1 fix: return tutorials WITHOUT base64 screenshot data
      // for each step. The dashboard previously called GET_TUTORIALS which
      // loaded every tutorial's every step's screenshot into memory — for
      // a library of 50 tutorials averaging 20 steps each, that's 1,000
      // multi-MB base64 strings parsed and held in JS memory just to render
      // the dashboard grid.
      //
      // SUMMARY shape includes:
      //   - All top-level metadata (id, title, description, status, dates, version)
      //   - For each step: id, number, action, description (for search),
      //     screenshot.image ONLY for the first step that has one (for the
      //     thumbnail). All other steps' screenshots are excluded.
      //   - Annotation counts (for the stats panel)
      //
      // When the user opens a tutorial for editing/preview, the editor
      // already calls GET_TUTORIAL (singular) which uses dbGet(id) — that
      // path was fixed in v1.0.9 to only load the one record.
      //
      // D15 fix: use dbGetAllSummaries() instead of dbGetAll() + .map().
      // The old code loaded EVERY tutorial (with EVERY base64 screenshot)
      // into memory via dbGetAll(), then stripped screenshots in JS. For a
      // large library this caused high memory use and SW pressure. The new
      // cursor-based approach processes one record at a time and discards
      // the full record before the next iteration.
      const summaries = await dbGetAllSummaries();
      return { tutorials: summaries };
    }

    case "GET_TUTORIAL": {
      // v1.0.9: use dbGet(id) instead of dbGetAll() + find().
      const tutorial = await dbGet(message.id);
      return { tutorial: tutorial || null };
    }

    case "SAVE_TUTORIAL":
      // H2 fix: normalize before saving so invalid dimensions, non-sanitized
      // colors, overlong titles, and non-alphanumeric IDs can't be persisted.
      if (message.tutorial) {
        try { await dbPut(normalizeTutorial(message.tutorial)); }
        catch (e) { return { ok: false, error: String(e?.message || e) }; }
      }
      return { ok: true };

    case "DUPLICATE_TUTORIAL": {
      if (!message.id) return { ok: false, error: "Missing tutorial id." };
      // P2-13 fix: use dbGet instead of dbGetAll to avoid loading entire library
      const source = await dbGet(message.id);
      if (!source) return { ok: false, error: "Tutorial not found." };
      // H2 fix: normalize the source before producing the copy.
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
      // S3 fix: broadcast so dashboards/settings pages re-load.
      chrome.runtime.sendMessage({ type: "TUTORIALS_CHANGED" }).catch(() => {});
      return { ok: true };

    case "DELETE_TUTORIALS": {
      const ids = Array.isArray(message.ids) ? message.ids : [];
      // D5 fix: don't swallow the error. The old code `.catch(() => 0)`
      // returned deleted=0 with ok:true, making a failed deletion look
      // successful to the dashboard while tutorials remained in IndexedDB.
      try {
        const deleted = await dbDeleteAll(ids);
        chrome.runtime.sendMessage({ type: "TUTORIALS_CHANGED" }).catch(() => {});
        return { ok: true, deleted };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }

    case "PAUSE_FROM_IDLE": {
      // P1-5 fix: use session lock
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

// ---------------------------------------------------------------------------
// Tab lifecycle listeners
// ---------------------------------------------------------------------------

// NH4 fix: wrap async chrome-event listener bodies in try/catch so an
// unhandled rejection does not silently abort the listener and leave the
// session in an inconsistent state. This also prevents "unhandled promise
// rejection" warnings in the SW console.
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    const session = await getSession();
    // Session status is only ever "recording" or "paused". If there's no
    // session or no tab.id, bail out.
    if (!session || !tab.id) return;
    // Only treat new tabs opened from a tab that belongs to this session as
    // part of the workflow. This filters out unrelated tabs the user may open
    // via Ctrl+T / window controls while a recording is in progress.
    if (!tab.openerTabId || !session.tabIds.includes(tab.openerTabId)) return;

  // A tab opened mid-recording is part of the workflow (incl. new windows).
  // P0-01 fix: determine window-newness BEFORE addTabToSession, which adds
  // the windowId to session.windowIds, making the subsequent check always false.
  const isNewWindow = tab.windowId != null && !session.windowIds.includes(tab.windowId);
  await addTabToSession(session, tab);

  // v1.6.6 fix: move pendingNewTabs.set and RECORDER_ATTACH INSIDE
  // withSessionLock, and re-check the session ID inside the lock. The previous
  // v1.6.5 fix re-checked getSession() but that check was NOT atomic with
  // pendingNewTabs.set — between the re-check and the set, the session could
  // be stopped and a new one started, causing the old session's pendingNewTabs
  // entry to contaminate the new recording. Now the entire sequence is atomic.
  await withSessionLock(async () => {
    const currentSession = await getSession();
    // If the session was stopped/discarded/replaced while we waited for the
    // lock, bail out — don't set pendingNewTabs or send RECORDER_ATTACH.
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

// P0-1 fix: track last-recorded navigation URL per tab to prevent duplicates
// P1-7 fix: persist to chrome.storage.session so it survives SW termination
const lastNavUrlByTab = new Map();
// D6 fix: pending navigation URLs (deferred from loading→complete)
const pendingNavUrls = new Map();

async function persistLastNavUrls() {
  try {
    await chrome.storage.session.set({ lastNavUrls: [...lastNavUrlByTab] });
  } catch (_) {}
}

// Restore on startup
try {
  chrome.storage.session.get("lastNavUrls", (result) => {
    if (result?.lastNavUrls && Array.isArray(result.lastNavUrls)) {
      for (const [tabId, url] of result.lastNavUrls) lastNavUrlByTab.set(tabId, url); persistLastNavUrls();
    }
  });
} catch (_) {}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // NH4 fix: wrap entire body in try/catch so an unhandled rejection doesn't
  // silently abort tab navigation handling and leave the session in a bad state.
  try {
  // v1.6.6 fix: read the session INSIDE the session lock and re-check the
  // session ID inside the lock. The previous code read the session BEFORE
  // acquiring the lock, then used the stale `session` reference inside the
  // lock — so if the session was stopped and a new one started while waiting
  // for the lock, the old session's excludedDomains/status were used for
  // RECORDER_ATTACH, and NAVIGATION/NEW_TAB steps could be recorded into the
  // wrong (new) session.
  await withSessionLock(async () => {
    const session = await getSession();
    if (!session || !session.tabIds.includes(tabId)) return;

    // D6 fix: navigation capture timing. The old code captured on
    // `changeInfo.url && status !== "complete"` — which includes `loading`,
    // so the screenshot could be of a partially-loaded page. Now we defer
    // the screenshot to the `complete` event via a pending-URL map. For
    // SPA navigations (where the document remains loaded), we still capture
    // early since there's no `complete` event for pushState.
    const pendingNavUrl = pendingNavUrls.get(tabId);
    if (changeInfo.url && changeInfo.status === "loading") {
      // A full document load started. Defer the screenshot to `complete`.
      pendingNavUrls.set(tabId, changeInfo.url);
      return;
    }
    if (changeInfo.url && changeInfo.status !== "complete" && !pendingNavUrl) {
      // SPA navigation (no loading→complete cycle). Capture early.
      if (!isValidPage(changeInfo.url)) {
        pendingNewTabs.delete(tabId);
        lastNavUrlByTab.delete(tabId); persistLastNavUrls();
        await persistPendingNewTabs();
        return;
      }
      const lastUrl = lastNavUrlByTab.get(tabId);
      if (lastUrl !== changeInfo.url && !pendingNewTabs.has(tabId)) {
        // P0-1 fix: wait briefly for SPA to render before capturing.
        await new Promise((r) => setTimeout(r, 200));
        await sendToTab(tabId, { type: "RECORDER_NAVIGATION", url: changeInfo.url });
        lastNavUrlByTab.set(tabId, changeInfo.url); persistLastNavUrls();
      }
      return;
    }

    if (changeInfo.status !== "complete") return;

    // D6 fix: if we had a pending navigation URL (from a loading event),
    // capture it now that the document is complete.
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

// Capture a full page by scrolling through it. Returns an array of
// { image, scrollY } captures — caller (editor) stitches them as needed.
// Fix H4: read actual scrollY after each scroll (not requested) so captures
// align correctly; crop the overlap region between captures during stitching.
//
// v1.5.1 P1-3: also scroll independently-scrollable nested containers (e.g.
//   sidebars) whose content is not in the document's vertical scroll range.
//   Their captures are returned with a `nested` field so the editor can
//   stitch them appropriately.
//
// v1.5.1 P1-4: re-check document height DURING the capture loop (not just
//   before). Lazy-loaded content can extend the page after the loop starts,
//   which previously caused the bottom section to be missed.
//
// v1.5.1 P1-5: recursively hide fixed/sticky elements in shadow DOM and
//   same-origin iframes (not just the top-level document). Fixed headers
//   inside an iframe can still repeat in stitched screenshots.
async function captureFullPage(tab) {
  // P0-1 v1.5.2 fix: the previous v1.5.1 code pushed nested-scroller captures
  // into the SAME `captures` array as the main vertical captures. editor.js
  // assumes every entry in `captures` is an `{image, scrollY, viewportHeight}`
  // object — the nested entries have a different shape (`{nested:true,
  // selector, captures:[...], rect}`), so `loadImage(c.image)` got `undefined`
  // and the whole full-page capture failed.
  //
  // Fix: keep the main `captures` array image-only. Return nested-scroller
  // captures as a SEPARATE `nestedCaptures` field on the result object.
  // editor.js can ignore `nestedCaptures` for now (they're best-effort
  // auxiliary captures that the editor doesn't yet know how to stitch).
  // This restores full-page capture to working order on pages with nested
  // scroll containers.
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
  } catch (e) { /* ignore — fall back to defaults */ }

  // H4 fix: send CAPTURE_SCROLL_START BEFORE the warm-up (not after). The
  // warm-up itself scrolls to bottom and back — without suppression, those
  // scrolls would be recorded as SCROLL steps in the tutorial.
  await sendToTab(tab.id, { type: "CAPTURE_SCROLL_START" }, null).catch(() => {});

  // B25: wait for lazy-loaded images to load before capturing.
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
  } catch (e) { /* ignore */ }

  // P1 fix: re-query doc height after lazy-load warm-up (lazy content may
  // have increased the page height).
  try {
    const [dhResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.scrollHeight
    });
    if (typeof dhResult?.result === "number") docHeight = dhResult.result;
  } catch (e) { /* ignore */ }

  // P1-03 fix: hide recorder badge before full-page capture
  await sendToTab(tab.id, { type: "HIDE_STATUS" }, 0).catch(() => {});

  // NC1 fix: broadcast PREPARE_CAPTURE with maskOnly:true to ALL frames so
  // sensitive fields (passwords, credit cards, 2FA codes, etc.) are masked
  // before the scroll-capture loop begins. Without this, the full-page
  // capture path skips sensitive-field masking entirely (the regular
  // doRecordEvent pipeline calls prepareCapture, but captureFullPage does
  // NOT), leaking sensitive data into the tall stitched screenshot.
  await sendToTab(tab.id, {
    type: "PREPARE_CAPTURE",
    maskOnly: true,
    point: null,
    boundingBox: null,
    action: "FULL_PAGE",
    showCursor: false
  }, null).catch(() => {});
  // Give every frame a moment to paint its masks.
  const fpSettings = await getSettings();
  await new Promise((r) => setTimeout(r, Math.max(50, fpSettings.captureDelay || 220)));
  await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});

  // P1-5 v1.5.1 fix: recursively hide fixed/sticky elements in shadow DOM
  // and same-origin iframes (not just the top-level document). Cross-origin
  // iframes can't be inspected from the parent — their own content script
  // would need to participate (best-effort; we accept that cross-origin
  // iframes' fixed elements may still repeat in stitched screenshots).
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Walk a subtree, descending into shadow roots and same-origin iframes.
        const hidden = []; // { el, visibility, ownerLabel }
        const visit = (root, label) => {
          if (!root) return;
          // Find all descendants with position fixed/sticky
          const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
          for (const el of allEls) {
            // Skip non-Element nodes
            if (!el.style) continue;
            const style = getComputedStyle(el);
            if ((style.position === "fixed" || style.position === "sticky") && el !== document.body) {
              hidden.push({ el, visibility: el.style.visibility, label });
              el.style.visibility = "hidden";
            }
            // Recurse into shadow DOM
            if (el.shadowRoot) {
              visit(el.shadowRoot, `${label} > #shadow-root`);
            }
            // Recurse into same-origin iframes (cross-origin throws on contentDocument access)
            if (el.tagName === "IFRAME") {
              try {
                const doc = el.contentDocument;
                if (doc) visit(doc, `${label} > iframe`);
              } catch (_) { /* cross-origin — skip */ }
            }
          }
        };
        visit(document, "document");
        window.__btr_hidden_fixed = hidden;
      }
    });
  } catch (_) { /* ignore */ }

  // v1.6.7 fix: also hide fixed/sticky elements in ALL frames (including
  // cross-origin iframes). The scripting.executeScript above only runs in
  // the top-level frame's context, so cross-origin iframe fixed/sticky
  // elements (e.g., a toolbar inside an embed) would repeat throughout the
  // stitched screenshot. We broadcast a HIDE_FIXED_ELEMENTS message to all
  // frames — each content script hides fixed/sticky elements in its own
  // document and stores the originals for restoration.
  await sendToTab(tab.id, { type: "HIDE_FIXED_ELEMENTS" }, null).catch(() => {});

  // B5 fix: declare `truncated` outside the try block so the return statement
  // (which is outside the try/finally) can read it. Set inside the try when
  // the MAX_CAPTURES limit is hit before reaching the bottom of the page.
  let truncated = false;

  // P1-12 fix: wrap capture loop in try/finally for unconditional cleanup
  try {
    const step = Math.max(100, Math.floor(viewportHeight * 0.7));
    let safetyCounter = 0;
    // P1-4 v1.5.2 fix: raise MAX_CAPTURES from 60 to 200. With a 720px
    // viewport and 0.7 step (~504px), 60 captures cover ~30,240px which is
    // too short for long documentation/dashboards/articles. 200 captures
    // cover ~100,800px — well beyond typical page heights and still safe
    // (the MAX_CANVAS_AREA guard in editor.js clamps the final stitched image
    // to browser canvas limits).
    //
    // P2-5 v1.5.3 fix: when scrolling produces no progress (we hit the
    // bottom OR a "load more" boundary), wait 800ms (instead of the regular
    // 350ms) to give async content loaders time to fetch and render new
    // content. Check if scrollHeight grew during the wait; if yes, continue
    // the loop. Only break after 3 consecutive no-progress iterations where
    // scrollHeight didn't grow. Previously broke after 2 consecutive
    // no-progress iterations, which could terminate the capture while a
    // lazy section was still loading.
    const MAX_CAPTURES = 200;
    const NO_PROGRESS_WAIT_MS = 800; // extended wait for lazy content
    const NO_PROGRESS_THRESHOLD = 3; // 3 consecutive no-growth → break
    let lastScrollY = -1;
    let lastDocHeight = docHeight;
    let noProgressCount = 0;
    for (let y = 0; y <= docHeight && safetyCounter < MAX_CAPTURES; y += step, safetyCounter++) {
      let actualY = y;
      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          // C3 fix: temporarily disable smooth scrolling during the capture
          // loop. On pages with `scroll-behavior:smooth`, window.scrollTo()
          // returns before the scroll animation completes — the recorded
          // scrollY and the actual screenshot position would disagree. We
          // set `scroll-behavior:auto` on the documentElement, scroll, read
          // the actual position, then restore the original value. This
          // affects ONLY the capture loop; normal page scrolling is untouched
          // after restoration.
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
      // P2-5 v1.5.3: if scroll didn't advance, wait longer for lazy content
      // and check if scrollHeight grew. Only count as "no progress" if BOTH
      // scrollY AND scrollHeight didn't change.
      if (actualY === lastScrollY) {
        // Wait extended period for async loaders to fire.
        await new Promise((r) => setTimeout(r, NO_PROGRESS_WAIT_MS));
        // Re-check scrollHeight to see if lazy content loaded.
        try {
          const [dhResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.scrollHeight
          });
          if (typeof dhResult?.result === "number") {
            docHeight = Math.max(docHeight, dhResult.result);
          }
        } catch (_) { /* ignore */ }
        if (docHeight > lastDocHeight) {
          // Page grew — lazy content loaded. Reset no-progress and continue.
          noProgressCount = 0;
          lastDocHeight = docHeight;
          // Don't break — fall through to capture + height re-check.
        } else {
          noProgressCount++;
          if (noProgressCount >= NO_PROGRESS_THRESHOLD) break;
          // Skip the capture for this iteration (we'd just re-capture the
          // same view as the last one). Continue the loop with y += step.
          lastScrollY = actualY;
          continue;
        }
      } else {
        noProgressCount = 0;
      }
      lastScrollY = actualY;
      await new Promise((r) => setTimeout(r, 350));
      // C1 fix: refresh masks after every scroll, immediately before each
      // captureVisibleTab. Masks are position:fixed so they don't follow the
      // element when the page scrolls. Also, lazy-loaded content may have
      // introduced new sensitive fields since the initial masking. The
      // refreshMasks() function now re-discovers fields AND repositions
      // existing masks. Without this, a password field lower on the page
      // would be captured unmasked in the full-page screenshot.
      await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});
      const shot = await serializeTransaction(() => captureVisibleTab(tab, "png"));
      // C2 fix: a failed main-page capture must not be silently skipped.
      // The old code `if (shot.image) captures.push(...)` meant a missing
      // section was stitched into an apparently-valid FULL_PAGE image.
      // Now abort the entire full-page capture on the first failure — the
      // editor will show "Full-page capture failed" instead of a misleading
      // partial result.
      if (!shot.image) {
        return { captures, nestedCaptures: [], truncated: false, captureError: shot.error || "Screenshot capture failed during full-page capture." };
      }
      captures.push({ image: shot.image, scrollY: actualY, viewportHeight });

      // P1-4 v1.5.1 fix: re-check doc height AFTER each scroll. Lazy content
      // can extend the page after the capture loop starts; without this, the
      // bottom section would be missed (e.g., infinite-scroll feeds that
      // load more content as the user scrolls down).
      try {
        const [dhResult] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.documentElement.scrollHeight
        });
        if (typeof dhResult?.result === "number") {
          docHeight = Math.max(docHeight, dhResult.result);
          lastDocHeight = docHeight;
        }
      } catch (_) { /* ignore — keep previous docHeight */ }
    }
    // B5 fix: detect silent truncation. If the loop exited because
    // safetyCounter hit MAX_CAPTURES but y hasn't reached docHeight, the
    // page is longer than the capture capacity.
    // `truncated` is declared above the try block so the return can read it.
    // F5 fix: also check on no-progress break — the loop can exit early when
    // scroll stops advancing (3 consecutive no-growth iterations), which may
    // happen before the bottom of the page. The old code only checked
    // `safetyCounter >= MAX_CAPTURES`, missing the no-progress exit path.
    // G6 fix: removed dead `|| true` — the check now runs unconditionally
    // for all exit paths, which was the intent all along.
    {
      // Re-check final docHeight to see if we actually reached the bottom.
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
      } catch (_) { /* ignore */ }
    }
  } finally {
    // P1-12 fix: always restore scroll position and badge, even on error
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scrollY) => window.scrollTo(0, scrollY),
        args: [originalScrollY]
      });
    } catch (e) { /* ignore */ }
    // P1 fix: restore fixed/sticky elements visibility (top-level + nested)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (window.__btr_hidden_fixed) {
            for (const { el, visibility } of window.__btr_hidden_fixed) {
              try { el.style.visibility = visibility; } catch (_) { /* element gone */ }
            }
            delete window.__btr_hidden_fixed;
          }
        }
      });
    } catch (_) { /* ignore */ }
    // v1.6.7: restore fixed/sticky elements in ALL frames (cross-origin too)
    await sendToTab(tab.id, { type: "RESTORE_FIXED_ELEMENTS" }, null).catch(() => {});
    // NC1 fix: clear the sensitive-field masks we painted above. Without
    // this, the masks stay on the page after capture.
    await sendToTab(tab.id, { type: "CLEAR_CAPTURE" }, null).catch(() => {});
    // H5 fix: CAPTURE_SCROLL_END is NOT sent here — it's sent after nested
    // capture completes (below). The old code re-enabled scroll recording
    // before the nested-scroller section, so nested scrolling could be
    // recorded as SCROLL steps.
    // P1-03 fix: restore recorder badge after full-page capture
    const session = await getSession();
    if (session?.status === "recording") {
      await sendToTab(tab.id, { type: "SHOW_STATUS", count: session.steps.length }, 0).catch(() => {});
    }
  }

  // P1-3 v1.5.1: best-effort capture of nested independently-scrollable
  // containers (sidebars, chat panels, etc.) whose content is NOT in the
  // document's vertical scroll range. We can't easily stitch these into the
  // main capture stream, so we return them as SEPARATE capture sequences
  // tagged with `nested: true` and a label. The editor can decide how to
  // display them (e.g., as auxiliary step screenshots).
  //
  // P0-1 v1.5.2 fix: nested captures are returned in a SEPARATE
  // `nestedCaptures` array (not mixed into the main `captures` array) so
  // editor.js's `loadImage(c.image)` doesn't choke on entries without `.image`.
  // editor.js fully stitches nestedCaptures into the final image as of v1.5.3.
  //
  // D2 fix: re-apply privacy protection (masks + fixed-element hiding) for
  // the nested capture section. The `finally` block above restored fixed
  // elements and cleared masks — so without re-applying, nested screenshots
  // would contain unmasked sensitive fields and duplicated fixed/sticky UI.
  try {
    // E6 fix: hide the recorder badge before nested capture — the main capture's
    // finally block may have re-shown it via SHOW_STATUS, and nested screenshots
    // would contain the "Recording / N steps" badge.
    await sendToTab(tab.id, { type: "HIDE_STATUS" }, 0).catch(() => {});
    // Re-mask sensitive fields in all frames.
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
    // Re-hide fixed/sticky elements in all frames.
    await sendToTab(tab.id, { type: "HIDE_FIXED_ELEMENTS" }, null).catch(() => {});
    const [nestedResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const candidates = [];
        let counter = 0;
        // D9 fix: recursively traverse shadow DOM and same-origin iframe
        // documents to discover nested scrollers — matching the traversal
        // already used for sensitive-field masking and fixed-element hiding.
        // E4 fix: also carry the iframe transform (offset + scale) down the
        // recursion so that the stored rect is in TOP-LEVEL viewport coords
        // (not iframe-local). The editor stitches nested captures into the
        // top-level screenshot, so iframe-local coords produce wrong crops.
        // E5 fix: the rect stored for a scroller inside an iframe must be
        // transformed to top-level coordinates.
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
              // E5 fix: transform local rect to top-level viewport coords
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
            // Recurse into shadow DOM (same coordinate system)
            if (el.shadowRoot) visit(el.shadowRoot, offsetX, offsetY, scaleX, scaleY);
            // Recurse into same-origin iframes — transform coordinates
            if (el.tagName === "IFRAME") {
              try {
                const doc = el.contentDocument;
                if (doc) {
                  const iframeRect = el.getBoundingClientRect();
                  // The iframe's contentDocument coords are relative to the
                  // iframe's viewport. Transform them to top-level by adding
                  // the iframe's position (already in the parent's coord system)
                  // and applying the parent's scale.
                  visit(doc, offsetX + scaleX * iframeRect.left, offsetY + scaleY * iframeRect.top, scaleX, scaleY);
                }
              } catch (_) { /* cross-origin — skip */ }
            }
          }
        };
        visit(document, 0, 0, 1, 1);
        return candidates.slice(0, 5); // cap to avoid pathological pages
      }
    });
    const nestedScrollers = Array.isArray(nestedResult?.result) ? nestedResult.result : [];

    for (const scroller of nestedScrollers) {
      // For each nested scroller, capture a sequence by scrolling it.
      const scrollerSequence = [];
      const nestedStep = Math.max(100, Math.floor(scroller.clientHeight * 0.7));
      // v1.6.4 fix: don't fix nestedMax at the start — re-check scrollHeight
      // during the loop so lazy-loaded/virtualized content that extends the
      // scroller mid-capture is included. We use a dynamic upper bound that
      // grows as scrollHeight grows, capped at 20 to avoid pathological pages.
      let nestedMax = Math.min(20, Math.ceil(scroller.scrollHeight / nestedStep));
      try {
        for (let i = 0; i < nestedMax; i++) {
          const yTarget = i * nestedStep;
          // D8 fix: read the ACTUAL scrollTop after setting it, and disable
          // smooth scrolling on the scroller during capture (same approach as
          // the main page). The old code stored yTarget (the requested position)
          // which could differ from the actual position due to scroll clamping,
          // snapping, or smooth scrolling — causing wrong overlap calculations.
          // E4 fix: use recursive findScrollerById instead of document.querySelector
          // — the scroller may be inside a shadow root or iframe that top-level
          // querySelector can't reach.
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
          // G3 fix: refresh masks after each nested scroll, just like the main
          // capture loop does. Masks are position:fixed — when a nested scroller
          // scrolls, sensitive fields inside it move but their masks don't.
          await sendToTab(tab.id, { type: "REFRESH_MASKS" }, null).catch(() => {});
          const shot = await serializeTransaction(() => captureVisibleTab(tab, "png"));
          if (shot.image) scrollerSequence.push({ image: shot.image, scrollY: actualNestedY, viewportHeight: scroller.clientHeight });
          // v1.6.4: re-check scrollHeight after each scroll. If the scroller
          // grew (lazy content loaded), extend nestedMax — but never beyond 20.
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
          } catch (_) { /* ignore recheck failure */ }
        }
      } catch (_) { /* skip this scroller on error */ }
      // Restore the scroller's original position
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
      } catch (_) { /* ignore */ }
      // Remove the data-btr-scroller-id attribute (cleanup)
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
      } catch (_) { /* ignore */ }
      // P0-1 v1.5.2: push into nestedCaptures (separate from main captures).
      if (scrollerSequence.length > 0) {
        nestedCaptures.push({
          scrollerId: scroller.scrollerId,
          rect: scroller.rect,
          captures: scrollerSequence
        });
      }
    }
  } catch (_) { /* ignore — nested capture is best-effort */ }
  // D2 fix: clean up the re-applied privacy protection after nested capture.
  // G15 fix: track cleanup failures and retry once — the old code silently
  // swallowed failures, which could leave the page in a modified state
  // (masks still visible, fixed elements still hidden, badge still hidden).
  for (const cleanupMsg of [
    { type: "RESTORE_FIXED_ELEMENTS" },
    { type: "CLEAR_CAPTURE" },
    { type: "CAPTURE_SCROLL_END" }
  ]) {
    const cleanupOk = await sendToTab(tab.id, cleanupMsg, null).catch(() => null);
    if (cleanupOk === null) {
      // Retry once after a brief delay — the content script may have been
      // temporarily unavailable (e.g., the tab was backgrounded).
      await new Promise((r) => setTimeout(r, 100));
      await sendToTab(tab.id, cleanupMsg, null).catch(() => {});
    }
  }
  // E6 fix: restore the recorder badge after nested capture.
  const sessionAfterNested = await getSession();
  if (sessionAfterNested?.status === "recording") {
    await sendToTab(tab.id, { type: "SHOW_STATUS", count: sessionAfterNested.steps.length }, 0).catch(() => {});
  }
  // D7 fix: re-enable SCROLL recording after nested capture too (in case
  // the main finally block was bypassed by the early return for captureError).
  await sendToTab(tab.id, { type: "CAPTURE_SCROLL_END" }, null).catch(() => {});

  // P0-1 v1.5.2: return nestedCaptures as a separate field so editor.js's
  // image-only consumer of `captures` doesn't break.
  // B5 fix: return `truncated` so editor.js can warn the user.
  // C2 fix: return `captureError` if a main capture failed mid-loop.
  return { captures, nestedCaptures, truncated, captureError: null };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // NH4 fix: wrap in try/catch for the same reason as the other listeners.
  try {
    if (pendingNewTabs.delete(tabId)) await persistPendingNewTabs();
    // E9 fix: clean up pendingNavUrls so a tab closed mid-navigation doesn't
    // leave a stale entry that could affect a recycled tab ID.
    pendingNavUrls.delete(tabId);
    // M1 fix: also clean up lastNavUrlByTab so the Map doesn't grow
    // unboundedly over a long browsing session, and so a recycled tab ID
    // doesn't inherit the closed tab's last URL (which would suppress a
    // legitimate NAVIGATION step via the dedup check).
    if (lastNavUrlByTab.delete(tabId)) await persistLastNavUrls();
    // P1-05 fix: use session lock so tab removal doesn't race with recording
    await withSessionLock(async () => {
      const session = await getSession();
      if (!session) return;
      session.tabIds = session.tabIds.filter((id) => id !== tabId);
      await saveSession(session);
    });
  } catch (e) { console.warn("[BTR] onRemoved handler failed:", e); }
});

// L8: chrome.windows.onCreated fires for new windows. Chrome fires
// chrome.tabs.onCreated for the first tab in a new window too, so this
// listener is a safety net — if a window is created with no tabs (rare),
// we don't miss it. No-op for now; left as a hook for future use.
chrome.windows.onCreated?.addListener(async (_window) => {
  // Intentionally empty — onCreated for the first tab in the window will
  // fire chrome.tabs.onCreated, which already adds the tab to the session
  // if its openerTabId is owned.
});

// Persist pendingNewTabs to chrome.storage.session so it survives service
// worker termination (B9). On SW startup we restore the Map below.
async function persistPendingNewTabs() {
  try {
    await chrome.storage.session.set({ pendingNewTabs: [...pendingNewTabs] });
  } catch (e) { /* storage.session may be unavailable in tests */ }
}

// Restore pendingNewTabs on SW startup so we don't lose NEW_TAB events.
try {
  chrome.storage.session.get("pendingNewTabs", (result) => {
    if (result?.pendingNewTabs && Array.isArray(result.pendingNewTabs)) {
      for (const [tabId, kind] of result.pendingNewTabs) pendingNewTabs.set(tabId, kind);
    }
  });
} catch (e) { /* ignore */ }

// v1.0.1: on SW startup, re-attach content scripts to all session-owned
// tabs. If the SW was terminated while a recording was in progress, the
// content scripts in those tabs may have lost their message listener
// registration. This ensures recording continues seamlessly.
// H5 fix: re-attach for both "recording" AND "paused" sessions. The
// previous check (`!== "recording"`) skipped paused sessions, leaving them
// orphaned after SW restart — when the user later clicked Resume, the
// freshly-injected content.js had no masking/excluded-domain state.
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
      } catch (e) { /* tab may be gone */ }
    }
  } catch (e) { console.warn("[BTR] onStartup handler failed:", e); }
});

// Also re-attach on SW install/update (covers the case where the SW is
// woken up by a message rather than a browser startup).
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
      } catch (e) { /* tab may be gone */ }
    }
  } catch (e) { console.warn("[BTR] onInstalled handler failed:", e); }
});

// ---------------------------------------------------------------------------
// Global keyboard commands (Chrome commands API)
// ---------------------------------------------------------------------------

// NH4 fix: wrap commands listener in try/catch so a rejection doesn't leave
// the keyboard-shortcut path silently dead.
chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case "start-recording": {
        // F2 fix: move the entire operation inside withSessionLock, including
        // finalizing any existing session. Uses _finalizeSessionLocked (not
        // stopSession) to avoid re-entrant deadlock.
        await withSessionLock(async () => {
          const existingKb = await getSession();
          if (existingKb) {
            await _finalizeSessionLocked(existingKb);
          }
          const tab = await currentTab();
          // v1.0.3: show user feedback when the page can't be recorded (was silent).
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
          // Read excluded domains from chrome.storage.local (synced by popup).
          const stored = await chrome.storage.local.get("btr-excluded-domains");
          session.excludedDomains = Array.isArray(stored["btr-excluded-domains"]) ? stored["btr-excluded-domains"] : [];
          await saveSession(session);
          const settings = await getSettings();
          // H1 fix: validate sendToTab result.
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
      // P0-4 fix: use session lock
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
