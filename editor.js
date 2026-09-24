import { bgCall } from "./common-ui.js";
import { makeId, formatDuration } from "./shared.js";
import { exportTutorial, drawAnnotations } from "./exporter.js";
import { getSettings, normalizeCombo, onSettingsChanged } from "./settings-store.js";
import {
  RECT_TYPES, syncGeom, annotationHit, handlesAt, rotateHandlePos, rotateAround, cropRemap
} from "./annotation-geom.js";

const els = {
  title: document.getElementById("tutorial-title"),
  saveState: document.getElementById("save-state"),
  stepList: document.getElementById("step-list"),
  stepCountLabel: document.getElementById("step-count-label"),
  canvas: document.getElementById("canvas"),
  canvasWrap: document.getElementById("canvas-wrap"),
  canvasEmpty: document.getElementById("canvas-empty"),
  textInput: document.getElementById("text-input"),
  propNumber: document.getElementById("prop-step-number"),
  propDescription: document.getElementById("prop-description"),
  propUrl: document.getElementById("prop-url"),
  shotInfo: document.getElementById("shot-info"),
  swatches: document.getElementById("swatches"),
  presets: document.getElementById("preset-chips"),
  cropBar: document.getElementById("crop-bar"),
  cropApply: document.getElementById("btn-crop-apply"),
  cropCancel: document.getElementById("btn-crop-cancel")
};

const COLORS = ["#ff5b45", "#1a73e8", "#1a7f4b", "#f9ab00", "#15161a"];

let tutorial = null;
let current = 0;
let tool = "select";
let selectedAnnotationId = null;
let settings = { editorShortcuts: {}, annotationPresets: [] };
const style = { color: COLORS[0], strokeWidth: 3, opacity: 0.9, blur: 10, fontSize: 18 };

let undoStack = [];
let redoStack = [];
let saveTimer = null;
let dirty = false;

let display = { image: null, scale: 1, imgScale: 1 };
let drag = null;
let cropMode = false;
let crop = null;
let clipboardAnnotation = null;
let imgCache = { key: "", image: null };

const params = new URLSearchParams(location.search);
const tutorialId = params.get("id");

function snapshot() {
  undoStack.push(tutorial.steps.map((s) => ({
    ...s,
    screenshot: { ...s.screenshot },
    annotations: s.annotations.map((a) => ({ ...a }))
  })));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneSteps(tutorial.steps));
  tutorial.steps = undoStack.pop();
  current = Math.min(current, tutorial.steps.length - 1);
  markDirty();
  renderAll();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneSteps(tutorial.steps));
  tutorial.steps = redoStack.pop();
  current = Math.min(current, tutorial.steps.length - 1);
  markDirty();
  renderAll();
}

function cloneSteps(steps) {
  return steps.map((s) => ({ ...s, screenshot: { ...s.screenshot }, annotations: s.annotations.map((a) => ({ ...a })) }));
}

function markDirty() {
  dirty = true;
  els.saveState.textContent = "…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1100);
}

async function save() {
  if (!dirty) return;
  tutorial.updatedAt = Date.now();
  try {
    await bgCall({ type: "SAVE_TUTORIAL", tutorial });
    dirty = false;
    els.saveState.textContent = "Saved ✓";
    setTimeout(() => { if (!dirty) els.saveState.textContent = ""; }, 1600);
  } catch (e) {
    els.saveState.textContent = "Save failed";
    console.error(e);
  }
}

function currentStep() { return tutorial.steps[current] || null; }

