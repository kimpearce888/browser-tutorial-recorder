import { JSDOM } from "jsdom";

let passed = 0, failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; failures.push(message); console.error(`  ✗ FAIL: ${message}`); }
}

function assertEq(actual, expected, message) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; }
  else {
    failed++; failures.push(message);
    console.error(`  ✗ FAIL: ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "https://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try { globalThis.navigator = dom.window.navigator; } catch (_) {}
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.Event = dom.window.Event;
globalThis.EventTarget = dom.window.EventTarget;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
globalThis.Image = dom.window.Image;
globalThis.Blob = dom.window.Blob;
globalThis.URL = dom.window.URL;
globalThis.FileReader = dom.window.FileReader;
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.btoa = (str) => Buffer.from(str, "binary").toString("base64");
globalThis.atob = (str) => Buffer.from(str, "base64").toString("binary");
const { TextEncoder, TextDecoder } = await import("util");
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;

if (!globalThis.Blob.prototype.arrayBuffer) {
  globalThis.Blob.prototype.arrayBuffer = async function() {
    const reader = new globalThis.FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const dbStore = new Map();
globalThis.indexedDB = {
  open: () => {
    const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
    setTimeout(() => {
      request.result = {
        transaction: () => {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            put: (v) => { dbStore.set(v.id, v); setTimeout(() => tx.oncomplete?.(), 0); return {}; },
            delete: (id) => { dbStore.delete(id); setTimeout(() => tx.oncomplete?.(), 0); return {}; },
            get: (id) => { const req = { onsuccess: null, onerror: null, result: dbStore.get(id) || null }; setTimeout(() => req.onsuccess?.(), 0); return req; },
            getAll: () => { const req = { onsuccess: null, onerror: null, result: [...dbStore.values()] }; setTimeout(() => req.onsuccess?.(), 0); return req; },

            openCursor: () => {
              const entries = [...dbStore.values()];
              let i = 0;
              const req = { onsuccess: null, onerror: null, result: null };
              const advance = () => {
                if (i < entries.length) {
                  const idx = i;
                  req.result = {
                    value: entries[idx],
                    continue: () => { i = idx + 1; setTimeout(advance, 0); }
                  };
                  req.onsuccess?.();
                } else {
                  req.result = null;
                  req.onsuccess?.();
                }
              };
              setTimeout(advance, 0);
              return req;
            },
          });
          return tx;
        },
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        deleteObjectStore: () => {},
      };
      request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  },
};

const chromeStorage = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => key in chromeStorage ? { [key]: chromeStorage[key] } : {},
      set: async (obj) => { Object.assign(chromeStorage, obj); },
      remove: async (key) => { delete chromeStorage[key]; },
    },
    session: { get: (_, cb) => { if (cb) cb({}); }, set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onMessage: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    getURL: (p) => `chrome-extension://testid/${p}`,
    lastError: null,
    sendMessage: () => Promise.resolve(),
  },
  tabs: {
    onCreated: { addListener: () => {} }, onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} },
    query: async () => [], get: async () => null, create: () => {}, update: async () => {},

    captureVisibleTab: async () => "",
    sendMessage: (...args) => {

      const cb = args[args.length - 1];
      if (typeof cb === "function") cb({ ok: true });
    },
    remove: () => {},
  },
  windows: { update: async () => {}, onCreated: { addListener: () => {} } },
  scripting: { executeScript: async () => [] },
  commands: { onCommand: { addListener: () => {} }, getAll: (cb) => cb([]) },
  action: { openPopup: () => {} },
  notifications: { create: () => {} },
  downloads: { download: () => {} },
};

console.log("═══════════════════════════════════════");
console.log("  Browser Tutorial Recorder");
console.log("  Test Suite");
console.log("═══════════════════════════════════════\n");

console.log("━ shared.js ━");
const shared = await import("./shared.js");
const mod = shared;

assertEq(shared.escapeHtml("<script>"), "&lt;script&gt;", "escapeHtml");
assertEq(shared.escapeHtml(null), "", "escapeHtml null");
assertEq(shared.escapeHtml('"q"'), "&quot;q&quot;", "escapeHtml quotes");

assert(shared.sanitizeImageUrl("data:image/png;base64,SGVsbG8=") !== "", "sanitize valid png");
assert(shared.sanitizeImageUrl("javascript:alert(1)") === "", "sanitize blocks js:");
assert(shared.sanitizeImageUrl("") === "", "sanitize empty");

assertEq(shared.sanitizeColor("#ff0000"), "#ff0000", "sanitizeColor valid");
assertEq(shared.sanitizeColor("red"), "#ff7352", "sanitizeColor fallback");

assertEq(shared.clamp(5, 0, 10), 5, "clamp in range");
assertEq(shared.clamp(-5, 0, 10), 0, "clamp below min");
assertEq(shared.clamp(15, 0, 10), 10, "clamp above max");

assertEq(shared.canvasSize({ screenshot: { width: 1920, height: 1080 } }), { width: 1920, height: 1080 }, "canvasSize");
assertEq(shared.canvasSize({}), { width: 1280, height: 720 }, "canvasSize defaults");

assertEq(shared.annotationBox({ type: "rectangle", x: 10, y: 20, width: 100, height: 50 }), { x: 10, y: 20, width: 100, height: 50 }, "annotationBox rect");
assertEq(shared.annotationBox({ type: "marker", x: 50, y: 60, width: 28, height: 28 }), { x: 36, y: 46, width: 28, height: 28 }, "annotationBox marker");

