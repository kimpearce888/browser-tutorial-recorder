// Tutorial editor: step list + annotation canvas + properties panel.
// Imports shared helpers + export logic from shared.js, exporter.js and
// settings-store.js.

import {
  $, escapeHtml, escapeAttr, sanitizeImageUrl, clone, clamp,
  dbPut, dbGet,
  ANNOTATION_DEFAULTS, ROTATABLE_TYPES, RESIZABLE_TYPES,
  canvasSize, annotationBox, withAlpha, arrowHeadPoints,
  normalizeAnnotation, normalizeTutorial
} from "./shared.js";
import { exportTutorial, loadImage } from "./exporter.js";
import { matchesShortcut, initTheme, DEFAULT_SHORTCUTS, getSettings } from "./settings-store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tutorial;
let selectedStep = 0;
let selectedAnnotation = null;
let activeTool = null;
let drawing = null;
let markersVisible = true;
let history = [];
let historyIndex = -1;
let saveTimer;
let arrowHistoryTimer; // debounce timer for arrow-key history pushes
let cropMode = false;  // when true, the next rectangle drag crops the screenshot
let clipboard = null;  // copy/paste clipboard for annotations
let annotationPresets = [];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function saveTutorial() {
  if (!tutorial) return;
  // B12 fix: normalize before persisting so the same sanitization rules used
  // for imports/background saves apply to direct editor edits. Without this,
  // a user could enter an out-of-bounds x/y/width or an invalid color that
  // bypasses normalizeAnnotation's clamps. The background's SAVE_TUTORIAL
  // path already normalizes, but the editor writes to IDB directly.
  // G8 fix: also sync the live `tutorial` object with the normalized result
  // so the editor's in-memory state matches what's in IndexedDB. Without this,
  // the editor would render/export the pre-normalized data while IDB has the
  // clamped data — exports could differ from what the user sees.
  const normalized = normalizeTutorial(tutorial);
  tutorial = normalized;
  await dbPut({ ...normalized, updatedAt: new Date().toISOString() });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveTutorial();
      $("saveState").textContent = "Saved locally";
    } catch {
      $("saveState").textContent = "Save failed";
    }
  }, 250);
}

// F5 fix: flush the debounced save before the page unloads so the last few
// hundred milliseconds of edits aren't lost when the user closes the tab,
// reloads, or navigates away. IndexedDB writes are async so we can't truly
// block unload, but we can fire the save immediately (without waiting for
// the debounce) to give it the best chance of completing before the page dies.
// D16 fix: also trigger on pagehide and visibilitychange (hidden) — these
// fire earlier than beforeunload on mobile and in some bfcache scenarios,
// giving the save more time to complete.
function flushPendingSave() {
  if (saveTimer && tutorial) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { saveTutorial(); } catch (_) { /* best-effort */ }
  }
}
window.addEventListener("beforeunload", flushPendingSave);
window.addEventListener("pagehide", flushPendingSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});

// F6 fix: re-render the canvas when the window is resized so the cached
// canvas scale (used for font sizes) stays correct. Debounced so a drag-
// resize doesn't flood re-renders.
let resizeRenderTimer = null;
window.addEventListener("resize", () => {
  if (!tutorial) return;
  if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
  resizeRenderTimer = setTimeout(() => { renderCanvas(); }, 150);
});

// ---------------------------------------------------------------------------
// Undo / redo history
// ---------------------------------------------------------------------------

// v1.1.0: snapshots store screenshot image strings directly (JS strings are
// immutable and shared by reference — no memory duplication across 60 history
// entries). The previous screenshotCache approach broke crop+undo because
// applyCrop overwrote the cache with the cropped image, making the original
// unrecoverable on undo.
function snapshotTutorial(t) {
  if (!t) return null;
  return {
    ...t,
    steps: (t.steps || []).map((s) => ({
      ...s,
      // Shallow-copy screenshot — image string is shared by reference (immutable)
      screenshot: { ...s.screenshot },
      annotations: (s.annotations || []).map((a) => ({ ...a }))
    }))
  };
}

function pushHistory() {
  clearTimeout(arrowHistoryTimer);
  history = history.slice(0, historyIndex + 1);
  history.push(snapshotTutorial(tutorial));
  historyIndex = history.length - 1;
  if (history.length > 60) {
    history.shift();
    historyIndex--;
  }
}

// Shallow-copy the snapshot so mutations to the live tutorial don't affect
// history entries. String values (including image data URLs) are shared by
// reference — no deep clone needed.
function restoreSnapshot(snap) {
  if (!snap) return snap;
  return {
    ...snap,
    steps: (snap.steps || []).map((s) => ({
      ...s,
      screenshot: { ...s.screenshot },
      annotations: (s.annotations || []).map((a) => ({ ...a }))
    }))
  };
}

// Apply a mutation, then render + save.
// v1.0.2 #5: exclude screenshot image data from the deep clone (it's the
// bulk of the object's size). Screenshots are immutable during edits, so we
// shallow-copy them by reference. This avoids multi-MB JSON.parse/stringify
// on every commit (add/delete/merge/split/drag-reorder step).
function commit(mutator) {
  const draft = cloneWithoutScreenshots(tutorial);
  mutator(draft);
  draft.updatedAt = new Date().toISOString();
  tutorial = draft;
  pushHistory();
  render();
  scheduleSave();
}

// Deep-clone a tutorial EXCLUDING screenshot image data (which is large
// and immutable during edits). Screenshot objects are shallow-copied with
// the image field preserved by reference from the original tutorial.
function cloneWithoutScreenshots(source) {
  if (!source) return source;
  const result = { ...source, steps: (source.steps || []).map((s) => {
    const stepCopy = { ...s };
    if (s.screenshot) {
      stepCopy.screenshot = { ...s.screenshot, image: s.screenshot.image };
    }
    stepCopy.annotations = (s.annotations || []).map((a) => ({ ...a }));
    return stepCopy;
  })};
  return result;
}

function undo() {
  // C5 fix: clear any pending arrow-key nudge timer before restoring. Without
  // this, if the user nudges an annotation and presses Ctrl+Z within the 400ms
  // debounce window, the pending pushHistory() would fire against the
  // POST-UNDO tutorial, slicing the redo stack and permanently losing the
  // user's previous edits.
  clearTimeout(arrowHistoryTimer);
  if (historyIndex <= 0) return;
  historyIndex--;
  tutorial = restoreSnapshot(history[historyIndex]);
  selectedAnnotation = null;
  render();
  scheduleSave();
}

function redo() {
  // C5 fix: same as undo() — clear the pending arrow-key nudge timer.
  clearTimeout(arrowHistoryTimer);
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  tutorial = restoreSnapshot(history[historyIndex]);
  selectedAnnotation = null;
  render();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  if (!tutorial) return;
  if (selectedStep >= tutorial.steps.length) {
    selectedStep = Math.max(0, tutorial.steps.length - 1);
  }

  const title = tutorial.title || "Untitled tutorial";
  $("headerTitle").textContent = title;
  $("canvasTitle").textContent = title;
  $("titleInput").value = tutorial.title || "";
  // v1.2.1 #3: update status toggle button text
  const statusBtn = $("toggleStatus");
  if (statusBtn) {
    statusBtn.textContent = tutorial.status === "ready" ? "✓ Ready" : "Draft";
    statusBtn.classList.toggle("is-ready", tutorial.status === "ready");
  }
  // H3: tutorial description in the editor (was hardcoded before)
  const descEl = $("tutorialDescription");
  if (descEl) descEl.value = tutorial.description || "";
  $("stepCountLabel").textContent = `${tutorial.steps.length} step${tutorial.steps.length === 1 ? "" : "s"}`;

  renderSteps();
  renderCanvas();
  renderProperties();
  updateToolButtons();
}

function renderSteps() {
  $("stepList").innerHTML = tutorial.steps.map((step, index) => `
    <div class="step-card ${index === selectedStep ? "selected" : ""}" data-step="${index}" draggable="true">
      <div class="step-number">${index + 1}</div>
      <div class="step-thumb">${step.screenshot?.image ? `<img src="${escapeAttr(sanitizeImageUrl(step.screenshot.image))}" alt="">` : ""}</div>
      <div class="step-copy">
        <strong>${escapeHtml(step.description || "Untitled step")}</strong>
        <span>${escapeHtml(step.action || "ACTION")}${step.group ? ` · ${escapeHtml(step.group)}` : ""}</span>
      </div>
    </div>`).join("");

  document.querySelectorAll("#stepList [data-step]").forEach((card) => {
    const index = Number(card.dataset.step);

    card.onclick = (event) => {
      // P1-9 fix: removed step-select checkbox check (multi-select removed)
      if (cropMode) { cropMode = false; $("canvasWrap").classList.remove("crop-mode"); }
      selectedStep = index;
      selectedAnnotation = null;
      activeTool = null;
      render();
    };

    card.ondragstart = (event) => {
      event.dataTransfer.setData("text/plain", String(index));
    };
    card.ondragover = (event) => event.preventDefault();
    card.ondrop = (event) => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      const to = Number(card.dataset.step);
      if (Number.isNaN(from) || from === to) return;
      commit((t) => {
        const [moved] = t.steps.splice(from, 1);
        t.steps.splice(to, 0, moved);
        t.steps.forEach((item, i) => (item.number = i + 1));
        selectedStep = to;
        selectedAnnotation = null;
      });
    };
  });
}

function renderCanvas() {
  const step = tutorial.steps[selectedStep];
  const isEmpty = !step;

  $("emptyCanvas").classList.toggle("hidden", !isEmpty);
  $("screenshot").classList.toggle("hidden", isEmpty);
  $("annotationLayer").innerHTML = "";
  $("annotationControls").innerHTML = "";
  $("annotationControls").classList.add("hidden");

  if (isEmpty) {
    $("canvasMeta").textContent = "No step selected";
    $("actionBadge").textContent = "—";
    $("descriptionInput").value = "";
    $("annotationCount").textContent = "0";
    return;
  }

  const size = canvasSize(step);
  $("canvasWrap").style.aspectRatio = `${size.width}/${size.height}`;
  // H11 fix: hide the screenshot <img> when the step has no image data.
  // Previously the code unconditionally set src = sanitizeImageUrl("") which
  // returns "", and Chrome resolves img.src = "" to the PAGE'S OWN URL,
  // trying to load editor.html as an image and showing a broken-image icon.
  const hasImage = !!step.screenshot?.image;
  $("screenshot").classList.toggle("hidden", !hasImage);
  // A4 fix: use removeAttribute("src") when there's no image, matching preview.js's
  // P1 fix. Setting src="" makes Chrome resolve it to the page's own URL and fire
  // a spurious image-load request internally (even though .hidden makes it invisible).
  if (hasImage) {
    $("screenshot").src = sanitizeImageUrl(step.screenshot.image);
  } else {
    $("screenshot").removeAttribute("src");
  }
  $("canvasMeta").textContent = `${size.width} × ${size.height} · ${step.screenshot?.url || "Captured page"}`;
  $("actionBadge").textContent = step.action || "ACTION";
  $("annotationCount").textContent = String(step.annotations.length);

  // B20: cache the canvas scale once per render instead of calling
  // getBoundingClientRect() for every annotation (layout thrash).
  const canvasRect = $("canvasWrap").getBoundingClientRect();
  const cachedScale = canvasRect.width / size.width || 1;

  step.annotations.forEach((annotation, index) => renderAnnotationNode(annotation, index, size, cachedScale));

  if (selectedAnnotation != null && step.annotations[selectedAnnotation]) {
    renderAnnotationControls(step.annotations[selectedAnnotation], selectedAnnotation, size);
  }
}

