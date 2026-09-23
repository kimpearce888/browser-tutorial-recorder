const DB_NAME = "browser-tutorial-recorder";
const DB_VERSION = 5;
const STORE = "tutorials";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const legacy of ["sessions", "settings"]) {
        if (db.objectStoreNames.contains(legacy)) db.deleteObjectStore(legacy);
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onblocked = () => { dbPromise = null; reject(new Error("IndexedDB upgrade blocked")); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      const err = req.error;
      if (err?.name === "VersionError") {
        reject(new Error("Database version mismatch. Upgrade the extension or clear IndexedDB via DevTools."));
        return;
      }
      reject(err);
    };
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then(db => {
    const transaction = db.transaction(STORE, mode);
    return { store: transaction.objectStore(STORE), transaction };
  });
}

function wrap(request, onsuccess) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(onsuccess ? onsuccess(request) : undefined);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(value) {
  const { store, transaction } = await tx("readwrite");
  store.put(value);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function dbDelete(id) {
  const { store, transaction } = await tx("readwrite");
  store.delete(id);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function dbDeleteAll(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const { store, transaction } = await tx("readwrite");
  let count = 0;
  for (const id of ids) {
    if (id != null) { store.delete(id); count++; }
  }
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(count);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function dbGetAll() {
  const { store } = await tx("readonly");
  return wrap(store.getAll(), req => req.result || []);
}

async function dbGet(id) {
  const { store } = await tx("readonly");
  return wrap(store.get(id), req => req.result || null);
}

async function dbGetAllSummaries() {
  const { store } = await tx("readonly");
  const summaries = [];
  return new Promise((resolve, reject) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      if (!cursor.result) return resolve(summaries);
      const t = cursor.result.value;
      const steps = Array.isArray(t.steps) ? t.steps : [];
      const thumb = steps.find(s => s.screenshot?.image);
      summaries.push({
        id: t.id, version: t.version, title: t.title, description: t.description,
        status: t.status, isDemo: t.isDemo, createdAt: t.createdAt, updatedAt: t.updatedAt,
        steps: steps.map(s => ({
          id: s.id, number: s.number, action: s.action, description: s.description,
          ...(s === thumb ? { screenshot: { image: s.screenshot?.image || "" } } : {}),
          annotationCount: s.annotations?.length || 0
        }))
      });
      cursor.result.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

const $ = id => document.getElementById(id);

const escapeMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
const escapeHtml = v => String(v ?? "").replace(/[&<>"']/g, c => escapeMap[c]);
const escapeAttr = v => escapeHtml(v).replace(/[`\r\n]/g, "");

const sanitizeImageUrl = url => {
  const s = String(url ?? "");
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : "";
};

const sanitizeColor = c => {
  const s = String(c ?? "").trim().toLowerCase();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s) ? s : "#ff7352";
};

const sanitizeNumber = (v, fb) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const clone = v => JSON.parse(JSON.stringify(v));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

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

const canvasSize = step => ({
  width: Number(step?.screenshot?.width) || 1280,
  height: Number(step?.screenshot?.height) || 720
});

function annotationBox(a) {
  return a.type === "marker"
    ? { x: a.x - a.width / 2, y: a.y - a.height / 2, width: a.width, height: a.height }
    : { x: a.x, y: a.y, width: a.width, height: a.height };
}

function withAlpha(hex, opacity) {
  let c = String(hex ?? "");
  if (/^#[0-9a-f]{3}$/i.test(c)) c = "#" + c[1]+c[1] + c[2]+c[2] + c[3]+c[3];
  if (!/^#[0-9a-f]{6}$/i.test(c)) c = "#ff7352";
  return c + Math.round(clamp(opacity, 0, 1) * 255).toString(16).padStart(2, "0");
}

function arrowHeadPoints(a, w, h) {
  w = Number(w) || 100;
  h = Number(h) || 100;
  const x1 = Number(a.startX)/100*w, y1 = Number(a.startY)/100*h;
  const x2 = Number(a.endX)/100*w,   y2 = Number(a.endY)/100*h;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(4, Number(a.arrowHeadSize || 12)) * (w + h) / 200;
  const sp = Math.PI / 6;
  const tx = px => px / w * 100, ty = py => py / h * 100;
  return [[tx(x2), ty(y2)],
    [tx(x2 - len * Math.cos(angle - sp)), ty(y2 - len * Math.sin(angle - sp))],
    [tx(x2 - len * Math.cos(angle + sp)), ty(y2 - len * Math.sin(angle + sp))]
  ].map(([x, y]) => `${x},${y}`).join(" ");
}

function normalizeAnnotation(source, index, cw, ch) {
  const src = (source && typeof source === "object" && !Array.isArray(source)) ? source : {};
  const type = ANNOTATION_DEFAULTS[src.type] ? src.type : "rectangle";
  const a = { ...ANNOTATION_DEFAULTS[type], ...src, type };
  a.id ||= `annotation-${crypto.randomUUID?.() || Date.now()}-${index}`;
  cw = Math.max(8, cw || 1280);
  ch = Math.max(8, ch || 720);
  a.width = Math.max(8, Math.min(cw, sanitizeNumber(a.width, type === "marker" ? 28 : 120)));
  a.height = Math.max(8, Math.min(ch, sanitizeNumber(a.height, type === "marker" ? 28 : 80)));
  if (type === "marker") {
    a.x = clamp(sanitizeNumber(a.x, cw/2), a.width/2, Math.max(a.width/2, cw - a.width/2));
    a.y = clamp(sanitizeNumber(a.y, ch/2), a.height/2, Math.max(a.height/2, ch - a.height/2));
  } else {
    a.x = clamp(sanitizeNumber(a.x, 0), 0, Math.max(0, cw - a.width));
    a.y = clamp(sanitizeNumber(a.y, 0), 0, Math.max(0, ch - a.height));
  }
  a.rotation = sanitizeNumber(a.rotation, 0);
  a.opacity = clamp(sanitizeNumber(a.opacity, 1), 0, 1);
  for (const f of ["color", "fillColor", "textColor", "background"]) {
    if (a[f] != null) a[f] = sanitizeColor(a[f]);
  }
  if (a.text != null) a.text = String(a.text).slice(0, 500);
  if (a.label != null) a.label = String(a.label).slice(0, 3);
  if (type === "marker") a.label = String(a.label ?? index + 1).slice(0, 3);
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
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Invalid tutorial data: expected a tutorial object.");
  }
  const sanitizeId = (v, prefix) => {
    const cleaned = String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200);
    return cleaned || `${prefix}-${Date.now()}`;
  };
  const result = {
    ...source,
    id: sanitizeId(source.id || `tutorial-${Date.now()}`, "tutorial"),
    version: 4,
    steps: Array.isArray(source.steps) ? source.steps : []
  };
  if (result.title != null) result.title = String(result.title).slice(0, 500);
  if (result.description != null) result.description = String(result.description).slice(0, 2000);
  result.steps = result.steps.map((step, index) => {
    const s = (step && typeof step === "object" && !Array.isArray(step)) ? step : {};
    const screenshot = s.screenshot || { image: "", status: "FAILED", width: 1280, height: 720, url: "", timestamp: Date.now() };
    const sw = Math.max(1, Math.min(100000, sanitizeNumber(screenshot.width, 1280)));
    const sh = Math.max(1, Math.min(100000, sanitizeNumber(screenshot.height, 720)));
    return {
      ...s,
      id: sanitizeId(s.id || `step-${crypto.randomUUID?.() || Date.now()}-${index}`, "step"),
      number: index + 1,
      description: s.description != null ? String(s.description).slice(0, 2000) : s.description,
      annotations: (Array.isArray(s.annotations) ? s.annotations : []).map((a, ai) => normalizeAnnotation(a, ai, sw, sh)),
      screenshot: { ...screenshot, image: sanitizeImageUrl(screenshot.image), width: sw, height: sh }
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
