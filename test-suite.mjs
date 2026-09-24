import { readFileSync } from "node:fs";
import nodeAssert from "node:assert/strict";

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  try {
    nodeAssert.ok(cond, label);
    passed++;
  } catch (e) {
    failed++;
    failures.push(label);
  }
}

function section(name) {
  console.log(`\n━ ${name} ━`);
}

function eq(a, b, label) {
  try {
    nodeAssert.deepEqual(a, b, label);
    passed++;
  } catch {
    failed++;
    failures.push(`${label} (got ${JSON.stringify(a)?.slice(0, 80)}, want ${JSON.stringify(b)?.slice(0, 80)})`);
  }
}

/* ------------------------------------------------------------------ */
section("shared.js — normalize + sanitize + helpers");

import {
  normalizeTutorial, sanitizeImageUrl, sanitizeFilename, toSummary,
  formatBytes, formatDuration, stripImages, tutorialNeedsMigration, makeId, clone
} from "./shared.js";

const goodTutorial = {
  id: "tut-1",
  title: "  My tutorial  ",
  steps: [{
    id: "s1",
    action: "CLICK",
    description: "Click the button",
    url: "https://example.com/page",
    target: { selector: "#btn", tag: "button", text: "Go" },
    screenshot: { image: "data:image/png;base64,AAA", width: 800, height: 600, timestamp: 1 },
    annotations: [{ id: "a1", type: "marker", x: 10, y: 10, w: 5, h: 5 }]
  }]
};