async function renderCanvas() {
  const step = currentStep();
  const ctx = els.canvas.getContext("2d");
  if (!step || !step.screenshot || !step.screenshot.image) {
    els.canvas.width = 640; els.canvas.height = 200;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    els.canvasEmpty.textContent = step
      ? "This step has no screenshot. Use Recapture in the right pane, or delete the step."
      : "Select a step to edit it.";
    els.canvasEmpty.classList.remove("hidden");
    display.image = null;
    return;
  }
  els.canvasEmpty.classList.add("hidden");
  // Cache the decoded bitmap: re-decoding a multi-MB data URL on every
  // pointermove made dragging annotations feel broken (janky, laggy draws).
  const key = `${step.id}|${step.screenshot.image.length}|${step.screenshot.image.slice(-40)}`;
  let image = imgCache.key === key ? imgCache.image : null;
  if (!image) {
    image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Screenshot failed to load."));
      image.src = step.screenshot.image;
    });
    imgCache = { key, image };
  }
  const wrapW = els.canvasWrap.clientWidth - 32;
  const wrapH = els.canvasWrap.clientHeight - 32;
  const fit = Math.min(wrapW / image.naturalWidth, wrapH / image.naturalHeight, 1);
  display.image = image;
  display.scale = fit;
  display.imgScale = step.screenshot.width > 0 ? image.naturalWidth / step.screenshot.width : 1;
  els.canvas.width = Math.round(image.naturalWidth * fit);
  els.canvas.height = Math.round(image.naturalHeight * fit);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(image, 0, 0, els.canvas.width, els.canvas.height);
  ctx.canvas.__btrImage = image;
  drawAnnotations(ctx, step.annotations, fit);
  if (selectedAnnotationId && !cropMode) {
    const a = step.annotations.find((x) => x.id === selectedAnnotationId);
    if (a) drawSelectionUI(ctx, a, fit);
  }
  if (cropMode && crop) drawCropOverlay(ctx, fit);
}