function renderProperties() {
  const step = tutorial.steps[selectedStep];
  $("descriptionInput").value = step?.description || "";
  const annotation = step?.annotations[selectedAnnotation];
  $("selectedAnnotation").classList.toggle("hidden", !annotation);
  if (annotation) renderAnnotationPanel(annotation);
}

// Paint a single annotation element onto the canvas layer.
// B20: accepts a pre-computed scale so we don't call getBoundingClientRect
// per annotation (layout thrash on tutorials with many annotations).
function renderAnnotationNode(a, index, size, cachedScale) {
  const node = document.createElement("div");
  const box = annotationBox(a);
  const scale = cachedScale || $("canvasWrap").getBoundingClientRect().width / size.width || 1;

  node.className = `annotation ${a.type}`;
  node.dataset.annotation = index;
  node.style.left = `${box.x / size.width * 100}%`;
  node.style.top = `${box.y / size.height * 100}%`;
  node.style.width = `${box.width / size.width * 100}%`;
  node.style.height = `${box.height / size.height * 100}%`;
  node.style.opacity = a.opacity;
  node.style.transform = `rotate(${Number(a.rotation || 0)}deg)`;

  if (a.type === "arrow") {
    // H21: sanitize numeric SVG attribute values to prevent injection via
    // imported tutorial JSON.
    const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
    const pct = (v, fallback = 0) => { const n = Number(v); if (!Number.isFinite(n)) return fallback; return Math.max(0, Math.min(100, n)); };
    // v1.0.2 #4: pass width/height to arrowHeadPoints so it computes the head
    // angle in real pixel space (avoids distortion from non-square SVG stretch).
    node.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1="${pct(a.startX, 8)}" y1="${pct(a.startY, 92)}" x2="${pct(a.endX, 92)}" y2="${pct(a.endY, 8)}"
        stroke="${escapeHtml(a.color)}" stroke-width="${num(a.strokeWidth, 4)}"
        stroke-linecap="${escapeHtml(a.arrowCap)}" vector-effect="non-scaling-stroke"/>
      <polygon points="${arrowHeadPoints(a, box.width, box.height)}" fill="${escapeHtml(a.color)}"/>
    </svg>`;
  } else if (a.type === "text") {
    node.textContent = a.text || "Add a note";
    node.style.color = a.textColor;
    node.style.background = a.background;
    // Fix: clamp AFTER scaling so text never becomes invisible when scale is 0.
    node.style.fontSize = `${Math.max(8, Number(a.fontSize || 22) * scale)}px`;
    node.style.fontWeight = String(a.fontWeight);
  } else if (a.type === "marker") {
    node.textContent = markersVisible ? a.label : "";
    node.style.background = a.color;
    node.style.color = "#fff";
    node.style.fontSize = `${Math.max(10, Math.min(box.width, box.height) * scale * 0.38)}px`;
    node.style.fontWeight = "800";
    node.style.border = "3px solid #fff";
    node.style.borderRadius = "50%";
    node.style.display = "grid";
    node.style.placeItems = "center";
  } else {
    node.style.borderColor = a.color || "transparent";
    if (a.type === "highlight") {
      node.style.borderWidth = `${a.strokeWidth}px`;
      node.style.background = withAlpha(a.color, 0.12);
    }
    if (a.type === "rectangle" || a.type === "circle") {
      node.style.borderWidth = `${a.strokeWidth}px`;
      node.style.background = withAlpha(a.fillColor || a.color, a.fillOpacity || 0);
    }
    if (a.type === "circle") node.style.borderRadius = "50%";
    if (a.type === "blur") {
      node.style.backdropFilter = `blur(${a.blur}px)`;
      node.style.background = "#25314455";
    }
    if (a.type === "redaction") node.style.background = a.color;
    if (a.type === "spotlight") {
      node.style.opacity = 1;
      node.style.boxShadow = `0 0 0 9999px ${withAlpha(a.color, a.opacity)}`;
    }
  }

  node.onpointerdown = (event) => {
    if (activeTool || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectedAnnotation = index;
    render();
    startMove(event, index);
  };

  $("annotationLayer").appendChild(node);
}

// Populate the right-hand properties panel for the selected annotation.
function renderAnnotationPanel(a) {
  $("annotationTypeHint").textContent = a.type.toUpperCase();

  const values = {
    annX: a.x, annY: a.y, annW: a.width, annH: a.height,
    annRotation: a.rotation || 0,
    opacityInput: a.opacity,
    annColor: a.color || "#ff7352",
    strokeWidth: a.strokeWidth || 4,
    fillColor: a.fillColor || a.color || "#4779f4",
    fillOpacity: a.fillOpacity || 0,
    arrowHeadSize: a.arrowHeadSize || 14,
    arrowCap: a.arrowCap || "round",
    blurAmount: a.blur || 10,
    annotationText: a.text || "",
    textColor: a.textColor || "#ffffff",
    textBackground: a.background || "#202b40",
    fontSize: a.fontSize || 22,
    fontWeight: String(a.fontWeight || 700),
    markerLabel: a.label || ""
  };

  for (const [id, value] of Object.entries(values)) {
    const field = $(id);
    if (field) field.value = value;
  }

  document.querySelectorAll(".control-section[data-for]").forEach((section) => {
    const types = section.dataset.for.split(/\s+/);
    section.classList.toggle("visible", types.includes(a.type));
  });

  document.querySelectorAll("[data-common]").forEach((field) => {
    const kind = field.dataset.common;
    const show = kind === "size" ? RESIZABLE_TYPES.has(a.type) : ROTATABLE_TYPES.has(a.type);
    field.classList.toggle("hidden", !show);
  });
}

// Render the transform handles around the selected annotation.
function renderAnnotationControls(a, index, size) {
  const controls = $("annotationControls");
  const box = annotationBox(a);
  controls.classList.remove("hidden");
  controls.style.left = `${box.x / size.width * 100}%`;
  controls.style.top = `${box.y / size.height * 100}%`;
  controls.style.width = `${box.width / size.width * 100}%`;
  controls.style.height = `${box.height / size.height * 100}%`;
  controls.style.transform = `rotate(${Number(a.rotation || 0)}deg)`;

  for (const position of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `transform-handle ${position}`;
    handle.title = `Resize ${position.toUpperCase()}`;
    handle.onpointerdown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      startResize(event, index, position, size);
    };
    controls.appendChild(handle);
  }

  if (ROTATABLE_TYPES.has(a.type)) {
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "rotate-handle";
    rotate.title = "Rotate (Shift = 15°)";
    rotate.textContent = "↻";
    rotate.onpointerdown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      startRotate(event, index);
    };
    controls.appendChild(rotate);
  }

  addControlButton(controls, "control-duplicate", "＋", "Duplicate", () => duplicateAnnotation(index));
  addControlButton(controls, "control-delete", "×", "Delete", () => deleteAnnotation(index));

  if (a.type === "arrow") {
    addArrowEndpoint(controls, a, index, "start");
    addArrowEndpoint(controls, a, index, "end");
  }
}

function addControlButton(parent, className, text, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-button ${className}`;
  button.textContent = text;
  button.title = title;
  button.onpointerdown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };
  parent.appendChild(button);
}

function addArrowEndpoint(parent, a, index, side) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = `arrow-handle arrow-${side}`;
  handle.title = `Move arrow ${side}`;
  handle.style.left = `${side === "start" ? a.startX : a.endX}%`;
  handle.style.top = `${side === "start" ? a.startY : a.endY}%`;
  handle.onpointerdown = (event) => {
    event.preventDefault();
    event.stopPropagation();
    startArrowEndpoint(event, index, side);
  };
  parent.appendChild(handle);
}

function updateToolButtons() {
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === activeTool);
  });
}

// ---------------------------------------------------------------------------
// Pointer interactions (move / resize / rotate / arrow endpoints)
// ---------------------------------------------------------------------------

function pointerToCanvas(event) {
  const rect = $("canvasWrap").getBoundingClientRect();
  const size = canvasSize(tutorial.steps[selectedStep]);
  return {
    x: clamp((event.clientX - rect.left) / rect.width * size.width, 0, size.width),
    y: clamp((event.clientY - rect.top) / rect.height * size.height, 0, size.height)
  };
}

function trackPointer(onMove, onUp) {
  const moveListener = (event) => onMove(event);
  // v1.0.3: also clean up on pointercancel (touch devices fire this instead
  // of pointerup when the OS interrupts the gesture). Without this, moveListener
  // leaks and references stale annotation data.
  // A8 fix: add a `settled` guard so onUp() can't fire twice if both pointerup
  // and pointercancel fire (rare but possible during OS-level gesture interruption).
  let settled = false;
  const upListener = () => {
    if (settled) return;
    settled = true;
    document.removeEventListener("pointermove", moveListener);
    document.removeEventListener("pointerup", upListener);
    document.removeEventListener("pointercancel", upListener);
    onUp();
  };
  document.addEventListener("pointermove", moveListener);
  document.addEventListener("pointerup", upListener, { once: true });
  document.addEventListener("pointercancel", upListener, { once: true });
}

function finishEdit() {
  tutorial.updatedAt = new Date().toISOString();
  pushHistory();
  scheduleSave();
}

function startMove(event, index) {
  const a = tutorial.steps[selectedStep].annotations[index];
  const start = pointerToCanvas(event);
  const original = { x: a.x, y: a.y };
  const size = canvasSize(tutorial.steps[selectedStep]);

  trackPointer((moveEvent) => {
    const point = pointerToCanvas(moveEvent);
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (a.type === "marker") {
      a.x = clamp(original.x + dx, a.width / 2, size.width - a.width / 2);
      a.y = clamp(original.y + dy, a.height / 2, size.height - a.height / 2);
    } else {
      a.x = clamp(original.x + dx, 0, Math.max(0, size.width - a.width));
      a.y = clamp(original.y + dy, 0, Math.max(0, size.height - a.height));
    }
    renderCanvas();
    renderProperties();
  }, finishEdit);
}

