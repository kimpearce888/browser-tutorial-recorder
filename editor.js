import { bgCall } from "./common-ui.js";
import { makeId, formatDuration } from "./shared.js";
import { exportTutorial, drawAnnotations } from "./exporter.js";
import { getSettings, normalizeCombo, onSettingsChanged } from "./settings-store.js";
import {
  RECT_TYPES, syncGeom, annotationHit, handlesAt, rotateHandlePos, rotateAround, cropRemap,
  viewerScale, VIEWER_MAX_ZOOM, VIEWER_MIN_ZOOM,
  cropRect, cropHandlePositions, cropHitTest, applyCropDrag, CROP_HANDLES,
  nextMarkerNumber
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
  cropCancel: document.getElementById("btn-crop-cancel"),
  cropDims: document.getElementById("crop-dims"),
  markerNum: document.getElementById("style-marker-num"),
  zoomBar: document.getElementById("zoom-bar"),
  zoomOut: document.getElementById("btn-zoom-out"),
  zoomIn: document.getElementById("btn-zoom-in"),
  zoomLabel: document.getElementById("btn-zoom-label"),
  zoomFitWidth: document.getElementById("btn-zoom-fit-width"),
  zoomFitPage: document.getElementById("btn-zoom-fit-page")
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
// Viewer zoom state. "fit" = fit width (the professional default: a long
// full-page capture fills the pane's width and scrolls vertically instead
// of shrinking into an unrecognizable strip), "page" = whole page in the
// pane, "custom" = explicit zoom factor around natural size.
let zoom = { mode: "fit", factor: 1 };
let drag = null;
let cropMode = false;
let crop = null;
let clipboardAnnotation = null;
let imgCache = { key: "", image: null };
let lastNudgeAt = 0;
// Numbered markers run sequentially across the WHOLE tutorial (never
// restarting at 1 in every step). null = auto (highest existing + 1);
// a number here is the user's explicit "next #" choice.
let markerNext = null;

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

// Single source of truth for switching tools: keeps the toolbar's active
// state, the canvas cursor class and crop mode in sync (the old inline
// tool-bar handler drifted from the crop button and the keyboard paths).
function setTool(name) {
  tool = name;
  cropMode = false;
  crop = null;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  els.canvas.classList.toggle("selecting", name !== "select");
  syncCropBar();
}

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
  const wrapW = Math.max(1, els.canvasWrap.clientWidth - 32);
  const wrapH = Math.max(1, els.canvasWrap.clientHeight - 32);
  const scale = viewerScale({
    mode: zoom.mode, factor: zoom.factor,
    natW: image.naturalWidth, natH: image.naturalHeight,
    wrapW, wrapH
  });
  display.image = image;
  display.scale = scale;
  display.imgScale = step.screenshot.width > 0 ? image.naturalWidth / step.screenshot.width : 1;
  els.canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  els.canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  ctx.drawImage(image, 0, 0, els.canvas.width, els.canvas.height);
  ctx.canvas.__btrImage = image;
  drawAnnotations(ctx, step.annotations, scale);
  if (selectedAnnotationId && !cropMode) {
    const a = step.annotations.find((x) => x.id === selectedAnnotationId);
    if (a) drawSelectionUI(ctx, a, scale);
  }
  if (cropMode && crop) drawCropOverlay(ctx, scale);
  syncZoomBar();
}

// ----------------------------------------------------------------
// Viewer zoom — fit width (default) / fit page / explicit zoom with
// buttons, Ctrl+wheel and Ctrl+= / Ctrl+- / Ctrl+0.
// ----------------------------------------------------------------
function syncZoomBar() {
  if (!els.zoomLabel) return;
  els.zoomLabel.textContent = `${Math.round(display.scale * 100)}%`;
  els.zoomFitWidth.classList.toggle("active", zoom.mode === "fit");
  els.zoomFitPage.classList.toggle("active", zoom.mode === "page");
}

function zoomTo(mode, factor = 1) {
  zoom = { mode, factor };
  renderCanvas().catch(() => {});
}

function zoomBy(ratio, anchor) {
  const next = Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, display.scale * ratio));
  if (Math.abs(next - display.scale) < 0.001) return;
  const wrap = els.canvasWrap;
  const canvas = els.canvas;
  // Keep the point under the cursor anchored while zooming (margin-auto
  // centering included via offsetLeft/Top).
  const imgX = anchor ? (wrap.scrollLeft + anchor.x - canvas.offsetLeft) / Math.max(1e-6, display.scale) : null;
  const imgY = anchor ? (wrap.scrollTop + anchor.y - canvas.offsetTop) / Math.max(1e-6, display.scale) : null;
  zoom = { mode: "custom", factor: next };
  renderCanvas().then(() => {
    if (imgX == null) return;
    wrap.scrollLeft = Math.max(0, imgX * next + canvas.offsetLeft - anchor.x);
    wrap.scrollTop = Math.max(0, imgY * next + canvas.offsetTop - anchor.y);
  }).catch(() => {});
}