function drawSelectionUI(ctx, a, fit) {
  ctx.save();
  ctx.strokeStyle = "#1a73e8";
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  const x2 = a.x2 == null ? a.x : a.x2;
  const y2 = a.y2 == null ? a.y : a.y2;
  if (a.type === "arrow") {
    ctx.strokeRect(Math.min(a.x, x2) * fit - 3, Math.min(a.y, y2) * fit - 3,
      Math.abs(x2 - a.x) * fit + 6, Math.abs(y2 - a.y) * fit + 6);
  } else if (a.type === "marker") {
    ctx.beginPath();
    ctx.arc(a.x * fit, a.y * fit, 16 * fit + 3, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const dims = a.type === "text"
      ? { w: a.w || 60, h: a.h || (a.fontSize || 18) * 1.4 }
      : { w: a.w || 0, h: a.h || 0 };
    ctx.strokeRect(a.x * fit - 3, a.y * fit - 3, dims.w * fit + 6, dims.h * fit + 6);
  }
  ctx.setLineDash([]);
  if (tool === "select") {
    if (a.type === "arrow") {
      for (const [hx, hy] of [[a.x, a.y], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(hx * fit, hy * fit, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const midX = ((a.x + x2) / 2) * fit, midY = ((a.y + y2) / 2) * fit;
      const { hx, hy } = rotateHandlePos(a);
      ctx.beginPath();
      ctx.moveTo(midX, midY);
      ctx.lineTo(hx * fit, hy * fit);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx * fit, hy * fit, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#1a73e8";
      ctx.fill();
    } else if (a.type !== "text" && a.type !== "marker") {
      const cx = (a.x + (a.w || 0)) * fit, cy = (a.y + (a.h || 0)) * fit;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 5, cy - 5, 10, 10);
    }
  }
  ctx.restore();
}

function drawCropOverlay(ctx, fit) {
  const x1 = Math.min(crop.x1, crop.x2) * fit;
  const y1 = Math.min(crop.y1, crop.y2) * fit;
  const w = Math.abs(crop.x2 - crop.x1) * fit;
  const h = Math.abs(crop.y2 - crop.y1) * fit;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.save();
  ctx.fillStyle = "rgba(9,10,14,0.55)";
  ctx.fillRect(0, 0, W, y1);
  ctx.fillRect(0, y1 + h, W, Math.max(0, H - y1 - h));
  ctx.fillRect(0, y1, x1, h);
  ctx.fillRect(x1 + w, y1, Math.max(0, W - x1 - w), h);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x1, y1, w, h);
  ctx.restore();
}

function canvasPoint(e) {
  // Use the live rect, not the nominal fit: CSS (max-width/max-height) can
  // shrink the displayed canvas below its bitmap size, and every coordinate
  // from drawing to hit-testing must map through that exact ratio.
  const rect = els.canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? els.canvas.width / rect.width : 1;
  const sy = rect.height > 0 ? els.canvas.height / rect.height : 1;
  return {
    x: (e.clientX - rect.left) / sx,
    y: (e.clientY - rect.top) / sy
  };
}

els.canvas.addEventListener("pointerdown", (e) => {
  const step = currentStep();
  if (!step || !display.image) return;
  els.canvas.setPointerCapture(e.pointerId);
  const pt = canvasPoint(e);

  if (cropMode) {
    crop = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    drag = { kind: "crop", startX: pt.x, startY: pt.y };
    renderCanvas();
    return;
  }

  if (tool === "select") {
    // Handles of the already-selected annotation win over a fresh hit test —
    // they reach slightly outside the shape, and the head/tail/rotate knobs
    // of an arrow overlap its own segment.
    const sel = step.annotations.find((x) => x.id === selectedAnnotationId) || null;
    const handle = sel ? handlesAt(sel, pt) : null;
    if (sel && handle === "rotate") {
      const x2 = sel.x2 == null ? sel.x : sel.x2;
      const y2 = sel.y2 == null ? sel.y : sel.y2;
      const cx = (sel.x + x2) / 2, cy = (sel.y + y2) / 2;
      drag = {
        kind: "rotate", ann: sel, orig: { ...sel }, cx, cy,
        startAngle: Math.atan2(pt.y - cy, pt.x - cx)
      };
      snapshot();
      renderCanvas();
      return;
    }
    if (sel && handle) {
      drag = { kind: "resize", handle, ann: sel, orig: { ...sel } };
      snapshot();
      renderCanvas();
      return;
    }
    const a = annotationHit(step.annotations, pt);
    selectedAnnotationId = a ? a.id : null;
    if (a) {
      drag = { kind: "move", ann: a, startX: pt.x, startY: pt.y, orig: { ...a } };
      snapshot();
    }
    renderCanvas();
    return;
  }

  const base = {
    id: makeId("ann"),
    type: tool,
    x: Math.round(pt.x), y: Math.round(pt.y),
    w: 0, h: 0, x2: Math.round(pt.x), y2: Math.round(pt.y),
    color: style.color,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    blur: style.blur,
    fontSize: style.fontSize,
    number: step.annotations.filter((x) => x.type === "marker").length + 1,
    text: ""
  };
  if (tool === "text") {
    openTextInput(pt, base);
    return;
  }
  if (tool === "marker") {
    snapshot();
    step.annotations.push(base);
    markDirty();
    renderCanvas();
    return;
  }
  // startX/startY MUST be the pointerdown point: they anchor the shape. The
  // old code left them undefined here, so the first move set w/h to 0 and
  // the origin jumped to the first pointermove position — rectangles and
  // arrows came out mangled whenever the pointer moved at all.
  drag = { kind: "draw", ann: base, step, startX: pt.x, startY: pt.y };
  snapshot();
  step.annotations.push(base);
  selectedAnnotationId = base.id;
});

els.canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const pt = canvasPoint(e);
  if (drag.kind === "draw") {
    const a = drag.ann;
    if (a.type === "arrow") {
      // Arrows keep the tail pinned at the pointerdown point; the head
      // follows the pointer. Forcing the tail to the bbox corner (old
      // behavior) made arrows point the wrong way when drawn upward.
      a.x2 = Math.round(pt.x);
      a.y2 = Math.round(pt.y);
    } else {
      a.x = Math.round(Math.min(drag.startX, pt.x));
      a.y = Math.round(Math.min(drag.startY, pt.y));
      a.w = Math.round(Math.abs(pt.x - drag.startX));
      a.h = Math.round(Math.abs(pt.y - drag.startY));
    }
    syncGeom(a);
  } else if (drag.kind === "move") {
    const a = drag.ann;
    const dx = Math.round(pt.x - drag.startX);
    const dy = Math.round(pt.y - drag.startY);
    a.x = drag.orig.x + dx;
    a.y = drag.orig.y + dy;
    if (drag.orig.x2 != null) {
      a.x2 = drag.orig.x2 + dx;
      a.y2 = drag.orig.y2 + dy;
    }
    syncGeom(a);
  } else if (drag.kind === "resize") {
    const a = drag.ann;
    if (drag.handle === "head") {
      a.x2 = Math.round(pt.x);
      a.y2 = Math.round(pt.y);
    } else if (drag.handle === "tail") {
      a.x = Math.round(pt.x);
      a.y = Math.round(pt.y);
    } else if (RECT_TYPES.has(a.type)) {
      a.w = Math.max(3, Math.round(pt.x - a.x));
      a.h = Math.max(3, Math.round(pt.y - a.y));
    }
    syncGeom(a);
  } else if (drag.kind === "rotate") {
    const a = drag.ann;
    const pointerAngle = Math.atan2(pt.y - drag.cy, pt.x - drag.cx);
    const next = rotateAround(
      drag.cx, drag.cy,
      drag.orig.x, drag.orig.y,
      drag.orig.x2 == null ? drag.orig.x : drag.orig.x2,
      drag.orig.y2 == null ? drag.orig.y : drag.orig.y2,
      drag.startAngle, pointerAngle
    );
    a.x = next.x; a.y = next.y; a.x2 = next.x2; a.y2 = next.y2;
    syncGeom(a);
  } else if (drag.kind === "crop") {
    crop.x2 = pt.x;
    crop.y2 = pt.y;
  }
  renderCanvas();
});

