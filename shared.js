const DB_NAME = "btr-tutorials";
const DB_VERSION = 1;
const STORE = "tutorials";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

export async function dbPut(value) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(value);
  return txDone(tx);
}

export async function dbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDelete(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  return txDone(tx);
}

export async function dbDeleteAll() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  return txDone(tx);
}

export async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetSummaries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      out.push(toSummary(cursor.value));
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function toSummary(t) {
  const thumbStep = (t.steps || []).find((s) => s.screenshot && s.screenshot.image);
  return {
    id: t.id,
    title: t.title,
    description: t.description || "",
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    durationMs: t.durationMs || 0,
    stepCount: (t.steps || []).length,
    thumbnail: thumbStep ? thumbStep.screenshot.image : ""
  };
}

export function makeId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

const SAFE_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i;

export function sanitizeImageUrl(source) {
  if (typeof source !== "string" || !source) return "";
  const trimmed = source.trim();
  return SAFE_URL_RE.test(trimmed) ? trimmed : "";
}

export function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

const ANNOTATION_TYPES = new Set([
  "highlight", "rectangle", "circle", "arrow", "text",
  "blur", "redaction", "spotlight", "marker"
]);

function normalizeAnnotation(a, index) {
  if (!a || typeof a !== "object") return null;
  const type = ANNOTATION_TYPES.has(a.type) ? a.type : null;
  if (!type) return null;
  const num = (v, fallback) => (typeof v === "number" && isFinite(v) ? v : fallback);
  return {
    id: typeof a.id === "string" && a.id ? a.id : makeId("ann"),
    type,
    x: num(a.x, 0),
    y: num(a.y, 0),
    w: num(a.w, 10),
    h: num(a.h, 10),
    x2: num(a.x2, 0),
    y2: num(a.y2, 0),
    color: typeof a.color === "string" ? a.color : "#ff5b45",
    strokeWidth: Math.max(1, num(a.strokeWidth, 3)),
    opacity: Math.min(1, Math.max(0, num(a.opacity, type === "spotlight" ? 0.78 : 1))),
    text: typeof a.text === "string" ? a.text.slice(0, 2000) : "",
    fontSize: Math.max(8, num(a.fontSize, 16)),
    blur: Math.max(0, num(a.blur, 8)),
    number: Math.max(1, Math.round(num(a.number, index + 1)))
  };
}

export function normalizeTutorial(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Invalid tutorial data: expected a tutorial object.");
  }
  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  const steps = rawSteps.map((raw, i) => {
    const s = (raw && typeof raw === "object") ? raw : {};
    const shot = (s.screenshot && typeof s.screenshot === "object") ? s.screenshot : {};
    const image = sanitizeImageUrl(shot.image);
    const annotations = Array.isArray(s.annotations)
      ? s.annotations.map(normalizeAnnotation).filter(Boolean)
      : [];
    // Element auto-crop metadata is passthrough-only: steps that have it keep
    // it (key order stable for tutorialNeedsMigration equality), steps that
    // don't are left untouched so old tutorials never flag a migration.
    const crop = (shot.crop && typeof shot.crop === "object")
      ? {
          x: Math.max(0, Math.round(Number(shot.crop.x) || 0)),
          y: Math.max(0, Math.round(Number(shot.crop.y) || 0)),
          w: Math.max(0, Math.round(Number(shot.crop.w) || 0)),
          h: Math.max(0, Math.round(Number(shot.crop.h) || 0))
        }
      : null;
    return {
      id: typeof s.id === "string" && s.id ? s.id.slice(0, 128) : makeId("step"),
      number: i + 1,
      action: typeof s.action === "string" ? s.action.slice(0, 32) : "CLICK",
      description: typeof s.description === "string" ? s.description.slice(0, 500) : "",
      url: typeof s.url === "string" ? s.url.slice(0, 2000) : "",
      target: (s.target && typeof s.target === "object") ? s.target : null,
      screenshot: {
        image,
        width: Number(shot.width) || 0,
        height: Number(shot.height) || 0,
        timestamp: Number(shot.timestamp) || 0,
        ...(crop ? { crop } : {})
      },
      annotations
    };
  });

  return {
    id: typeof source.id === "string" && source.id ? source.id.slice(0, 128) : makeId("tut"),
    schemaVersion: 1,
    title: typeof source.title === "string" && source.title.trim()
      ? source.title.trim().slice(0, 200)
      : "Untitled tutorial",
    description: typeof source.description === "string" ? source.description.slice(0, 2000) : "",
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Date.now(),
    durationMs: Math.max(0, Number(source.durationMs) || 0),
    steps
  };
}

export function stripImages(tutorial) {
  const copy = clone(tutorial);
  for (const step of copy.steps || []) {
    if (step.screenshot) step.screenshot.image = "";
  }
  return copy;
}

export function tutorialNeedsMigration(source) {
  if (!source || typeof source !== "object") return true;
  if (source.schemaVersion !== 1) return true;
  try {
    const normalized = normalizeTutorial(source);
    const a = JSON.stringify({ ...normalized, updatedAt: 0 });
    const b = JSON.stringify({ ...clone(source), updatedAt: 0 });
    return a !== b;
  } catch {
    return true;
  }
}

export function sanitizeFilename(name, fallback = "tutorial") {
  let out = String(name || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return out || fallback;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