{
  const n = normalizeTutorial(goodTutorial);
  assert(n.id === "tut-1", "normalizeTutorial keeps id");
  assert(n.title === "My tutorial", "normalizeTutorial trims title");
  assert(n.schemaVersion === 1, "normalizeTutorial sets schemaVersion 1");
  assert(n.steps.length === 1, "normalizeTutorial keeps steps");
  assert(n.steps[0].number === 1, "normalizeTutorial renumbers steps");
  assert(n.steps[0].screenshot.image === "data:image/png;base64,AAA", "normalizeTutorial keeps valid image URL");
  assert(n.steps[0].annotations.length === 1, "normalizeTutorial keeps valid annotations");
}
{
  const n = normalizeTutorial({ steps: "nope" });
  assert(n.steps.length === 0, "normalizeTutorial tolerates bad steps");
  assert(n.title === "Untitled tutorial", "normalizeTutorial defaults title");
  assert(n.steps.length === 0, "no crash on junk");
  const m = normalizeTutorial({ steps: [{ action: "CLICK" }] });
  assert(m.steps.length === 1 && m.steps[0].id, "normalizeTutorial generates step ids");
}
{
  eq(sanitizeImageUrl("data:image/png;base64,AAA"), "data:image/png;base64,AAA", "sanitizeImageUrl accepts png data URL");
  eq(sanitizeImageUrl("data:image/jpeg;base64,AAA"), "data:image/jpeg;base64,AAA", "sanitizeImageUrl accepts jpeg data URL");
  eq(sanitizeImageUrl("javascript:alert(1)"), "", "sanitizeImageUrl blocks javascript:");
  eq(sanitizeImageUrl(""), "", "sanitizeImageUrl blocks empty");
  eq(sanitizeImageUrl("http://evil.com/x.png"), "", "sanitizeImageUrl blocks http URLs");
  eq(sanitizeImageUrl(null), "", "sanitizeImageUrl blocks null");
}
{
  eq(sanitizeFilename("My Cool Tutorial!"), "My-Cool-Tutorial", "sanitizeFilename strips exclamation");
  eq(sanitizeFilename("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij", "sanitizeFilename strips illegal chars");
  eq(sanitizeFilename("  ..hidden..  "), "hidden", "sanitizeFilename trims dots/spaces");
  eq(sanitizeFilename(""), "tutorial", "sanitizeFilename falls back");
  eq(sanitizeFilename("日本語チュートリアル"), "日本語チュートリアル", "sanitizeFilename keeps unicode");
  eq(sanitizeFilename("x".repeat(300)).length <= 120, true, "sanitizeFilename caps length");
}
{
  const s = toSummary({ id: "t", title: "T", steps: [{ screenshot: { image: "data:image/png;base64,A" } }, { screenshot: { image: "" } }] });
  assert(s.stepCount === 2, "toSummary counts steps");
  assert(s.thumbnail === "data:image/png;base64,A", "toSummary picks first available thumbnail");
  const noShot = toSummary({ id: "t", title: "T", steps: [] });
  assert(noShot.thumbnail === "", "toSummary handles no screenshots");
}
{
  eq(formatBytes(500), "500 B", "formatBytes bytes");
  eq(formatBytes(2048), "2.0 KB", "formatBytes KB");
  eq(formatBytes(3 * 1024 * 1024), "3.00 MB", "formatBytes MB");
  eq(formatDuration(65000), "1:05", "formatDuration 1:05");
  eq(formatDuration(0), "0:00", "formatDuration zero");
  eq(formatDuration(600000), "10:00", "formatDuration 10:00");
}
{
  const stripped = stripImages(goodTutorial);
  assert(stripped.steps[0].screenshot.image === "", "stripImages clears images");
  assert(goodTutorial.steps[0].screenshot.image === "data:image/png;base64,AAA", "stripImages does not mutate original");
}
{
  assert(tutorialNeedsMigration(goodTutorial) === true, "legacy tutorial needs migration");
  assert(tutorialNeedsMigration(normalizeTutorial(goodTutorial)) === false, "normalized tutorial needs no migration");
  assert(tutorialNeedsMigration(null) === true, "null needs migration");
}
{
  assert(makeId("x").startsWith("x-"), "makeId prefix");
  assert(makeId("x") !== makeId("x"), "makeId uniqueness");
  const c = clone({ a: { b: 1 } });
  c.a.b = 2;
  assert(clone({ a: { b: 1 } }).a.b === 1, "clone is deep");
}

/* ------------------------------------------------------------------ */
section("settings-store.js — defaults, combos, conflicts");

import { normalizeSettings, normalizeCombo, findShortcutConflicts, DEFAULT_SETTINGS } from "./settings-store.js";

{
  const s = normalizeSettings({});
  assert(s.captureDelayMs === DEFAULT_SETTINGS.captureDelayMs, "defaults captureDelayMs");
  assert(s.screenshotFormat === "png", "defaults format png");
  assert(s.theme === "system", "defaults theme system");
  assert(Array.isArray(s.sensitivePatterns) && s.sensitivePatterns.length > 0, "defaults sensitive patterns");
  assert(s.editorShortcuts && s.editorShortcuts.undo, "defaults editor shortcuts");
  const clamped = normalizeSettings({ captureDelayMs: 99999, screenshotQuality: 1, autoPauseIdleSec: -5, gifFrameDelayMs: 0 });
  assert(clamped.captureDelayMs === 3000, "clamps capture delay high");
  assert(clamped.screenshotQuality === 30, "clamps quality low");
  assert(clamped.autoPauseIdleSec === 0, "clamps idle to zero");
  assert(clamped.gifFrameDelayMs === 100, "clamps gif delay");
  const fmt = normalizeSettings({ screenshotFormat: "bmp" });
  assert(fmt.screenshotFormat === "png", "rejects unknown format");
  const badPatterns = normalizeSettings({ sensitivePatterns: ["ok", "", 42, "  spaced  "] });
  eq(badPatterns.sensitivePatterns, ["ok", "spaced"], "filters bad sensitive patterns");
}
{
  eq(normalizeCombo("Ctrl+Shift+Z"), "Ctrl+Shift+Z", "normalizeCombo canonical order");
  eq(normalizeCombo("shift+ctrl+z"), "Ctrl+Shift+Z", "normalizeCombo sorts modifiers");
  eq(normalizeCombo("z"), "Z", "normalizeCombo uppercases single key");
  eq(normalizeCombo("Ctrl+Shift"), "", "normalizeCombo rejects modifier-only");
  eq(normalizeCombo("Ctrl+A+B"), "", "normalizeCombo rejects two keys");
  eq(normalizeCombo("Escape"), "Escape", "normalizeCombo keeps named keys");
}
{
  const conflicts = findShortcutConflicts({ undo: "Ctrl+Z", redo: "Ctrl+Z", save: "Ctrl+S" });
  assert(conflicts.length === 1, "detects one conflict");
  eq(conflicts[0].actions, ["undo", "redo"], "conflict reports both actions");
  assert(findShortcutConflicts({ undo: "Ctrl+Z", redo: "Ctrl+Shift+Z" }).length === 0, "no false conflicts");
}

/* ------------------------------------------------------------------ */
section("recorder-core.js — the recording state machine");

import { createRecorder, isInternalUrl, describeUrl, sameTarget, nextScrollY } from "./recorder-core.js";

function newRecorder() {
  let t = 1000000;
  return createRecorder({
    now: () => (t += 100),
    newId: (() => { let i = 0; return (p) => `${p}-${++i}`; })()
  });
}
const CLICK_EVT = {
  event: "CLICK",
  url: "https://example.com/form",
  description: "Click the Submit button",
  target: { selector: "#submit", tag: "button", text: "Submit", point: { x: 50, y: 60 } },
  viewport: { width: 1280, height: 720, devicePixelRatio: 1 }
};
const SHOT = { image: "data:image/png;base64,SHOT", width: 1280, height: 720, dpr: 1 };

{
  const rec = newRecorder();
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "ignored", "events ignored before start");
  const session = rec.startRecording({ id: 1, windowId: 1 });
  assert(session.id.startsWith("session-"), "start creates session");
  assert(rec.isRecording() === true, "isRecording after start");
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "captured", "click captured");
  rec.commitStep(CLICK_EVT, SHOT);
  assert(rec.state.steps.length === 1 && rec.state.steps[0].number === 1, "step committed with number 1");
  assert(rec.state.steps[0].screenshot.image === SHOT.image, "step carries screenshot");
  eq(rec.state.steps[0].action, "CLICK", "step action recorded");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  eq(rec.handleEvent({ ...CLICK_EVT, url: "chrome://settings" }, { tabId: 1 }).action, "ignored", "internal pages ignored");
  eq(rec.handleEvent({ ...CLICK_EVT, url: "file:///etc/passwd" }, { tabId: 1 }).action, "ignored", "file pages ignored");
  rec.setExcludedDomains(["example.com"]);
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "ignored", "excluded domain ignored");
  rec.setExcludedDomains(["other.com"]);
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "captured", "non-excluded domain captured");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.handleEvent({ ...CLICK_EVT, url: "https://example.com/a" }, { tabId: 1 });
  eq(rec.handleEvent({ event: "NAVIGATION", url: "https://example.com/b", target: null, description: "" }, { tabId: 1 }).action, "captured", "navigation captured");
  eq(rec.handleEvent({ event: "NAVIGATION", url: "https://example.com/b", target: null, description: "" }, { tabId: 1 }).action, "ignored", "duplicate navigation ignored");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.handleEvent(CLICK_EVT, { tabId: 1 });
  rec.commitStep(CLICK_EVT, SHOT);
  rec.handleEvent({ ...CLICK_EVT, event: "DOUBLE_CLICK" }, { tabId: 1 });
  rec.commitStep({ ...CLICK_EVT, event: "DOUBLE_CLICK" }, SHOT);
  assert(rec.state.steps.length === 1, "DOUBLE_CLICK retracts prior CLICK");
  eq(rec.state.steps[0].action, "DOUBLE_CLICK", "double-click step recorded");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.handleEvent(CLICK_EVT, { tabId: 1 });
  rec.commitStep(CLICK_EVT, SHOT);
  const submitEvt = { ...CLICK_EVT, event: "SUBMIT", description: "Submit the form" };
  rec.handleEvent(submitEvt, { tabId: 1 });
  rec.commitStep(submitEvt, SHOT);
  assert(rec.state.steps.length === 1, "SUBMIT retracts prior CLICK same target");
  eq(rec.state.steps[0].action, "SUBMIT", "submit step recorded");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  const scroll = (y) => ({ event: "SCROLL", url: "https://example.com/", target: { scrollY: y }, description: "Scroll the page" });
  rec.handleEvent(scroll(100), { tabId: 1 });
  rec.commitStep(scroll(100), SHOT);
  eq(rec.handleEvent(scroll(200), { tabId: 1 }).action, "ignored", "small scroll coalesced");
  eq(rec.handleEvent(scroll(800), { tabId: 1 }).action, "captured", "big scroll captured");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.setPaused(true, "manual");
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "ignored", "events ignored while paused");
  rec.setPaused(false);
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).action, "captured", "events resume after unpause");
  eq(rec.uiState().session.status, "recording", "uiState reflects resume");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.handleEvent(CLICK_EVT, { tabId: 1 });
  rec.commitStep(CLICK_EVT, SHOT);
  rec.commitStep({ ...CLICK_EVT, description: "Second" }, SHOT);
  rec.commitStep({ ...CLICK_EVT, description: "Third" }, SHOT);
  rec.state.steps.pop();
  eq(rec.state.steps.map((s) => s.number), [1, 2], "renumber keeps sequence");
  rec.handleEvent(CLICK_EVT, { tabId: 2 });
  rec.commitStep(CLICK_EVT, SHOT);
  assert(rec.state.session.tabIds.includes(2), "new tab joined session");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  const evt = rec.addSystemStep("NAVIGATION", 1, "https://example.com/target");
  assert(evt && evt.description.includes("example.com"), "system NAVIGATION described");
  eq(rec.handleEvent(evt, { tabId: 1 }).action, "captured", "system NAVIGATION passes handleEvent (dedupe already ran in addSystemStep)");
  rec.commitStep(evt, SHOT);
  eq(rec.addSystemStep("NAVIGATION", 1, "https://example.com/target"), null, "system NAVIGATION deduped");
  const nt = rec.addSystemStep("NEW_TAB", 2, "about:blank");
  assert(nt && nt.description === "Open a new tab", "NEW_TAB described");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.handleEvent(CLICK_EVT, { tabId: 1 });
  rec.commitStep(CLICK_EVT, SHOT);
  const draft = rec.exportDraft();
  const rec2 = createRecorder({ now: () => 1, newId: (p) => `${p}-r2` });
  rec2.rehydrate(JSON.parse(JSON.stringify(draft)));
  assert(rec2.isActive() === true, "rehydrate restores active session");
  assert(rec2.isRecording() === false, "rehydrated session starts paused");
  eq(rec2.state.steps.length, 1, "rehydrate restores steps");
  eq(rec2.state.steps[0].number, 1, "rehydrated steps renumbered");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.commitStep(CLICK_EVT, SHOT);
  const tut = rec.buildTutorial({ title: "Fresh" });
  assert(tut.schemaVersion === 1, "tutorial schema version 1");
  eq(tut.title, "Fresh", "tutorial title override");
  assert(tut.steps.length === 1 && tut.durationMs >= 0, "tutorial carries steps + duration");
  rec.reset();
  assert(rec.isActive() === false, "reset clears session");
}
{
  assert(isInternalUrl("chrome://extensions") === true, "isInternalUrl chrome");
  assert(isInternalUrl("") === true, "isInternalUrl empty");
  assert(isInternalUrl("https://ok.com") === false, "isInternalUrl https ok");
  eq(describeUrl("https://mail.google.com/mail/u/0"), "mail.google.com/mail/u/0", "describeUrl host+path");
  assert(sameTarget({ selector: "#a" }, { selector: "#a" }) === true, "sameTarget by selector");
  assert(sameTarget({ selector: "", text: "Go" }, { selector: "", text: "Go" }) === true, "sameTarget by text");
  assert(sameTarget(null, null) === false, "sameTarget nulls");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  rec.commitStep({ ...CLICK_EVT, event: "CLICK", description: "d1" }, SHOT);
  rec.commitStep({ ...CLICK_EVT, event: "TYPE", description: "d2" }, null);
  assert(rec.state.steps[1].screenshot.status === "FAILED", "missing screenshot marked FAILED");
  assert(rec.state.steps[1].screenshot.image === "", "missing screenshot empty image");
}

/* ------------------------------------------------------------------ */
section("gif-encoder.js — GIF89a structure");

import { encodeGif } from "./gif-encoder.js";

function fakeFrame(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
  }
  return {
    width, height,
    getContext: () => ({ getImageData: () => ({ data }) })
  };
}