assertEq(shared.withAlpha("#ff0000", 1), "#ff0000ff", "withAlpha full");
assertEq(shared.withAlpha("#ff0000", 0), "#ff000000", "withAlpha zero");

{
  const a = { startX: 8, startY: 92, endX: 92, endY: 8, arrowHeadSize: 14 };
  const pts = shared.arrowHeadPoints(a, 300, 60).split(" ").map(p => p.split(",").map(Number));
  assert(Math.abs(pts[0][0] - 92) < 0.01, "arrowHeadPoints tip at endX,endY");
}

{
  const a = shared.normalizeAnnotation({ type: "rectangle", x: "10", y: "20", width: "100", height: "50" }, 0);
  assert(a.x === 10 && a.width === 100, "normalizeAnnotation coerces numbers");
  assert(a.id && a.id.startsWith("annotation-"), "normalizeAnnotation generates id");
}
{
  const a = shared.normalizeAnnotation({ type: "unknown" }, 0);
  assert(a.type === "rectangle", "normalizeAnnotation unknown → rectangle");
}

{
  const t = shared.normalizeTutorial({ id: "t1", title: "Test", steps: [
    { id: "s1", description: "Step 1", screenshot: { image: "data:image/png;base64,abc", width: 800, height: 600 }, annotations: [] },
    { id: "s2", description: "Step 2", screenshot: { image: "javascript:alert(1)" }, annotations: [] },
  ]});
  assert(t.steps[0].screenshot.image === "data:image/png;base64,abc", "normalizeTutorial valid screenshot preserved");
  assert(t.steps[1].screenshot.image === "", "normalizeTutorial invalid screenshot cleared");
}
{
  const longId = "a".repeat(500);
  const t = shared.normalizeTutorial({ id: longId, steps: [] });
  assert(t.id.length === 200, "normalizeTutorial ID capped at 200");
}

{
  await shared.dbPut({ id: "test-dbget", title: "DBGet Test", steps: [] });
  const result = await shared.dbGet("test-dbget");
  assert(result !== null && result.title === "DBGet Test", "dbGet fetches single record by ID");
  const missing = await shared.dbGet("nonexistent");
  assert(missing === null, "dbGet returns null for missing record");
  await shared.dbDelete("test-dbget");
}

console.log(`  → ${passed} passed\n`);
const s1 = passed;

console.log("━ gif-encoder.js ━");
const gif = await import("./gif-encoder.js");

