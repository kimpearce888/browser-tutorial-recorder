import { sanitizeImageUrl, sanitizeFilename } from "./shared.js";
import { encodeGif } from "./gif-encoder.js";

export function loadImage(source) {
  return new Promise((resolve, reject) => {
    const safe = sanitizeImageUrl(source);
    if (!safe) return reject(new Error("This step has no screenshot."));
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load a captured screenshot."));
    image.src = safe;
  });
}

function alpha(color, opacity) {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const o = Math.max(0, Math.min(1, opacity == null ? 1 : opacity));
  return `rgba(${r},${g},${b},${o})`;
}

function drawArrow(ctx, a, scale) {
  const x1 = a.x * scale, y1 = a.y * scale;
  const x2 = (a.x2 || a.x + a.w) * scale, y2 = (a.y2 || a.y + a.h) * scale;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, a.strokeWidth * 4) * scale;
  ctx.strokeStyle = alpha(a.color, a.opacity);
  ctx.lineWidth = Math.max(1, a.strokeWidth * scale);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
  ctx.stroke();
  ctx.fillStyle = alpha(a.color, a.opacity);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(angle - Math.PI / 7) * head, y2 - Math.sin(angle - Math.PI / 7) * head);
  ctx.lineTo(x2 - Math.cos(angle + Math.PI / 7) * head, y2 - Math.sin(angle + Math.PI / 7) * head);
  ctx.closePath();
  ctx.fill();
}

function drawBlur(ctx, image, a, scale) {
  const pad = a.blur * scale;
  const x = Math.max(0, a.x * scale - pad);
  const y = Math.max(0, a.y * scale - pad);
  const w = Math.min(ctx.canvas.width - x, a.w * scale + pad * 2);
  const h = Math.min(ctx.canvas.height - y, a.h * scale + pad * 2);
  if (w <= 0 || h <= 0) return;
  const temp = document.createElement("canvas");
  temp.width = Math.max(1, Math.round(w));
  temp.height = Math.max(1, Math.round(h));
  const tctx = temp.getContext("2d");
  tctx.filter = `blur(${Math.max(2, a.blur * scale * 0.5)}px)`;
  tctx.drawImage(image, x, y, w, h, 0, 0, temp.width, temp.height);
  ctx.drawImage(temp, x, y);
}

function drawSpotlight(ctx, a, scale) {
  const overlay = document.createElement("canvas");
  overlay.width = ctx.canvas.width;
  overlay.height = ctx.canvas.height;
  const octx = overlay.getContext("2d");
  octx.fillStyle = alpha(a.color, a.opacity);
  octx.fillRect(0, 0, overlay.width, overlay.height);
  octx.globalCompositeOperation = "destination-out";
  octx.beginPath();
  octx.ellipse(
    (a.x + a.w / 2) * scale, (a.y + a.h / 2) * scale,
    Math.max(2, (a.w / 2) * scale), Math.max(2, (a.h / 2) * scale),
    0, 0, Math.PI * 2
  );
  octx.fill();
  ctx.drawImage(overlay, 0, 0);
}

function drawMarker(ctx, a, scale) {
  const r = 13 * scale;
  const cx = a.x * scale, cy = a.y * scale;
  ctx.fillStyle = alpha(a.color, a.opacity);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(r)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(a.number || 1), cx, cy + 1);
}

