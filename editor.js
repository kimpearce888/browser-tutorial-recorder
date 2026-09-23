import {
  $, escapeHtml, escapeAttr, sanitizeImageUrl, clone, clamp,
  dbPut, dbGet,
  ANNOTATION_DEFAULTS, ROTATABLE_TYPES, RESIZABLE_TYPES,
  canvasSize, annotationBox, withAlpha, arrowHeadPoints,
  normalizeAnnotation, normalizeTutorial
} from "./shared.js";
import { exportTutorial, loadImage } from "./exporter.js";
import { matchesShortcut, initTheme, DEFAULT_SHORTCUTS, getSettings } from "./settings-store.js";

let tutorial;
let selectedStep = 0;
let selectedAnnotation = null;
let activeTool = null;
let drawing = null;
let markersVisible = true;
let history = [];
let historyIndex = -1;
let saveTimer;
let arrowHistoryTimer;
let cropMode = false;
let clipboard = null;
let annotationPresets = [];

async function saveTutorial() {
  if (!tutorial) return;

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

async function flushPendingSave() {
  if (saveTimer && tutorial) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { await saveTutorial(); } catch (_) {}
  }
}
window.addEventListener("beforeunload", flushPendingSave);
window.addEventListener("pagehide", flushPendingSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});

let resizeRenderTimer = null;
window.addEventListener("resize", () => {
  if (!tutorial) return;
  if (resizeRenderTimer) clearTimeout(resizeRenderTimer);
  resizeRenderTimer = setTimeout(() => { renderCanvas(); }, 150);
});

function snapshotTutorial(t) {
  if (!t) return null;
  return {
    ...t,
    steps: (t.steps || []).map((s) => ({
      ...s,

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

function commit(mutator) {
  const draft = cloneWithoutScreenshots(tutorial);
  mutator(draft);
  draft.updatedAt = new Date().toISOString();
  tutorial = draft;
  pushHistory();
  render();
  scheduleSave();
}

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

  clearTimeout(arrowHistoryTimer);
  if (historyIndex <= 0) return;
  historyIndex--;
  tutorial = restoreSnapshot(history[historyIndex]);
  selectedAnnotation = null;
  render();
  scheduleSave();
}

function redo() {

  clearTimeout(arrowHistoryTimer);
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  tutorial = restoreSnapshot(history[historyIndex]);
  selectedAnnotation = null;
  render();
  scheduleSave();
}

function render() {
  if (!tutorial) return;
  if (selectedStep >= tutorial.steps.length) {
    selectedStep = Math.max(0, tutorial.steps.length - 1);
  }

  const title = tutorial.title || "Untitled tutorial";
  $("headerTitle").textContent = title;
  $("canvasTitle").textContent = title;
  $("titleInput").value = tutorial.title || "";

  const statusBtn = $("toggleStatus");
  if (statusBtn) {
    statusBtn.textContent = tutorial.status === "ready" ? "✓ Ready" : "Draft";
    statusBtn.classList.toggle("is-ready", tutorial.status === "ready");
  }

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

  const hasImage = !!step.screenshot?.image;
  $("screenshot").classList.toggle("hidden", !hasImage);

  if (hasImage) {
    $("screenshot").src = sanitizeImageUrl(step.screenshot.image);
  } else {
    $("screenshot").removeAttribute("src");
  }
  $("canvasMeta").textContent = `${size.width} × ${size.height} · ${step.screenshot?.url || "Captured page"}`;
  $("actionBadge").textContent = step.action || "ACTION";
  $("annotationCount").textContent = String(step.annotations.length);

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

    const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
    const pct = (v, fallback = 0) => { const n = Number(v); if (!Number.isFinite(n)) return fallback; return Math.max(0, Math.min(100, n)); };

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
    a.label = String(nextMarkerNumber()).slice(0, 3);
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

    copy.x = clamp(copy.x + 20, copy.width / 2, Math.max(copy.width / 2, size.width - copy.width / 2));
    copy.y = clamp(copy.y + 20, copy.height / 2, Math.max(copy.height / 2, size.height - copy.height / 2));
  } else {

    copy.x = clamp(copy.x + 20, 0, Math.max(0, size.width - copy.width));
    copy.y = clamp(copy.y + 20, 0, Math.max(0, size.height - copy.height));
  }
  step.annotations.splice(index + 1, 0, copy);
  selectedAnnotation = index + 1;
  pushHistory();
  scheduleSave();
  render();
}

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

      renderCanvas();
    }
  });
  field.addEventListener("change", () => {

    if (tutorial.steps[selectedStep]?.annotations[selectedAnnotation] != null) pushHistory();
  });

  field.addEventListener("focus", () => { field._editedAnnotation = selectedAnnotation; });
}

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