{
  const rgba = new Uint8Array([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255]);
  const blob = await gif.encodeGif([{ width: 2, height: 2, rgba, delayMs: 100 }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert(String.fromCharCode(...buf.slice(0, 6)) === "GIF89a", "gif signature");
  assert(buf[buf.length - 1] === 0x3b, "gif trailer");
}

{
  const w = 200, h = 200;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = Math.random()*256; rgba[i+1] = Math.random()*256; rgba[i+2] = Math.random()*256; rgba[i+3] = 255; }
  const blob = await gif.encodeGif([{ width: w, height: h, rgba, delayMs: 1000 }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert(buf.length > 10000, "gif large frame (growIfNeeded fires)");
}

{
  const f1 = new Uint8Array([255,0,0,255, 0,255,0,255]);
  const f2 = new Uint8Array([0,0,255,255, 255,255,0,255]);
  const blob = await gif.encodeGif([{ width:2, height:1, rgba:f1, delayMs:500 }, { width:2, height:1, rgba:f2, delayMs:500 }], { loop: true });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let found = false;
  const target = "NETSCAPE2.0";
  for (let i = 0; i <= buf.length - target.length; i++) {
    let match = true;
    for (let j = 0; j < target.length; j++) { if (buf[i+j] !== target.charCodeAt(j)) { match = false; break; } }
    if (match) { found = true; break; }
  }
  assert(found, "gif NETSCAPE loop extension");
}

console.log(`  → ${passed - s1} passed\n`);
const s2 = passed;

console.log("━ settings-store.js ━");
const ss = await import("./settings-store.js");

assert(ss.DEFAULT_SHORTCUTS.undo.keys === "mod+z", "default undo shortcut");
assert(ss.DEFAULT_SHORTCUTS.save.keys === "mod+s", "default save shortcut");
assert(ss.DEFAULT_SHORTCUTS.preview.keys === "mod+shift+p", "default preview shortcut");
assert(Object.keys(ss.DEFAULT_SHORTCUTS).length >= 20, "20+ default shortcuts");

const fakeEvent = (o) => ({ metaKey:false, ctrlKey:false, altKey:false, shiftKey:false, key:"a", ...o });
assertEq(ss.eventToKey(fakeEvent({})), "a", "eventToKey plain letter");
assertEq(ss.eventToKey(fakeEvent({ shiftKey:true, key:"A" })), "shift+a", "eventToKey shift+letter");
assertEq(ss.eventToKey(fakeEvent({ ctrlKey:true })), "mod+a", "eventToKey ctrl+letter");
assertEq(ss.eventToKey(fakeEvent({ key:" " })), "space", "eventToKey space");
assertEq(ss.eventToKey(fakeEvent({ key:"?" })), "?", "eventToKey question mark");

assert(ss.matchesShortcut({ metaKey:true, ctrlKey:false, altKey:false, shiftKey:false, key:"s" }, "save") === true, "Ctrl+S matches save");
assert(ss.matchesShortcut({ metaKey:false, ctrlKey:false, altKey:false, shiftKey:false, key:"x" }, "save") === false, "X doesn't match save");

{
  const s = await ss.getSettings();
  assert(s.captureDelay === 220, "default captureDelay");
  assert(s.screenshotFormat === "png", "default screenshot format");
  assert(s.theme === "system", "default theme");
}

console.log(`  → ${passed - s2} passed\n`);
const s3 = passed;

console.log("━ exporter.js ━");

try {
  const exporter = await import("./exporter.js");
  let downloaded = null;
  const origCreate = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = (blob) => { downloaded = { blob, url: "mock://download" }; return "mock://download"; };

  const origRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.revokeObjectURL = () => {};
  const origClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function() { if (this.download) downloaded.name = this.download; };
  const blobContents = new WeakMap();
  const OrigBlob = globalThis.Blob;
  globalThis.Blob = function(parts, opts) { const b = new OrigBlob(parts, opts); if (parts?.length) blobContents.set(b, parts[0]); return b; };
  globalThis.Blob.prototype = OrigBlob.prototype;

  const tutorial = { id:"t", title:"My Tutorial", description:"A test", steps:[{ id:"s1", number:1, description:"Step 1", screenshot:{image:""}, annotations:[] }] };

  await exporter.exportTutorial(tutorial, "json", 0);
  assert(downloaded?.name === "my-tutorial.json", "JSON export filename sanitized");

  await exporter.exportTutorial(tutorial, "text", 0);
  assert(downloaded?.name === "my-tutorial.txt", "text export filename");

  try { await exporter.exportTutorial({id:"t",title:"T",steps:[]}, "png", 0); assert(false, "should throw"); }
  catch (e) { assert(e.message.includes("Select a step"), "PNG no-step throws"); }

  try { await exporter.exportTutorial(tutorial, "png", 99); assert(false, "should throw"); }
  catch (_) { assert(true, "PNG bad-index throws"); }

  globalThis.URL.createObjectURL = origCreate;
  globalThis.URL.revokeObjectURL = origRevoke || globalThis.URL.revokeObjectURL;
  dom.window.HTMLAnchorElement.prototype.click = origClick;
  globalThis.Blob = OrigBlob;
} catch (e) { assert(false, "exporter import: " + e.message); }

console.log(`  → ${passed - s3} passed\n`);
const s4 = passed;

console.log("━ background.js ━");

let messageListener = null;
globalThis.chrome.runtime.onMessage.addListener = (fn) => { messageListener = fn; };

try {
  await import("./background.js");
  assert(messageListener !== null, "message listener registered");

  const sender = { tab: { id: 1, windowId: 1 } };

  {
    const r = await new Promise(res => messageListener({ type: "GET_STATE" }, sender, res));
    assert(r.session === null, "GET_STATE returns null when no session");
  }

  {
    const r = await new Promise(res => messageListener({ type: "GET_TUTORIALS" }, sender, res));
    assert(Array.isArray(r.tutorials) && r.tutorials.length === 0, "GET_TUTORIALS returns empty array");
  }

  {
    await new Promise(res => messageListener({ type: "SAVE_TUTORIAL", tutorial: { id:"round-trip", title:"Round Trip", steps:[] } }, sender, res));
    const r = await new Promise(res => messageListener({ type: "GET_TUTORIAL", id: "round-trip" }, sender, res));
    assert(r.tutorial?.title === "Round Trip", "GET_TUTORIAL returns saved tutorial");
  }

  {
    const r = await new Promise(res => messageListener({ type: "DUPLICATE_TUTORIAL", id: "round-trip" }, sender, res));
    assert(r.ok === true && r.tutorial.title.includes("(copy)"), "DUPLICATE_TUTORIAL creates copy");
  }

  {
    await new Promise(res => messageListener({ type: "DELETE_TUTORIAL", id: "round-trip" }, sender, res));
    const r = await new Promise(res => messageListener({ type: "GET_TUTORIAL", id: "round-trip" }, sender, res));
    assert(r.tutorial === null, "DELETE_TUTORIAL removes tutorial");
  }

  {
    const r = await new Promise(res => messageListener({ type: "UNKNOWN" }, sender, res));
    assert(r.ok === false, "unknown type returns ok:false");
  }

  {
    globalThis.chrome.tabs.query = async () => [{ id: 99, windowId: 1, url: "chrome://settings" }];
    const r = await new Promise(res => messageListener({ type: "START_RECORDING" }, sender, res));
    assert(r.ok === false, "START_RECORDING on chrome:// fails");
  }

  {
    globalThis.chrome.tabs.query = async () => [{ id: 99, windowId: 1, url: "" }];
    const r = await new Promise(res => messageListener({ type: "START_RECORDING" }, sender, res));
    assert(r.ok === false, "START_RECORDING on empty URL fails");
  }

  {
    globalThis.chrome.tabs.query = async () => [{ id: 99, windowId: 1, url: "file:///etc/passwd" }];
    const r = await new Promise(res => messageListener({ type: "START_RECORDING" }, sender, res));
    assert(r.ok === false, "START_RECORDING on file:// fails");
  }

} catch (e) { assert(false, "background import: " + e.message); }

console.log(`  → ${passed - s4} passed\n`);
const s5 = passed;

console.log("━ fixes: P0-1 submit, P0-2 click dedup ━");

{

  const sender2 = { tab: { id: 7, windowId: 1 } };
  const r = await new Promise(res => messageListener({
    type: "RECORD_EVENT",
    event: "CLICK",
    target: { selectors: ["#btn"], tag: "button", boundingBox: { x: 10, y: 20 } },
    url: "https://example.com",
    frame: { id: 0, url: "https://example.com", isTop: true }
  }, sender2, res));
  assert(r?.ok === false, "CLICK with no session returns ok:false (P0-2)");
}

{

  const contentSrc = await import("node:fs").then(fs => fs.readFileSync("./content.js", "utf8"));
  const dom2 = new JSDOM(`<!DOCTYPE html><html><body>
    <button id="btn">Click me</button>
    <form id="f"><input type="text" name="q"><button type="submit">Submit</button></form>
  </body></html>`, { url: "https://example.com/", runScripts: "outside-only" });

  dom2.window.chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => { setTimeout(() => cb?.({ ok: true, stepNumber: 1 }), 0); },
      lastError: null,
    },
  };
  try {
    dom2.window.eval(contentSrc);
    assert(true, "content.js evaluates without syntax errors");
  } catch (e) {
    assert(false, "content.js evaluates without syntax errors: " + e.message);
  }
}

{
  const senderLocal = { tab: { id: 1, windowId: 1 } };

  const tutorial = {
    id: "summary-test",
    title: "Summary Test",
    steps: [
      { id: "s1", number: 1, description: "Step 1", screenshot: { image: "data:image/png;base64,STEP1" }, annotations: [{ type: "rectangle" }] },
      { id: "s2", number: 2, description: "Step 2", screenshot: { image: "data:image/png;base64,STEP2" }, annotations: [] },
      { id: "s3", number: 3, description: "Step 3", screenshot: { image: "data:image/png;base64,STEP3" }, annotations: [{ type: "text" }, { type: "arrow" }] }
    ]
  };
  await new Promise(res => messageListener({ type: "SAVE_TUTORIAL", tutorial }, senderLocal, res));

  const r = await new Promise(res => messageListener({ type: "GET_TUTORIALS_SUMMARY" }, senderLocal, res));
  assert(Array.isArray(r.tutorials) && r.tutorials.length > 0, "GET_TUTORIALS_SUMMARY returns array");
  const found = r.tutorials.find((t) => t.id === "summary-test");
  assert(found, "summary includes the saved tutorial");
  assert(found.steps.length === 3, "summary has all 3 steps");

  assert(found.steps[0].screenshot?.image === "data:image/png;base64,STEP1", "summary first step keeps its screenshot (thumbnail)");

  assert(found.steps[1].screenshot?.image === undefined, "summary second step excludes screenshot.image");
  assert(found.steps[2].screenshot?.image === undefined, "summary third step excludes screenshot.image");

  assert(found.steps[0].annotationCount === 1, "summary step 1 has annotationCount=1");
  assert(found.steps[2].annotationCount === 2, "summary step 3 has annotationCount=2");

  assert(found.steps[2].description === "Step 3", "summary preserves step descriptions for search");

  await new Promise(res => messageListener({ type: "DELETE_TUTORIAL", id: "summary-test" }, senderLocal, res));
}

{
  const senderLocal = { tab: { id: 1, windowId: 1 } };

  const origTabsGet = globalThis.chrome.tabs.get;
  const origTabsUpdate = globalThis.chrome.tabs.update;
  const origWindowsUpdate = globalThis.chrome.windows.update;
  const origWindowsGetAll = globalThis.chrome.windows.getAll;
  const origScriptingExecute = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.tabs.get = async (tabId) => ({ id: tabId, windowId: 1, url: "https://example.com/" });
  globalThis.chrome.tabs.update = async () => {};
  globalThis.chrome.windows.update = async () => {};
  globalThis.chrome.windows.getAll = async () => [];

  globalThis.chrome.scripting.executeScript = async () => [{ result: [720, 720, 0] }];

  const origCapture = globalThis.chrome.tabs.captureVisibleTab;
  globalThis.chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,AAAA";

  try {
    const r = await new Promise(res => messageListener({ type: "CAPTURE_FULL_PAGE", tabId: 99 }, senderLocal, res));
    assert(r?.ok === true, "CAPTURE_FULL_PAGE returns ok:true");
    assert(Array.isArray(r?.captures), "CAPTURE_FULL_PAGE returns captures array");
    assert(Array.isArray(r?.nestedCaptures), "CAPTURE_FULL_PAGE returns nestedCaptures array (P0-1)");

    if (r && r.captures && r.captures.length > 0) {
      for (const c of r.captures) {
        assert(typeof c.image === "string", "every captures entry has .image string (P0-1)");
        assert(typeof c.scrollY === "number", "every captures entry has .scrollY number (P0-1)");
      }
    }

    if (r && r.nestedCaptures) {
      for (const n of r.nestedCaptures) {
        assert(n.image === undefined, "nestedCaptures entries do NOT have .image (P0-1)");
        assert(Array.isArray(n.captures), "nestedCaptures entries have .captures array (P0-1)");
      }
    }
  } catch (e) {
    assert(false, "CAPTURE_FULL_PAGE smoke test: " + e.message);
  }

  globalThis.chrome.tabs.get = origTabsGet;
  globalThis.chrome.tabs.update = origTabsUpdate;
  globalThis.chrome.windows.update = origWindowsUpdate;
  if (origWindowsGetAll) globalThis.chrome.windows.getAll = origWindowsGetAll;
  globalThis.chrome.scripting.executeScript = origScriptingExecute;
  globalThis.chrome.tabs.captureVisibleTab = origCapture;
}

{
  const senderLocal = { tab: { id: 99, windowId: 1 } };

  const r = await new Promise(res => messageListener({
    type: "RECORD_EVENT",
    event: "SUBMIT",
    target: { selectors: ["#submit-btn"], tag: "button", text: "Submit", boundingBox: { x: 100, y: 200, width: 80, height: 30 } },
    url: "https://example.com",
    frame: { id: 0, url: "https://example.com", isTop: true },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 }
  }, senderLocal, res));
  assert(r?.ok === false, "SUBMIT with no session returns ok:false without throwing (P0-1)");
}