export function drawAnnotations(ctx, annotations, scale = 1) {
  for (const a of annotations || []) {
    ctx.save();
    switch (a.type) {
      case "highlight":
        ctx.fillStyle = alpha(a.color, (a.opacity == null ? 1 : a.opacity) * 0.35);
        ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        break;
      case "rectangle":
        ctx.strokeStyle = alpha(a.color, a.opacity);
        ctx.lineWidth = Math.max(1, a.strokeWidth * scale);
        ctx.strokeRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        break;
      case "circle":
        ctx.strokeStyle = alpha(a.color, a.opacity);
        ctx.lineWidth = Math.max(1, a.strokeWidth * scale);
        ctx.beginPath();
        ctx.ellipse((a.x + a.w / 2) * scale, (a.y + a.h / 2) * scale,
          Math.max(1, Math.abs(a.w / 2) * scale), Math.max(1, Math.abs(a.h / 2) * scale), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "arrow":
        drawArrow(ctx, a, scale);
        break;
      case "text":
        ctx.fillStyle = alpha(a.color, a.opacity);
        ctx.font = `${a.fontSize * scale}px system-ui, sans-serif`;
        ctx.textBaseline = "top";
        for (const [i, line] of (a.text || "").split("\n").entries()) {
          ctx.fillText(line, a.x * scale, (a.y + i * a.fontSize * 1.3) * scale);
        }
        break;
      case "blur":
        drawBlur(ctx, ctx.canvas.__btrImage, a, scale);
        break;
      case "redaction":
        ctx.fillStyle = alpha(a.color, 1);
        ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
        break;
      case "spotlight":
        drawSpotlight(ctx, a, scale);
        break;
      case "marker":
        drawMarker(ctx, a, scale);
        break;
    }
    ctx.restore();
  }
}

export async function annotatedCanvas(step, maxWidth = 0) {
  const image = await loadImage(step.screenshot && step.screenshot.image);
  const canvas = document.createElement("canvas");
  canvas.__btrImage = image;
  let scale = 1;
  if (maxWidth > 0 && image.naturalWidth > maxWidth) {
    scale = maxWidth / image.naturalWidth;
  }
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawAnnotations(ctx, step.annotations, scale);
  return canvas;
}

export function scaleForStep(step, image) {
  const cssW = step.screenshot && step.screenshot.width;
  return cssW > 0 ? image.naturalWidth / cssW : 1;
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function exportTutorial(tutorial, kind, options = {}) {
  const name = sanitizeFilename(tutorial.title, "tutorial");
  switch (kind) {
    case "json": {
      const blob = new Blob([JSON.stringify(tutorial, null, 2)], { type: "application/json" });
      downloadBlob(`${name}.json`, blob);
      return;
    }
    case "text": {
      const lines = [tutorial.title, "=".repeat(tutorial.title.length), ""];
      tutorial.steps.forEach((s) => lines.push(`${s.number}. ${s.description}`, ""));
      downloadBlob(`${name}.txt`, new Blob([lines.join("\n")], { type: "text/plain" }));
      return;
    }
    case "markdown": {
      const lines = [`# ${tutorial.title}`, ""];
      for (const s of tutorial.steps) {
        lines.push(`## ${s.number}. ${s.description}`);
        if (s.screenshot && s.screenshot.image) lines.push("", `![Step ${s.number}](${s.screenshot.image})`);
        lines.push("");
      }
      downloadBlob(`${name}.md`, new Blob([lines.join("\n")], { type: "text/markdown" }));
      return;
    }
    case "png": {
      const step = tutorial.steps[options.selectedStepIndex];
      if (!step) throw new Error("Select a step before exporting PNG.");
      const canvas = await annotatedCanvas(step);
      const blob = await canvasToBlob(canvas, "image/png");
      downloadBlob(`${name}-step-${step.number}.png`, blob);
      return;
    }
    case "html": {
      const parts = [];
      for (const s of tutorial.steps) {
        const canvas = await annotatedCanvas(s);
        parts.push({ step: s, dataUrl: canvas.toDataURL("image/png") });
      }
      const html = buildStandaloneHtml(tutorial, parts);
      downloadBlob(`${name}.html`, new Blob([html], { type: "text/html" }));
      return;
    }
    case "gif": {
      const frames = [];
      const maxWidth = options.gifMaxWidth || 800;
      for (const s of tutorial.steps) {
        if (!s.screenshot || !s.screenshot.image) continue;
        frames.push(await annotatedCanvas(s, maxWidth));
      }
      if (!frames.length) throw new Error("No screenshots to export as GIF.");
      const blob = encodeGif(frames, options.gifFrameDelayMs || 500);
      downloadBlob(`${name}.gif`, blob);
      return;
    }
    case "pdf":
    case "print": {
      const popup = window.open(`print-export.html?id=${encodeURIComponent(tutorial.id)}`, "_blank");
      if (!popup) throw new Error("Popup blocked. Allow popups for this site to export PDF.");
      return;
    }
    default:
      throw new Error(`Unknown export format: ${kind}`);
  }
}

function buildStandaloneHtml(tutorial, parts) {
  const stepsHtml = parts.map(({ step, dataUrl }) => `
    <section class="step">
      <h2><span class="num">${step.number}</span> ${escapeHtml(step.description)}</h2>
      ${dataUrl ? `<img src="${dataUrl}" alt="Step ${step.number}" loading="lazy" />` : "<p class='missing'>Screenshot unavailable.</p>"}
      ${step.url ? `<p class="url">${escapeHtml(step.url)}</p>` : ""}
    </section>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tutorial.title)}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:32px 20px;color:#1c2733;background:#f6f7f9}
  h1{font-size:26px} .step{background:#fff;border:1px solid #e3e7ec;border-radius:12px;padding:18px;margin:18px 0;box-shadow:0 1px 3px rgba(16,24,40,.06)}
  .step img{max-width:100%;border-radius:8px;border:1px solid #e3e7ec}
  .num{display:inline-block;background:#ff5b45;color:#fff;border-radius:50%;width:26px;height:26px;text-align:center;line-height:26px;font-size:14px;margin-right:8px}
  .url{color:#5c6b7a;font-size:12.5px;word-break:break-all}
  .missing{color:#a24;}
</style>
</head>
<body>
<h1>${escapeHtml(tutorial.title)}</h1>
<p>${escapeHtml(tutorial.description || "")}</p>
${stepsHtml}
</body>
</html>`;
}

export function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Canvas encoding failed."))), type);
  });
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