els.canvas.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const kind = drag.kind;
  const pt = canvasPoint(e);
  if (kind === "draw") {
    const a = drag.ann;
    const tiny = a.type === "arrow"
      ? Math.hypot((a.x2 == null ? a.x : a.x2) - a.x, (a.y2 == null ? a.y : a.y2) - a.y) < 4
      : (a.w < 3 && a.h < 3);
    if (tiny) {
      const step = currentStep();
      step.annotations = step.annotations.filter((x) => x.id !== a.id);
      if (selectedAnnotationId === a.id) selectedAnnotationId = null;
      undoStack.pop();
    }
    markDirty();
  } else if (kind === "move" || kind === "resize" || kind === "rotate") {
    markDirty();
  } else if (kind === "crop") {
    crop.x2 = pt.x;
    crop.y2 = pt.y;
    // An accidental click without a real drag clears the marquee instead of
    // committing a degenerate crop region.
    if (Math.abs(crop.x2 - crop.x1) < 8 || Math.abs(crop.y2 - crop.y1) < 8) crop = null;
    syncCropBar();
  }
  drag = null;
  renderCanvas();
});

function openTextInput(pt, ann) {
  const input = els.textInput;
  input.classList.remove("hidden");
  // Map the canvas-bitmap point through the LIVE displayed size: display.scale
  // predates any CSS shrinking of the canvas, so the input could drift away
  // from the click point on narrow windows.
  const rect = els.canvas.getBoundingClientRect();
  const ratio = els.canvas.width > 0 ? rect.width / els.canvas.width : display.scale;
  input.style.left = `${els.canvas.offsetLeft + pt.x * ratio}px`;
  input.style.top = `${els.canvas.offsetTop + pt.y * ratio}px`;
  input.value = "";
  input.focus();
  const commit = () => {
    const text = input.value.trim();
    input.classList.add("hidden");
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", commit);
    if (text) {
      ann.text = text;
      ann.w = Math.max(40, text.length * ann.fontSize * 0.62);
      ann.h = ann.fontSize * 1.4;
      const step = currentStep();
      step.annotations.push(ann);
      snapshot();
      markDirty();
    }
    renderCanvas();
  };
  const onKey = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { input.value = ""; commit(); }
  };
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", commit);
}

// ----------------------------------------------------------------
// Crop tool: a real one. Toggle with the Crop button, drag a marquee
// (live preview with the outside dimmed), adjust by dragging again,
// then Apply (button or Enter) or Cancel (button or Esc).
// ----------------------------------------------------------------
function syncCropBar() {
  if (!els.cropBar) return;
  els.cropBar.classList.toggle("hidden", !cropMode);
  els.cropApply.disabled = !crop;
}

function exitCropMode() {
  cropMode = false;
  crop = null;
  tool = "select";
  els.canvas.classList.remove("selecting");
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === "select"));
  syncCropBar();
}

function cancelCrop() {
  crop = null;
  exitCropMode();
  renderCanvas();
}

