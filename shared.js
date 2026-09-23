const DB_NAME = "browser-tutorial-recorder";
const DB_VERSION = 5;
const TUTORIAL_STORE = "tutorials";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;

      for (const legacy of ["sessions", "settings"]) {
        if (db.objectStoreNames.contains(legacy)) db.deleteObjectStore(legacy);
      }
      if (!db.objectStoreNames.contains(TUTORIAL_STORE)) {
        db.createObjectStore(TUTORIAL_STORE, { keyPath: "id" });
      }
    };
    request.onblocked = () => {


      dbPromise = null;
      reject(new Error("IndexedDB upgrade blocked — close other tabs"));
    };
    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };

      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;










      const err = request.error;
      if (err && err.name === "VersionError") {
        console.error("[BTR] IndexedDB VersionError: the on-disk database is newer than this extension version. Tutorials are preserved but cannot be read until you upgrade the extension or manually clear IndexedDB via DevTools (which WILL delete all tutorials).");
        reject(new Error("Database version mismatch. Your tutorials are preserved but cannot be read by this version of the extension. Please upgrade to the latest version, or clear the extension's IndexedDB via DevTools if you accept losing all tutorials."));
        return;
      }
      reject(err);
    };
  });
  return dbPromise;
}

async function dbPut(value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TUTORIAL_STORE, "readwrite");
    tx.objectStore(TUTORIAL_STORE).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TUTORIAL_STORE, "readwrite");
    tx.objectStore(TUTORIAL_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

async function dbDeleteAll(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TUTORIAL_STORE, "readwrite");
    const store = tx.objectStore(TUTORIAL_STORE);
    let count = 0;
    for (const id of ids) {
      if (id != null) {
        store.delete(id);
        count++;
      }
    }
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(TUTORIAL_STORE).objectStore(TUTORIAL_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAllSummaries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const summaries = [];
    const tx = db.transaction(TUTORIAL_STORE, "readonly");
    const store = tx.objectStore(TUTORIAL_STORE);
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {

        resolve(summaries);
        return;
      }
      const t = cursor.value;




      const steps = Array.isArray(t.steps) ? t.steps : [];

      const thumbStep = steps.find((s) => s.screenshot?.image);
      summaries.push({
        id: t.id,
        version: t.version,
        title: t.title,
        description: t.description,
        status: t.status,
        isDemo: t.isDemo,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        steps: steps.map((s) => ({
          id: s.id,
          number: s.number,
          action: s.action,
          description: s.description,
          ...(s === thumbStep ? { screenshot: { image: s.screenshot?.image || "" } } : {}),
          annotationCount: s.annotations?.length || 0
        }))
      });


      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(TUTORIAL_STORE).objectStore(TUTORIAL_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]
  ));
}