els.zoomOut.addEventListener("click", () => zoomBy(1 / 1.25));
els.zoomIn.addEventListener("click", () => zoomBy(1.25));
els.zoomLabel.addEventListener("click", () => zoomTo("custom", 1));
els.zoomFitWidth.addEventListener("click", () => zoomTo("fit"));
els.zoomFitPage.addEventListener("click", () => zoomTo("page"));
els.canvasWrap.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect = els.canvasWrap.getBoundingClientRect();
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX - rect.left, y: e.clientY - rect.top });
}, { passive: false });

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
  const r = cropRect(crop);
  const x1 = r.x * fit, y1 = r.y * fit, w = r.w * fit, h = r.h * fit;
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
  // Rule-of-thirds guide lines, like every serious crop tool.
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(x1 + (w * i) / 3, y1);
    ctx.lineTo(x1 + (w * i) / 3, y1 + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1 + (h * i) / 3);
    ctx.lineTo(x1 + w, y1 + (h * i) / 3);
    ctx.stroke();
  }
  // 8 resize handles (corners + edges) — screen-constant size.
  const handles = cropHandlePositions(crop);
  const hs = Math.max(3.5, Math.min(6, 5 / (fit || 1)));
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#1a73e8";
  ctx.lineWidth = 1.5;
  for (const key of CROP_HANDLES) {
    const [hx, hy] = handles[key];
    ctx.beginPath();
    ctx.rect(hx * fit - hs, hy * fit - hs, hs * 2, hs * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Dimension readout on a pill above the marquee (inside when clipped).
  const label = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  ctx.font = "600 11px system-ui, sans-serif";
  const tw = ctx.measureText(label).width;
  const padX = 7, padY = 5, pillW = tw + padX * 2, pillH = 11 + padY * 2;
  let lx = x1, ly = y1 - pillH - 6;
  if (ly < 2) ly = y1 + 6;
  if (lx + pillW > W - 2) lx = Math.max(2, W - 2 - pillW);
  ctx.fillStyle = "rgba(21,22,26,0.92)";
  ctx.beginPath();
  ctx.roundRect(lx, ly, pillW, pillH, 6);
  ctx.fill();
  ctx.fillStyle = "#ffd23f";
  ctx.textBaseline = "middle";
  ctx.fillText(label, lx + padX, ly + pillH / 2 + 0.5);
  ctx.restore();
}

function canvasPoint(e) {
  // Map the pointer into NATURAL IMAGE pixels — the single coordinate space
  // annotations are stored in. Drawing goes through drawAnnotations' fit
  // scale, hit-testing compares raw stored coords, and the crop overlay and
  // text input all derive from this point, so every consumer stays consistent.
  // The old version returned element/bitmap px while rendering multiplied by
  // fit AGAIN: on any screenshot larger than the pane (fit < 1 — nearly
  // always) every shape drew offset from its click, selection missed the
  // visible shape, the rotate handle was ungrabbable and the crop marquee
  // cropped the wrong region.
  const rect = els.canvas.getBoundingClientRect();
  const img = display.image;
  const sx = rect.width > 0 && img ? img.naturalWidth / rect.width : 1;
  const sy = rect.height > 0 && img ? img.naturalHeight / rect.height : 1;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy
  };
}