async function applyCrop() {
  if (!cropMode || !crop) return;
  const step = currentStep();
  if (!step || !display.image || !step.screenshot.width) { cancelCrop(); return; }
  const imgScale = display.imgScale;
  const nx1 = Math.max(0, Math.round(Math.min(crop.x1, crop.x2) * imgScale));
  const ny1 = Math.max(0, Math.round(Math.min(crop.y1, crop.y2) * imgScale));
  const nx2 = Math.min(display.image.naturalWidth, Math.round(Math.max(crop.x1, crop.x2) * imgScale));
  const ny2 = Math.min(display.image.naturalHeight, Math.round(Math.max(crop.y1, crop.y2) * imgScale));
  const w = nx2 - nx1, h = ny2 - ny1;
  if (w < 10 || h < 10) { cancelCrop(); return; }
  snapshot();
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(display.image, nx1, ny1, w, h, 0, 0, w, h);
  const cssW = Math.round(w / imgScale), cssH = Math.round(h / imgScale);
  step.screenshot.image = c.toDataURL("image/png");
  step.screenshot.width = cssW;
  step.screenshot.height = cssH;
  // Annotations move with the image; ones left fully outside the crop are
  // dropped instead of lingering at negative coordinates.
  step.annotations = cropRemap(step.annotations, Math.round(nx1 / imgScale), Math.round(ny1 / imgScale), cssW, cssH);
  selectedAnnotationId = null;
  exitCropMode();
  markDirty();
  renderAll();
}

function renderStepList() {
  els.stepList.innerHTML = "";
  els.stepCountLabel.textContent = `${tutorial.steps.length}`;
  tutorial.steps.forEach((step, index) => {
    const card = document.createElement("div");
    card.className = "step-card" + (index === current ? " active" : "");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", index === current ? "true" : "false");
    card.dataset.index = String(index);

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(step.number);
    card.appendChild(num);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (step.screenshot && step.screenshot.image) {
      thumb.style.backgroundImage = `url("${step.screenshot.image}")`;
    }
    card.appendChild(thumb);

    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = step.description || "(no description)";
    card.appendChild(desc);

    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      selectStep(index);
      startReorderDrag(e, card, index);
    });

    els.stepList.appendChild(card);
  });
}

function startReorderDrag(startEvent, card, fromIndex) {
  const pane = els.stepList;
  let targetIndex = fromIndex;
  card.classList.add("dragging");
  const onMove = (e) => {
    const cards = [...pane.querySelectorAll(".step-card")];
    const over = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (over) targetIndex = Number(over.dataset.index);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    card.classList.remove("dragging");
    if (targetIndex !== fromIndex) {
      snapshot();
      const [moved] = tutorial.steps.splice(fromIndex, 1);
      tutorial.steps.splice(targetIndex, 0, moved);
      tutorial.steps.forEach((s, i) => { s.number = i + 1; });
      current = targetIndex;
      markDirty();
      renderAll();
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function selectStep(index) {
  current = Math.max(0, Math.min(index, tutorial.steps.length - 1));
  selectedAnnotationId = null;
  renderAll();
}

function renderProps() {
  const step = currentStep();
  if (!step) {
    els.propNumber.textContent = "–";
    els.propDescription.value = "";
    els.propUrl.value = "";
    els.shotInfo.textContent = "–";
    return;
  }
  els.propNumber.textContent = String(step.number);
  els.propDescription.value = step.description || "";
  els.propUrl.value = step.url || "";
  const shot = step.screenshot || {};
  els.shotInfo.textContent = shot.image
    ? `${shot.width || "?"} × ${shot.height || "?"} css px · ${(shot.image.length / 1024).toFixed(0)} KB`
    : "No screenshot";
}

function renderStyleBar() {
  els.swatches.innerHTML = "";
  COLORS.forEach((color) => {
    const sw = document.createElement("button");
    sw.className = "swatch" + (color === style.color ? " active" : "");
    sw.style.background = color;
    sw.title = color;
    sw.addEventListener("click", () => { style.color = color; renderStyleBar(); });
    els.swatches.appendChild(sw);
  });
  els.presets.innerHTML = "";
  for (const preset of settings.annotationPresets || []) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = preset.name;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.addEventListener("click", async () => {
      settings.annotationPresets = settings.annotationPresets.filter((p) => p.name !== preset.name);
      await bgCall({ type: "SAVE_SETTINGS", patch: { annotationPresets: settings.annotationPresets } });
      renderStyleBar();
    });
    chip.appendChild(x);
    chip.addEventListener("click", (e) => {
      if (e.target === x) return;
      Object.assign(style, preset.style);
      syncStyleInputs();
    });
    els.presets.appendChild(chip);
  }
}

function syncStyleInputs() {
  document.getElementById("style-stroke").value = String(style.strokeWidth);
  document.getElementById("style-opacity").value = String(Math.round(style.opacity * 100));
  document.getElementById("style-blur").value = String(style.blur);
  document.getElementById("style-font").value = String(style.fontSize);
  renderStyleBar();
}

function renderAll() {
  renderStepList();
  renderCanvas().catch((e) => console.error(e));
  renderProps();
}

els.propDescription.addEventListener("input", () => {
  const step = currentStep();
  if (!step) return;
  step.description = els.propDescription.value;
  const card = els.stepList.children[current];
  if (card) card.querySelector(".desc").textContent = step.description || "(no description)";
  markDirty();
});

els.title.addEventListener("input", () => {
  tutorial.title = els.title.value || "Untitled tutorial";
  markDirty();
});

document.querySelectorAll(".tool").forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = btn.dataset.tool;
    cropMode = false;
    crop = null;
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b === btn));
    els.canvas.classList.toggle("selecting", tool !== "select");
    syncCropBar();
    renderCanvas();
  });
});
document.querySelector('.tool[data-tool="select"]').classList.add("active");