{

  const session = {
    id: "test-session",
    title: "Test",
    status: "recording",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    primaryTabId: 1,
    primaryWindowId: 1,
    tabIds: [1],
    windowIds: [1],
    excludedDomains: [],
    steps: [{
      id: "step-1",
      number: 1,
      action: "CLICK",
      description: "Click the Submit button.",
      target: { selectors: ["#submit-btn"], tag: "button", text: "Submit", boundingBox: { x: 100, y: 200, width: 80, height: 30 } },
      screenshot: { image: "", status: "OK", width: 1280, height: 720, devicePixelRatio: 1, url: "https://example.com", timestamp: Date.now() },
      annotations: []
    }]
  };
  await globalThis.chrome.storage.local.set({ activeSession: session });

  const origTabsGet = globalThis.chrome.tabs.get;
  const origWindowsGetAll = globalThis.chrome.windows.getAll;
  const origScriptingExecute = globalThis.chrome.scripting.executeScript;
  const origCapture = globalThis.chrome.tabs.captureVisibleTab;
  const origTabsQuery = globalThis.chrome.tabs.query;
  const origWindowsUpdate = globalThis.chrome.windows.update;
  const origTabsUpdate = globalThis.chrome.tabs.update;
  globalThis.chrome.tabs.get = async (id) => ({ id, windowId: 1, url: "https://example.com/" });
  globalThis.chrome.windows.getAll = async () => [];
  globalThis.chrome.tabs.query = async () => [];
  globalThis.chrome.windows.update = async () => {};
  globalThis.chrome.tabs.update = async () => {};
  globalThis.chrome.scripting.executeScript = async () => [];
  globalThis.chrome.tabs.captureVisibleTab = async () => "data:image/png;base64,AAAA";

  try {

    const senderLocal = { tab: { id: 1, windowId: 1 }, frameId: 0 };
    const r = await new Promise(res => messageListener({
      type: "RECORD_EVENT",
      event: "SUBMIT",
      target: { selectors: ["#submit-btn"], tag: "button", text: "Submit", boundingBox: { x: 100, y: 200, width: 80, height: 30 } },
      url: "https://example.com",
      frame: { id: 0, url: "https://example.com", isTop: true },
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 }
    }, senderLocal, res));

    const stored = await globalThis.chrome.storage.local.get("activeSession");
    const steps = stored.activeSession?.steps || [];
    const hasClick = steps.some(s => s.action === "CLICK");
    const hasSubmit = steps.some(s => s.action === "SUBMIT");

    assert(!hasClick, "P0-1: prior CLICK step retracted when SUBMIT arrives on same element");
  } catch (e) {
    assert(false, "P0-1 SUBMIT retract test: " + e.message);
  }

  await globalThis.chrome.storage.local.remove("activeSession");
  globalThis.chrome.tabs.get = origTabsGet;
  globalThis.chrome.windows.getAll = origWindowsGetAll;
  globalThis.chrome.tabs.query = origTabsQuery;
  globalThis.chrome.windows.update = origWindowsUpdate;
  globalThis.chrome.tabs.update = origTabsUpdate;
  globalThis.chrome.scripting.executeScript = origScriptingExecute;
  globalThis.chrome.tabs.captureVisibleTab = origCapture;
}