els.canvas.addEventListener("pointerdown", (e) => {
  const step = currentStep();
  if (!step || !display.image) return;
  els.canvas.setPointerCapture(e.pointerId);
  const pt = canvasPoint(e);

  if (cropMode) {
    // Standard crop-tool priority: grab a handle to resize, drag inside the
    // box to move it, drag outside to draw a fresh marquee.
    const tol = 1 / (display.scale || 1);
    const hit = crop ? cropHitTest(crop, pt, tol) : null;
    if (hit && hit !== "move") {
      drag = { kind: "crop-resize", handle: hit, orig: { ...crop } };
    } else if (hit === "move") {
      drag = { kind: "crop-move", anchor: pt, orig: { ...crop } };
    } else {
      crop = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      drag = { kind: "crop-new", anchor: pt };
    }
    renderCanvas();
    return;
  }

  if (tool === "select") {
    // Handles of the already-selected annotation win over a fresh hit test —
    // they reach slightly outside the shape, and the head/tail/rotate knobs
    // of an arrow overlap its own segment.
    // Tolerances are defined in image pixels; scale them up when the
    // screenshot is displayed smaller so handles stay equally grabbable on
    // screen at any zoom.
    const tol = 1 / (display.scale || 1);
    const sel = step.annotations.find((x) => x.id === selectedAnnotationId) || null;
    const handle = sel ? handlesAt(sel, pt, tol) : null;
    if (sel && handle === "rotate") {
      const x2 = sel.x2 == null ? sel.x : sel.x2;
      const y2 = sel.y2 == null ? sel.y : sel.y2;
      const cx = (sel.x + x2) / 2, cy = (sel.y + y2) / 2;
      drag = {
        kind: "rotate", ann: sel, orig: { ...sel }, cx, cy,
        startAngle: Math.atan2(pt.y - cy, pt.x - cx),
        startX: pt.x, startY: pt.y
      };
      renderCanvas();
      return;
    }
    if (sel && handle) {
      drag = { kind: "resize", handle, ann: sel, orig: { ...sel }, startX: pt.x, startY: pt.y };
      renderCanvas();
      return;
    }
    const a = annotationHit(step.annotations, pt, tol);
    selectedAnnotationId = a ? a.id : null;
    if (a) {
      drag = { kind: "move", ann: a, startX: pt.x, startY: pt.y, orig: { ...a } };
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
    number: 0, // resolved below for markers (tutorial-wide sequence)
    text: ""
  };
  if (tool === "text") {
    // preventDefault kills the browser's default mousedown handling for this
    // gesture — which would otherwise steal focus back from the text input we
    // are about to focus and blur it before a single character could be typed
    // (blur fired the empty commit that instantly closed the box: the
    // "text tool never worked" bug).
    e.preventDefault();
    openTextInput(pt, base);
    return;
  }
  if (tool === "marker") {
    base.number = takeMarkerNumber();
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
  // Undo snapshots are taken on the FIRST real movement, not on pointerdown:
  // clicking an annotation without dragging must not push a no-op undo state.
  if ((drag.kind === "move" || drag.kind === "resize" || drag.kind === "rotate") && !drag.snapped) {
    if (Math.hypot(pt.x - drag.startX, pt.y - drag.startY) > 2) {
      snapshot();
      drag.snapped = true;
    }
  }
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
  } else if (drag.kind === "crop-new") {
    crop = applyCropDrag(crop, "new", null, drag.anchor, pt, {
      w: display.image.naturalWidth, h: display.image.naturalHeight
    });
  } else if (drag.kind === "crop-move") {
    crop = applyCropDrag(drag.orig, "move", null, drag.anchor, pt, {
      w: display.image.naturalWidth, h: display.image.naturalHeight
    });
  } else if (drag.kind === "crop-resize") {
    crop = applyCropDrag(drag.orig, "resize", drag.handle, null, pt, {
      w: display.image.naturalWidth, h: display.image.naturalHeight
    });
  }
  renderCanvas();
});

els.canvas.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const kind = drag.kind;
  const pt = canvasPoint(e);
  if (kind === "draw") {
    const a = drag.ann;
    // Thresholds are screen px; convert to image px so a plain click on a
    // heavily scaled-down screenshot still counts as a click.
    const tinyPx = 4 / (display.scale || 1);
    const tiny = a.type === "arrow"
      ? Math.hypot((a.x2 == null ? a.x : a.x2) - a.x, (a.y2 == null ? a.y : a.y2) - a.y) < tinyPx
      : (a.w < tinyPx && a.h < tinyPx);
    if (tiny) {
      const step = currentStep();
      step.annotations = step.annotations.filter((x) => x.id !== a.id);
      if (selectedAnnotationId === a.id) selectedAnnotationId = null;
      undoStack.pop();
    } else {
      // Professional editors snap back to Select after every draw so the
      // next drag moves the shape instead of spawning an accidental twin.
      setTool("select");
    }
    markDirty();
  } else if (kind === "move" || kind === "resize" || kind === "rotate") {
    markDirty();
  } else if (kind === "crop-new") {
    crop = applyCropDrag(crop, "new", null, drag.anchor, pt, {
      w: display.image.naturalWidth, h: display.image.naturalHeight
    });
    // An accidental click without a real drag clears the marquee instead of
    // committing a degenerate crop region.
    const minPx = 8 / (display.scale || 1);
    if (Math.abs(crop.x2 - crop.x1) < minPx || Math.abs(crop.y2 - crop.y1) < minPx) crop = null;
    syncCropBar();
  } else if (kind === "crop-move" || kind === "crop-resize") {
    syncCropBar();
  }
  drag = null;
  renderCanvas();
});