function startResize(event, index, handle) {
  const a = tutorial.steps[selectedStep].annotations[index];
  const original = clone(a);
  const box = annotationBox(original);
  const rotation = Number(original.rotation || 0);
  const size = canvasSize(tutorial.steps[selectedStep]);
  const min = original.type === "marker" ? 14 : original.type === "text" ? 40 : 8;

  trackPointer((moveEvent) => {
    const point = toLocal(pointerToCanvas(moveEvent), box, rotation);
    let left = 0, top = 0, right = original.width, bottom = original.height;
    if (handle.includes("w")) left = point.x;
    if (handle.includes("e")) right = point.x;
    if (handle.includes("n")) top = point.y;
    if (handle.includes("s")) bottom = point.y;

    let width = Math.max(min, Math.abs(right - left));
    let height = Math.max(min, Math.abs(bottom - top));

    // Shift on a corner handle preserves the original aspect ratio.
    if (moveEvent.shiftKey && handle.length === 2) {
      const ratio = original.width / Math.max(1, original.height);
      if (width / height > ratio) height = width / ratio;
      else width = height * ratio;
    }

    if (handle.includes("w")) left = original.width - width;
    else right = left + width;
    if (handle.includes("n")) top = original.height - height;
    else bottom = top + height;

    const centerLocal = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const centerOriginal = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const center = rotatePoint(centerOriginal, centerLocal.x - original.width / 2, centerLocal.y - original.height / 2, rotation);

    a.width = width;
    a.height = height;
    if (a.type === "marker") {
      a.x = clamp(center.x, width / 2, size.width - width / 2);
      a.y = clamp(center.y, height / 2, size.height - height / 2);
    } else {
      a.x = clamp(center.x - width / 2, 0, Math.max(0, size.width - width));
      a.y = clamp(center.y - height / 2, 0, Math.max(0, size.height - height));
    }
    renderCanvas();
    renderProperties();
  }, finishEdit);
}

function startRotate(event, index) {
  const a = tutorial.steps[selectedStep].annotations[index];
  const box = annotationBox(a);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const start = pointerToCanvas(event);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const original = Number(a.rotation || 0);

  trackPointer((moveEvent) => {
    const point = pointerToCanvas(moveEvent);
    let angle = original + (Math.atan2(point.y - center.y, point.x - center.x) - startAngle) * 180 / Math.PI;
    if (moveEvent.shiftKey) angle = Math.round(angle / 15) * 15;
    // F18 fix: normalize the angle to [0, 360) so it doesn't grow unbounded
    // after many rotations (which would make the properties panel show a
    // huge number and could break exporters that don't modulo).
    a.rotation = ((angle % 360) + 360) % 360;
    renderCanvas();
    renderProperties();
  }, finishEdit);
}

function startArrowEndpoint(event, index, side) {
  const a = tutorial.steps[selectedStep].annotations[index];
  trackPointer((moveEvent) => {
    const box = annotationBox(a);
    const point = toLocal(pointerToCanvas(moveEvent), box, Number(a.rotation || 0));
    const x = clamp(point.x / Math.max(1, box.width) * 100, 0, 100);
    const y = clamp(point.y / Math.max(1, box.height) * 100, 0, 100);
    if (side === "start") { a.startX = x; a.startY = y; }
    else { a.endX = x; a.endY = y; }
    renderCanvas();
    renderProperties();
  }, finishEdit);
}

// Convert a canvas-space point to annotation-local space (accounting for rotation).
function toLocal(point, box, rotation) {
  const r = -rotation * Math.PI / 180;
  const dx = point.x - (box.x + box.width / 2);
  const dy = point.y - (box.y + box.height / 2);
  return {
    x: dx * Math.cos(r) - dy * Math.sin(r) + box.width / 2,
    y: dx * Math.sin(r) + dy * Math.cos(r) + box.height / 2
  };
}

function rotatePoint(center, dx, dy, degrees) {
  const r = degrees * Math.PI / 180;
  return {
    x: center.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: center.y + dx * Math.sin(r) + dy * Math.cos(r)
  };
}

// ---------------------------------------------------------------------------
// Drawing new annotations
// ---------------------------------------------------------------------------

function createAnnotation(type, start, end) {
  const step = tutorial.steps[selectedStep];
  const size = canvasSize(step);
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(12, Math.abs(end.x - start.x));
  const height = Math.max(12, Math.abs(end.y - start.y));

  const a = {
    id: `annotation-${crypto.randomUUID()}`,
    type, x: left, y: top, width, height, rotation: 0,
    ...ANNOTATION_DEFAULTS[type]
  };

  if (type === "marker") {
    a.width = 28;
    a.height = 28;
    a.x = clamp(end.x, 14, size.width - 14);
    a.y = clamp(end.y, 14, size.height - 14);
    a.label = String(nextMarkerNumber());
  }

  if (type === "arrow") {
    a.startX = width ? (start.x - left) / width * 100 : 0;
    a.startY = height ? (start.y - top) / height * 100 : 0;
    a.endX = width ? (end.x - left) / width * 100 : 100;
    a.endY = height ? (end.y - top) / height * 100 : 100;
  }

  if (type === "text") {
    a.width = Math.max(160, width);
    a.height = Math.max(48, height);
  }

  if (type !== "marker") {
    a.x = clamp(a.x, 0, Math.max(0, size.width - a.width));
    a.y = clamp(a.y, 0, Math.max(0, size.height - a.height));
  }

  step.annotations.push(a);
  selectedAnnotation = step.annotations.length - 1;
  activeTool = null;
  drawing = null;
  pushHistory();
  scheduleSave();
  render();
}