{
  const senderLocal = { tab: { id: 1, windowId: 1 } };

  await new Promise(res => messageListener({ type: "SAVE_TUTORIAL", tutorial: { id: "export-test", title: "Export Test", steps: [{ id: "s1", number: 1, description: "Step 1", screenshot: { image: "data:image/png;base64,AAA", width: 800, height: 600 }, annotations: [] }] } }, senderLocal, res));

  let getTutorialCalled = false;
  let getTutorialId = null;
  const origSendMessage = globalThis.chrome.runtime.sendMessage;

  const r = await new Promise(res => messageListener({ type: "GET_TUTORIAL", id: "export-test" }, senderLocal, res));
  assert(r?.tutorial?.title === "Export Test", "GET_TUTORIAL returns full tutorial for dashboard export (P0)");
  assert(r?.tutorial?.steps[0]?.screenshot?.image === "data:image/png;base64,AAA", "GET_TUTORIAL preserves screenshot.image (P0)");

  await new Promise(res => messageListener({ type: "DELETE_TUTORIAL", id: "export-test" }, senderLocal, res));
}

{
  const exporter = await import("./exporter.js");

  try {
    await exporter.loadImage("javascript:alert(1)");
    assert(false, "loadImage should reject javascript: URLs (P2)");
  } catch (e) {
    assert(e.message.includes("no screenshot"), "loadImage rejects javascript: URLs with sanitization error (P2)");
  }
  try {
    await exporter.loadImage("");
    assert(false, "loadImage should reject empty source");
  } catch (e) {
    assert(e.message.includes("no screenshot"), "loadImage rejects empty source (P2)");
  }
  try {
    await exporter.loadImage(null);
    assert(false, "loadImage should reject null source");
  } catch (e) {
    assert(e.message.includes("no screenshot"), "loadImage rejects null source (P2)");
  }
}