// Like escapeHtml but also strips backticks and newlines — safe for HTML
// attribute interpolation.
function escapeAttr(value) {
  return escapeHtml(value).replace(/[`\r\n]/g, "");
}

// Only data: URLs of known raster image types are allowed.
function sanitizeImageUrl(url) {
  const str = String(url ?? "");
  const match = str.match(/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/);
  return match ? str : "";
}

// Only `#rgb` or `#rrggbb` hex colors; falls back to the brand orange.
function sanitizeColor(color) {
  const str = String(color ?? "").trim().toLowerCase();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(str) ? str : "#ff7352";
}

// Returns a finite number, else the fallback.
function sanitizeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Annotation + tutorial helpers (shared by editor and preview)
// ---------------------------------------------------------------------------

const ANNOTATION_DEFAULTS = {
  highlight: { color: "#ff7352", strokeWidth: 3, opacity: 0.75 },
  rectangle: { color: "#4779f4", fillColor: "#4779f4", fillOpacity: 0, strokeWidth: 4, opacity: 1 },
  circle: { color: "#8b5cf6", fillColor: "#8b5cf6", fillOpacity: 0, strokeWidth: 4, opacity: 1 },
  arrow: { color: "#ff7352", strokeWidth: 5, arrowHeadSize: 14, arrowCap: "round", opacity: 1 },
  text: { text: "Add a note", textColor: "#ffffff", background: "#202b40", fontSize: 22, fontWeight: 700, opacity: 1 },
  blur: { blur: 10, opacity: 1 },
  redaction: { color: "#202b40", opacity: 1 },
  spotlight: { color: "#172238", opacity: 0.78 },
  marker: { color: "#ff7352", opacity: 1, label: "1" }
};

const ROTATABLE_TYPES = new Set(["highlight", "rectangle", "circle", "arrow", "text", "blur", "redaction", "spotlight"]);
const RESIZABLE_TYPES = new Set([...ROTATABLE_TYPES, "marker"]);

function canvasSize(step) {
  return {
    width: Number(step?.screenshot?.width) || 1280,
    height: Number(step?.screenshot?.height) || 720
  };
}

// Markers store their centre as (x, y); every other annotation uses top-left.
function annotationBox(annotation) {
  const a = annotation;
  if (a.type === "marker") {
    return { x: a.x - a.width / 2, y: a.y - a.height / 2, width: a.width, height: a.height };
  }
  return { x: a.x, y: a.y, width: a.width, height: a.height };
}

function withAlpha(hex, opacity) {
  // H23 fix: expand 3-digit hex (#rgb → #rrggbb) before appending alpha.
  // sanitizeColor() permits #rgb, but the old withAlpha() only matched
  // #rrggbb — so a valid #abc fell back to the brand orange.
  let color = String(hex || "");
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    color = "#" + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) color = "#ff7352";
  return `${color}${Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, "0")}`;
}

// v1.0.2 #4: arrowHeadPoints now accepts the annotation's width/height so it
// can compute the arrowhead angle in real pixel space (matching drawArrow in
// exporter.js). Without this, the SVG's preserveAspectRatio="none" stretches
// the 0-100x0-100 viewBox non-uniformly, distorting the arrowhead away from
// the shaft's true direction. We compute in pixel space then convert back
// to 0-100 SVG units at the end.
function arrowHeadPoints(a, width, height) {
  // Convert normalized 0-100 coordinates to pixel-space.
  const w = Number(width) || 100;
  const h = Number(height) || 100;
  const x1 = Number(a.startX) / 100 * w;
  const y1 = Number(a.startY) / 100 * h;
  const x2 = Number(a.endX) / 100 * w;
  const y2 = Number(a.endY) / 100 * h;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  // Head length in pixel space, scaled to the annotation's average dimension.
  const avgDim = (w + h) / 2;
  const length = Math.max(4, Number(a.arrowHeadSize || 12)) * avgDim / 100;
  const spread = Math.PI / 6;
  // Compute head points in pixel space, then convert back to 0-100 SVG units.
  const toSvgX = (px) => px / w * 100;
  const toSvgY = (py) => py / h * 100;
  return [
    [toSvgX(x2), toSvgY(y2)],
    [toSvgX(x2 - length * Math.cos(angle - spread)), toSvgY(y2 - length * Math.sin(angle - spread))],
    [toSvgX(x2 - length * Math.cos(angle + spread)), toSvgY(y2 - length * Math.sin(angle + spread))]
  ].map(([x, y]) => `${x},${y}`).join(" ");
}

function normalizeAnnotation(source, index, canvasWidth, canvasHeight) {
  // C11 fix: defend against null/non-object annotations (e.g., annotations: [null]).
  const src = (source && typeof source === "object" && !Array.isArray(source)) ? source : {};
  const type = ANNOTATION_DEFAULTS[src.type] ? src.type : "rectangle";
  const a = { ...ANNOTATION_DEFAULTS[type], ...src, type };
  a.id ||= `annotation-${Date.now()}-${index}`;
  // F10 fix: bound annotation geometry to the canvas dimensions. Without this,
  // an imported annotation with x=-500, y=9000, width=10000 survives normalization
  // and renders off-canvas. Now clamp x/y to [0, canvasWidth/Height] and
  // width/height to [8, canvasWidth/Height].
  const cw = Math.max(8, canvasWidth || 1280);
  const ch = Math.max(8, canvasHeight || 720);
  // P2-11 fix: use sanitizeNumber to prevent NaN from invalid imports
  a.width = Math.max(8, Math.min(cw, sanitizeNumber(a.width, type === "marker" ? 28 : 120)));
  a.height = Math.max(8, Math.min(ch, sanitizeNumber(a.height, type === "marker" ? 28 : 80)));
  if (type === "marker") {
    // Markers store center; clamp center to [width/2, cw-width/2] etc.
    a.x = clamp(sanitizeNumber(a.x, cw / 2), a.width / 2, Math.max(a.width / 2, cw - a.width / 2));
    a.y = clamp(sanitizeNumber(a.y, ch / 2), a.height / 2, Math.max(a.height / 2, ch - a.height / 2));
  } else {
    a.x = clamp(sanitizeNumber(a.x, 0), 0, Math.max(0, cw - a.width));
    a.y = clamp(sanitizeNumber(a.y, 0), 0, Math.max(0, ch - a.height));
  }
  a.rotation = sanitizeNumber(a.rotation, 0);
  a.opacity = clamp(sanitizeNumber(a.opacity, 1), 0, 1);
  // Sanitize color fields across every annotation type.
  if (a.color != null) a.color = sanitizeColor(a.color);
  if (a.fillColor != null) a.fillColor = sanitizeColor(a.fillColor);
  if (a.textColor != null) a.textColor = sanitizeColor(a.textColor);
  if (a.background != null) a.background = sanitizeColor(a.background);
  // Cap text/label length to keep DOM output sane.
  if (a.text != null) a.text = String(a.text).slice(0, 500);
  if (a.label != null) a.label = String(a.label).slice(0, 3);
  if (type === "marker") a.label = String(a.label ?? index + 1);
  // A6 fix: sanitize numeric fields used by non-arrow annotation types.
  // Previously only the arrow branch sanitized strokeWidth. highlight/rectangle/
  // circle/text/blur types could carry strokeWidth:"abc", blur:"xyz",
  // fillOpacity:"high", fontSize:"big", fontWeight:"bold" from a corrupted
  // import — producing invalid CSS like "abcpx" or "blur(xyzpx)" that the
  // browser silently ignores, leaving the annotation invisible.
  if (a.strokeWidth != null) a.strokeWidth = clamp(sanitizeNumber(a.strokeWidth, 4), 1, 40);
  if (a.fillOpacity != null) a.fillOpacity = clamp(sanitizeNumber(a.fillOpacity, 0), 0, 1);
  if (a.blur != null) a.blur = clamp(sanitizeNumber(a.blur, 10), 0, 40);
  if (a.fontSize != null) a.fontSize = clamp(sanitizeNumber(a.fontSize, 22), 8, 96);
  if (a.fontWeight != null) a.fontWeight = clamp(sanitizeNumber(a.fontWeight, 700), 100, 900);
  if (type === "arrow") {
    a.startX = clamp(sanitizeNumber(a.startX, 8), 0, 100);
    a.startY = clamp(sanitizeNumber(a.startY, 92), 0, 100);
    a.endX = clamp(sanitizeNumber(a.endX, 92), 0, 100);
    a.endY = clamp(sanitizeNumber(a.endY, 8), 0, 100);
    a.strokeWidth = clamp(sanitizeNumber(a.strokeWidth, 5), 1, 40);
    a.arrowHeadSize = clamp(sanitizeNumber(a.arrowHeadSize, 14), 4, 40);
    if (!["round", "square", "butt"].includes(a.arrowCap)) a.arrowCap = "round";
  }
  return a;
}

function normalizeTutorial(source) {
  // Guard against null/undefined/non-object input. All callers
  // have try/catch, but a clean error message is better than a TypeError.
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Invalid tutorial data: expected a tutorial object.");
  }
  const result = {
    ...source,
    id: source.id || `tutorial-${Date.now()}`,
    version: 4,
    steps: Array.isArray(source.steps) ? source.steps : []
  };
  // IDs must be alphanumeric so they're safe as DOM ids and URL params.
  // M16: cap length so a malicious import can't create pathological IDs.
  const sanitizeId = (value, prefix) => {
    const cleaned = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200);
    return cleaned || `${prefix}-${Date.now()}`;
  };
  result.id = sanitizeId(result.id, "tutorial");
  // Also cap title length to keep DOM/IndexedDB sane.
  if (result.title != null) result.title = String(result.title).slice(0, 500);
  if (result.description != null) result.description = String(result.description).slice(0, 2000);
  result.steps = result.steps.map((step, index) => {
    // C11 fix: defend against null/non-object steps (e.g., steps: [null]).
    // The old code assumed step was an object and accessed step.screenshot,
    // step.id, etc. — which would throw TypeError on null.
    const s = (step && typeof step === "object" && !Array.isArray(step)) ? step : {};
    const screenshot = s.screenshot || { image: "", status: "FAILED", width: 1280, height: 720, url: "", timestamp: Date.now() };
    // P2-12 fix: validate screenshot dimensions (must be positive finite numbers)
    // H24 fix: normalize to FINAL positive values BEFORE passing to
    // normalizeAnnotation, so annotation geometry is clamped against the
    // actual stored dimensions, not the raw unsanitized values.
    const sw = Math.max(1, Math.min(100000, sanitizeNumber(screenshot.width, 1280)));
    const sh = Math.max(1, Math.min(100000, sanitizeNumber(screenshot.height, 720)));
    return {
      ...s,
      id: sanitizeId(s.id || `step-${Date.now()}-${index}`, "step"),
      number: index + 1,
      // Cap description length to keep DOM/IndexedDB sane.
      description: s.description != null ? String(s.description).slice(0, 2000) : s.description,
      annotations: (Array.isArray(s.annotations) ? s.annotations : []).map((a, ai) => normalizeAnnotation(a, ai, sw, sh)),
      screenshot: {
        ...screenshot,
        image: sanitizeImageUrl(screenshot.image),
        width: Math.max(1, Math.min(100000, sw)),
        height: Math.max(1, Math.min(100000, sh))
      }
    };
  });
  return result;
}

export {
  $, escapeHtml, escapeAttr, sanitizeImageUrl, sanitizeColor, sanitizeNumber,
  clone, clamp,
  dbPut, dbDelete, dbDeleteAll, dbGet, dbGetAll, dbGetAllSummaries,
  ANNOTATION_DEFAULTS, ROTATABLE_TYPES, RESIZABLE_TYPES,
  canvasSize, annotationBox, withAlpha, arrowHeadPoints,
  normalizeAnnotation, normalizeTutorial
};
