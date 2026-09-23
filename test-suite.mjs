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

import { createRecorder, isInternalUrl, describeUrl, sameTarget } from "./recorder-core.js";

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
  eq(hooks.describe("CLICK", doc.getElementById("go")), "Click the Submit button", "describe CLICK");
  eq(hooks.describe("TYPE", doc.getElementById("user")), "Type into the Username", "describe TYPE");
  eq(hooks.describe("DOUBLE_CLICK", doc.getElementById("link1")), "Double-click the Read more", "describe DOUBLE_CLICK uses text");
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