document.getElementById("style-stroke").addEventListener("input", (e) => { style.strokeWidth = Number(e.target.value); });
document.getElementById("style-opacity").addEventListener("input", (e) => { style.opacity = Number(e.target.value) / 100; });
document.getElementById("style-blur").addEventListener("input", (e) => { style.blur = Number(e.target.value); });
document.getElementById("style-font").addEventListener("input", (e) => { style.fontSize = Number(e.target.value); });

document.getElementById("btn-save-preset").addEventListener("click", async () => {
  const name = prompt("Preset name:", "My style");
  if (!name) return;
  settings.annotationPresets = [...(settings.annotationPresets || []), {
    name: name.slice(0, 40),
    style: { ...style }
  }];
  await bgCall({ type: "SAVE_SETTINGS", patch: { annotationPresets: settings.annotationPresets } });
  renderStyleBar();
});

document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);
document.getElementById("btn-delete-annotation").addEventListener("click", deleteSelectedAnnotation);

function deleteSelectedAnnotation() {
  const step = currentStep();
  if (!step || !selectedAnnotationId) return;
  snapshot();
  step.annotations = step.annotations.filter((a) => a.id !== selectedAnnotationId);
  selectedAnnotationId = null;
  markDirty();
  renderCanvas();
}

function copySelectedAnnotation() {
  const step = currentStep();
  if (!step || !selectedAnnotationId) return;
  const a = step.annotations.find((x) => x.id === selectedAnnotationId);
  if (!a) return;
  clipboardAnnotation = JSON.parse(JSON.stringify(a));
  els.saveState.textContent = "Copied ✓";
  setTimeout(() => { if (!dirty && els.saveState.textContent === "Copied ✓") els.saveState.textContent = ""; }, 1400);
}

function pasteAnnotation() {
  const step = currentStep();
  if (!step || !clipboardAnnotation) return;
  snapshot();
  const copy = JSON.parse(JSON.stringify(clipboardAnnotation));
  copy.id = makeId("ann");
  copy.x += 14; copy.y += 14;
  if (copy.x2 != null) { copy.x2 += 14; copy.y2 += 14; }
  if (copy.type === "marker") copy.number = step.annotations.filter((x) => x.type === "marker").length + 1;
  step.annotations.push(copy);
  selectedAnnotationId = copy.id;
  markDirty();
  renderCanvas();
}

function shortcutsHelpText() {
  const map = settings.editorShortcuts || {};
  return "Editor shortcuts\n" + Object.entries(map)
    .map(([action, combo]) => `${combo || "—"} — ${action}`)
    .join("\n");
}

document.getElementById("btn-copy-annotation").addEventListener("click", copySelectedAnnotation);
document.getElementById("btn-paste-annotation").addEventListener("click", pasteAnnotation);

document.getElementById("btn-add-step").addEventListener("click", () => {
  snapshot();
  const step = currentStep();
  tutorial.steps.splice(current + 1, 0, {
    id: makeId("step"),
    number: current + 2,
    action: "NOTE",
    description: "New step — describe it here.",
    url: step ? step.url : "",
    target: null,
    screenshot: { image: "", width: 0, height: 0, timestamp: Date.now(), status: "PENDING" },
    annotations: []
  });
  tutorial.steps.forEach((s, i) => { s.number = i + 1; });
  current = current + 1;
  markDirty();
  renderAll();
});