// Hover feedback for the crop tool: the cursor tells you what a press will
// do (resize by direction, move inside the box, draw a fresh one outside).
const CROP_CURSORS = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize"
};
els.canvas.addEventListener("pointermove", (e) => {
  if (drag || !cropMode) return;
  const step = currentStep();
  if (!step || !display.image) return;
  const hit = crop ? cropHitTest(crop, canvasPoint(e), 1 / (display.scale || 1)) : null;
  els.canvas.style.cursor = hit === "move" ? "move" : (hit && CROP_CURSORS[hit]) || "crosshair";
});
els.canvas.addEventListener("pointerleave", () => {
  if (cropMode && !drag) els.canvas.style.cursor = "crosshair";
});

// Only one text box may exist at a time; its finisher is stored here so a
// second canvas click COMMITS the first box instead of stacking a second set
// of keydown/blur listeners on the same input (which committed duplicates).
let closeTextInput = null;

function openTextInput(pt, ann) {
  if (closeTextInput) closeTextInput();
  const input = els.textInput;
  input.classList.remove("hidden");
  // Map the natural-image point through the LIVE displayed size so the input
  // sits exactly on the click, whatever the current zoom / CSS shrinking is.
  const rect = els.canvas.getBoundingClientRect();
  const img = display.image;
  const ratio = rect.width > 0 && img ? rect.width / img.naturalWidth : display.scale;
  input.style.left = `${els.canvas.offsetLeft + pt.x * ratio}px`;
  input.style.top = `${els.canvas.offsetTop + pt.y * ratio}px`;
  input.value = "";
  input.focus();
  // Belt for engines that settle focus asynchronously.
  setTimeout(() => { if (closeTextInput) input.focus(); }, 0);
  const finish = (commitValue) => {
    if (!closeTextInput) return;
    closeTextInput = null;
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    const text = commitValue ? input.value.trim() : "";
    input.classList.add("hidden");
    if (text) {
      const lines = text.split("\n");
      ann.text = text;
      ann.w = Math.max(40, ...lines.map((l) => l.length * ann.fontSize * 0.62));
      ann.h = Math.max(ann.fontSize * 1.4, lines.length * ann.fontSize * 1.4);
      const step = currentStep();
      if (step && !step.annotations.some((x) => x.id === ann.id)) {
        snapshot(); // undo restores the state WITHOUT the new text
        step.annotations.push(ann);
        markDirty();
      }
    }
    // Professional editors drop back to Select after inserting text so the
    // next drag moves the new label instead of spawning another one.
    setTool("select");
    renderCanvas();
  };
  const onKey = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); input.value = ""; finish(false); }
  };
  const onBlur = () => finish(true);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
  closeTextInput = () => finish(true);
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
  if (els.cropDims) {
    if (crop) {
      const r = cropRect(crop);
      els.cropDims.textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px`;
    } else {
      els.cropDims.textContent = "";
    }
  }
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
  // Crop coords are natural image pixels (the same space annotations live
  // in), so the bitmap source rect IS the coords — no extra scaling.
  const imgScale = display.imgScale || 1;
  const nx1 = Math.max(0, Math.round(Math.min(crop.x1, crop.x2)));
  const ny1 = Math.max(0, Math.round(Math.min(crop.y1, crop.y2)));
  const nx2 = Math.min(display.image.naturalWidth, Math.round(Math.max(crop.x1, crop.x2)));
  const ny2 = Math.min(display.image.naturalHeight, Math.round(Math.max(crop.y1, crop.y2)));
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
  // Annotations move with the image (offset in natural pixels, matching the
  // space they are stored in); ones left fully outside the crop are dropped
  // instead of lingering at negative coordinates.
  step.annotations = cropRemap(step.annotations, nx1, ny1, w, h);
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
  // A long full-page capture can leave the viewer scrolled deep into the
  // previous step — every step switch starts at the top, like any standard
  // document viewer. (Undo/redo and annotation edits deliberately keep the
  // scroll position.)
  els.canvasWrap.scrollTop = 0;
  els.canvasWrap.scrollLeft = 0;
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
    ? `${shot.width || "?"} × ${shot.height || "?"} css px · ${(shot.image.length / 1024).toFixed(0)} KB${shot.crop ? " · cropped to action" : ""}`
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
  syncMarkerNumInput();
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
    setTool(btn.dataset.tool);
    renderCanvas();
  });
});
document.querySelector('.tool[data-tool="select"]').classList.add("active");

document.getElementById("style-stroke").addEventListener("input", (e) => { style.strokeWidth = Number(e.target.value); });
document.getElementById("style-opacity").addEventListener("input", (e) => { style.opacity = Number(e.target.value) / 100; });
document.getElementById("style-blur").addEventListener("input", (e) => { style.blur = Number(e.target.value); });
document.getElementById("style-font").addEventListener("input", (e) => { style.fontSize = Number(e.target.value); });

// "Next #" control for numbered markers: typing a number pins the next
// marker number; clearing the field returns to auto (highest existing + 1).
els.markerNum.addEventListener("input", (e) => {
  const v = parseInt(e.target.value, 10);
  markerNext = Number.isFinite(v) && v >= 1 ? v : null;
});
els.markerNum.addEventListener("keydown", (e) => {
  // Enter commits and blurs; do not let the global shortcut loop eat it.
  if (e.key === "Enter") e.target.blur();
  e.stopPropagation();
});

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
  if (copy.type === "marker") copy.number = takeMarkerNumber();
  step.annotations.push(copy);
  selectedAnnotationId = copy.id;
  markDirty();
  renderCanvas();
}

// ----------------------------------------------------------------
// Numbered markers: the sequence runs across the WHOLE tutorial
// (Scribe-style), and the "Next #" field gives explicit control —
// type a number to restart the series from there; empty = auto.
// ----------------------------------------------------------------
function takeMarkerNumber() {
  const n = markerNext != null ? markerNext : nextMarkerNumber(tutorial.steps);
  markerNext = n + 1;
  syncMarkerNumInput();
  return n;
}

function syncMarkerNumInput() {
  if (!els.markerNum || !tutorial) return;
  els.markerNum.value = String(markerNext != null ? markerNext : nextMarkerNumber(tutorial.steps));
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
    // The fresh shot covers the full viewport / full page — a stored element
    // crop from record time no longer matches it.
    delete step.screenshot.crop;
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
  // Crop mode keys win over everything (the shortcut loop would otherwise
  // eat Escape for the deselect action and the crop could never be cancelled).
  if (!typing && cropMode) {
    if (e.key === "Enter") { e.preventDefault(); applyCrop(); return; }
    if (e.key === "Escape") { e.preventDefault(); cancelCrop(); return; }
  }
  // Zoom keys (Ctrl/⌘ = / - / 0), mirroring the zoom bar. "0" returns to
  // fit width — the standard "actual/fit" convention for image viewers.
  if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "0") zoomTo("fit");
    else zoomBy(e.key === "-" ? 1 / 1.25 : 1.25);
    return;
  }
  // Arrow keys nudge the selected annotation — table stakes for annotation
  // editors. One undo entry per burst, not per keypress.
  if (!typing && !cropMode && selectedAnnotationId && /^Arrow/.test(e.key)) {
    const step = currentStep();
    const a = step && step.annotations.find((x) => x.id === selectedAnnotationId);
    if (a) {
      e.preventDefault();
      // Nudge in image pixels: one screen px is 1/fit image px.
      const d = Math.max(1, Math.round((e.shiftKey ? 10 : 1) / (display.scale || 1)));
      const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
      const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      if (Date.now() - lastNudgeAt > 800) snapshot();
      lastNudgeAt = Date.now();
      a.x += dx; a.y += dy;
      if (a.x2 != null) { a.x2 += dx; a.y2 += dy; }
      syncGeom(a);
      markDirty();
      renderCanvas();
      return;
    }
  }
  const combo = normalizeCombo([
    e.ctrlKey || e.metaKey ? "Ctrl" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    // Settings captures the space bar as "Space" (settings.js), but e.key
    // here is " " — the raw forms never matched, so ANY shortcut the user
    // bound to Space (plain or Ctrl+Space) was dead. Name both sides the
    // same.
    e.key === " " ? "Space" : e.key
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
    else if (action === "deselect") {
      selectedAnnotationId = null;
      setTool("select");
      renderCanvas();
    }
    else if (action === "export") exportMenu.classList.toggle("hidden");
    else if (action === "dashboard") location.href = "dashboard.html";
    else if (action === "copyAnnotation") copySelectedAnnotation();
    else if (action === "pasteAnnotation") pasteAnnotation();
    else if (action === "preview") document.getElementById("btn-preview").click();
    else if (action === "shortcuts") alert(shortcutsHelpText());
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

// Live full-page capture progress from the service worker — "Capturing 3/8…"
// instead of a silent "Recapturing…" that could sit there for half a minute.
try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "BTR_CAPTURE_PROGRESS" && els.saveState) {
      els.saveState.textContent = `Capturing ${message.done}/${message.total}…`;
    }
    return undefined;
  });
} catch { /* extension context unavailable (tests) */ }

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