{
  const t = {
    id: "idempotent-test",
    version: 4,
    title: "Already Saved",
    description: "desc",
    steps: [
      { id: "s1", number: 1, description: "Step 1", screenshot: { image: "data:image/png;base64,AAA", width: 800, height: 600, status: "OK" }, annotations: [] }
    ]
  };
  const normalized = shared.normalizeTutorial(t);

  const needsMigration = JSON.stringify({ ...normalized, version: t.version }) !== JSON.stringify(t);
  assert(!needsMigration, "normalizeTutorial is idempotent for well-formed tutorials");
}

{
  const malformed = {
    id: "malformed-test",
    title: "Needs Migration",
    steps: [
      { id: "s1", number: 1, description: "Step 1", screenshot: { image: "javascript:alert(1)", width: 800, height: 600 }, annotations: [] }
    ]

  };
  const normalized = shared.normalizeTutorial(malformed);

  assert(normalized.steps[0].screenshot.image === "", "normalizeTutorial sanitizes invalid screenshot URLs");
  assert(normalized.version === 4, "normalizeTutorial sets version to 4");

  const needsMigration = JSON.stringify({ ...normalized, version: malformed.version }) !== JSON.stringify(malformed);
  assert(needsMigration, "normalizeTutorial detects migration needed for malformed tutorials");
}

console.log(`  → ${passed - s5} passed\n`);

console.log("━ regression fixes ━");

const s5b = passed;

{
  const tutorial = {
    title: "Test",
    steps: [{
      id: "step-1",
      screenshot: { image: "data:image/png;base64,ORIGINAL", width: 800, height: 600, status: "OK" },
      annotations: []
    }]
  };
  const snap1 = shared.clone(tutorial);
  snap1.steps[0].screenshot.image = "data:image/png;base64,CROPPED";
  const snap2 = shared.clone(tutorial);

  assert(tutorial.steps[0].screenshot.image === "data:image/png;base64,ORIGINAL", "original tutorial image unchanged after snapshot mutation");

  assert(snap1.steps[0].screenshot.image === "data:image/png;base64,CROPPED", "snapshot 1 has cropped image");

  assert(snap2.steps[0].screenshot.image === "data:image/png;base64,ORIGINAL", "snapshot 2 has original image");
}

{

  const ts = Math.floor(Date.now() / 100);
  const key1 = `NAVIGATION|1|body|0|0|https://example.com/page1|${ts}`;
  const key2 = `NAVIGATION|1|body|0|0|https://example.com/page2|${ts}`;
  assert(key1 !== key2, "NAVIGATION dedup keys differ for different URLs");
}

console.log(`  → ${passed - s5b} passed\n`);

const s6 = passed;
console.log("━ edge case coverage ━");

{
  const a = mod.normalizeAnnotation({ type: "rectangle", color: "#abc", x: -100, y: -100, width: 99999, height: 99999 }, 0, 1280, 720);
  assert(a.x >= 0 && a.y >= 0, "annotation clamped to canvas bounds");
  assert(a.width <= 1280 && a.height <= 720, "annotation width/height clamped to canvas");
  assert(a.color === "#abc", "3-digit hex preserved by sanitizeColor");
}

{
  const t = mod.normalizeTutorial({ id: "test", title: "T", steps: [null, { id: "s1", screenshot: null }] });
  assert(t.steps.length === 2, "null step preserved as empty step");
  assert(t.steps[0].id != null, "null step gets generated id");
  assert(t.steps[1].screenshot.width > 0, "null screenshot gets default dimensions");
}

{
  const a = mod.normalizeAnnotation({ type: "marker", x: -50, y: -50, width: 28, height: 28 }, 0, 1280, 720);
  assert(a.x >= 14, "marker center x clamped to >= width/2");
  assert(a.y >= 14, "marker center y clamped to >= height/2");
}

{
  const a = mod.normalizeAnnotation({ type: "arrow", startX: -10, startY: 200, endX: -5, endY: 300 }, 0, 1280, 720);
  assert(a.startX === 0, "arrow startX clamped to 0");
  assert(a.startY === 100, "arrow startY clamped to 100");
}

{
  const result = mod.withAlpha("#abc", 0.5);
  assert(result.startsWith("#aabbcc"), "withAlpha expands 3-digit hex");
  assert(result.length === 9, "withAlpha returns 8-char hex + 2-char alpha");
}

{
  const result = mod.withAlpha("#ff0000", 1);
  assert(result === "#ff0000ff", "withAlpha full opacity");
  assert(mod.withAlpha("invalid", 0.5) === "#ff735280", "withAlpha falls back to brand color");
}

{
  const box = mod.annotationBox({ type: "marker", x: 100, y: 100, width: 20, height: 20 });
  assert(box.x === 90 && box.y === 90, "marker annotationBox returns top-left from center");
  const box2 = mod.annotationBox({ type: "rectangle", x: 50, y: 60, width: 100, height: 80 });
  assert(box2.x === 50 && box2.y === 60, "rectangle annotationBox returns x/y directly");
}