{
  const blob = encodeGif([fakeFrame(8, 8, [255, 0, 0]), fakeFrame(8, 8, [0, 255, 0])], 500);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert(bytes.length > 40, "gif has bytes");
  const header = String.fromCharCode(...bytes.slice(0, 6));
  eq(header, "GIF89a", "gif magic verified");
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  eq(width, 8, "gif logical width");
  eq(height, 8, "gif logical height");
  assert((bytes[10] & 0x80) !== 0, "global color table flag set");
  let gceCount = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) gceCount++;
  }
  eq(gceCount, 2, "one graphic control extension per frame");
  eq(bytes[bytes.length - 1], 0x3b, "gif trailer");
  const allBytes = String.fromCharCode(...bytes);
  assert(allBytes.includes("NETSCAPE2.0"), "netscape loop block present");
  try {
    encodeGif([], 500);
    assert(false, "encodeGif rejects empty frames");
  } catch { passed++; }
}

/* ------------------------------------------------------------------ */
section("exporter.js — sanitized image loading");

import { loadImage } from "./exporter.js";

{
  try {
    await loadImage("javascript:alert(1)");
    assert(false, "loadImage rejects javascript: URLs");
  } catch (e) {
    assert(String(e.message).includes("no screenshot"), "loadImage javascript: blocked with sanitization error");
  }
  try { await loadImage(""); assert(false, "loadImage rejects empty"); }
  catch (e) { assert(String(e.message).includes("no screenshot"), "loadImage empty blocked"); }
  try { await loadImage(null); assert(false, "loadImage rejects null"); }
  catch (e) { assert(String(e.message).includes("no screenshot"), "loadImage null blocked"); }
}

/* ------------------------------------------------------------------ */
section("content.js — real content script in jsdom");

import { JSDOM } from "jsdom";

{
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <form id="f"><input type="password" id="pw" name="password"><input id="user" aria-label="Username"><button type="submit" id="go">Submit</button></form>
    <select id="lang"><option>EN</option></select>
    <a href="#" id="link1">Read more</a>
  </body></html>`, { url: "https://example.com/app", runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;
  let sent = [];
  window.chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: () => {} }
    }
  };
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\-\u0080-\uffff]/g, (c) => "\\" + c);
  }
  const src = readFileSync(new URL("./content.js", import.meta.url), "utf8");
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = src;
  window.document.body.appendChild(scriptEl);
  const hooks = window.__btrTest;
  assert(hooks && typeof hooks.buildSelector === "function", "content script evaluates and exposes test hooks");

  const doc = window.document;
  eq(hooks.buildSelector(doc.getElementById("pw")), "#pw", "buildSelector uses unique id");
  eq(hooks.fieldLabel(doc.getElementById("pw")), "password", "fieldLabel falls back to name");
  eq(hooks.fieldLabel(doc.getElementById("user")), "Username", "fieldLabel prefers aria-label");
  eq(hooks.describe("CLICK", doc.getElementById("go")), 'Click "Submit"', "describe CLICK quotes the element (professional phrasing)");
  eq(hooks.describe("TYPE", doc.getElementById("user")), 'Type into "Username"', "describe TYPE quotes the field");
  eq(hooks.describe("TYPE", doc.getElementById("user"), { text: "ada@example.com" }), 'Type "ada@example.com" into "Username"', "describe TYPE includes the typed text");
  eq(hooks.describe("DOUBLE_CLICK", doc.getElementById("link1")), 'Double-click "Read more"', "describe DOUBLE_CLICK quotes the text");
  assert(hooks.isSensitiveField(doc.getElementById("pw")) === true, "password field is sensitive");
  assert(hooks.isSensitiveField(doc.getElementById("user")) === false, "username field not sensitive");
  eq(hooks.collectSensitiveFields().length, 1, "collectSensitiveFields finds masked fields");
  eq(hooks.getState().attached, false, "content starts detached");
  assert(sent.some((m) => m && m.type === "CS_HELLO"), "content script says hello on load");
  dom.window.close();
}

/* ------------------------------------------------------------------ */
section("integration — full recording sequence");

{
  const rec = newRecorder();
  rec.startRecording({ id: 7, windowId: 1 });
  const seq = [
    { event: "NAVIGATION", url: "https://shop.example.com/", target: null, description: "Navigate to shop.example.com" },
    { ...CLICK_EVT, description: "Click the Buy now button" },
    { ...CLICK_EVT, event: "TYPE", description: "Type into the Search box" },
    { ...CLICK_EVT, event: "SUBMIT", description: "Submit the form (Search)" }
  ];
  for (const evt of seq) {
    rec.handleEvent(evt, { tabId: 7 });
    rec.commitStep(evt, SHOT);
  }
  const tut = rec.buildTutorial({});
  eq(tut.steps.length, 3, "sequence yields 3 steps (click retracted by submit)");
  eq(tut.steps[0].action, "NAVIGATION", "first step is navigation");
  eq(tut.steps[2].action, "SUBMIT", "last step is submit");
  assert(tut.steps.every((s) => s.number === s.number && s.id), "steps numbered and identified");
  assert(normalizeTutorial(JSON.parse(JSON.stringify(tut))).steps.length === 3, "recorded tutorial survives normalize round-trip");
}

/* ------------------------------------------------------------------ */
section("integration — background ⇄ content message bus (loop regression)");

{
  const CAP = 300;
  const bus = { count: 0, overflow: false, log: [] };
  const framesByTab = new Map();
  const bgMessageHandlers = [];

  function countMessage(kind, direction) {
    bus.count++;
    bus.log.push(`${direction}:${kind}`);
    if (bus.count > CAP) bus.overflow = true;
  }

  function deliverToBackground(message, sender) {
    countMessage(message && message.type, "c2bg");
    if (bus.overflow) return;
    for (const h of [...bgMessageHandlers]) h(message, sender, () => {});
  }

  function deliverToFrames(tabId, message, frameId) {
    const frames = framesByTab.get(tabId) || [];
    for (const f of frames) {
      if (typeof frameId === "number" && f.frameId !== frameId) continue;
      countMessage(message && message.type, "bg2c");
      if (bus.overflow) return;
      for (const h of [...f.handlers]) h(message, { tab: { id: tabId, windowId: 1 } }, () => {});
    }
  }

  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async (tabId, message, opts) => { deliverToFrames(tabId, message, opts && opts.frameId); },
      captureVisibleTab: async () => "data:image/png;base64,MOCKSHOT",
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  await import("./background.js");
  assert(bgMessageHandlers.length === 1, "background registers its message handler");

  const contentSrc = readFileSync(new URL("./content.js", import.meta.url), "utf8");

  function makeFrame(frameId, url) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body><input type="password" name="password"><button id="b">Go</button></body></html>`, { url, runScripts: "outside-only" });
    const { window } = dom;
    if (!window.CSS) window.CSS = {};
    if (!window.CSS.escape) {
      window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\-\u0080-\uffff]/g, (c) => "\\" + c);
    }
    const handlers = [];
    window.chrome = {
      runtime: {
        // Real content scripts carry our extension id AND the host page URL.
        sendMessage: (msg) => { deliverToBackground(msg, { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId, url }); return Promise.resolve(); },
        onMessage: { addListener: (fn) => handlers.push(fn) }
      }
    };
    window.eval(contentSrc);
    const entry = { frameId, window, handlers, dom };
    framesByTab.set(1, [...(framesByTab.get(1) || []), entry]);
    return entry;
  }

  const top = makeFrame(0, "https://example.com/app");
  const sub = makeFrame(1, "https://cdn.example.com/embed");

  const startRes = await new Promise((resolve) => {
    // The popup is an extension page WITHOUT a tab; its sender.url is our own.
    bgMessageHandlers[0]({ type: "START_RECORDING" }, { id: "btr-test-ext", url: "chrome-extension://btr-test-ext/popup.html" }, resolve);
  });
  assert(startRes && startRes.ok === true, "START_RECORDING responds ok over the bus");

  await new Promise((r) => setTimeout(r, 400));
  const countA = bus.count;
  await new Promise((r) => setTimeout(r, 400));
  const countB = bus.count;

  assert(bus.overflow === false, "message bus never overflows (no hello/attach loop)");
  assert(bus.count < 60, `message count bounded after start (${bus.count} messages)`);
  assert(countA === countB, `messages quiesce after start (${countA} → ${countB})`);

  assert(top.window.__btrTest.getState().attached === true, "top frame attached after start");
  assert(sub.window.__btrTest.getState().attached === true, "sub frame attached after start");
  assert(top.window.__btrTest.getState().paused === false, "top frame unpaused on attach");

  const helloCount = bus.log.filter((l) => l === "c2bg:CS_HELLO").length;
  const hooksBefore = top.window.__btrTest;
  top.window.eval(contentSrc);
  assert(top.window.__btrTest === hooksBefore, "double injection is a no-op (idempotent guard)");
  assert(bus.log.filter((l) => l === "c2bg:CS_HELLO").length === helloCount, "double injection sends no second hello");

  const recBefore = bus.log.filter((l) => l === "c2bg:REC_EVENT").length;
  top.window.document.getElementById("b").click();
  await new Promise((r) => setTimeout(r, 1200));
  const recAfter = bus.log.filter((l) => l === "c2bg:REC_EVENT").length;
  assert(recAfter === recBefore + 1, `single click produces exactly one REC_EVENT (${recAfter - recBefore})`);
  assert(bus.overflow === false, "bus still healthy after event processing");

  top.dom.window.close();
  sub.dom.window.close();
}