function startDrawing(event) {
  // Crop mode: drag a rectangle over the canvas to crop the screenshot.
  if (cropMode) {
    drawing = { start: pointerToCanvas(event), tool: "__crop__" };
    const onMove = (moveEvent) => {
      if (!drawing) return;
      const point = pointerToCanvas(moveEvent);
      const layer = $("annotationLayer");
      layer.dataset.drawing = "true";
      layer.style.setProperty("--draw-x", `${Math.min(drawing.start.x, point.x)}px`);
      layer.style.setProperty("--draw-y", `${Math.min(drawing.start.y, point.y)}px`);
      layer.style.setProperty("--draw-w", `${Math.abs(point.x - drawing.start.x)}px`);
      layer.style.setProperty("--draw-h", `${Math.abs(point.y - drawing.start.y)}px`);
    };
    // E10 fix: add settled guard so onUp only fires once. Without this,
    // both pointerup and pointercancel could fire onUp, causing double crop
    // application or duplicate annotations.
    let settled = false;
    const onUp = (upEvent) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      const current = drawing;
      drawing = null;
      $("annotationLayer").removeAttribute("data-drawing");
      if (!current) return;
      const end = pointerToCanvas(upEvent);
      const rect = {
        x: Math.min(current.start.x, end.x),
        y: Math.min(current.start.y, end.y),
        width: Math.abs(end.x - current.start.x),
        height: Math.abs(end.y - current.start.y)
      };
      if (rect.width < 8 || rect.height < 8) {
        // v1.2.1 #2: cancel crop mode on aborted/too-small drag so the canvas
        // doesn't get permanently locked into crop-only mode.
        cropMode = false;
        $("canvasWrap").classList.remove("crop-mode");
        render();
        return;
      }
      applyCrop(rect);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.addEventListener("pointercancel", onUp, { once: true });
    return;
  }

  drawing = { start: pointerToCanvas(event), tool: activeTool };

  const onMove = (moveEvent) => {
    if (!drawing) return;
    const point = pointerToCanvas(moveEvent);
    const layer = $("annotationLayer");
    layer.dataset.drawing = "true";
    layer.style.setProperty("--draw-x", `${Math.min(drawing.start.x, point.x)}px`);
    layer.style.setProperty("--draw-y", `${Math.min(drawing.start.y, point.y)}px`);
    layer.style.setProperty("--draw-w", `${Math.abs(point.x - drawing.start.x)}px`);
    layer.style.setProperty("--draw-h", `${Math.abs(point.y - drawing.start.y)}px`);
  };

  // E10 fix: add settled guard so onUp only fires once.
  let settled = false;
  const onUp = (upEvent) => {
    if (settled) return;
    settled = true;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    const current = drawing;
    drawing = null;
    $("annotationLayer").removeAttribute("data-drawing");
    if (!current) return;

    const end = pointerToCanvas(upEvent);
    // Treat a tiny drag as a click — keep the tool active instead of creating a 1px annotation.
    const isClick = Math.abs(end.x - current.start.x) < 8 && Math.abs(end.y - current.start.y) < 8;
    if (current.tool !== "marker" && isClick) {
      activeTool = current.tool;
      updateToolButtons();
      return;
    }
    createAnnotation(current.tool, current.start, end);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
  document.addEventListener("pointercancel", onUp, { once: true });
}

// ---------------------------------------------------------------------------
// Annotation CRUD
// ---------------------------------------------------------------------------

function deleteAnnotation(index = selectedAnnotation) {
  const step = tutorial.steps[selectedStep];
  if (!step?.annotations[index]) return;
  step.annotations.splice(index, 1);
  selectedAnnotation = null;
  activeTool = null;
  pushHistory();
  scheduleSave();
  render();
}

function duplicateAnnotation(index) {
  const step = tutorial.steps[selectedStep];
  const source = step?.annotations[index];
  if (!source) return;

  const copy = clone(source);
  copy.id = `annotation-${crypto.randomUUID()}`;
  const size = canvasSize(step);
  if (copy.type === "marker") {
    // H15 fix: protect against min > max when annotation is wider than canvas
    copy.x = clamp(copy.x + 20, copy.width / 2, Math.max(copy.width / 2, size.width - copy.width / 2));
    copy.y = clamp(copy.y + 20, copy.height / 2, Math.max(copy.height / 2, size.height - copy.height / 2));
  } else {
    // H15 fix: protect against min > max when annotation is wider than canvas
    copy.x = clamp(copy.x + 20, 0, Math.max(0, size.width - copy.width));
    copy.y = clamp(copy.y + 20, 0, Math.max(0, size.height - copy.height));
  }
  step.annotations.splice(index + 1, 0, copy);
  selectedAnnotation = index + 1;
  pushHistory();
  scheduleSave();
  render();
}

// Bind an input field to a property on the currently selected annotation.
// H17: wrap mutator in try/catch so a bad input value doesn't crash the
// editor and leave the tutorial in a half-mutated state.
function bindField(id, update) {
  const field = $(id);
  if (!field) return;
  field.addEventListener("input", () => {
    const a = tutorial.steps[selectedStep]?.annotations[selectedAnnotation];
    if (!a) return;
    try {
      update(a, field.value);
      tutorial.updatedAt = new Date().toISOString();
      renderCanvas();
      scheduleSave();
    } catch (err) {
      console.warn("Field update failed:", err.message);
      // Re-render to revert the visible state to match the data.
      renderCanvas();
    }
  });
  field.addEventListener("change", () => {
    // F9 fix: use the annotation index captured at focus time, not the
    // current selectedAnnotation (which may have changed if the user
    // clicked another annotation between input and change). Without this,
    // a field edit's history entry could be silently bundled with the next
    // action's snapshot instead of being its own undo step.
    if (field._editedAnnotation != null && tutorial.steps[selectedStep]?.annotations[field._editedAnnotation]) pushHistory();
  });
  // F9 fix: capture which annotation is being edited at focus time.
  field.addEventListener("focus", () => { field._editedAnnotation = selectedAnnotation; });
}

// ---------------------------------------------------------------------------
// Step CRUD
// ---------------------------------------------------------------------------

function addStep() {
  if (!tutorial) return;
  commit((t) => {
    t.steps.push({
      id: `step-${crypto.randomUUID()}`,
      number: t.steps.length + 1,
      action: "NOTE",
      description: "Describe the next step.",
      screenshot: { image: "", status: "FAILED", width: 1280, height: 720, url: "", timestamp: Date.now() },
      annotations: []
    });
    selectedStep = t.steps.length - 1;
    selectedAnnotation = null;
    activeTool = null;
  });
}

function deleteStep() {
  if (!tutorial?.steps[selectedStep]) return;
  if (!confirm("Delete this step?")) return;
  commit((t) => {
    t.steps.splice(selectedStep, 1);
    t.steps.forEach((step, i) => (step.number = i + 1));
    selectedStep = Math.max(0, Math.min(selectedStep, t.steps.length - 1));
    selectedAnnotation = null;
    activeTool = null;
  });
}

// H9: duplicateStep was declared as a shortcut but had no implementation.
function duplicateStep() {
  const step = tutorial?.steps[selectedStep];
  if (!step) return;
  commit((t) => {
    // P2 fix: shallow-copy screenshot (string is immutable/shared by ref)
    // instead of deep-cloning with JSON.parse/stringify.
    const copy = { ...step, screenshot: { ...step.screenshot } };
    copy.id = `step-${crypto.randomUUID()}`;
    copy.annotations = (step.annotations || []).map((a) => {
      const c = { ...a };
      c.id = `annotation-${crypto.randomUUID()}`;
      return c;
    });
    t.steps.splice(selectedStep + 1, 0, copy);
    t.steps.forEach((s, i) => (s.number = i + 1));
    selectedStep = selectedStep + 1;
    selectedAnnotation = null;
  });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function setupEvents() {
  // Canvas: start drawing with a tool, or deselect when clicking empty space.
  $("canvasWrap").addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Start drawing if a tool OR crop mode is active (cropMode doesn't set activeTool)
    if ((activeTool || cropMode) && tutorial.steps[selectedStep]) {
      event.preventDefault();
      event.stopPropagation();
      startDrawing(event);
      return;
    }
    if (event.target === $("canvasWrap") || event.target === $("screenshot") || event.target === $("annotationLayer")) {
      // H10 fix: also deselect when clicking on #annotationLayer (which sits
      // on top of canvasWrap and screenshot with z-index:10, so it receives
      // all clicks on empty canvas space). Previously the deselect branch was
      // unreachable because clicks hit #annotationLayer, not canvasWrap or
      // #screenshot. The only way to deselect was Escape.
      selectedAnnotation = null;
      render();
    }
  });

  // Tool buttons
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      // P2 fix: cancel crop mode when switching tools
      if (cropMode) { cropMode = false; $("canvasWrap").classList.remove("crop-mode"); }
      activeTool = activeTool === button.dataset.tool ? null : button.dataset.tool;
      selectedAnnotation = null;
      updateToolButtons();
    };
  });

  // Annotation property fields
  // B11 fix: clamp x/y/width/height to the canvas bounds instead of allowing
  // any number (including negative or massive values). The old `Number(v) || 0`
  // produced invalid coordinates that could place annotations off-canvas.
  // G9 fix: markers store CENTER as (x, y) — the old code used the top-left
  // clamp model, allowing markers to be placed partly outside the canvas and
  // incorrectly clamping legitimate edge-center coordinates. Now uses the
  // marker-specific center clamp for markers.
  bindField("annX", (a, v) => {
    const size = canvasSize(tutorial?.steps?.[selectedStep]);
    if (a.type === "marker") {
      a.x = clamp(Number(v) || 0, a.width / 2, Math.max(a.width / 2, size.width - a.width / 2));
    } else {
      a.x = clamp(Number(v) || 0, 0, Math.max(0, size.width - (a.width || 0)));
    }
  });
  bindField("annY", (a, v) => {
    const size = canvasSize(tutorial?.steps?.[selectedStep]);
    if (a.type === "marker") {
      a.y = clamp(Number(v) || 0, a.height / 2, Math.max(a.height / 2, size.height - a.height / 2));
    } else {
      a.y = clamp(Number(v) || 0, 0, Math.max(0, size.height - (a.height || 0)));
    }
  });
  bindField("annW", (a, v) => {
    const size = canvasSize(tutorial?.steps?.[selectedStep]);
    a.width = clamp(Math.max(8, Number(v) || 8), 8, Math.max(8, size.width));
  });
  bindField("annH", (a, v) => {
    const size = canvasSize(tutorial?.steps?.[selectedStep]);
    a.height = clamp(Math.max(8, Number(v) || 8), 8, Math.max(8, size.height));
  });
  bindField("annRotation", (a, v) => (a.rotation = clamp(Number(v) || 0, 0, 360)));
  bindField("opacityInput", (a, v) => (a.opacity = clamp(Number(v), 0, 1)));
  bindField("annColor", (a, v) => (a.color = v));
  bindField("strokeWidth", (a, v) => (a.strokeWidth = clamp(Number(v) || 1, 1, 40)));
  bindField("fillColor", (a, v) => (a.fillColor = v));
  bindField("fillOpacity", (a, v) => (a.fillOpacity = clamp(Number(v), 0, 1)));
  bindField("arrowHeadSize", (a, v) => (a.arrowHeadSize = clamp(Number(v) || 14, 4, 40)));
  bindField("arrowCap", (a, v) => (a.arrowCap = v));
  bindField("blurAmount", (a, v) => (a.blur = clamp(Number(v) || 0, 0, 40)));
  bindField("annotationText", (a, v) => (a.text = v));
  bindField("textColor", (a, v) => (a.textColor = v));
  bindField("textBackground", (a, v) => (a.background = v));
  bindField("fontSize", (a, v) => (a.fontSize = clamp(Number(v) || 8, 8, 96)));
  bindField("fontWeight", (a, v) => (a.fontWeight = Number(v) || 700));
  bindField("markerLabel", (a, v) => (a.label = v.slice(0, 3)));

  $("deleteAnnotation").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteAnnotation();
  });

  // Tutorial title. H18: guard against undefined tutorial object.
  $("titleInput").addEventListener("input", (event) => {
    if (!tutorial) return;
    tutorial.title = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    $("headerTitle").textContent = event.target.value || "Untitled tutorial";
    $("canvasTitle").textContent = event.target.value || "Untitled tutorial";
    scheduleSave();
  });
  $("titleInput").addEventListener("change", pushHistory);

  // Step description. H18: guard against undefined step.
  $("descriptionInput").addEventListener("input", (event) => {
    const step = tutorial?.steps[selectedStep];
    if (!step) return;
    step.description = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    scheduleSave();
  });
  $("descriptionInput").addEventListener("change", pushHistory);

  // H3: Tutorial description (was hardcoded to "Captured browser workflow").
  $("tutorialDescription")?.addEventListener("input", (event) => {
    if (!tutorial) return;
    tutorial.description = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    scheduleSave();
  });
  $("tutorialDescription")?.addEventListener("change", pushHistory);

  // Step add / delete
  $("addStep").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    addStep();
  });
  $("deleteStep").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteStep();
  });
  // Duplicate current step — previously there was no button, but the
  // `duplicateStep` shortcut was already defined and shown in the cheat sheet (H9).
  // Wire it up here so the shortcut works.
  // (No button exists in HTML, but the shortcut handler below calls duplicateStep.)

  // Canvas actions
  $("toggleMarkers").addEventListener("click", () => {
    markersVisible = !markersVisible;
    renderCanvas();
  });
  // B22: "Fit" now actually fits the canvas to the viewport by toggling
  // a CSS class that constrains the canvas-wrap height. Was just scrollIntoView.
  $("fit").addEventListener("click", () => {
    const wrap = $("canvasWrap");
    wrap.classList.toggle("fit-to-viewport");
    renderCanvas(); // re-render so annotation scale is recalculated
  });

  // v1.0.4 #2: wire the properties-toggle button (only visible below 1100px).
  const propsToggle = document.querySelector(".properties-toggle");
  if (propsToggle) {
    propsToggle.addEventListener("click", () => {
      document.querySelector(".properties-panel")?.classList.toggle("open");
    });
  }

  // Undo / redo
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);

  // Preview
  // v1.0.3: flush pending debounced save before navigating away.
  $("preview").addEventListener("click", async () => {
    await saveTutorial();
    const popup = window.open(`preview.html?id=${encodeURIComponent(tutorial.id)}`, "_blank");
    if (!popup) alert("Allow popups to open preview.");
  });

  // v1.2.1 #3: toggle tutorial status between draft and ready
  $("toggleStatus")?.addEventListener("click", () => {
    if (!tutorial) return;
    commit((t) => {
      t.status = t.status === "ready" ? "draft" : "ready";
    });
  });

  // Back to dashboard
  $("backToDashboard").addEventListener("click", async (event) => {
    event.preventDefault();
    await saveTutorial();
    location.href = "dashboard.html";
  });

  // Export dialog
  $("exportMenu").onclick = () => $("exportDialog").showModal();
  // v1.0.3: null-check the dialog close button so setupEvents doesn't crash.
  const exportCloseBtn = document.querySelector("#exportDialog .dialog-close");
  if (exportCloseBtn) exportCloseBtn.onclick = () => $("exportDialog").close();
  document.querySelectorAll("[data-export]").forEach((button) => {
    button.onclick = async () => {
      // M8: show a loading state so the user gets feedback during slow exports.
      const originalText = button.innerHTML;
      button.disabled = true;
      button.style.opacity = "0.6";
      button.innerHTML = "<span>Exporting…</span>";
      try {
        // Make sure the latest tutorial state is in IndexedDB before we hand
        // off to print-export.html (which loads by id from the DB).
        await saveTutorial();
        await exportTutorial(tutorial, button.dataset.export, selectedStep);
        $("exportDialog").close();
      } catch (error) {
        alert(error.message || "Export failed.");
      } finally {
        button.disabled = false;
        button.style.opacity = "";
        button.innerHTML = originalText;
      }
    };
  });

  // Editor-only buttons: crop / full-page / merge / split / group / presets.
  // Each is optional — guard so missing elements don't crash setupEvents.
  $("cropStep")?.addEventListener("click", (event) => {
    event.preventDefault();
    startCropMode();
  });
  $("captureFullPage")?.addEventListener("click", (event) => {
    event.preventDefault();
    captureFullPage();
  });
  $("mergeNext")?.addEventListener("click", (event) => {
    event.preventDefault();
    mergeWithNextStep(selectedStep);
  });
  $("splitStep")?.addEventListener("click", (event) => {
    event.preventDefault();
    splitStep(selectedStep);
  });
  $("setStepGroup")?.addEventListener("click", (event) => {
    event.preventDefault();
    const group = prompt("Group label for this step:", tutorial.steps[selectedStep]?.group || "");
    if (group != null) setStepGroup(selectedStep, group);
  });
  $("savePreset")?.addEventListener("click", (event) => {
    event.preventDefault();
    savePreset();
  });

  // Import
  $("import").addEventListener("click", () => $("importInput").click());
  $("importInput").onchange = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        // v1.7.1 fix: handle JSON arrays (from Settings → Export All) in
        // addition to single tutorial objects. The dashboard and settings
        // page already handle arrays; the editor's import should too.
        const parsed = JSON.parse(reader.result);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        if (list.length === 0) { alert("No tutorials found in the file."); return; }
        // D14 fix: process the entire list sequentially with per-item try/catch.
        // The old code did normalizeTutorial(list[0]) BEFORE the per-item loop —
        // so if the first item was malformed, the outer catch fired and NOTHING
        // was imported. Now we try each item; the first valid one opens in the
        // editor, subsequent valid ones go to the DB.
        let loadedFirst = false;
        let imported = 0;
        for (let i = 0; i < list.length; i++) {
          try {
            const item = normalizeTutorial(list[i]);
            if (!loadedFirst) {
              tutorial = item;
              tutorial.id = `tutorial-${crypto.randomUUID()}`;
              selectedStep = 0;
              selectedAnnotation = null;
              history = [];
              historyIndex = -1;
              pushHistory();
              await saveTutorial();
              loadedFirst = true;
            } else {
              const extra = item;
              extra.id = `tutorial-${crypto.randomUUID()}`;
              extra.createdAt = new Date().toISOString();
              extra.updatedAt = new Date().toISOString();
              await dbPut(extra);
            }
            imported++;
          } catch (_) { /* skip invalid entries */ }
        }
        if (!loadedFirst) {
          alert("No valid tutorials found in the file.");
          return;
        }
        if (imported > 1) {
          alert(`Imported ${imported} tutorials. The first is open in the editor; the rest are saved to your library.`);
        }
        render();
      } catch (error) {
        alert(error.message || "Invalid tutorial file.");
      }
    };
    reader.readAsText(file);
    event.target.value = ""; // H10 — allow re-importing the same file
  };

  // Keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    if (!tutorial) return;
    // H12 fix: do not fire any shortcuts while a <dialog> or overlay is open.
    // Without this, pressing 1–9 inside the export dialog switched annotation
    // tools, Ctrl+N added a step behind the dialog, and Delete erased
    // annotations — all confusing and possibly destructive.
    if (document.querySelector("dialog[open]") || $("shortcutOverlay")) return;
    const tag = document.activeElement?.tagName;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

    // Global editor shortcuts — fire even when an input is focused,
    // but only when a modifier key is held (Ctrl/Cmd).
    if (matchesShortcut(event, "save")) {
      event.preventDefault();
      saveTutorial().then(() => {
        // H29: show a visible "Saved" toast instead of subtle text change.
        const el = $("saveState");
        const old = el.textContent;
        el.textContent = "✓ Saved";
        el.style.color = "var(--success, #1c9a62)";
        clearTimeout(saveTutorial._toastTimer);
        saveTutorial._toastTimer = setTimeout(() => {
          el.textContent = old;
          el.style.color = "";
        }, 1500);
      }).catch(() => {
        $("saveState").textContent = "Save failed";
      });
      return;
    }
    // P1-11 fix: don't hijack undo/redo when typing in text fields —
    // let the browser handle native text-field undo/redo instead.
    if (!typing) {
      // F7 fix: also accept Ctrl+Y (Windows convention) for redo, in addition
      // to the configured Ctrl+Shift+Z. Windows users expect both to work.
      const isRedo = matchesShortcut(event, "redo") ||
        ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "y");
      if (isRedo) { event.preventDefault(); redo(); return; }
      if (matchesShortcut(event, "undo")) { event.preventDefault(); undo(); return; }
    }
    if (matchesShortcut(event, "backToDashboard")) { event.preventDefault(); $("backToDashboard").click(); return; }

    // All remaining shortcuts are disabled while typing in text fields.
    // This prevents digits, "?", Escape, etc. from being hijacked.
    if (typing) return;

    if (matchesShortcut(event, "preview")) { event.preventDefault(); $("preview").click(); return; }
    if (matchesShortcut(event, "exportMenu")) { event.preventDefault(); $("exportMenu").click(); return; }
    if (matchesShortcut(event, "showShortcuts")) { event.preventDefault(); showShortcutCheatSheet(); return; }
    if (matchesShortcut(event, "copyAnnotation")) { event.preventDefault(); copyAnnotation(); return; }
    if (matchesShortcut(event, "pasteAnnotation")) { event.preventDefault(); pasteAnnotation(); return; }
    if (matchesShortcut(event, "mergeNext")) { event.preventDefault(); mergeWithNextStep(selectedStep); return; }
    if (matchesShortcut(event, "splitStep")) { event.preventDefault(); splitStep(selectedStep); return; }
    // H9: wire up previously-defined but never-handled shortcuts.
    if (matchesShortcut(event, "newStep")) { event.preventDefault(); addStep(); return; }
    if (matchesShortcut(event, "duplicateStep")) { event.preventDefault(); duplicateStep(); return; }
    if (matchesShortcut(event, "deleteStep")) { event.preventDefault(); deleteStep(); return; }
    if (matchesShortcut(event, "deselect")) {
      event.preventDefault();
      // P2 fix: also cancel crop mode on Escape
      if (cropMode) { cropMode = false; $("canvasWrap").classList.remove("crop-mode"); }
      selectedAnnotation = null;
      activeTool = null;
      render();
      return;
    }
    if (matchesShortcut(event, "nextStep")) {
      event.preventDefault();
      if (selectedStep < tutorial.steps.length - 1) { selectedStep++; selectedAnnotation = null; render(); }
      return;
    }
    if (matchesShortcut(event, "prevStep")) {
      event.preventDefault();
      if (selectedStep > 0) { selectedStep--; selectedAnnotation = null; render(); }
      return;
    }

    // Tool selection: 1–9 pick the corresponding tool.
    for (let i = 1; i <= 9; i++) {
      if (matchesShortcut(event, `tool${i}`)) {
        event.preventDefault();
        const tools = ["highlight", "rectangle", "circle", "arrow", "text", "blur", "redaction", "spotlight", "marker"];
        activeTool = activeTool === tools[i - 1] ? null : tools[i - 1];
        selectedAnnotation = null;
        updateToolButtons();
        return;
      }
    }

    if (selectedAnnotation == null) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      deleteAnnotation();
      return;
    }

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const a = tutorial.steps[selectedStep]?.annotations[selectedAnnotation];
      if (!a) return;
      const size = canvasSize(tutorial.steps[selectedStep]);
      const distance = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowUp") a.y -= distance;
      if (event.key === "ArrowDown") a.y += distance;
      if (event.key === "ArrowLeft") a.x -= distance;
      if (event.key === "ArrowRight") a.x += distance;
      if (a.type === "marker") {
        a.x = clamp(a.x, a.width / 2, size.width - a.width / 2);
        a.y = clamp(a.y, a.height / 2, size.height - a.height / 2);
      } else {
        a.x = clamp(a.x, 0, Math.max(0, size.width - a.width));
        a.y = clamp(a.y, 0, Math.max(0, size.height - a.height));
      }
      // v1.0.1: debounce history pushes for arrow-key nudges so holding an
      // arrow doesn't create 60 history entries per second. Save + render
      // immediately, but push history only after the user stops pressing.
      clearTimeout(arrowHistoryTimer);
      arrowHistoryTimer = setTimeout(() => { pushHistory(); }, 400);
      scheduleSave();
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// Annotation presets (saved to localStorage)
// ---------------------------------------------------------------------------