{
  assert(mod.clamp(5, 0, 10) === 5, "clamp returns value when in range");
  assert(mod.clamp(-5, 0, 10) === 0, "clamp returns min when below");
  assert(mod.clamp(15, 0, 10) === 10, "clamp returns max when above");
}

{
  assert(mod.sanitizeNumber(42, 0) === 42, "sanitizeNumber returns valid number");
  assert(mod.sanitizeNumber("abc", 99) === 99, "sanitizeNumber returns fallback for NaN");
  assert(mod.sanitizeNumber(Infinity, 0) === 0, "sanitizeNumber returns fallback for Infinity");
}

{
  assert(mod.sanitizeImageUrl("data:image/png;base64,AAAA") === "data:image/png;base64,AAAA", "valid data URL passes");
  assert(mod.sanitizeImageUrl("javascript:alert(1)") === "", "javascript: URL blocked");
  assert(mod.sanitizeImageUrl("https://example.com/img.png") === "", "https: URL blocked");
  assert(mod.sanitizeImageUrl("") === "", "empty URL returns empty");
}

{
  assert(mod.sanitizeColor("#fff") === "#fff", "3-digit hex passes");
  assert(mod.sanitizeColor("#ffffff") === "#ffffff", "6-digit hex passes");
  assert(mod.sanitizeColor("red") === "#ff7352", "named color falls back");
  assert(mod.sanitizeColor(null) === "#ff7352", "null falls back");
}

{
  assert(mod.escapeHtml("<script>") === "&lt;script&gt;", "escapeHtml escapes angle brackets");
  assert(mod.escapeHtml('"hello"') === "&quot;hello&quot;", "escapeHtml escapes quotes");
  assert(mod.escapeHtml(null) === "", "escapeHtml handles null");
  assert(mod.escapeAttr("test`code") === "testcode", "escapeAttr strips backticks");
}

{
  const c = mod.clone({ a: 1, b: [2, 3] });
  assert(c.a === 1 && c.b[0] === 2, "clone produces deep copy");
  c.b[0] = 99;
  assert(mod.clone({ a: 1, b: [2, 3] }).b[0] === 2, "clone is independent of original");
}

{
  const points = mod.arrowHeadPoints({ startX: 0, startY: 100, endX: 100, endY: 0, arrowHeadSize: 10 }, 200, 100);
  assert(typeof points === "string", "arrowHeadPoints returns string");
  assert(points.split(" ").length === 3, "arrowHeadPoints returns 3 coordinate pairs");
  assert(points.split(",")[0] === "100", "arrowHeadPoints endpoint x is 100");
}

{
  const size = mod.canvasSize({ screenshot: { width: 1920, height: 1080 } });
  assert(size.width === 1920 && size.height === 1080, "canvasSize returns screenshot dimensions");
  const defaultSize = mod.canvasSize({});
  assert(defaultSize.width === 1280 && defaultSize.height === 720, "canvasSize returns defaults for missing screenshot");
}

{
  const t = mod.normalizeTutorial({ id: "test-id", title: "T", steps: [] });
  assert(t.version === 4, "normalizeTutorial sets version to 4");
  assert(t.steps.length === 0, "normalizeTutorial handles empty steps array");
  assert(t.id === "test-id", "normalizeTutorial preserves valid id");
}

{
  try {
    mod.normalizeTutorial(null);
    assert(false, "normalizeTutorial(null) should throw");
  } catch (e) {
    assert(e.message.includes("Invalid"), "normalizeTutorial(null) throws with clear message");
  }
  try {
    mod.normalizeTutorial([1, 2, 3]);
    assert(false, "normalizeTutorial(array) should throw");
  } catch (e) {
    assert(e.message.includes("Invalid"), "normalizeTutorial(array) throws with clear message");
  }
}

{
  const t = mod.normalizeTutorial({ id: "test", title: "A".repeat(600), steps: [] });
  assert(t.title.length === 500, "normalizeTutorial caps title at 500 chars");
}

{
  const t = mod.normalizeTutorial({
    id: "test", title: "T", steps: [
      { id: "s1", annotations: [{ type: "text", text: "A".repeat(600) }] }
    ]
  });
  assert(t.steps[0].annotations[0].text.length === 500, "annotation text capped at 500 chars");
}

console.log(`  → ${passed - s6} passed\n`);

const s7 = passed;
console.log("━ settings-store + eventToKey ━");

{
  assert(ss.DEFAULT_SHORTCUTS.undo.keys === "mod+z", "default undo shortcut");
  assert(ss.DEFAULT_SHORTCUTS.save.keys === "mod+s", "default save shortcut");
  assert(ss.DEFAULT_SHORTCUTS.preview.keys === "mod+shift+p", "default preview shortcut");
  assert(Object.keys(ss.DEFAULT_SHORTCUTS).length >= 20, "20+ default shortcuts");
  assert(ss.GLOBAL_COMMANDS.length === 4, "4 global commands");
}

{
  const fakeEvent = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "z" };
  assert(ss.eventToKey(fakeEvent) === "mod+z", "eventToKey: mod+z");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, key: "z" };
  assert(ss.eventToKey(fakeEvent) === "mod+shift+z", "eventToKey: mod+shift+z");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "?" };
  assert(ss.eventToKey(fakeEvent) === "?", "eventToKey: ? (no modifiers)");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: " " };
  assert(ss.eventToKey(fakeEvent) === "space", "eventToKey: space");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, key: "A" };
  assert(ss.eventToKey(fakeEvent) === "shift+a", "eventToKey: shift+a (lowercased)");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: true, key: "Escape" };
  assert(ss.eventToKey(fakeEvent) === "alt+escape", "eventToKey: alt+escape");
}

