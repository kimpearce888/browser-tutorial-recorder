import { bgCall } from "./common-ui.js";
import { sanitizeImageUrl } from "./shared.js";

const $ = (id) => document.getElementById(id);
let tutorial = null;
let index = 0;
let watchMode = false;
let watchTimer = null;

function render() {
  const step = tutorial.steps[index];
  $("progress").textContent = `Step ${step.number} of ${tutorial.steps.length}`;
  const imageWrap = $("step-image");
  imageWrap.innerHTML = "";
  const url = sanitizeImageUrl(step.screenshot && step.screenshot.image);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `Step ${step.number}`;
    imageWrap.appendChild(img);
  } else {
    const p = document.createElement("p");
    p.className = "missing";
    p.textContent = "No screenshot for this step.";
    imageWrap.appendChild(p);
  }
  $("step-description").textContent = step.description || `Step ${step.number}`;
  $("step-url").textContent = step.url || "";
  $("btn-prev").disabled = index === 0;
  $("btn-next").disabled = index === tutorial.steps.length - 1 && !watchMode;
  $("step-description").animate(
    [{ opacity: 0.35 }, { opacity: 1 }],
    { duration: 220, easing: "ease-out" }
  );
}

function go(delta) {
  index = Math.max(0, Math.min(index + delta, tutorial.steps.length - 1));
  render();
}

function setWatch(on) {
  watchMode = on;
  clearInterval(watchTimer);
  $("mode-watch").classList.toggle("active", on);
  $("mode-guide").classList.toggle("active", !on);
  if (on) {
    watchTimer = setInterval(() => {
      if (index < tutorial.steps.length - 1) { index++; render(); }
      else { index = 0; render(); }
    }, settings_delay());
  }
}

function settings_delay() {
  return window.__btrPreviewDelay || 2500;
}

$("btn-prev").addEventListener("click", () => go(-1));
$("btn-next").addEventListener("click", () => go(1));
$("mode-guide").addEventListener("click", () => setWatch(false));
$("mode-watch").addEventListener("click", () => setWatch(true));
$("btn-editor").addEventListener("click", () => {
  location.href = `editor.html?id=${encodeURIComponent(tutorial.id)}`;
});

(async () => {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) { $("tutorial-title").textContent = "Open preview from the dashboard or editor."; return; }
  const res = await bgCall({ type: "GET_TUTORIAL", id });
  tutorial = res.tutorial;
  document.title = `${tutorial.title} — Preview`;
  $("tutorial-title").textContent = tutorial.title;
  try {
    const s = (await bgCall({ type: "GET_SETTINGS" })).settings;
    window.__btrPreviewDelay = s.previewAutoAdvanceMs || 2500;
  } catch { /* default delay */ }
  render();
})().catch((e) => {
  $("tutorial-title").textContent = "Preview unavailable";
  $("step-description").textContent = e.message;
});
