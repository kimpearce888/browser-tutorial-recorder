import {
  $, escapeHtml, dbGet, canvasSize, annotationBox, withAlpha, arrowHeadPoints, sanitizeImageUrl, normalizeTutorial
} from "./shared.js";
import { initTheme, getSettings } from "./settings-store.js";

let tutorial = null;
let stepIndex = 0;
let mode = "guide";
let watchTimer = null;
let autoplaySpeed = 3000;

function render() {
  if (!tutorial?.steps?.length) return;

  const step = tutorial.steps[stepIndex];
  $("title").textContent = tutorial.title || "Untitled tutorial";
  $("counter").textContent = `${stepIndex + 1} / ${tutorial.steps.length}`;
  $("number").textContent = String(stepIndex + 1).padStart(2, "0");
  $("description").textContent = step.description || "";

  const imgUrl = sanitizeImageUrl(step.screenshot?.image);
  const imgEl = $("image");
  if (imgUrl) {
    imgEl.src = imgUrl;
    imgEl.style.display = "";
  } else {
    imgEl.removeAttribute("src");
    imgEl.style.display = "none";
  }
  $("progress").style.width = `${(stepIndex + 1) / tutorial.steps.length * 100}%`;
  $("previous").disabled = stepIndex === 0;
  $("next").textContent = stepIndex === tutorial.steps.length - 1 ? "Finish tutorial" : "Next step →";

  document.querySelectorAll(".modes button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  renderAnnotations(step);

  clearTimeout(watchTimer);
  if (mode === "watch" && stepIndex < tutorial.steps.length - 1) {
    watchTimer = setTimeout(() => {
      stepIndex++;
      render();
    }, autoplaySpeed);
  }
}

function renderAnnotations(step) {
  const layer = $("annotations");
  const size = canvasSize(step);
  layer.innerHTML = "";

  const layerScale = Number.isFinite(layer.getBoundingClientRect().width / size.width) ? layer.getBoundingClientRect().width / size.width : 1;

  for (const annotation of step.annotations || []) {
    const box = annotationBox(annotation);
    const node = document.createElement("div");
    node.className = `annotation ${annotation.type}`;
    node.style.left = `${box.x / size.width * 100}%`;
    node.style.top = `${box.y / size.height * 100}%`;
    node.style.width = `${box.width / size.width * 100}%`;
    node.style.height = `${box.height / size.height * 100}%`;
    node.style.opacity = annotation.type === "spotlight" ? 1 : annotation.opacity ?? 1;
    node.style.transform = `rotate(${annotation.rotation || 0}deg)`;
    paintAnnotation(node, annotation, size, layerScale);
    layer.appendChild(node);
  }
}

function paintAnnotation(node, a, size, layerScale) {

  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const pct = (v, fallback = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
  };
  if (a.type === "arrow") {
    const color = escapeHtml(a.color || "#ff7352");

    const box = annotationBox(a);
    node.innerHTML = `
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="${pct(a.startX, 8)}" y1="${pct(a.startY, 92)}" x2="${pct(a.endX, 92)}" y2="${pct(a.endY, 8)}"
          stroke="${color}" stroke-width="${num(a.strokeWidth, 6)}"
          stroke-linecap="${escapeHtml(a.arrowCap || "round")}" />
        <polygon points="${arrowHeadPoints(a, box.width, box.height)}" fill="${color}" />
      </svg>`;
    return;
  }
  if (a.type === "text") {

    const scale = layerScale || 1;
    node.textContent = a.text || "Note";
    node.style.background = a.background || "#202b40";
    node.style.color = a.textColor || "#fff";
    node.style.fontSize = `${Math.max(8, Number(a.fontSize || 22) * scale)}px`;
    node.style.fontWeight = String(a.fontWeight || 700);
    node.style.lineHeight = "1.2";
    return;
  }
  if (a.type === "marker") {
    node.textContent = a.label || "";
    node.style.background = a.color || "#ff7352";
    node.style.border = "3px solid #fff";
    node.style.display = "grid";
    node.style.placeItems = "center";
    node.style.color = "#fff";
    node.style.fontWeight = "800";
    return;
  }
  if (a.type === "blur") {
    node.style.background = "#25314455";
    node.style.backdropFilter = `blur(${Number(a.blur || 10)}px)`;
    return;
  }
  if (a.type === "redaction") {
    node.style.background = a.color || "#202b40";
    return;
  }
  if (a.type === "spotlight") {

    node.style.boxShadow = `0 0 0 9999px ${withAlpha(a.color || "#172238", a.opacity ?? 0.78)}`;
    return;
  }

  node.style.border = `${Math.max(1, Number(a.strokeWidth || 4))}px solid ${a.color || "#4779f4"}`;
  if (a.type === "highlight") {
    node.style.background = withAlpha(a.color || "#ff7352", 0.12);
  }
  if (a.type === "circle") {
    node.style.borderRadius = "50%";
    node.style.background = withAlpha(a.fillColor || a.color || "#8b5cf6", a.fillOpacity || 0);
  }
  if (a.type === "rectangle") {
    node.style.background = withAlpha(a.fillColor || a.color || "#4779f4", a.fillOpacity || 0);
  }
}

async function init() {
  await initTheme();
  const settings = await getSettings();
  autoplaySpeed = settings.autoplaySpeed || 3000;

  const id = new URLSearchParams(location.search).get("id");

  const raw = id ? await dbGet(id) : null;
  tutorial = raw ? normalizeTutorial(raw) : null;

  if (!tutorial) {
    document.body.innerHTML = `<main style="max-width:560px;margin:80px auto;padding:0 20px;text-align:center;font:16px system-ui;color:#202b40">
      <h1 style="font-size:28px;margin:0 0 12px">Tutorial not found</h1>
      <p style="margin:0 0 24px;color:#5a6679">The tutorial you tried to open no longer exists in this browser.</p>
      <a href="dashboard.html" style="display:inline-block;padding:10px 18px;background:#ff7352;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Back to dashboard</a>
    </main>`;
    return;
  }
  render();
}

$("previous").onclick = () => {
  if (stepIndex > 0) {
    stepIndex--;
    render();
  }
};

$("next").onclick = () => {
  if (!tutorial) return;
  if (stepIndex < tutorial.steps.length - 1) {
    stepIndex++;
    render();
  } else {

    try {
      chrome.tabs.getCurrent((tab) => {
        if (tab?.id) chrome.tabs.remove(tab.id).catch(() => window.close());
        else window.close();
      });
    } catch (e) {

      try { window.close(); } catch (_) { location.href = "dashboard.html"; }
    }
  }
};

document.querySelectorAll(".modes button").forEach((button) => {
  button.onclick = () => {
    mode = button.dataset.mode;
    render();
  };
});

$("close").onclick = (event) => {
  event.preventDefault();

  try {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => window.close());
      else window.close();
    });
  } catch (e) {
    try { window.close(); } catch (_) { history.back(); }
  }
};

init().catch((error) => alert(error.message));
window.addEventListener("unload", () => { if (watchTimer) clearTimeout(watchTimer); });