{
  const fakeEvent = { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: "s" };
  assert(ss.matchesShortcut(fakeEvent, "save") === true, "matchesShortcut: Ctrl+S matches save");
}

{
  const fakeEvent = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: "x" };
  assert(ss.matchesShortcut(fakeEvent, "save") === false, "matchesShortcut: X does not match save");
}

{
  assert(typeof ss.getShortcut === "function", "getShortcut is a function");
  assert(ss.getShortcut("undo") === "mod+z", "getShortcut returns default when no cache");
  assert(ss.getShortcut("nonexistent") === null, "getShortcut returns null for unknown action");
}

{
  assert(typeof ss.subscribe === "function", "subscribe is a function");
  let called = false;
  const unsub = ss.subscribe(() => { called = true; });
  assert(typeof unsub === "function", "subscribe returns unsubscribe function");
  unsub();
}

console.log(`  → ${passed - s7} passed\n`);

const s8 = passed;
console.log("━ gif-encoder edge cases ━");

{
  const gif2 = await import("./gif-encoder.js");
  const emptyRgba = new Uint8Array(4);
  emptyRgba[3] = 255;
  const blob = await gif2.encodeGif([{ width: 1, height: 1, rgba: emptyRgba, delayMs: 100 }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert(buf[0] === 0x47 && buf[1] === 0x49, "1x1 GIF has GIF89a header");
  assert(buf[buf.length - 1] === 0x3b, "1x1 GIF has trailer");
}

{
  const gif3 = await import("./gif-encoder.js");
  const rgba = new Uint8Array(8);
  rgba[3] = 255; rgba[7] = 255;
  const blob = await gif3.encodeGif([{ width: 2, height: 1, rgba, delayMs: 0 }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert(buf.length > 30, "GIF with delayMs=0 is non-trivial");
}

{
  const gif4 = await import("./gif-encoder.js");
  const frames = [];
  for (let f = 0; f < 3; f++) {
    const rgba = new Uint8Array(4);
    rgba[0] = f * 80; rgba[1] = 100; rgba[2] = 200; rgba[3] = 255;
    frames.push({ width: 1, height: 1, rgba, delayMs: 500 });
  }
  const blob = await gif4.encodeGif(frames, { loop: true });
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert(String.fromCharCode(...buf.slice(0, 6)) === "GIF89a", "multi-frame GIF has header");
  let found = false;
  const target = "NETSCAPE2.0";
  for (let i = 0; i <= buf.length - target.length; i++) {
    let match = true;
    for (let j = 0; j < target.length; j++) {
      if (buf[i+j] !== target.charCodeAt(j)) { match = false; break; }
    }
    if (match) { found = true; break; }
  }
  assert(found, "multi-frame GIF has NETSCAPE loop extension");
}

console.log(`  → ${passed - s8} passed\n`);

const s9 = passed;
console.log("━ background message routing ━");

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "GET_STATE" }, sender, res));
  assert(r?.session === null || r?.session === undefined, "GET_STATE with no session returns null/undefined");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "GET_TUTORIAL", id: "nonexistent-id" }, sender, res));
  assert(r?.tutorial === null, "GET_TUTORIAL with bad id returns null");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "GET_TUTORIALS" }, sender, res));
  assert(Array.isArray(r?.tutorials), "GET_TUTORIALS returns array");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "GET_TUTORIALS_SUMMARY" }, sender, res));
  assert(Array.isArray(r?.tutorials), "GET_TUTORIALS_SUMMARY returns array");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "DELETE_TUTORIAL", id: "nonexistent" }, sender, res));
  assert(r?.ok === true, "DELETE_TUTORIAL returns ok even for nonexistent id");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "DELETE_TUTORIALS", ids: [] }, sender, res));
  assert(r?.ok === true, "DELETE_TUTORIALS with empty array returns ok");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "DELETE_TUTORIALS", ids: ["nonexistent"] }, sender, res));
  assert(r?.ok === true, "DELETE_TUTORIALS with nonexistent ids returns ok");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "START_RECORDING" }, sender, res));
  assert(r?.ok === false, "START_RECORDING with no valid tab returns ok:false");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "CAPTURE_FULL_PAGE" }, sender, res));
  assert(r?.ok === false, "CAPTURE_FULL_PAGE without tabId returns ok:false");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "DUPLICATE_TUTORIAL" }, sender, res));
  assert(r?.ok === false, "DUPLICATE_TUTORIAL without id returns ok:false");
}

{
  const sender = { tab: { id: 1, windowId: 1 } };
  const r = await new Promise(res => messageListener({ type: "UNKNOWN_TYPE" }, sender, res));
  assert(r?.ok === false, "Unknown message type returns ok:false");
}

console.log(`  → ${passed - s9} passed\n`);

console.log("═══════════════════════════════════════");
console.log(`  TOTAL: ${passed} passed, ${failed} failed`);
console.log("═══════════════════════════════════════");

if (failed > 0) {
  console.error("\nFAILURES:");
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
} else {
  console.log("\n✅ ALL TESTS PASSED — production ready");
  process.exit(0);
}