document.getElementById("btn-duplicate").addEventListener("click", () => {
  const step = currentStep();
  if (!step) return;
  snapshot();
  const copy = JSON.parse(JSON.stringify(step));
  copy.id = makeId("step");
  copy.description = `${step.description} (copy)`;
  copy.annotations.forEach((a) => { a.id = makeId("ann"); });
  tutorial.steps.splice(current + 1, 0, copy);
  tutorial.steps.forEach((s, i) => { s.number = i + 1; });
  current += 1;
  markDirty();
  renderAll();
});

document.getElementById("btn-delete-step").addEventListener("click", () => {
  if (tutorial.steps.length <= 1) { alert("A tutorial needs at least one step."); return; }
  snapshot();
  tutorial.steps.splice(current, 1);
  tutorial.steps.forEach((s, i) => { s.number = i + 1; });
  current = Math.max(0, Math.min(current, tutorial.steps.length - 1));
  markDirty();
  renderAll();
});

document.getElementById("btn-merge").addEventListener("click", () => {
  if (current >= tutorial.steps.length - 1) { alert("No next step to merge."); return; }
  snapshot();
  const a = tutorial.steps[current];
  const b = tutorial.steps[current + 1];
  a.description = [a.description, b.description].filter(Boolean).join(" — ");
  a.annotations = [...a.annotations, ...b.annotations];
  tutorial.steps.splice(current + 1, 1);
  tutorial.steps.forEach((s, i) => { s.number = i + 1; });
  markDirty();
  renderAll();
});

document.getElementById("btn-split").addEventListener("click", () => {
  const step = currentStep();
  if (!step) return;
  const k = selectedAnnotationId ? step.annotations.findIndex((a) => a.id === selectedAnnotationId) : Math.ceil(step.annotations.length / 2);
  snapshot();
  const part1 = step.annotations.slice(0, Math.max(0, k));
  const part2 = step.annotations.slice(Math.max(0, k));
  const second = {
    ...JSON.parse(JSON.stringify(step)),
    id: makeId("step"),
    annotations: part2.map((a) => ({ ...a, id: makeId("ann") }))
  };
  step.annotations = part1;
  step.description = `${step.description} (part 1)`;
  second.description = `${step.description.replace(" (part 1)", "")} (part 2)`;
  tutorial.steps.splice(current + 1, 0, second);
  tutorial.steps.forEach((s, i) => { s.number = i + 1; });
  markDirty();
  renderAll();
});

const cropBtn = document.getElementById("btn-crop");
cropBtn.addEventListener("click", () => {
  cropMode = !cropMode;
  crop = null;
  if (cropMode) {
    tool = "crop";
    els.canvas.classList.add("selecting");
    document.querySelectorAll(".tool").forEach((b) => b.classList.remove("active"));
    cropBtn.classList.add("active");
  } else {
    exitCropMode();
  }
  syncCropBar();
  renderCanvas();
});
els.cropApply.addEventListener("click", applyCrop);
els.cropCancel.addEventListener("click", cancelCrop);

async function recapture(mode) {
  const step = currentStep();
  if (!step || !step.url) { alert("This step has no page URL to recapture."); return; }
  els.saveState.textContent = "Recapturing…";
  try {
    const res = await bgCall({ type: "RECAPTURE", url: step.url, mode });
    snapshot();
    step.screenshot.image = res.screenshot.image;
    step.screenshot.width = res.screenshot.width;
    step.screenshot.height = res.screenshot.height;
    markDirty();
    await save();
    renderAll();
  } catch (e) {
    alert(`Recapture failed: ${e.message}`);
    els.saveState.textContent = "";
  }
}
document.getElementById("btn-recapture-viewport").addEventListener("click", () => recapture("viewport"));
document.getElementById("btn-recapture-full").addEventListener("click", () => recapture("full"));

document.getElementById("btn-preview").addEventListener("click", async () => {
  await save();
  location.href = `preview.html?id=${encodeURIComponent(tutorial.id)}`;
});
document.getElementById("btn-dashboard").addEventListener("click", () => {
  location.href = "dashboard.html";
});