function loadPresets() {
  try {
    const raw = localStorage.getItem("btr-annotation-presets");
    const parsed = raw ? JSON.parse(raw) : [];
    // H17 fix: verify the parsed value is an array. A valid JSON object (e.g., {})
    // would make later .map()/.push()/.splice() operations fail.
    annotationPresets = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    annotationPresets = [];
  }
}

function savePreset() {
  const step = tutorial?.steps[selectedStep];
  const a = step?.annotations[selectedAnnotation];
  if (!a) { alert("Select an annotation first."); return; }
  const name = prompt("Preset name:", a.type);
  if (!name) return;
  const preset = { name, type: a.type, data: clone(a) };
  delete preset.data.id;
  annotationPresets.push(preset);
  try { localStorage.setItem("btr-annotation-presets", JSON.stringify(annotationPresets)); } catch (e) {}
  renderPresets();
  alert(`Saved preset "${name}".`);
}

// H2: render the preset library so saved presets can be applied.
function renderPresets() {
  const list = $("presetList");
  const count = $("presetCount");
  if (!list) return;
  if (count) count.textContent = String(annotationPresets.length);
  if (!annotationPresets.length) {
    list.innerHTML = `<div class="preset-empty">Save an annotation as a preset to reuse it later.</div>`;
    return;
  }
  list.innerHTML = annotationPresets.map((p, i) => `
    <div class="preset-item" data-i="${i}">
      <span class="preset-name">${escapeHtml(p.name)} <small>${escapeHtml(p.type)}</small></span>
      <button type="button" class="preset-apply" data-i="${i}" title="Apply to current step">＋</button>
      <button type="button" class="preset-delete" data-i="${i}" title="Delete preset">×</button>
    </div>
  `).join("");
  list.querySelectorAll(".preset-apply").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyPreset(Number(btn.dataset.i));
    });
  });
  list.querySelectorAll(".preset-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(btn.dataset.i);
      annotationPresets.splice(idx, 1);
      try { localStorage.setItem("btr-annotation-presets", JSON.stringify(annotationPresets)); } catch (err) {}
      renderPresets();
    });
  });
}

// H2: apply a saved preset to the current step.
function applyPreset(idx) {
  const preset = annotationPresets[idx];
  if (!preset) return;
  // P2-05 fix: validate preset data via normalizeAnnotation
  // H16 fix: pass the current step's actual screenshot dimensions to
  // normalizeAnnotation instead of 0 (which falls back to 1280×720).
  const stepForPreset = tutorial?.steps?.[selectedStep];
  const presetSize = canvasSize(stepForPreset);
  const validated = normalizeAnnotation(preset.data || {}, 0, presetSize.width, presetSize.height);
  const step = tutorial?.steps[selectedStep];
  if (!step) return;
  commit((t) => {
    const s = t.steps[selectedStep];
    const copy = { ...validated };
    copy.id = `annotation-${crypto.randomUUID()}`;
    const size = canvasSize(s);
    if (copy.type === "marker") {
      copy.x = clamp(copy.x, copy.width / 2, size.width - copy.width / 2);
      copy.y = clamp(copy.y, copy.height / 2, size.height - copy.height / 2);
    } else {
      copy.x = clamp(copy.x, 0, Math.max(0, size.width - copy.width));
      copy.y = clamp(copy.y, 0, Math.max(0, size.height - copy.height));
    }
    s.annotations.push(copy);
    selectedAnnotation = s.annotations.length - 1;
  });
}

