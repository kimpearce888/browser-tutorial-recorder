import { bgCall } from "./common-ui.js";
import { makeId, formatDuration } from "./shared.js";
import { exportTutorial } from "./exporter.js";
import { getSettings, normalizeCombo, onSettingsChanged } from "./settings-store.js";

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
  presets: document.getElementById("preset-chips")
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
    els.canvasEmpty.classList.toggle("hidden", Boolean(step));
    display.image = null;
    return;
  }
  els.canvasEmpty.classList.add("hidden");
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Screenshot failed to load."));
    image.src = step.screenshot.image;
  });
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
  for (const a of step.annotations) drawAnnotation(ctx, a, fit);
  if (selectedAnnotationId) {
    const a = step.annotations.find((x) => x.id === selectedAnnotationId);
    if (a) {
      ctx.save();
      ctx.strokeStyle = "#1a73e8";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x * fit - 3, a.y * fit - 3, a.w * fit + 6, a.h * fit + 6);
      ctx.restore();
    }
  }
}

function drawAnnotation(ctx, a, scale) {
  ctx.save();
  ctx.lineWidth = Math.max(1, a.strokeWidth * scale);
  switch (a.type) {
    case "highlight":
      ctx.fillStyle = hexA(a.color, a.opacity * 0.35);
      ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
      break;
    case "rectangle":
      ctx.strokeStyle = hexA(a.color, a.opacity);
      ctx.strokeRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
      break;
    case "circle":
      ctx.strokeStyle = hexA(a.color, a.opacity);
      ctx.beginPath();
      ctx.ellipse((a.x + a.w / 2) * scale, (a.y + a.h / 2) * scale, Math.abs(a.w / 2) * scale, Math.abs(a.h / 2) * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "arrow": {
      const x2 = a.x2, y2 = a.y2;
      const ang = Math.atan2(y2 - a.y, x2 - a.x);
      const head = Math.max(10, a.strokeWidth * 4);
      ctx.strokeStyle = hexA(a.color, a.opacity);
      ctx.beginPath();
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo((x2 - Math.cos(ang) * head * 0.6) * scale, (y2 - Math.sin(ang) * head * 0.6) * scale);
      ctx.stroke();
      ctx.fillStyle = hexA(a.color, a.opacity);
      ctx.beginPath();
      ctx.moveTo(x2 * scale, y2 * scale);
      ctx.lineTo((x2 - Math.cos(ang - Math.PI / 7) * head) * scale, (y2 - Math.sin(ang - Math.PI / 7) * head) * scale);
      ctx.lineTo((x2 - Math.cos(ang + Math.PI / 7) * head) * scale, (y2 - Math.sin(ang + Math.PI / 7) * head) * scale);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "text":
      ctx.fillStyle = hexA(a.color, a.opacity);
      ctx.font = `${a.fontSize * scale}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      (a.text || "Text").split("\n").forEach((line, i) => {
        ctx.fillText(line, a.x * scale, (a.y + i * a.fontSize * 1.3) * scale);
      });
      break;
    case "redaction":
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
      break;
    case "marker": {
      const r = 13 * scale;
      ctx.fillStyle = hexA(a.color, a.opacity);
      ctx.beginPath();
      ctx.arc(a.x * scale, a.y * scale, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.round(r)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(a.number), a.x * scale, a.y * scale + 1);
      break;
    }
  }
  ctx.restore();
}

function hexA(hex, opacity) {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(f.slice(0, 2), 16) || 0;
  const g = parseInt(f.slice(2, 4), 16) || 0;
  const b = parseInt(f.slice(4, 6), 16) || 0;
  const o = Math.max(0, Math.min(1, opacity == null ? 1 : opacity));
  return `rgba(${r},${g},${b},${o})`;
}

function canvasPoint(e) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / display.scale,
    y: (e.clientY - rect.top) / display.scale
  };
}

function hitAnnotation(pt) {
  const step = currentStep();
  if (!step) return null;
  for (let i = step.annotations.length - 1; i >= 0; i--) {
    const a = step.annotations[i];
    const x1 = Math.min(a.x, a.x2 || a.x), x2 = Math.max(a.x, a.x2 || a.x);
    const y1 = Math.min(a.y, a.y2 || a.y), y2 = Math.max(a.y, a.y2 || a.y);
    const tol = 8;
    if (pt.x >= x1 - tol && pt.x <= x2 + tol && pt.y >= y1 - tol && pt.y <= y2 + tol) return a;
  }
  return null;
}

els.canvas.addEventListener("pointerdown", (e) => {
  const step = currentStep();
  if (!step || !display.image) return;
  els.canvas.setPointerCapture(e.pointerId);
  const pt = canvasPoint(e);

  if (tool === "select") {
    const a = hitAnnotation(pt);
    selectedAnnotationId = a ? a.id : null;
    if (a) {
      drag = { kind: "move", ann: a, startX: pt.x, startY: pt.y, orig: { ...a } };
      snapshot();
    }
    renderCanvas();
    return;
  }
  if (cropMode) {
    drag = { kind: "crop", startX: pt.x, startY: pt.y };
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
  drag = { kind: "draw", ann: base, step };
  snapshot();
  step.annotations.push(base);
  selectedAnnotationId = base.id;
});

els.canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const pt = canvasPoint(e);
  if (drag.kind === "draw") {
    const a = drag.ann;
    a.x2 = Math.round(pt.x); a.y2 = Math.round(pt.y);
    a.x = Math.min(drag.startX ?? a.x, a.x2);
    a.y = Math.min(drag.startY ?? a.y, a.y2);
    a.w = Math.abs(a.x2 - (drag.startX ?? a.x2));
    a.h = Math.abs(a.y2 - (drag.startY ?? a.y2));
    if (drag.startX == null) { drag.startX = a.x2; drag.startY = a.y2; }
    a.x = Math.min(drag.startX, a.x2); a.y = Math.min(drag.startY, a.y2);
    a.w = Math.abs(a.x2 - drag.startX); a.h = Math.abs(a.y2 - drag.startY);
  } else if (drag.kind === "move") {
    const a = drag.ann;
    const dx = Math.round(pt.x - drag.startX);
    const dy = Math.round(pt.y - drag.startY);
    a.x = drag.orig.x + dx; a.y = drag.orig.y + dy;
    if (a.type === "arrow") { a.x2 = drag.orig.x2 + dx; a.y2 = drag.orig.y2 + dy; }
  } else if (drag.kind === "crop") {
    cropPreview(drag.startX, drag.startY, pt.x, pt.y);
  }
  if (drag.kind !== "crop") renderCanvas();
});

els.canvas.addEventListener("pointerup", (e) => {
  if (!drag) return;
  const kind = drag.kind;
  const pt = canvasPoint(e);
  if (kind === "draw") {
    const a = drag.ann;
    if (a.type === "arrow") {
      a.w = Math.abs(a.x2 - a.x); a.h = Math.abs(a.y2 - a.y);
    }
    if (a.w < 3 && a.h < 3 && a.type !== "arrow") {
      const step = currentStep();
      step.annotations = step.annotations.filter((x) => x.id !== a.id);
      undoStack.pop();
    }
    markDirty();
  } else if (kind === "move") {
    markDirty();
  } else if (kind === "crop") {
    applyCrop(drag.startX, drag.startY, pt.x, pt.y);
  }
  drag = null;
  renderCanvas();
});

function openTextInput(pt, ann) {
  const input = els.textInput;
  input.classList.remove("hidden");
  const wrapRect = els.canvasWrap.getBoundingClientRect();
  input.style.left = `${els.canvas.offsetLeft + pt.x * display.scale}px`;
  input.style.top = `${els.canvas.offsetTop + pt.y * display.scale}px`;
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
      snapshot.pop();
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

function cropPreview() { /* live preview not needed; crop applies on pointerup */ }

async function applyCrop(x1, y1, x2, y2) {
  cropMode = false;
  els.canvas.classList.remove("selecting");
  const step = currentStep();
  if (!step || !display.image || !step.screenshot.width) return;
  const imgScale = display.imgScale;
  const nx1 = Math.max(0, Math.round(Math.min(x1, x2) * imgScale));
  const ny1 = Math.max(0, Math.round(Math.min(y1, y2) * imgScale));
  const nx2 = Math.min(display.image.naturalWidth, Math.round(Math.max(x1, x2) * imgScale));
  const ny2 = Math.min(display.image.naturalHeight, Math.round(Math.max(y1, y2) * imgScale));
  const w = nx2 - nx1, h = ny2 - ny1;
  if (w < 10 || h < 10) return;
  snapshot();
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(display.image, nx1, ny1, w, h, 0, 0, w, h);
  const cssW = Math.round(w / imgScale), cssH = Math.round(h / imgScale);
  step.screenshot.image = c.toDataURL("image/png");
  step.screenshot.width = cssW;
  step.screenshot.height = cssH;
  for (const a of step.annotations) {
    a.x -= nx1 / imgScale; a.y -= ny1 / imgScale;
    if (a.type === "arrow") { a.x2 -= nx1 / imgScale; a.y2 -= ny1 / imgScale; }
  }
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
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b === btn));
    els.canvas.classList.toggle("selecting", tool !== "select");
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

document.getElementById("btn-crop").addEventListener("click", () => {
  cropMode = !cropMode;
  tool = cropMode ? "crop" : "select";
  els.canvas.classList.toggle("selecting", !cropMode);
  alert(cropMode ? "Drag a rectangle on the screenshot to crop, then release." : "Crop cancelled.");
});

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
    return;
  }
  if (!typing && e.key === "Delete" && selectedAnnotationId) deleteSelectedAnnotation();
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