const exportBtn = document.getElementById("btn-export");
const exportMenu = document.getElementById("export-menu");
exportBtn.addEventListener("click", () => exportMenu.classList.toggle("hidden"));
document.addEventListener("click", (e) => {
  if (!exportMenu.contains(e.target) && e.target !== exportBtn) exportMenu.classList.add("hidden");
});
exportMenu.addEventListener("click", async (e) => {
  const kind = e.target.dataset && e.target.dataset.kind;
  if (!kind) return;
  exportMenu.classList.add("hidden");
  await save();
  try {
    await exportTutorial(tutorial, kind, {
      selectedStepIndex: current,
      gifFrameDelayMs: settings.gifFrameDelayMs || 500,
      gifMaxWidth: 800
    });
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
});

window.addEventListener("keydown", (e) => {
  const target = e.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  const combo = normalizeCombo([
    e.ctrlKey || e.metaKey ? "Ctrl" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    e.key.length === 1 ? e.key : e.key
  ].filter(Boolean).join("+"));
  const shortcuts = settings.editorShortcuts || {};
  for (const [action, comboDef] of Object.entries(shortcuts)) {
    if (normalizeCombo(comboDef) !== combo) continue;
    if (typing && !combo.startsWith("Ctrl")) return;
    e.preventDefault();
    if (action === "undo") undo();
    else if (action === "redo") redo();
    else if (action === "save") save();
    else if (action === "deleteStep") document.getElementById("btn-delete-step").click();
    else if (action === "duplicateStep") document.getElementById("btn-duplicate").click();
    else if (action === "mergeStep") document.getElementById("btn-merge").click();
    else if (action === "splitStep") document.getElementById("btn-split").click();
    else if (action === "addStep") document.getElementById("btn-add-step").click();
    else if (action === "nextStep") selectStep(current + 1);
    else if (action === "prevStep") selectStep(current - 1);
    else if (action === "deselect") { selectedAnnotationId = null; renderCanvas(); }
    else if (action === "export") exportMenu.classList.toggle("hidden");
    else if (action === "dashboard") location.href = "dashboard.html";
    else if (action === "copyAnnotation") copySelectedAnnotation();
    else if (action === "pasteAnnotation") pasteAnnotation();
    else if (action === "preview") document.getElementById("btn-preview").click();
    else if (action === "shortcuts") alert(shortcutsHelpText());
    return;
  }
  if (!typing && cropMode) {
    if (e.key === "Enter") { e.preventDefault(); applyCrop(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelCrop(); }
    return;
  }
  if (!typing && e.key === "Delete" && selectedAnnotationId) deleteSelectedAnnotation();
  if (!typing && (e.key === "v" || e.key === "V")) {
    const btn = document.querySelector('.tool[data-tool="select"]');
    if (btn) btn.click();
  }
  if (!typing && /^([1-9])$/.test(e.key)) {
    const tools = ["highlight", "rectangle", "circle", "arrow", "text", "blur", "redaction", "spotlight", "marker"];
    const t = tools[Number(e.key) - 1];
    const btn = document.querySelector(`.tool[data-tool="${t}"]`);
    if (btn) btn.click();
  }
});

window.addEventListener("resize", () => renderCanvas().catch(() => {}));

(async () => {
  if (!tutorialId) { document.body.innerHTML = "<p style='padding:40px'>Open the editor from the dashboard.</p>"; return; }
  try {
    settings = (await bgCall({ type: "GET_SETTINGS" })).settings;
    const res = await bgCall({ type: "GET_TUTORIAL", id: tutorialId });
    tutorial = res.tutorial;
    tutorial.steps = tutorial.steps || [];
    // Repair legacy geometry (v2.0.6 saved rects with stale x2/y2 and arrows
    // with missing w/h) so selection and handles work on old tutorials.
    tutorial.steps.forEach((s) => (s.annotations || []).forEach(syncGeom));
    els.title.value = tutorial.title;
    syncStyleInputs();
    renderAll();
    const mins = Math.round((tutorial.durationMs || 0) / 60000);
    document.title = `${tutorial.title} — Editor`;
    void mins; void formatDuration;
  } catch (e) {
    console.error("[BTR] editor boot failed:", e);
    els.saveState.textContent = "Load failed — reopen this page";
    els.saveState.style.color = "#d93025";
  }
})();