// ---------------------------------------------------------------------------
// Crop / capture / merge / split / group / copy-paste / multi-select
// ---------------------------------------------------------------------------

function startCropMode() {
  const step = tutorial.steps[selectedStep];
  if (!step?.screenshot?.image) { alert("This step has no screenshot to crop."); return; }
  cropMode = true;
  activeTool = null;
  $("canvasWrap").classList.add("crop-mode");
  alert("Drag a rectangle over the canvas to crop. The screenshot will be resized to the selection.");
}

async function applyCrop(rect) {
  cropMode = false;
  $("canvasWrap").classList.remove("crop-mode");
  const step = tutorial.steps[selectedStep];
  if (!step?.screenshot?.image || !rect) { render(); return; }
  try {
    const image = await loadImage(step.screenshot.image);
    // v1.0.3: guard against zero screenshot dimensions (was dividing by 0).
    const sw = step.screenshot.width || image.naturalWidth || 1280;
    const sh = step.screenshot.height || image.naturalHeight || 720;
    const canvas = document.createElement("canvas");
    const sx = rect.x / sw * image.naturalWidth;
    const sy = rect.y / sh * image.naturalHeight;
    const cropW = rect.width / sw * image.naturalWidth;
    const cropH = rect.height / sh * image.naturalHeight;
    canvas.width = Math.max(8, Math.round(cropW));
    canvas.height = Math.max(8, Math.round(cropH));
    canvas.getContext("2d").drawImage(image, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
    commit((t) => {
      const s = t.steps[selectedStep];
      s.screenshot.image = canvas.toDataURL("image/png");
      s.screenshot.width = canvas.width;
      s.screenshot.height = canvas.height;
      // Shift annotations that lie inside the crop; drop the rest.
      s.annotations = s.annotations.filter((a) => {
        const box = annotationBox(a);
        // F20 fix: use partial-overlap test instead of strict containment.
        // Previously, an annotation whose right edge was even 1px outside the
        // crop rect was dropped entirely — surprise data loss. Now we keep any
        // annotation that overlaps the crop rect at all, then clamp it below.
        return box.x < rect.x + rect.width &&
               box.x + box.width > rect.x &&
               box.y < rect.y + rect.height &&
               box.y + box.height > rect.y;
      }).map((a) => {
        const box = annotationBox(a);
        // F20 fix: clamp the annotation to the crop rect so it doesn't
        // extend outside the cropped screenshot.
        const clampedX = Math.max(rect.x, box.x);
        const clampedY = Math.max(rect.y, box.y);
        const clampedRight = Math.min(rect.x + rect.width, box.x + box.width);
        const clampedBottom = Math.min(rect.y + rect.height, box.y + box.height);
        const nx = clampedX - rect.x;
        const ny = clampedY - rect.y;
        if (a.type === "marker") {
          // A7 fix: markers store their CENTER as (x, y), but box.x/box.y are
          // the top-left (center - width/2). The old code set a.x = nx, which is
          // the clamped top-left offset — shifting the marker left by width/2.
          // Correct: shift the center by the crop offset and clamp it.
          const newCenterX = a.x - rect.x;
          const newCenterY = a.y - rect.y;
          a.x = Math.max(a.width / 2, Math.min(newCenterX, rect.width - a.width / 2));
          a.y = Math.max(a.height / 2, Math.min(newCenterY, rect.height - a.height / 2));
        } else if (a.type === "arrow") {
          // D11 fix: arrows store endpoints as normalized 0-100 percentages
          // relative to the annotation box. When the box is clamped by the crop,
          // the endpoints must be recomputed against the new box dimensions,
          // otherwise the arrow visibly moves or changes direction.
          // Convert endpoints from % to absolute screenshot coords, shift by
          // crop offset, then recompute as % of the new (clamped) box.
          const oldBox = annotationBox(a);
          const startAbsX = oldBox.x + (a.startX / 100) * oldBox.width;
          const startAbsY = oldBox.y + (a.startY / 100) * oldBox.height;
          const endAbsX = oldBox.x + (a.endX / 100) * oldBox.width;
          const endAbsY = oldBox.y + (a.endY / 100) * oldBox.height;
          // New box position (clamped to crop rect, relative to crop origin)
          a.x = nx;
          a.y = ny;
          a.width = Math.max(8, clampedRight - clampedX);
          a.height = Math.max(8, clampedBottom - clampedY);
          // Recompute endpoints as % of the new box, clamped to 0-100
          a.startX = clamp((startAbsX - clampedX) / Math.max(1, a.width) * 100, 0, 100);
          a.startY = clamp((startAbsY - clampedY) / Math.max(1, a.height) * 100, 0, 100);
          a.endX = clamp((endAbsX - clampedX) / Math.max(1, a.width) * 100, 0, 100);
          a.endY = clamp((endAbsY - clampedY) / Math.max(1, a.height) * 100, 0, 100);
        } else {
          a.x = nx;
          a.y = ny;
          a.width = Math.max(8, clampedRight - clampedX);
          a.height = Math.max(8, clampedBottom - clampedY);
        }
        return a;
      });
    });
  } catch (error) {
    alert(`Crop failed: ${error.message}`);
    render();
  }
}

// M4: A proper searchable tab picker dialog, replacing the bare prompt()
// that was unreadable with many tabs.
// H19: focus trap + Escape handling + restoration of previously-focused element.
function pickTab(tabs) {
  return new Promise((resolve) => {
    // Remove any pre-existing picker.
    const existing = document.getElementById("tabPickerDialog");
    if (existing) existing.remove();

    // Remember the currently focused element so we can restore focus on close.
    const previouslyFocused = document.activeElement;

    const dialog = document.createElement("dialog");
    dialog.id = "tabPickerDialog";
    dialog.style.cssText = "border:1px solid #d4dae4;border-radius:12px;padding:0;max-width:520px;width:90vw;background:#fff;color:#202b40;font:14px system-ui";
    const host = document.createElement("div");
    host.style.cssText = "padding:20px";
    host.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong style="font-size:16px">Pick a tab to capture</strong>
        <button type="button" class="tp-close" style="border:0;background:transparent;font-size:20px;cursor:pointer;color:#768196">×</button>
      </div>
      <input type="search" class="tp-search" placeholder="Search tabs…" style="width:100%;padding:8px 12px;border:1px solid #d4dae4;border-radius:8px;font:inherit;margin-bottom:12px;box-sizing:border-box">
      <div class="tp-list" style="max-height:340px;overflow:auto;border:1px solid #eef1f5;border-radius:8px"></div>
      <p style="margin:12px 0 0;color:#768196;font-size:12px">Click a tab to start the full-page capture.</p>
    `;
    dialog.appendChild(host);
    document.body.appendChild(dialog);
    dialog.showModal();

    const list = host.querySelector(".tp-list");
    const search = host.querySelector(".tp-search");
    const closeBtn = host.querySelector(".tp-close");
    const close = () => {
      try { dialog.close(); } catch (e) {}
      dialog.remove();
      // H19: restore focus to whatever had it before the dialog opened.
      try { previouslyFocused?.focus?.(); } catch (e) {}
      resolve(null);
    };
    closeBtn.onclick = close;
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

    // H19: focus trap — Tab cycles within the dialog.
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const focusable = host.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    function render(filter) {
      const q = (filter || "").toLowerCase();
      const items = tabs
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => {
          if (!q) return true;
          const hay = `${t.title || ""} ${t.url || ""}`.toLowerCase();
          return hay.includes(q);
        });
      list.innerHTML = items.length ? items.map(({ t, i }) => `
        <button type="button" class="tp-item" data-i="${i}" style="display:block;width:100%;text-align:left;padding:10px 14px;border:0;border-bottom:1px solid #f2f4f8;background:transparent;cursor:pointer;font:inherit;color:#202b40">
          <div style="font-weight:600">${escapeHtml((t.title || "Untitled").slice(0, 60))}</div>
          <div style="font-size:11px;color:#768196;margin-top:2px">${escapeHtml((t.url || "").slice(0, 70))}</div>
        </button>
      `).join("") : `<div style="padding:20px;text-align:center;color:#768196">No matching tabs</div>`;

      list.querySelectorAll(".tp-item").forEach((btn) => {
        btn.onmouseenter = () => { btn.style.background = "#f6f8fb"; };
        btn.onmouseleave = () => { btn.style.background = "transparent"; };
        btn.onclick = () => {
          const idx = Number(btn.dataset.i);
          try { dialog.close(); } catch (e) {}
          dialog.remove();
          try { previouslyFocused?.focus?.(); } catch (e) {}
          resolve(tabs[idx]);
        };
      });
    }
    render("");
    search.addEventListener("input", () => render(search.value));
    search.focus();
  });
}

async function captureFullPage() {
  if (!tutorial) return;
  try {
    // Ask the user which tab to capture by listing all open tabs.
    const tabs = await chrome.tabs.query({});
    // v1.0.3: use the same scheme filter as background.js#isValidPage so the
    // picker doesn't show tabs that would be rejected on capture.
    const capturable = tabs.filter((t) => t.url && !/^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|file|moz-extension|extension):/i.test(t.url));
    if (!capturable.length) {
      alert("No capturable tabs found. Open a webpage first, then try again.");
      return;
    }

    // M4: replace the bare prompt() with a proper searchable dialog so it's
    // usable with many tabs.
    const targetTab = await pickTab(capturable);
    if (!targetTab) return;

    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_FULL_PAGE", tabId: targetTab.id });
    if (!response?.ok || !response.captures?.length) {
      alert(response?.error || response?.captureError || "Full-page capture failed.");
      return;
    }
    // C2 fix: if a main-page capture failed mid-loop, the capture was aborted.
    // Show the error instead of saving a misleading partial result.
    if (response.captureError) {
      alert(response.captureError);
      return;
    }
    // B5 fix: warn the user if the capture was truncated at the 200-capture
    // limit (~100,000 CSS px). Without this, the resulting FULL_PAGE step
    // looks complete but only contains the top portion of a very long page.
    if (response.truncated) {
      if (!confirm("This page is too long to capture in full. The capture will contain only the first ~100,000 pixels of the page. Continue?")) {
        return;
      }
    }

    // Stitch captures vertically into one tall image. Fix H4: crop the
    // overlap region between captures so content isn't duplicated. Each
    // capture is placed at the previous capture's bottom edge, and the
    // overlap (captureHeight - viewportHeight) is trimmed from the top of
    // subsequent captures.
    // B4 fix: load images one at a time and free each decoded image as soon as
    // its drawImage call completes. The previous code used Promise.all to load
    // ALL captures simultaneously — for a 200-capture full-page on a HiDPI
    // display, that held hundreds of MB of decoded HTMLImageElement objects at
    // once before the stitch canvas even started.
    //
    // We still compute sourceRects from the full response (cheap), but load
    // and draw each image sequentially, then drop the reference so GC can
    // reclaim it before the next image loads.
    const widths = [];
    let viewportHeight = response.captures[0]?.viewportHeight || 0;
    // First pass: load only the first image to get width/viewportHeight.
    const firstImg = await loadImage(response.captures[0].image);
    widths.push(firstImg.naturalWidth);
    if (!viewportHeight) viewportHeight = firstImg.naturalHeight;
    const width = firstImg.naturalWidth;

    // v1.0.6: pre-compute each capture's overlap-trimmed source rect BEFORE
    // creating the canvas. Setting canvas.height after drawing clears the
    // bitmap (canvas width/height assignment is the standard "clear canvas"
    // idiom), so the old code's post-loop `canvas.height = y` wiped everything
    // and produced a blank image on every full-page capture.
    //
    // v1.0.9: derive the overlap from the actual scrollY delta (CSS px, same
    // unit as viewportHeight) as a FRACTION of the viewport, then apply that
    // fraction to each image's own native pixel height. Comparing
    // img.naturalHeight (device px) directly to viewportHeight (CSS px) — as
    // before — breaks on any HiDPI display or non-100% browser zoom, silently
    // over-trimming real page content.
    //
    // B4 fix: all captures from the same tab have identical native dimensions
    // (same viewport, same DPR), so we can compute sourceRects from the first
    // image alone — no need to load every image first. This keeps the streaming
    // load loop below memory-efficient.
    const firstH = firstImg.naturalHeight;
    const sourceRects = response.captures.map((cap, i) => {
      if (i === 0) return { sourceY: 0, sourceH: firstH };
      const prevY = response.captures[i - 1].scrollY;
      const scrollDelta = Math.max(0, cap.scrollY - prevY);
      const overlapFraction = Math.min(1, Math.max(0, (viewportHeight - scrollDelta) / viewportHeight));
      const overlap = Math.round(overlapFraction * firstH);
      const sourceH = Math.max(0, firstH - overlap);
      return { sourceY: Math.min(overlap, firstH), sourceH };
    });
    const totalHeight = sourceRects.reduce((sum, r) => sum + r.sourceH, 0);

    // P1 fix: guard against canvas dimension limits. Browsers typically
    // cap canvas area at ~16384×16384 or 268M pixels. If the stitched
    // image exceeds this, scale it down proportionally.
    const MAX_CANVAS_HEIGHT = 32767; // conservative browser limit
    const MAX_CANVAS_AREA = 268435456; // 256MP
    let finalWidth = width;
    let finalHeight = totalHeight;
    if (finalHeight > MAX_CANVAS_HEIGHT || finalWidth * finalHeight > MAX_CANVAS_AREA) {
      const scale = Math.min(MAX_CANVAS_HEIGHT / finalHeight, Math.sqrt(MAX_CANVAS_AREA / (finalWidth * finalHeight)));
      finalWidth = Math.round(finalWidth * scale);
      finalHeight = Math.round(finalHeight * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = finalWidth;
    canvas.height = finalHeight;  // set once, before any drawing
    const ctx = canvas.getContext("2d");
    const drawScale = finalWidth / width; // scale factor for drawing
    let y = 0;
    // B4 fix: stream images one at a time. Load → draw → drop reference so GC
    // can reclaim the decoded image before the next one loads. This caps peak
    // memory at ~2 decoded images (current + first, which we keep for nested
    // capture aspect-ratio derivation below) instead of all `captures.length`.
    for (let i = 0; i < response.captures.length; i++) {
      const { sourceY, sourceH } = sourceRects[i];
      if (sourceH <= 0) continue; // fully-duplicate capture (already at max scroll) — skip it
      const img = i === 0 ? firstImg : await loadImage(response.captures[i].image);
      const drawW = img.naturalWidth * drawScale;
      const drawH = sourceH * drawScale;
      ctx.drawImage(img, 0, sourceY, img.naturalWidth, sourceH, 0, y, drawW, drawH);
      y += drawH;
    }

    // P0-2 v1.5.3 fix: incorporate nested scroller captures into the stitched
    // image. The previous v1.5.2 code returned nestedCaptures as a separate
    // field but editor.js never consumed them — so pages with independently
    // scrolling containers (sidebars, chat panels) had their nested content
    // silently discarded from the Full Page Capture.
    //
    // For each nested scroller:
    //   1. Crop each of its viewport screenshots to the scroller's bounding
    //      rect (entry.rect — in CSS px relative to the viewport).
    //   2. Stitch the crops vertically with overlap-trim (same algorithm as
    //      the main stitch, but per-axis scale is computed from the scroller's
    //      own clientHeight, not the viewport).
    //   3. Append the stitched scroller image below the main capture, with a
    //      small gap and a label so the user can visually distinguish them.
    //
    // The nested captures use full-viewport screenshots, so the crop is the
    // same region of every image. The overlap-trim uses the scrollY delta
    // (in CSS px) divided by the scroller's clientHeight to compute the
    // fraction to trim — same logic as the main stitch.
    //
    // Best-effort: if a nested capture's image fails to load or the rect is
    // invalid, we skip that nested scroller entirely rather than failing the
    // whole Full Page Capture.
    const nestedEntries = Array.isArray(response.nestedCaptures) ? response.nestedCaptures : [];
    if (nestedEntries.length > 0) {
      // Process each nested scroller's captures.
      const nestedStitchedPanels = []; // {img: HTMLImageElement, label: string}
      for (const entry of nestedEntries) {
        if (!entry?.captures?.length || !entry?.rect) continue;
        try {
          // C8 fix: load the first nested image to get dimensions, then stream
          // the rest. The old code used Promise.all to load ALL nested captures
          // simultaneously — for a large nested scroller with many captures,
          // that held dozens of decoded images in memory at once.
          const firstNestedImg = await loadImage(entry.captures[0].image);
          const scrollerRect = entry.rect; // CSS px relative to viewport
          const mainImg = firstImg;
          const viewportWidthCss = viewportHeight * mainImg.naturalWidth / mainImg.naturalHeight;
          const ratioX = mainImg.naturalWidth / viewportWidthCss;
          const ratioY = mainImg.naturalHeight / viewportHeight;
          const cropX = Math.round(scrollerRect.x * ratioX);
          const cropY = Math.round(scrollerRect.y * ratioY);
          const cropW = Math.max(1, Math.round(scrollerRect.width * ratioX));
          const cropH = Math.max(1, Math.round(scrollerRect.height * ratioY));
          // Compute overlap-trim per nested capture from the first image's height
          // (all captures from the same viewport have the same native dimensions).
          const nestedSourceRects = entry.captures.map((cap, i) => {
            if (i === 0) return { sourceY: 0, sourceH: cropH };
            const prevY = entry.captures[i - 1].scrollY;
            const scrollDelta = Math.max(0, cap.scrollY - prevY);
            const overlapFraction = Math.min(1, Math.max(0, (scrollerRect.height - scrollDelta) / scrollerRect.height));
            const overlap = Math.round(overlapFraction * cropH);
            const sourceH = Math.max(0, cropH - overlap);
            return { sourceY: Math.min(overlap, cropH), sourceH };
          });
          const nestedTotalHeight = nestedSourceRects.reduce((sum, r) => sum + r.sourceH, 0);
          if (nestedTotalHeight <= 0) continue;

          const nestedCanvas = document.createElement("canvas");
          nestedCanvas.width = cropW;
          nestedCanvas.height = nestedTotalHeight;
          const nestedCtx = nestedCanvas.getContext("2d");
          let ny = 0;
          // C8 fix: stream images one at a time (load → draw → drop reference).
          for (let i = 0; i < entry.captures.length; i++) {
            const { sourceY, sourceH } = nestedSourceRects[i];
            if (sourceH <= 0) continue;
            const img = i === 0 ? firstNestedImg : await loadImage(entry.captures[i].image);
            nestedCtx.drawImage(img, cropX, cropY + sourceY, cropW, sourceH, 0, ny, cropW, sourceH);
            ny += sourceH;
          }
          // Convert to data URL so we can load it as an image for the
          // final composite (drawImage needs an HTMLImageElement to scale).
          const nestedDataUrl = nestedCanvas.toDataURL("image/png");
          const nestedImg = await loadImage(nestedDataUrl);
          nestedStitchedPanels.push({
            img: nestedImg,
            label: `Nested scroller content (${Math.round(scrollerRect.width)}×${Math.round(scrollerRect.height)} CSS px)`
          });
        } catch (_) { /* skip this scroller on error */ }
      }

      // If we have stitched nested panels, append them below the main capture
      // with a small label/gap.
      if (nestedStitchedPanels.length > 0) {
        // Compute total additional height needed (with 24px gap + 28px label
        // per panel, in CSS px — we'll scale to canvas units).
        const GAP_PX = 24;
        const LABEL_PX = 28;
        const additionalHeight = nestedStitchedPanels.reduce((sum, p) => sum + p.img.naturalHeight + GAP_PX + LABEL_PX, 0);
        let newHeight = canvas.height + additionalHeight;
        let newWidth = canvas.width;
        // v1.6.4 fix: apply the same canvas-size protection that the main
        // capture uses. The previous code checked MAX_CANVAS_HEIGHT / AREA
        // only for the main stitched image, then appended nested panels
        // without re-checking — so a long main page + large nested scrollers
        // could exceed browser canvas limits and produce a blank/too-large
        // canvas. Now we scale the combined image down proportionally if
        // needed.
        const MAX_CANVAS_HEIGHT = 32767;
        const MAX_CANVAS_AREA = 268435456; // 256MP
        if (newHeight > MAX_CANVAS_HEIGHT || newWidth * newHeight > MAX_CANVAS_AREA) {
          const scale = Math.min(MAX_CANVAS_HEIGHT / newHeight, Math.sqrt(MAX_CANVAS_AREA / (newWidth * newHeight)));
          newWidth = Math.round(newWidth * scale);
          newHeight = Math.round(newHeight * scale);
        }
        // Re-create the canvas at the new size (must set width/height before
        // drawing — assigning height clears the bitmap).
        const newCanvas = document.createElement("canvas");
        newCanvas.width = newWidth;
        newCanvas.height = newHeight;
        const newCtx = newCanvas.getContext("2d");
        // Copy the main capture into the new canvas (scaled if needed).
        newCtx.drawImage(canvas, 0, 0, newWidth, canvas.height * (newWidth / canvas.width));
        let ny = canvas.height * (newWidth / canvas.width);
        const widthScale = newWidth / canvas.width;
        for (const panel of nestedStitchedPanels) {
          // Draw the label area (a dark strip with text).
          newCtx.fillStyle = "#1b2333";
          newCtx.fillRect(0, ny, newCanvas.width, Math.round(LABEL_PX * widthScale));
          newCtx.fillStyle = "#ffffff";
          newCtx.font = `600 ${Math.round(LABEL_PX * 0.6 * widthScale)}px system-ui, sans-serif`;
          newCtx.textBaseline = "middle";
          newCtx.fillText(panel.label, Math.round(12 * widthScale), ny + Math.round(LABEL_PX * widthScale / 2));
          ny += Math.round(LABEL_PX * widthScale);
          // Gap
          ny += Math.round(GAP_PX / 2 * widthScale);
          // Draw the stitched scroller image.
          // D10 fix: use the SAME combined scale that was applied to the main
          // image (widthScale), not an independent panelScale. The old code
          // could keep panels near native size while the main image was scaled
          // down — causing clipped panels or content extending beyond the canvas.
          const panelDrawW = panel.img.naturalWidth * widthScale;
          const panelDrawH = panel.img.naturalHeight * widthScale;
          const panelX = Math.round((newCanvas.width - panelDrawW) / 2);
          // Fill background behind the panel so centered narrow panels
          // don't show transparent gaps.
          newCtx.fillStyle = "#f0f2f5";
          newCtx.fillRect(0, ny, newCanvas.width, panelDrawH);
          newCtx.drawImage(panel.img, 0, 0, panel.img.naturalWidth, panel.img.naturalHeight, panelX, ny, panelDrawW, panelDrawH);
          ny += panelDrawH + Math.round(GAP_PX / 2 * widthScale);
        }
        // Replace canvas with newCanvas for the final toDataURL.
        canvas.width = newCanvas.width;
        canvas.height = newCanvas.height;
        canvas.getContext("2d").drawImage(newCanvas, 0, 0);
      }
    }

    const dataUrl = canvas.toDataURL("image/png");
    commit((t) => {
      t.steps.push({
        id: `step-${crypto.randomUUID()}`,
        number: t.steps.length + 1,
        action: "FULL_PAGE",
        description: `Full page capture of ${targetTab.title || "page"}`,
        screenshot: { image: dataUrl, status: "OK", width: canvas.width, height: canvas.height, url: targetTab.url, timestamp: Date.now() },
        annotations: []
      });
      selectedStep = t.steps.length - 1;
      selectedAnnotation = null;
    });
  } catch (error) {
    alert(`Full-page capture failed: ${error.message}`);
  }
}

function mergeWithNextStep(index) {
  if (!tutorial?.steps[index] || !tutorial.steps[index + 1]) {
    alert("Select a step that has a step after it.");
    return;
  }
  // P1-17 fix: warn that the next screenshot will be lost
  if (!confirm("Merging will combine descriptions and annotations but discard the next step's screenshot. Continue?")) return;
  commit((t) => {
    const current = t.steps[index];
    const next = t.steps[index + 1];
    // H24: use a visible separator (em-dash on its own line) instead of \n\n
    // which the textarea doesn't render as a visible break.
    const sep = current.description && next.description ? "\n\n— Next step —\n\n" : "";
    current.description = `${current.description || ""}${sep}${next.description || ""}`.trim();
    // H5: scale annotations from the next step to the current step's canvas
    // so they stay in bounds if the two screenshots have different dimensions.
    const currentSize = canvasSize(current);
    const nextSize = canvasSize(next);
    const scaleX = currentSize.width / Math.max(1, nextSize.width);
    const scaleY = currentSize.height / Math.max(1, nextSize.height);
    const scaledAnnotations = next.annotations.map((a) => {
      // F11 fix: shallow-copy the annotation instead of deep-cloning. Annotations
      // are small flat objects, so JSON.parse(JSON.stringify()) is ~10x slower
      // than a spread for no benefit.
      const c = { ...a };
      c.id = `annotation-${crypto.randomUUID()}`;
      c.x = c.x * scaleX;
      c.y = c.y * scaleY;
      c.width = c.width * scaleX;
      c.height = c.height * scaleY;
      return c;
    });
    current.annotations = [...current.annotations, ...scaledAnnotations];
    t.steps.splice(index + 1, 1);
    t.steps.forEach((s, i) => (s.number = i + 1));
    selectedAnnotation = null;
  });
}

function splitStep(index) {
  const step = tutorial?.steps[index];
  if (!step) return;
  commit((t) => {
    // F10 fix: shallow-copy the step instead of deep-cloning via
    // JSON.parse(JSON.stringify(step)). The deep clone copies the entire
    // base64 screenshot string (multi-MB), causing a visible UI hitch.
    // We only need a new step object with the same screenshot reference
    // (screenshots are immutable in practice) and a clean annotations array.
    const copy = {
      ...step,
      screenshot: { ...step.screenshot },
      annotations: []
    };
    copy.id = `step-${crypto.randomUUID()}`;
    // H6: the second step starts with a clean annotation list — duplicating
    // all annotations left the user with two identical-looking steps to clean up.
    copy.description = `${step.description || ""} (continued)`.trim();
    t.steps.splice(index + 1, 0, copy);
    t.steps.forEach((s, i) => (s.number = i + 1));
    selectedStep = index + 1;
    selectedAnnotation = null;
  });
}

function setStepGroup(index, group) {
  const step = tutorial?.steps[index];
  if (!step) return;
  commit((t) => {
    t.steps[index].group = group || undefined;
  });
}

function copyAnnotation() {
  const step = tutorial?.steps[selectedStep];
  const a = step?.annotations[selectedAnnotation];
  if (!a) { alert("Select an annotation to copy."); return; }
  clipboard = clone(a);
  delete clipboard.id;
}

function pasteAnnotation() {
  if (!clipboard) { alert("Clipboard is empty."); return; }
  const step = tutorial?.steps[selectedStep];
  if (!step) return;
  commit((t) => {
    const copy = clone(clipboard);
    copy.id = `annotation-${crypto.randomUUID()}`;
    const size = canvasSize(t.steps[selectedStep]);
    if (copy.type === "marker") {
      copy.x = clamp(copy.x + 20, copy.width / 2, size.width - copy.width / 2);
      copy.y = clamp(copy.y + 20, copy.height / 2, size.height - copy.height / 2);
    } else {
      copy.x = clamp(copy.x + 20, 0, size.width - copy.width);
      copy.y = clamp(copy.y + 20, 0, size.height - copy.height);
    }
    t.steps[selectedStep].annotations.push(copy);
    selectedAnnotation = t.steps[selectedStep].annotations.length - 1;
  });
}

// Next auto-incrementing marker number for the active step.
function nextMarkerNumber() {
  const step = tutorial?.steps[selectedStep];
  if (!step) return 1;
  const numbers = step.annotations
    .filter((a) => a.type === "marker")
    // F19 fix: use Number() (strict numeric) instead of parseInt() so a
    // marker labeled "1A" doesn't parse as 1 and collide with the next marker.
    .map((a) => Number(a.label))
    .filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

// ---------------------------------------------------------------------------
// Shortcut cheat sheet
// ---------------------------------------------------------------------------

async function showShortcutCheatSheet() {
  const existing = $("shortcutOverlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "shortcutOverlay";
  overlay.className = "shortcut-overlay";
  // Show the user's ACTUAL shortcut bindings, not the defaults.
  // getSettings() is async (always returns a Promise), so we must await it.
  const userSettings = await getSettings();
  const userShortcuts = (userSettings || {}).shortcuts || {};
  const entries = Object.entries(DEFAULT_SHORTCUTS);
  const rows = entries.map(([name, def]) => {
    // Use the user's custom binding if set, otherwise the default
    const keys = userShortcuts[name]?.keys || def.keys;
    return `
    <tr><td><kbd>${escapeHtml(keys)}</kbd></td><td>${escapeHtml(def.label)}</td><td>${escapeHtml(def.scope)}</td></tr>
  `}).join("");
  overlay.innerHTML = `
    <div class="shortcut-card">
      <button id="shortcutClose" type="button" class="shortcut-close" aria-label="Close">×</button>
      <span class="kicker">KEYBOARD SHORTCUTS</span>
      <h2>Browser Tutorial Recorder</h2>
      <table><thead><tr><th>Shortcut</th><th>Action</th><th>Scope</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  document.body.appendChild(overlay);
  $("shortcutClose").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  await initTheme();
  // P2 fix: platform-aware shortcut hint in the editor footer
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const modKey = isMac ? "⌘" : "Ctrl";
  const hint = document.getElementById("shortcutHint");
  if (hint) hint.innerHTML = `<kbd>${modKey}</kbd> <kbd>Z</kbd> undo · <kbd>${modKey}</kbd> <kbd>S</kbd> save`;
  const id = new URLSearchParams(location.search).get("id");
  // v1.0.9: fetch only the one tutorial we need via dbGet(id) instead of
  // loading the entire library with dbGetAll().
  let source = id ? await dbGet(id) : null;
  if (!source) {
    if (id) {
      alert("Tutorial not found. Redirecting to dashboard.");
      location.href = "dashboard.html";
      return;
    }
    location.href = "dashboard.html";
    return;
  }
  tutorial = normalizeTutorial(source);
  // v1.6.1 fix: only save (and bump updatedAt) if normalization actually
  // changed the data. For any tutorial the app already saved, normalizeTutorial
  // is idempotent — same fields in, same fields out. The previous code called
  // saveTutorial() unconditionally on every open, which stamped a fresh
  // updatedAt timestamp even when nothing changed. This broke the dashboard's
  // sort-by-recency (tutorials jumped to the top just from being viewed) and
  // made the "Updated X ago" label meaningless.
  //
  // F13 fix: gate the expensive JSON.stringify comparison behind a fast
  // structural pre-check. The previous code always ran two JSON.stringify calls
  // on the entire tutorial (including multi-MB base64 screenshots) on every
  // open — 1-2s freeze on 100-step tutorials. Now we only do the deep compare
  // if the version is wrong or a structural key is missing.
  const needsMigration = (() => {
    if (source.version !== 4) return true;
    if (!Array.isArray(source.steps)) return true;
    // F7 fix: guard against null/non-object steps. The old code `s.id && ...`
    // would throw TypeError if s was null. Now safely checks s first.
    if (!source.steps.every(s => s && s.id && s.number != null && s.screenshot && typeof s.screenshot.width === "number")) return true;
    // Structural check passed — do the deep compare to catch field-level
    // changes (e.g., oversized strings, invalid colors).
    // F13 perf: exclude screenshot.image from the comparison since it's a
    // multi-MB string that normalizeTutorial never changes for valid URLs.
    const stripImages = (t) => ({
      ...t,
      steps: (t.steps || []).map(s => ({ ...s, screenshot: { ...s.screenshot, image: "" } }))
    });
    return JSON.stringify(stripImages({ ...tutorial, version: source.version })) !== JSON.stringify(stripImages(source));
  })();
  if (needsMigration) {
    // Persist the migrated record WITHOUT bumping updatedAt (preserve source.updatedAt)
    await dbPut({ ...tutorial, updatedAt: source.updatedAt || tutorial.updatedAt });
  }
  pushHistory();
  render();
}

loadPresets();
setupEvents();
renderPresets(); // H2: render the preset library on load
init().catch((error) => alert(`Could not open editor: ${error.message}`));