/* ------------------------------------------------------------------ */
section("integration — extension pages hosted in tabs reach page handlers");

{
  const CAP = 300;
  const bus = { count: 0, overflow: false, log: [] };
  const bgMessageHandlers = [];

  function deliverToBackground(message, sender) {
    bus.count++;
    bus.log.push(`c2bg:${message && message.type}`);
    if (bus.overflow) return;
    for (const h of [...bgMessageHandlers]) h(message, sender, () => {});
  }

  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => {},
      captureVisibleTab: async () => "data:image/png;base64,MOCKSHOT",
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  // Query string busts the ES module cache: this evaluates a FRESH copy of
  // background.js against this section's chrome mock, so the routing
  // assertions below exercise the real listener registration path.
  await import("./background.js?ext-page-routing");

  // Regression: editor.html / dashboard.html / settings.html / preview.html are
  // opened in browser tabs via chrome.tabs.create or location.href. Their
  // messages carry sender.tab (the tab hosting the page) AND a
  // chrome-extension://<id>/ sender.url. The old !sender.tab check misrouted
  // them into the content-script branch, which silently dropped GET_SETTINGS /
  // GET_TUTORIAL / GET_SUMMARIES — the "No response from the recorder service"
  // boot failure. Tab identity must be irrelevant for extension pages.
  // Every call races a 500 ms timeout so a routing regression fails the test
  // cleanly instead of hanging the suite on a never-resolving sendResponse.
  const callBg = (message, sender) => Promise.race([
    new Promise((resolve) => { bgMessageHandlers[0](message, sender, resolve); }),
    new Promise((r) => setTimeout(() => r(undefined), 500))
  ]);

  const editorSender = {
    id: "btr-test-ext",
    tab: { id: 42, windowId: 3 },
    frameId: 0,
    url: "chrome-extension://btr-test-ext/editor.html?id=tut-abc123"
  };

  const settingsRes = await callBg({ type: "GET_SETTINGS" }, editorSender);
  assert(settingsRes && settingsRes.ok === true, "tab-hosted editor page receives GET_SETTINGS response");
  assert(settingsRes.settings && typeof settingsRes.settings === "object", "GET_SETTINGS returns settings payload");

  const uiRes = await callBg({ type: "GET_UI_STATE" }, editorSender);
  assert(uiRes && uiRes.ok === true && uiRes.uiState, "tab-hosted page receives GET_UI_STATE response");

  // GET_SUMMARIES touches IndexedDB (unavailable in Node — the response body
  // is ok:false here), so this only asserts that A response is delivered at
  // all: under the old misrouting no response ever arrives.
  const summariesRes = await callBg({ type: "GET_SUMMARIES" }, editorSender);
  assert(summariesRes !== undefined, "tab-hosted page receives a GET_SUMMARIES response (routing proven)");

  const dashSender = { id: "btr-test-ext", tab: { id: 43, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/dashboard.html" };
  const pingRes = await callBg({ type: "PING" }, dashSender);
  assert(pingRes && pingRes.ok === true, "tab-hosted dashboard page receives PING response");

  // Content scripts (our extension id + host page https URL) must NOT reach
  // page handlers even when a tab is attached.
  let contentReachedPage = false;
  bgMessageHandlers[0]({ type: "PING" }, { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId: 0, url: "https://example.com/app" }, () => { contentReachedPage = true; });
  await new Promise((r) => setTimeout(r, 120));
  assert(contentReachedPage === false, "content-script sender never reaches page handlers");

  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */
section("integration — blocked screenshot capture is surfaced and steps still commit");

{
  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });
  const bgMessageHandlers = [];
  let captureAttempts = 0;

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => {},
      captureVisibleTab: async () => { captureAttempts++; throw new Error("Missing permission for captureVisibleTab"); },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  // Fresh background copy against a captureVisibleTab that always throws —
  // exactly what users hit when host permissions do not satisfy the
  // captureVisibleTab requirement (regressed in v2.0.0: http/https patterns
  // instead of <all_urls>).
  await import("./background.js?capture-fail");

  const startRes = await new Promise((resolve) => {
    bgMessageHandlers[0]({ type: "START_RECORDING" }, { id: "btr-test-ext", url: "chrome-extension://btr-test-ext/popup.html" }, resolve);
  });
  assert(startRes && startRes.ok === true, "recording starts even with a throwing captureVisibleTab");

  bgMessageHandlers[0](
    { type: "REC_EVENT", event: "CLICK", url: "https://example.com/app", frameUrl: "https://example.com/app", isIframe: false, frameNonce: null, description: "Click the Go button", target: { selector: "#b", tag: "button", text: "Go", point: { x: 10, y: 10 } }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
    { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId: 0, url: "https://example.com/app" },
    () => {}
  );

  await new Promise((r) => setTimeout(r, 1500));

  eq(captureAttempts, 2, "starting Navigate step + the click each attempt one capture");
  const uiRes = await new Promise((resolve) => {
    bgMessageHandlers[0]({ type: "GET_UI_STATE" }, { id: "btr-test-ext", tab: { id: 42, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/popup.html" }, resolve);
  });
  assert(uiRes && uiRes.ok === true && uiRes.uiState, "GET_UI_STATE responds after failed capture");
  assert(uiRes.uiState.captureBlocked === true, "captureBlocked surfaces in uiState when screenshots fail");
  assert(uiRes.uiState.session && uiRes.uiState.session.stepCount === 2, "the Navigate opener + the click both commit without images when capture fails");

  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */
section("common-ui.js — bgCall retries transient no-response");

{
  let calls = 0;
  globalThis.chrome = {
    runtime: { sendMessage: async () => { calls++; return calls === 1 ? undefined : { ok: true, value: "rescued" }; } }
  };
  const { bgCall } = await import("./common-ui.js");
  const res = await bgCall({ type: "PING" });
  assert(res.value === "rescued", "bgCall retries once after an undefined response");
  eq(calls, 2, "bgCall retry count");
}
{
  globalThis.chrome = { runtime: { sendMessage: async () => undefined } };
  const { bgCall } = await import("./common-ui.js");
  try { await bgCall({ type: "X" }); assert(false, "bgCall exhausts retries on persistent no-response"); }
  catch (e) { assert(String(e.message).includes("No response"), "bgCall surfaces no-response error after retries"); }
}
{
  let calls = 0;
  globalThis.chrome = {
    runtime: { sendMessage: async () => { calls++; throw new Error("The message port closed before a response was received."); } }
  };
  const { bgCall } = await import("./common-ui.js");
  try { await bgCall({ type: "X" }); assert(false, "port-closed propagates after retries"); }
  catch (e) { assert(String(e.message).includes("port closed"), "port-closed error surfaced"); }
  eq(calls, 4, "port-closed retried then gave up");
}
{
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: "Tutorial not found." }) } };
  const { bgCall } = await import("./common-ui.js");
  try { await bgCall({ type: "GET_TUTORIAL", id: "nope" }); assert(false, "ok:false rejects"); }
  catch (e) { eq(e.message, "Tutorial not found.", "bgCall forwards background error text"); }
  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */

section("full-page scroll planning + cursor stamp decisions (v2.0.5 regressions)");
{
  eq(nextScrollY({ y: 0, total: 5000, h: 800 }, 0), 800, "long page advances to next viewport");
  eq(nextScrollY({ y: 800, total: 5000, h: 800 }, 800), 1600, "second shot keeps advancing (old stitcher always stopped here)");
  eq(nextScrollY({ y: 4100, total: 5000, h: 800 }, 3400), 4200, "near-bottom clamps to max scroll");
  eq(nextScrollY({ y: 4200, total: 5000, h: 800 }, 3400), null, "bottom reached stops the scan");
  eq(nextScrollY({ y: 0, total: 600, h: 800 }, 0), null, "page shorter than viewport = single shot");
  eq(nextScrollY(null, 0), null, "missing position data stops safely");
}
{
  let requested = 0, shots = 0;
  const page = { total: 5000, h: 800 };
  while (shots < 40) {
    const pos = { y: Math.min(requested, page.total - page.h), total: page.total, h: page.h };
    shots++;
    const next = nextScrollY(pos, requested);
    if (next == null) break;
    requested = next;
  }
  eq(shots, 7, "5000px page stitches 7 viewport shots (old code always delivered 2)");
}
{
  const rec = newRecorder();
  rec.startRecording({ id: 1, windowId: 1 });
  eq(rec.handleEvent(CLICK_EVT, { tabId: 1 }).needsCursor, true, "click steps request the cursor stamp");
  eq(rec.handleEvent({ ...CLICK_EVT, event: "SCROLL", target: { selector: "html", tag: "html", scrollY: 400 } }, { tabId: 1 }).needsCursor, false, "scroll steps never request the cursor stamp");
  eq(rec.handleEvent({ event: "NAVIGATION", url: "https://example.com/nav", target: null, description: "" }, { tabId: 1 }).needsCursor, false, "navigation steps never request the cursor stamp");
}
{
  const { normalizeSettings } = await import("./settings-store.js");
  eq(normalizeSettings({}).showCursor, true, "showCursor defaults to on");
  eq(normalizeSettings({}).autoElementCrop, false, "auto element crop defaults OFF — steps keep the full current view");
  eq(normalizeSettings({ autoElementCrop: true }).autoElementCrop, true, "auto element crop opt-in is kept");
  eq(normalizeSettings({ autoElementCrop: false }).autoElementCrop, false, "auto element crop stays off when unset");
  eq(normalizeSettings({ showCursor: false }).showCursor, false, "showCursor opt-out is kept");
  eq(normalizeSettings({ showCursor: 0 }).showCursor, true, "showCursor only boolean false turns it off");
}

/* ------------------------------------------------------------------ */

section("v2.0.6 — captureVisibleTab quota gate (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)");

{
  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });
  const bgMessageHandlers = [];
  const captureTimes = [];
  // Chrome really throws this when the extension exceeds ~2 captures/sec —
  // exactly what the old un-gated full-page stitcher did on its 3rd shot.
  const captureMock = async () => {
    const now = Date.now();
    if (captureTimes.length && now - captureTimes[captureTimes.length - 1] < 540) {
      throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
    }
    captureTimes.push(now);
    return "data:image/png;base64,MOCKSHOT";
  };

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => {},
      captureVisibleTab: captureMock,
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  await import("./background.js?capture-gate");

  const callBg = (message, sender) => Promise.race([
    new Promise((resolve) => { bgMessageHandlers[0](message, sender, resolve); }),
    new Promise((r) => setTimeout(() => r(undefined), 500))
  ]);
  const contentSender = { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId: 0, url: "https://example.com/app" };
  const pageSender = { id: "btr-test-ext", tab: { id: 42, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/popup.html" };

  await callBg({ type: "SAVE_SETTINGS", patch: { captureDelayMs: 0 } }, pageSender);
  const startRes = await callBg({ type: "START_RECORDING" }, pageSender);
  assert(startRes && startRes.ok === true, "recording starts for the quota-gate test");

  // v2.1.0: START commits the professional opener step ("Navigate to …") —
  // wait for its capture, then measure the burst in isolation.
  for (let i = 0; i < 40; i++) {
    const ui = await callBg({ type: "GET_UI_STATE" }, pageSender);
    if (ui && ui.uiState.session && ui.uiState.session.stepCount >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const openerRes = await callBg({ type: "GET_UI_STATE" }, pageSender);
  eq(openerRes.uiState.session.stepCount, 1, "the starting Navigate step commits before any user click");
  captureTimes.length = 0;

  // Three clicks in rapid succession — the old code rate-crashed here.
  for (let i = 0; i < 3; i++) {
    bgMessageHandlers[0](
      { type: "REC_EVENT", event: "CLICK", url: "https://example.com/app", frameUrl: "https://example.com/app", isIframe: false, frameNonce: null, overlayActive: true, description: `Click button ${i}`, target: { selector: `#b${i}`, tag: "button", text: `B${i}`, point: { x: 10 + i, y: 10 } }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
      contentSender,
      () => {}
    );
  }
  await new Promise((r) => setTimeout(r, 3200));

  const uiRes = await callBg({ type: "GET_UI_STATE" }, pageSender);
  assert(uiRes && uiRes.ok === true && uiRes.uiState.session, "ui state readable after burst");
  eq(uiRes.uiState.session.stepCount, 4, "opener + all 3 rapid clicks committed steps");
  eq(captureTimes.length, 3, "captureVisibleTab called exactly once per burst step");
  assert(uiRes.uiState.captureBlocked === false, "no capture failure surfaced (gate prevented the quota throw)");
  let minGap = Infinity;
  for (let i = 1; i < captureTimes.length; i++) minGap = Math.min(minGap, captureTimes[i] - captureTimes[i - 1]);
  assert(minGap >= 540, `captures are rate-limited to <= 2/sec (min gap ${minGap}ms)`);

  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */

section("v2.0.6 — capture gate retries a genuine quota error");

{
  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });
  const bgMessageHandlers = [];
  let attempts = 0;

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => {},
      captureVisibleTab: async () => {
        attempts++;
        if (attempts === 1) throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
        return "data:image/png;base64,MOCKSHOT";
      },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  await import("./background.js?capture-retry");

  const callBg = (message, sender) => Promise.race([
    new Promise((resolve) => { bgMessageHandlers[0](message, sender, resolve); }),
    new Promise((r) => setTimeout(() => r(undefined), 500))
  ]);
  const contentSender = { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId: 0, url: "https://example.com/app" };
  const pageSender = { id: "btr-test-ext", tab: { id: 42, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/popup.html" };

  await callBg({ type: "SAVE_SETTINGS", patch: { captureDelayMs: 0 } }, pageSender);
  await callBg({ type: "START_RECORDING" }, pageSender);
  bgMessageHandlers[0](
    { type: "REC_EVENT", event: "CLICK", url: "https://example.com/app", frameUrl: "https://example.com/app", isIframe: false, frameNonce: null, overlayActive: true, description: "Click the Go button", target: { selector: "#b", tag: "button", text: "Go", point: { x: 10, y: 10 } }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
    contentSender,
    () => {}
  );
  await new Promise((r) => setTimeout(r, 2600));

  const uiRes = await callBg({ type: "GET_UI_STATE" }, pageSender);
  assert(uiRes && uiRes.uiState.session && uiRes.uiState.session.stepCount === 2, "opener + click commit even when the click's first capture hits the quota");
  eq(attempts, 3, "opener captured once; the click's quota error was retried once and then succeeded");
  assert(uiRes.uiState.captureBlocked === false, "retried capture clears captureBlocked");

  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */

section("v2.0.6 — full-page stitcher survives the capture quota and always restores the page");

{
  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });
  const bgMessageHandlers = [];
  const captureTimes = [];
  const scriptKinds = [];
  const PAGE = { w: 1280, h: 800, total: 2400 };
  const captureMock = async () => {
    const now = Date.now();
    if (captureTimes.length && now - captureTimes[captureTimes.length - 1] < 540) {
      throw new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.");
    }
    captureTimes.push(now);
    return "data:image/png;base64,MOCKSHOT";
  };
  const executeScriptMock = async (opts) => {
    const src = String(opts.func);
    if (src.includes("scrollToY")) {
      const requested = Array.isArray(opts.args) ? opts.args[0] : 0;
      return [{ result: { y: Math.min(requested, PAGE.total - PAGE.h), total: PAGE.total, h: PAGE.h } }];
    }
    if (src.includes("createElement")) { scriptKinds.push("style"); return [{ result: null }]; }
    if (src.includes("getElementById")) { scriptKinds.push("restore"); return [{ result: null }]; }
    scriptKinds.push("probe");
    return [{ result: { w: PAGE.w, h: PAGE.h, total: PAGE.total, y: 0, dpr: 1 } }];
  };

  // Minimal canvas stack so the stitch (OffscreenCanvas + createImageBitmap +
  // FileReader + data: fetch) can run under Node.
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }); }
  };
  globalThis.createImageBitmap = async () => ({ width: PAGE.w, height: PAGE.h, close() {} });
  if (typeof globalThis.FileReader === "undefined") {
    globalThis.FileReader = class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
          this.result = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
          if (this.onload) this.onload();
        });
      }
    };
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("data:")) {
      const b64 = String(url).split(",")[1] || "";
      return { blob: async () => new Blob([Buffer.from(b64, "base64")], { type: "image/png" }) };
    }
    return realFetch(url);
  };

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: executeScriptMock },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async () => {},
      captureVisibleTab: captureMock,
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  await import("./background.js?full-page");

  const editorSender = { id: "btr-test-ext", tab: { id: 42, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/editor.html?id=tut-1" };
  const res = await Promise.race([
    new Promise((resolve) => { bgMessageHandlers[0]({ type: "CAPTURE_FULL_PAGE", tabId: 1 }, editorSender, resolve); }),
    new Promise((r) => setTimeout(() => r(undefined), 12000))
  ]);

  assert(res && res.ok === true, `full-page capture succeeds under the quota gate (${res && res.ok === false ? res.error : ""})`);
  assert(res && res.screenshot && res.screenshot.width === 1280, "stitched canvas keeps the CSS width");
  assert(res && res.screenshot && res.screenshot.height === 2400, "stitched canvas spans the full 2400px page (not 2 viewports)");
  eq(captureTimes.length, 3, "2400px page needs exactly 3 viewport shots");
  eq(scriptKinds.filter((k) => k === "restore").length, 1, "page scroll + scrollbar style are restored exactly once");

  delete globalThis.fetch;
  delete globalThis.OffscreenCanvas;
  delete globalThis.createImageBitmap;
  delete globalThis.FileReader;
  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */

section("v2.0.7 — click-point overlay only: no cursor follower (content.js in jsdom)");

{
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <button id="b">Go</button>
  </body></html>`, { url: "https://example.com/app", runScripts: "dangerously", pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  const contentListeners = [];
  window.chrome = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: (fn) => contentListeners.push(fn) }
    }
  };
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_\-\u0080-\uffff]/g, (c) => "\\" + c);
  }
  const src = readFileSync(new URL("./content.js", import.meta.url), "utf8");
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = src;
  window.document.body.appendChild(scriptEl);
  const doc = window.document;
  const hooks = window.__btrTest;

  assert(!doc.getElementById(hooks.ids.CURSOR_LAYER_ID), "no cursor layer before attach");
  assert(!doc.getElementById(hooks.ids.TOOLBAR_ID), "no toolbar before attach");

  contentListeners[0]({ type: "ATTACH_RECORDER", recording: true, paused: false, excludedDomains: [], sensitivePatterns: [], showCursor: true, stepCount: 4 });
  assert(doc.getElementById(hooks.ids.TOOLBAR_ID), "toolbar appears while recording");
  assert(doc.getElementById(hooks.ids.TOOLBAR_ID).textContent.includes("4"), "toolbar shows the initial step count");

  // THE FIX: moving the mouse must NOT draw anything. The v2.0.6 follower
  // ring hung around wherever the pointer last was — a cursor was visible
  // on pages the user was only reading.
  window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 120, clientY: 90, bubbles: true }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 200, clientY: 180, bubbles: true }));
  assert(!doc.getElementById(hooks.ids.CURSOR_LAYER_ID), "mousemove never creates a cursor overlay (no always-visible follower)");

  // A click still gets its transient, page-anchored ring.
  window.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 120, clientY: 90, bubbles: true }));
  const layer = doc.getElementById(hooks.ids.CURSOR_LAYER_ID);
  assert(layer, "click ring layer appears on mousedown");
  assert(hooks.clickRingCount() === 1, "exactly one click ring is alive after one click");
  assert(layer.children.length === 1, "the overlay layer contains only the click ring (no follower dot/ring)");

  const recBefore = sent.filter((m) => m && m.type === "REC_EVENT").length;
  doc.getElementById("b").click();
  await new Promise((r) => setTimeout(r, 50));
  const recs = sent.filter((m) => m && m.type === "REC_EVENT");
  eq(recs.length, recBefore + 1, "recorded click still emits exactly one REC_EVENT");
  assert(recs.length && recs[recs.length - 1].overlayActive === true, "REC_EVENT reports the live ring (live feedback; the marker in the step is stamped by the SW onto the clean shot)"
  );

  // The SW commits the step and echoes the step count back: the oldest ring
  // (whose screenshot was just taken) fades out instead of lingering.
  contentListeners[0]({ type: "BTR_STEP_COUNT", count: 7 });
  assert(layer.children[0] && layer.children[0].style.opacity === "0", "step commit retires the click ring it just captured");

  const bar = doc.getElementById(hooks.ids.TOOLBAR_ID);
  eq(bar.querySelector("span:nth-of-type(2)").textContent, "7", "step count updates live from BTR_STEP_COUNT");

  // v2.1.0 — the clean-screenshot handshake: the SW hides ALL recorder UI for
  // the instant captureVisibleTab grabs the frame, then restores it. The ring
  // never lands baked into the shot; the reader sees the marker WE draw.
  let captureUiAck = null;
  contentListeners[0]({ type: "BTR_CAPTURE_UI", visible: false }, {}, (res) => { captureUiAck = res; });
  assert(captureUiAck && captureUiAck.applied === true, "BTR_CAPTURE_UI hide is acknowledged synchronously");
  assert(hooks.captureUiHidden() === true, "capture UI state reports hidden");
  assert(layer.style.display === "none", "click rings hidden during the capture instant");
  assert(bar.style.display === "none", "recording toolbar hidden during the capture instant");
  contentListeners[0]({ type: "BTR_CAPTURE_UI", visible: true }, {}, (res) => { captureUiAck = res; });
  assert(hooks.captureUiHidden() === false, "BTR_CAPTURE_UI show restores the state");
  assert(layer.style.display === "", "click rings restored after the capture");
  assert(bar.style.display === "", "recording toolbar restored after the capture");
  assert(hooks.clickRingCount() === 1, "hide/restore preserves ring state (only visibility toggles)");
  const buttons = bar.querySelectorAll("button");
  buttons[1].click(); // Stop
  buttons[0].click(); // Pause toggle
  await new Promise((r) => setTimeout(r, 20));
  assert(sent.some((m) => m && m.type === "TOOLBAR_STOP"), "toolbar Stop asks the service worker to stop");
  assert(sent.some((m) => m && m.type === "TOOLBAR_TOGGLE_PAUSE"), "toolbar Pause asks the service worker to toggle pause");
  eq(sent.filter((m) => m && m.type === "REC_EVENT").length, recBefore + 1, "toolbar interactions are never recorded as steps");

  contentListeners[0]({ type: "ATTACH_RECORDER", recording: false, paused: false, excludedDomains: [], sensitivePatterns: [], showCursor: true, stepCount: 0 });
  assert(!doc.getElementById(hooks.ids.TOOLBAR_ID), "toolbar is removed on detach");
  assert(!doc.getElementById(hooks.ids.CURSOR_LAYER_ID), "cursor overlay is removed on detach");

  dom.window.close();
}

/* ------------------------------------------------------------------ */

section("v2.0.7 — annotation geometry: hit-testing, handles, rotation, crop remap");

{
  const { syncGeom, annotationHit, handlesAt, rotateAround, cropRemap } =
    await import("./annotation-geom.js");

  // Rects keep x2/y2 in lockstep with w/h (the stale-x2 bug that broke
  // selection after a resize).
  const rect = syncGeom({ type: "rectangle", x: 10, y: 10, w: 50, h: 30 });
  eq(rect.x2, 60, "syncGeom derives x2 for rect-like shapes");
  eq(rect.y2, 40, "syncGeom derives y2 for rect-like shapes");
  rect.w = 80;
  syncGeom(rect);
  eq(rect.x2, 90, "syncGeom repairs stale x2 after resize");

  const arrow = syncGeom({ type: "arrow", x: 0, y: 0, x2: 30, y2: 40 });
  eq(arrow.w, 30, "syncGeom derives the arrow bbox width from its endpoints");
  eq(arrow.h, 40, "syncGeom derives the arrow bbox height from its endpoints");

  // Hit-testing matches what the user sees, not a loose bounding box.
  const anns = [
    { type: "rectangle", x: 0, y: 0, w: 100, h: 100, id: "r1" },
    { type: "text", x: 120, y: 10, fontSize: 18, text: "Hello world", id: "t1" },
    { type: "marker", x: 220, y: 30, number: 1, id: "m1" },
    { type: "arrow", x: 300, y: 0, x2: 300, y2: 200, id: "a1" }
  ];
  anns.forEach(syncGeom);
  eq(annotationHit(anns, { x: 90, y: 90 }).id, "r1", "rect is hittable inside its box");
  eq(annotationHit(anns, { x: 135, y: 18 }).id, "t1", "text is hittable across its measured box (was anchor-only)");
  eq(annotationHit(anns, { x: 228, y: 24 }).id, "m1", "marker is hittable across its visible disc (was 8px core)");
  eq(annotationHit(anns, { x: 312, y: 100 }), null, "points beside the arrow shaft miss");
  eq(annotationHit(anns, { x: 306, y: 100 }).id, "a1", "arrow is hittable along its segment, not just its bbox");

  // Handles: arrows expose head, tail and a rotate knob; text/markers stay
  // move-only; rects keep the bottom-right resize handle.
  const arr = { type: "arrow", x: 0, y: 0, x2: 100, y2: 0 };
  eq(handlesAt(arr, { x: 100, y: 0 }), "head", "arrow head handle detected");
  eq(handlesAt(arr, { x: 0, y: 0 }), "tail", "arrow tail handle detected");
  const rot = handlesAt(arr, { x: 50, y: -26 });
  eq(rot, "rotate", "arrow rotate handle detected above the midpoint");
  eq(handlesAt({ type: "text", x: 0, y: 0, fontSize: 18, text: "hi" }, { x: 5, y: 5 }), null, "text has no resize/rotate handles");
  eq(handlesAt({ type: "rectangle", x: 0, y: 0, w: 40, h: 40 }, { x: 40, y: 40 }), "se", "rect keeps its se resize handle");

  // v2.1.1 — tolerances are zoom-aware: the editor passes 1/displayScale, so
  // a miss at 1:1 becomes a grab when the screenshot is displayed smaller.
  eq(annotationHit(anns, { x: 112, y: 100 }, 1), null, "12px right of the rect edge misses at 1:1");
  eq(annotationHit(anns, { x: 112, y: 100 }, 2).id, "r1", "the same point grabs the rect at 2x tolerance (zoom-aware)");
  eq(handlesAt(arr, { x: 115, y: 0 }, 2), "head", "handle tolerance scales with zoom too");
  eq(handlesAt(arr, { x: 115, y: 0 }), null, "and stays strict at 1:1");

  // Rotation preserves the segment length and pivots around the midpoint.
  const turned = rotateAround(50, 0, 0, 0, 100, 0, 0, Math.PI / 2);
  eq(turned.x, 50, "rotated tail lands on the pivot axis (x)");
  eq(turned.y, -50, "rotated tail lands on the pivot axis (y)");
  eq(turned.x2, 50, "rotated head lands on the pivot axis (x)");
  eq(turned.y2, 50, "rotated head lands on the pivot axis (y)");
  const lenBefore = Math.hypot(100, 0);
  const lenAfter = Math.hypot(turned.x2 - turned.x, turned.y2 - turned.y);
  assert(Math.abs(lenBefore - lenAfter) < 1.5, "rotation preserves arrow length");

  // Crop: coordinates remap by the crop offset, fully-outside annotations
  // are dropped, intersecting ones survive.
  const cropped = cropRemap([
    { type: "rectangle", x: 60, y: 60, w: 30, h: 30, id: "in" },
    { type: "marker", x: 45, y: 45, id: "kept-edge" },
    { type: "rectangle", x: 500, y: 500, w: 30, h: 30, id: "out" }
  ], 50, 50, 200, 150);
  const inAnn = cropped.find((a) => a.id === "in");
  assert(inAnn && inAnn.x === 10 && inAnn.y === 10, "annotations shift by the crop offset");
  assert(!cropped.some((a) => a.id === "out"), "annotations fully outside the crop are removed");
  assert(cropped.some((a) => a.id === "kept-edge"), "annotations intersecting the crop edge survive");
}

/* ------------------------------------------------------------------ */

section("v2.0.7 — double-click reported by two DOM events commits one step");

{
  const { createRecorder } = await import("./recorder-core.js");
  const rec = createRecorder();
  rec.startRecording({ id: 1, windowId: 1 }, {});
  const target = { selector: "#go", tag: "button", text: "Go" };
  const first = rec.handleEvent({ event: "DOUBLE_CLICK", url: "https://example.com/x", target }, { tabId: 1 });
  eq(first.action, "captured", "first DOUBLE_CLICK event is captured");
  // background.js commits the raw event (which carries target), not the verdict.
  const step = rec.commitStep({ event: "DOUBLE_CLICK", url: "https://example.com/x", target }, null);
  eq(step.action, "added", "first double-click commits");
  const second = rec.handleEvent({ event: "DOUBLE_CLICK", url: "https://example.com/x", target }, { tabId: 1 });
  eq(second.action, "ignored", "the duplicate DOUBLE_CLICK (detail>=2 click + dblclick) is ignored");
  eq(rec.uiState().session.stepCount, 1, "a double-click produces exactly one step");
}

/* ------------------------------------------------------------------ */

section("v2.1.0 — element auto-crop planning (planCrop)");

{
  const { planCrop } = await import("./recorder-core.js");

  // A small button gets padded, then expanded to the minimum crop size.
  const small = planCrop({ x: 500, y: 400, width: 120, height: 40 }, null, 1280, 720);
  assert(small && small.x === 380 && small.y === 280 && small.w === 360 && small.h === 280,
    "small elements expand to the 360x280 minimum around their center");

  // A large region just gets the 56px padding, clamped to the viewport.
  const large = planCrop({ x: 100, y: 100, width: 800, height: 500 }, null, 1280, 720);
  assert(large && large.x === 44 && large.y === 44 && large.w === 912 && large.h === 612,
    "large elements get 56px padding clamped to the viewport");

  // Near-viewport-size elements are not "cropped" at all.
  eq(planCrop({ x: 0, y: 0, width: 1270, height: 700 }, null, 1280, 720), null,
    "a near-full-viewport element skips the crop (it would be a no-op)");

  // Centered point-only targets still get a useful crop.
  const point = planCrop(null, { x: 640, y: 360 }, 1280, 720);
  assert(point && point.x === 460 && point.y === 220 && point.w === 360 && point.h === 280,
    "point-only targets center the minimum crop");

  // Edge-clamped point keeps the visible part instead of failing.
  const edge = planCrop(null, { x: 2, y: 2 }, 1280, 720);
  assert(edge && edge.x === 0 && edge.y === 0 && edge.w === 182 && edge.h === 142,
    "points near the viewport corner clamp instead of producing a degenerate crop");

  eq(planCrop(null, null, 1280, 720), null, "no target info means a full-viewport step");
  eq(planCrop({ x: 0, y: 0, width: 120, height: 40 }, { x: 10, y: 10 }, 0, 0), null, "degenerate viewport is rejected");
}

/* ------------------------------------------------------------------ */

section("v2.1.0 — clean screenshots: element crop + marker stamped onto the image");

{
  const TAB1 = { id: 1, windowId: 1, url: "https://example.com/app", title: "Example App", active: true };
  const tabsMap = new Map([[1, TAB1]]);
  const store = { local: new Map(), session: new Map() };
  const mkStorage = (m) => ({
    get: async (keys) => {
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); }
  });
  const bgMessageHandlers = [];
  const canvasLog = { constructed: [], drawImage: [], arcs: 0 };
  const captureUiMessages = [];

  // Recording canvas stack: proves the crop offset AND the marker in one pass.
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w; this.height = h;
      canvasLog.constructed.push([w, h]);
    }
    getContext() {
      return {
        drawImage: (...args) => canvasLog.drawImage.push(args),
        arc: () => { canvasLog.arcs++; },
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        fill() {}, stroke() {}, save() {}, restore() {},
        translate() {}, scale() {},
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {}
      };
    }
    async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }); }
  };
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720, close() {} });
  if (typeof globalThis.FileReader === "undefined") {
    globalThis.FileReader = class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((buf) => {
          this.result = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
          if (this.onload) this.onload();
        });
      }
    };
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("data:")) {
      const b64 = String(url).split(",")[1] || "";
      return { blob: async () => new Blob([Buffer.from(b64, "base64")], { type: "image/png" }) };
    }
    return realFetch(url);
  };

  globalThis.chrome = {
    runtime: {
      id: "btr-test-ext",
      getURL: (p) => `chrome-extension://btr-test-ext/${p || ""}`,
      onMessage: { addListener: (fn) => bgMessageHandlers.push(fn) }
    },
    storage: {
      local: mkStorage(store.local),
      session: mkStorage(store.session),
      onChanged: { addListener: () => {} }
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
    commands: { onCommand: { addListener: () => {} } },
    tabs: {
      query: async (q) => (q && q.active ? [TAB1] : [...tabsMap.values()]),
      get: async (id) => tabsMap.get(id) || null,
      create: async (o) => ({ id: 99, ...o }),
      update: async () => ({}),
      remove: async () => {},
      sendMessage: async (tabId, message) => {
        if (message && message.type === "BTR_CAPTURE_UI") {
          captureUiMessages.push(message.visible !== false ? "show" : "hide");
          return { ok: true, applied: true };
        }
        return undefined;
      },
      captureVisibleTab: async () => "data:image/png;base64,MOCKSHOT",
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
      onCreated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    }
  };

  await import("./background.js?clean-capture");

  const callBg = (message, sender) => Promise.race([
    new Promise((resolve) => { bgMessageHandlers[0](message, sender, resolve); }),
    new Promise((r) => setTimeout(() => r(undefined), 800))
  ]);
  const contentSender = { id: "btr-test-ext", tab: { id: 1, windowId: 1 }, frameId: 0, url: "https://example.com/app" };
  const pageSender = { id: "btr-test-ext", tab: { id: 42, windowId: 3 }, frameId: 0, url: "chrome-extension://btr-test-ext/popup.html" };

  await callBg({ type: "SAVE_SETTINGS", patch: { captureDelayMs: 0, autoElementCrop: true } }, pageSender);
  await callBg({ type: "START_RECORDING" }, pageSender);
  for (let i = 0; i < 40; i++) {
    const ui = await callBg({ type: "GET_UI_STATE" }, pageSender);
    if (ui && ui.uiState.session && ui.uiState.session.stepCount >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  canvasLog.constructed.length = 0;
  canvasLog.drawImage.length = 0;
  canvasLog.arcs = 0;
  captureUiMessages.length = 0;

  // Click on a 120x40 button at (500,400) in a 1280x720 viewport.
  bgMessageHandlers[0](
    { type: "REC_EVENT", event: "CLICK", url: "https://example.com/app", frameUrl: "https://example.com/app", isIframe: false, frameNonce: null, overlayActive: true, description: 'Click "Buy now"', target: { selector: "#buy", tag: "button", text: "Buy now", point: { x: 560, y: 420 }, boundingBox: { x: 500, y: 400, width: 120, height: 40 } }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
    contentSender,
    () => {}
  );
  for (let i = 0; i < 40; i++) {
    const ui = await callBg({ type: "GET_UI_STATE" }, pageSender);
    if (ui && ui.uiState.session && ui.uiState.session.stepCount >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const uiRes = await callBg({ type: "GET_UI_STATE" }, pageSender);
  eq(uiRes.uiState.session.stepCount, 2, "opener + click committed");
  eq(canvasLog.constructed.length, 1, "the step image is recomposed exactly once");
  const [w, h] = canvasLog.constructed[0];
  assert(w === 360 && h === 280, `the step image is cropped to the element region (got ${w}x${h}, want 360x280)`);
  eq(canvasLog.drawImage.length, 1, "the raw frame is drawn into the crop exactly once");
  assert(canvasLog.drawImage[0][1] === -380 && canvasLog.drawImage[0][2] === -280,
    "the frame is offset by the crop origin (-380,-280)");
  assert(canvasLog.arcs >= 2, "the professional click marker is drawn onto the cropped image");
  assert(captureUiMessages[0] === "hide" && captureUiMessages[captureUiMessages.length - 1] === "show",
    `recorder UI is hidden before the grab and restored after (${captureUiMessages.join(",")})`);

  // v2.1.1 — element crop is OPT-IN. The default must keep the FULL current
  // view in every step (the v2.1.0 default of ON shipped cropped portions and
  // read as "it is taking a portion of the page instead of the current view").
  await callBg({ type: "SAVE_SETTINGS", patch: { autoElementCrop: false } }, pageSender);
  canvasLog.constructed.length = 0;
  canvasLog.drawImage.length = 0;
  canvasLog.arcs = 0;
  bgMessageHandlers[0](
    { type: "REC_EVENT", event: "CLICK", url: "https://example.com/app", frameUrl: "https://example.com/app", isIframe: false, frameNonce: null, overlayActive: true, description: 'Click "Save draft"', target: { selector: "#save", tag: "button", text: "Save draft", point: { x: 300, y: 200 }, boundingBox: { x: 240, y: 180, width: 120, height: 40 } }, viewport: { width: 1280, height: 720, devicePixelRatio: 1 } },
    contentSender,
    () => {}
  );
  for (let i = 0; i < 40; i++) {
    const ui = await callBg({ type: "GET_UI_STATE" }, pageSender);
    if (ui && ui.uiState.session && ui.uiState.session.stepCount >= 3) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  eq(canvasLog.constructed.length, 1, "the default shot is recomposed once — only to stamp the marker");
  const [fw, fh] = canvasLog.constructed[0];
  assert(fw === 1280 && fh === 720, `the default step keeps the full current view (got ${fw}x${fh}, want 1280x720)`);
  assert(canvasLog.drawImage[0][1] === 0 && canvasLog.drawImage[0][2] === 0,
    "the full-view frame is drawn with NO crop offset");
  assert(canvasLog.arcs >= 2, "the click marker is still stamped onto the full view");

  delete globalThis.fetch;
  delete globalThis.OffscreenCanvas;
  delete globalThis.createImageBitmap;
  delete globalThis.FileReader;
  delete globalThis.chrome;
}

/* ------------------------------------------------------------------ */

section("v2.1.0 — crop metadata round-trips through normalizeTutorial");

{
  const withCrop = normalizeTutorial({
    title: "T",
    steps: [{
      action: "CLICK", description: "d",
      screenshot: { image: "data:image/png;base64,AAA", width: 360, height: 280, timestamp: 1, crop: { x: 10, y: 20, w: 360, h: 280 } }
    }]
  });
  assert(withCrop.steps[0].screenshot.crop && withCrop.steps[0].screenshot.crop.x === 10,
    "crop metadata survives normalize (saved tutorials keep their crop)");

  const withoutCrop = normalizeTutorial({
    title: "T",
    steps: [{
      action: "CLICK", description: "d",
      screenshot: { image: "data:image/png;base64,AAA", width: 1280, height: 720, timestamp: 1 }
    }]
  });
  assert(withoutCrop.steps[0].screenshot.crop === undefined,
    "steps without a crop stay crop-free (old tutorials unchanged)");
}

/* ------------------------------------------------------------------ */

console.log("  → " + passed + " passed\n");
console.log("═══════════════════════════════════════");
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════");

if (failed > 0) {
  console.error("\nFAILURES:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
} else {
  console.log("\n✅ ALL TESTS PASSED — production ready");
  process.exit(0);
}