function duplicateStep() {
  const step = tutorial?.steps[selectedStep];
  if (!step) return;
  commit((t) => {

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

function setupEvents() {

  $("canvasWrap").addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;

    if ((activeTool || cropMode) && tutorial.steps[selectedStep]) {
      event.preventDefault();
      event.stopPropagation();
      startDrawing(event);
      return;
    }
    if (event.target === $("canvasWrap") || event.target === $("screenshot") || event.target === $("annotationLayer")) {

      selectedAnnotation = null;
      render();
    }
  });

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();

      if (cropMode) { cropMode = false; $("canvasWrap").classList.remove("crop-mode"); }
      activeTool = activeTool === button.dataset.tool ? null : button.dataset.tool;
      selectedAnnotation = null;
      updateToolButtons();
    };
  });

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

  $("titleInput").addEventListener("input", (event) => {
    if (!tutorial) return;
    tutorial.title = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    $("headerTitle").textContent = event.target.value || "Untitled tutorial";
    $("canvasTitle").textContent = event.target.value || "Untitled tutorial";
    scheduleSave();
  });
  $("titleInput").addEventListener("change", pushHistory);

  $("descriptionInput").addEventListener("input", (event) => {
    const step = tutorial?.steps[selectedStep];
    if (!step) return;
    step.description = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    scheduleSave();
  });
  $("descriptionInput").addEventListener("change", pushHistory);

  $("tutorialDescription")?.addEventListener("input", (event) => {
    if (!tutorial) return;
    tutorial.description = event.target.value;
    tutorial.updatedAt = new Date().toISOString();
    scheduleSave();
  });
  $("tutorialDescription")?.addEventListener("change", pushHistory);

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

  $("toggleMarkers").addEventListener("click", () => {
    markersVisible = !markersVisible;
    renderCanvas();
  });

  $("fit").addEventListener("click", () => {
    const wrap = $("canvasWrap");
    wrap.classList.toggle("fit-to-viewport");
    renderCanvas();
  });

  const propsToggle = document.querySelector(".properties-toggle");
  if (propsToggle) {
    propsToggle.addEventListener("click", () => {
      document.querySelector(".properties-panel")?.classList.toggle("open");
    });
  }

  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);

  $("preview").addEventListener("click", async () => {
    await saveTutorial();
    const popup = window.open(`preview.html?id=${encodeURIComponent(tutorial.id)}`, "_blank");
    if (!popup) alert("Allow popups to open preview.");
  });

  $("toggleStatus")?.addEventListener("click", () => {
    if (!tutorial) return;
    commit((t) => {
      t.status = t.status === "ready" ? "draft" : "ready";
    });
  });

  $("backToDashboard").addEventListener("click", async (event) => {
    event.preventDefault();
    await saveTutorial();
    location.href = "dashboard.html";
  });

  $("exportMenu").onclick = () => $("exportDialog").showModal();

  const exportCloseBtn = document.querySelector("#exportDialog .dialog-close");
  if (exportCloseBtn) exportCloseBtn.onclick = () => $("exportDialog").close();
  document.querySelectorAll("[data-export]").forEach((button) => {
    button.onclick = async () => {

      const originalText = button.innerHTML;
      button.disabled = true;
      button.style.opacity = "0.6";
      button.innerHTML = "<span>Exporting…</span>";
      try {

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

  $("import").addEventListener("click", () => $("importInput").click());
  $("importInput").onchange = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {

        const parsed = JSON.parse(reader.result);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        if (list.length === 0) { alert("No tutorials found in the file."); return; }

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
          } catch (_) {  }
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
    event.target.value = "";
  };

  document.addEventListener("keydown", (event) => {
    if (!tutorial) return;

    if ($("shortcutOverlay")) {
      if (event.key === "Escape") { $("shortcutOverlay").remove(); event.preventDefault(); }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    const tag = document.activeElement?.tagName;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);

    if (matchesShortcut(event, "save")) {
      event.preventDefault();
      saveTutorial().then(() => {

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

    if (!typing) {

      const isRedo = matchesShortcut(event, "redo") ||
        ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "y");
      if (isRedo) { event.preventDefault(); redo(); return; }
      if (matchesShortcut(event, "undo")) { event.preventDefault(); undo(); return; }
    }
    if (typing) return;
    if (matchesShortcut(event, "backToDashboard")) { event.preventDefault(); $("backToDashboard").click(); return; }

    if (matchesShortcut(event, "preview")) { event.preventDefault(); $("preview").click(); return; }
    if (matchesShortcut(event, "exportMenu")) { event.preventDefault(); $("exportMenu").click(); return; }
    if (matchesShortcut(event, "showShortcuts")) { event.preventDefault(); showShortcutCheatSheet(); return; }
    if (matchesShortcut(event, "copyAnnotation")) { event.preventDefault(); copyAnnotation(); return; }
    if (matchesShortcut(event, "pasteAnnotation")) { event.preventDefault(); pasteAnnotation(); return; }
    if (matchesShortcut(event, "mergeNext")) { event.preventDefault(); mergeWithNextStep(selectedStep); return; }
    if (matchesShortcut(event, "splitStep")) { event.preventDefault(); splitStep(selectedStep); return; }

    if (matchesShortcut(event, "newStep")) { event.preventDefault(); addStep(); return; }
    if (matchesShortcut(event, "duplicateStep")) { event.preventDefault(); duplicateStep(); return; }
    if (matchesShortcut(event, "deleteStep")) { event.preventDefault(); deleteStep(); return; }
    if (matchesShortcut(event, "deselect")) {
      event.preventDefault();

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

      clearTimeout(arrowHistoryTimer);
      arrowHistoryTimer = setTimeout(() => { pushHistory(); }, 400);
      scheduleSave();
      render();
    }
  });
}

function loadPresets() {
  try {
    const raw = localStorage.getItem("btr-annotation-presets");
    const parsed = raw ? JSON.parse(raw) : [];

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

function applyPreset(idx) {
  const preset = annotationPresets[idx];
  if (!preset) return;

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
  const cropStepIndex = selectedStep;
  const step = tutorial.steps[cropStepIndex];
  if (!step?.screenshot?.image || !rect) { render(); return; }
  try {
    const image = await loadImage(step.screenshot.image);
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
      const s = t.steps[cropStepIndex];
      s.screenshot.image = canvas.toDataURL("image/png");
      s.screenshot.width = canvas.width;
      s.screenshot.height = canvas.height;

      s.annotations = s.annotations.filter((a) => {
        const box = annotationBox(a);

        return box.x < rect.x + rect.width &&
               box.x + box.width > rect.x &&
               box.y < rect.y + rect.height &&
               box.y + box.height > rect.y;
      }).map((a) => {
        const box = annotationBox(a);

        const clampedX = Math.max(rect.x, box.x);
        const clampedY = Math.max(rect.y, box.y);
        const clampedRight = Math.min(rect.x + rect.width, box.x + box.width);
        const clampedBottom = Math.min(rect.y + rect.height, box.y + box.height);
        const nx = clampedX - rect.x;
        const ny = clampedY - rect.y;
        if (a.type === "marker") {

          const newCenterX = a.x - rect.x;
          const newCenterY = a.y - rect.y;
          a.x = Math.max(a.width / 2, Math.min(newCenterX, rect.width - a.width / 2));
          a.y = Math.max(a.height / 2, Math.min(newCenterY, rect.height - a.height / 2));
        } else if (a.type === "arrow") {

          const oldBox = annotationBox(a);
          const startAbsX = oldBox.x + (a.startX / 100) * oldBox.width;
          const startAbsY = oldBox.y + (a.startY / 100) * oldBox.height;
          const endAbsX = oldBox.x + (a.endX / 100) * oldBox.width;
          const endAbsY = oldBox.y + (a.endY / 100) * oldBox.height;

          a.x = nx;
          a.y = ny;
          a.width = Math.max(8, clampedRight - clampedX);
          a.height = Math.max(8, clampedBottom - clampedY);

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

function pickTab(tabs) {
  return new Promise((resolve) => {

    const existing = document.getElementById("tabPickerDialog");
    if (existing) existing.remove();

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

      try { previouslyFocused?.focus?.(); } catch (e) {}
      resolve(null);
    };
    closeBtn.onclick = close;
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

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

    const tabs = await chrome.tabs.query({});

    const capturable = tabs.filter((t) => t.url && !/^(chrome|edge|about|devtools|chrome-extension|chrome-untrusted|file|moz-extension|extension):/i.test(t.url));
    if (!capturable.length) {
      alert("No capturable tabs found. Open a webpage first, then try again.");
      return;
    }

    const targetTab = await pickTab(capturable);
    if (!targetTab) return;

    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_FULL_PAGE", tabId: targetTab.id });
    if (!response?.ok || !response.captures?.length) {
      alert(response?.error || response?.captureError || "Full-page capture failed.");
      return;
    }

    if (response.captureError) {
      alert(response.captureError);
      return;
    }

    if (response.truncated) {
      if (!confirm("This page is too long to capture in full. The capture will contain only the first ~100,000 pixels of the page. Continue?")) {
        return;
      }
    }

    const widths = [];
    let viewportHeight = response.captures[0]?.viewportHeight || 0;

    const firstImg = await loadImage(response.captures[0].image);
    widths.push(firstImg.naturalWidth);
    if (!viewportHeight) viewportHeight = firstImg.naturalHeight;
    const width = firstImg.naturalWidth;

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

    const MAX_CANVAS_HEIGHT = 32767;
    const MAX_CANVAS_AREA = 268435456;
    let finalWidth = width;
    let finalHeight = totalHeight;
    if (finalHeight > MAX_CANVAS_HEIGHT || finalWidth * finalHeight > MAX_CANVAS_AREA) {
      const scale = Math.min(MAX_CANVAS_HEIGHT / finalHeight, Math.sqrt(MAX_CANVAS_AREA / (finalWidth * finalHeight)));
      finalWidth = Math.round(finalWidth * scale);
      finalHeight = Math.round(finalHeight * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    const ctx = canvas.getContext("2d");
    const drawScale = finalWidth / width;
    let y = 0;

    for (let i = 0; i < response.captures.length; i++) {
      const { sourceY, sourceH } = sourceRects[i];
      if (sourceH <= 0) continue;
      const img = i === 0 ? firstImg : await loadImage(response.captures[i].image);
      const drawW = img.naturalWidth * drawScale;
      const drawH = sourceH * drawScale;
      ctx.drawImage(img, 0, sourceY, img.naturalWidth, sourceH, 0, y, drawW, drawH);
      y += drawH;
    }

    const nestedEntries = Array.isArray(response.nestedCaptures) ? response.nestedCaptures : [];
    if (nestedEntries.length > 0) {

      const nestedStitchedPanels = [];
      for (const entry of nestedEntries) {
        if (!entry?.captures?.length || !entry?.rect) continue;
        try {

          const firstNestedImg = await loadImage(entry.captures[0].image);
          const scrollerRect = entry.rect;
          const mainImg = firstImg;
          const viewportWidthCss = viewportHeight * mainImg.naturalWidth / mainImg.naturalHeight;
          const ratioX = mainImg.naturalWidth / viewportWidthCss;
          const ratioY = mainImg.naturalHeight / viewportHeight;
          const cropX = Math.round(scrollerRect.x * ratioX);
          const cropY = Math.round(scrollerRect.y * ratioY);
          const cropW = Math.max(1, Math.round(scrollerRect.width * ratioX));
          const cropH = Math.max(1, Math.round(scrollerRect.height * ratioY));

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

          for (let i = 0; i < entry.captures.length; i++) {
            const { sourceY, sourceH } = nestedSourceRects[i];
            if (sourceH <= 0) continue;
            const img = i === 0 ? firstNestedImg : await loadImage(entry.captures[i].image);
            nestedCtx.drawImage(img, cropX, cropY + sourceY, cropW, sourceH, 0, ny, cropW, sourceH);
            ny += sourceH;
          }

          const nestedDataUrl = nestedCanvas.toDataURL("image/png");
          const nestedImg = await loadImage(nestedDataUrl);
          nestedStitchedPanels.push({
            img: nestedImg,
            label: `Nested scroller content (${Math.round(scrollerRect.width)}×${Math.round(scrollerRect.height)} CSS px)`
          });
        } catch (_) {  }
      }

      if (nestedStitchedPanels.length > 0) {

        const GAP_PX = 24;
        const LABEL_PX = 28;
        const additionalHeight = nestedStitchedPanels.reduce((sum, p) => sum + p.img.naturalHeight + GAP_PX + LABEL_PX, 0);
        let newHeight = canvas.height + additionalHeight;
        let newWidth = canvas.width;

        const MAX_CANVAS_HEIGHT = 32767;
        const MAX_CANVAS_AREA = 268435456;
        if (newHeight > MAX_CANVAS_HEIGHT || newWidth * newHeight > MAX_CANVAS_AREA) {
          const scale = Math.min(MAX_CANVAS_HEIGHT / newHeight, Math.sqrt(MAX_CANVAS_AREA / (newWidth * newHeight)));
          newWidth = Math.round(newWidth * scale);
          newHeight = Math.round(newHeight * scale);
        }

        const newCanvas = document.createElement("canvas");
        newCanvas.width = newWidth;
        newCanvas.height = newHeight;
        const newCtx = newCanvas.getContext("2d");

        newCtx.drawImage(canvas, 0, 0, newWidth, canvas.height * (newWidth / canvas.width));
        let ny = canvas.height * (newWidth / canvas.width);
        const widthScale = newWidth / canvas.width;
        for (const panel of nestedStitchedPanels) {

          newCtx.fillStyle = "#1b2333";
          newCtx.fillRect(0, ny, newCanvas.width, Math.round(LABEL_PX * widthScale));
          newCtx.fillStyle = "#ffffff";
          newCtx.font = `600 ${Math.round(LABEL_PX * 0.6 * widthScale)}px system-ui, sans-serif`;
          newCtx.textBaseline = "middle";
          newCtx.fillText(panel.label, Math.round(12 * widthScale), ny + Math.round(LABEL_PX * widthScale / 2));
          ny += Math.round(LABEL_PX * widthScale);

          ny += Math.round(GAP_PX / 2 * widthScale);

          const panelDrawW = panel.img.naturalWidth * widthScale;
          const panelDrawH = panel.img.naturalHeight * widthScale;
          const panelX = Math.round((newCanvas.width - panelDrawW) / 2);

          newCtx.fillStyle = "#f0f2f5";
          newCtx.fillRect(0, ny, newCanvas.width, panelDrawH);
          newCtx.drawImage(panel.img, 0, 0, panel.img.naturalWidth, panel.img.naturalHeight, panelX, ny, panelDrawW, panelDrawH);
          ny += panelDrawH + Math.round(GAP_PX / 2 * widthScale);
        }

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

  if (!confirm("Merging will combine descriptions and annotations but discard the next step's screenshot. Continue?")) return;
  commit((t) => {
    const current = t.steps[index];
    const next = t.steps[index + 1];

    const sep = current.description && next.description ? "\n\n— Next step —\n\n" : "";
    current.description = `${current.description || ""}${sep}${next.description || ""}`.trim();

    const currentSize = canvasSize(current);
    const nextSize = canvasSize(next);
    const scaleX = currentSize.width / Math.max(1, nextSize.width);
    const scaleY = currentSize.height / Math.max(1, nextSize.height);
    const scaledAnnotations = next.annotations.map((a) => {

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

    const copy = {
      ...step,
      screenshot: { ...step.screenshot },
      annotations: []
    };
    copy.id = `step-${crypto.randomUUID()}`;

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

function nextMarkerNumber() {
  const step = tutorial?.steps[selectedStep];
  if (!step) return 1;
  const numbers = step.annotations
    .filter((a) => a.type === "marker")

    .map((a) => Number(a.label))
    .filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? numbers.reduce((m, n) => n > m ? n : m, 0) + 1 : 1;
}

async function showShortcutCheatSheet() {
  const existing = $("shortcutOverlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "shortcutOverlay";
  overlay.className = "shortcut-overlay";

  const userSettings = await getSettings();
  const userShortcuts = (userSettings || {}).shortcuts || {};
  const entries = Object.entries(DEFAULT_SHORTCUTS);
  const rows = entries.map(([name, def]) => {

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

async function init() {
  await initTheme();

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const modKey = isMac ? "⌘" : "Ctrl";
  const hint = document.getElementById("shortcutHint");
  if (hint) hint.innerHTML = `<kbd>${modKey}</kbd> <kbd>Z</kbd> undo · <kbd>${modKey}</kbd> <kbd>S</kbd> save`;
  const id = new URLSearchParams(location.search).get("id");

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

  const needsMigration = (() => {
    if (source.version !== 4) return true;
    if (!Array.isArray(source.steps)) return true;

    if (!source.steps.every(s => s && s.id && s.number != null && s.screenshot && typeof s.screenshot.width === "number")) return true;

    const stripImages = (t) => ({
      ...t,
      steps: (t.steps || []).map(s => ({ ...s, screenshot: { ...s.screenshot, image: "" } }))
    });
    return JSON.stringify(stripImages({ ...tutorial, version: source.version })) !== JSON.stringify(stripImages(source));
  })();
  if (needsMigration) {

    await dbPut({ ...tutorial, updatedAt: source.updatedAt || tutorial.updatedAt || new Date().toISOString() });
  }
  pushHistory();
  render();
}

loadPresets();
setupEvents();
renderPresets();
init().catch((error) => alert(`Could not open editor: ${error.message}`));
