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
  // `a.x2 || …` broke arrows whose head sits exactly on x=0/y=0; only fall
  // back to the bbox corner when x2/y2 is genuinely absent.
  const x2 = (a.x2 == null ? a.x + (a.w || 0) : a.x2) * scale;
  const y2 = (a.y2 == null ? a.y + (a.h || 0) : a.y2) * scale;
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
  if (!image) return;
  // Annotations live in natural image pixels; the SOURCE rect must be read
  // in that same space. The old version fed display-scaled coords into a
  // full-resolution image, so blur sampled the wrong region whenever the
  // image was displayed (or exported) at anything other than 1:1 — the
  // pixelated/blurry patch showed the wrong part of the screenshot.
  const pad = a.blur || 10;
  const sx = Math.max(0, (a.x || 0) - pad);
  const sy = Math.max(0, (a.y || 0) - pad);
  const sw = Math.min(image.naturalWidth - sx, (a.x || 0) + (a.w || 0) + pad - sx);
  const sh = Math.min(image.naturalHeight - sy, (a.y || 0) + (a.h || 0) + pad - sy);
  if (sw <= 1 || sh <= 1) return;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const temp = document.createElement("canvas");
  temp.width = dw;
  temp.height = dh;
  const tctx = temp.getContext("2d");
  tctx.filter = `blur(${Math.max(1.5, pad * scale * 0.5)}px)`;
  tctx.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);
  ctx.drawImage(temp, sx * scale, sy * scale);
}

function drawSpotlight(ctx, a, scale) {
  const overlay = document.createElement("canvas");
  overlay.width = ctx.canvas.width;
  overlay.height = ctx.canvas.height;
  const octx = overlay.getContext("2d");
  // A spotlight dims with a neutral dark veil (like every serious tool) —
  // tinting it with the active swatch color read as a broken red overlay.
  octx.fillStyle = alpha("#0f121a", Math.min(0.85, 0.55 * (a.opacity == null ? 1 : a.opacity)));
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

// The GIF frames-per-step pipeline produces canvases of DIFFERING pixel
// sizes whenever a tutorial mixes viewport shots, full-page captures and
// (opt-in) element crops — encodeGif reads every frame at frame 0's
// dimensions, so shorter frames came out padded with black and taller ones
// silently cropped: the exported GIF showed wrong content per step.
//
// normalizeGifFrames maps every frame onto ONE uniform white-letterboxed
// canvas:
//   - width  = the widest frame, capped at maxWidth; nothing is upscaled
//     (a 400px element crop stays 400px, centered on white)
//   - height = the tallest width-scaled frame, capped at maxHeight — a
//     12,000px full-page step used to freeze the encoder for seconds on a
//     9.6M-pixel frame; the cap bounds every frame to a fixed pixel budget
//   - a frame taller than the box shows its TOP at full width (cropped,
//     never sliver-shrunk by an extreme aspect ratio)
// `options.makeCanvas` is injectable so tests can pass fake canvases.
export function normalizeGifFrames(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("GIF export needs at least one frame.");
  }
  const make = options.makeCanvas || ((w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  });
  const W = Math.max(1, Math.min(
    Math.max(1, Math.round(options.maxWidth || 800)),
    Math.max(...frames.map((f) => f.width))
  ));
  const H_CAP = Math.max(1, Math.round(options.maxHeight || 1400));
  const scaled = frames.map((f) => {
    const s = Math.min(1, W / f.width);
    return { f, s, h: f.height * s };
  });
  const H = Math.max(1, Math.min(H_CAP, Math.round(Math.max(...scaled.map((x) => x.h)))));
  return scaled.map(({ f, s }) => {
    const canvas = make(W, H);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const dw = Math.max(1, Math.round(f.width * s));
    const fullH = f.height * s;
    let dh = Math.round(fullH);
    let dy = Math.round((H - dh) / 2);
    let sh = f.height;
    if (fullH > H) {
      // Tall frame: source region is the box height at the same scale —
      // top of the page, full width, zero distortion.
      sh = Math.max(1, Math.floor(H / s));
      dh = H;
      dy = 0;
    }
    const dx = Math.round((W - dw) / 2);
    ctx.drawImage(f, 0, 0, f.width, sh, dx, dy, dw, dh);
    return canvas;
  });
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
      const raw = [];
      const maxWidth = options.gifMaxWidth || 800;
      for (const s of tutorial.steps) {
        if (!s.screenshot || !s.screenshot.image) continue;
        raw.push(await annotatedCanvas(s, maxWidth));
      }
      if (!raw.length) throw new Error("No screenshots to export as GIF.");
      // Steps arrive in mixed pixel sizes (viewport + full-page + element
      // crops). encodeGif rasterizes every frame at frame 0's dimensions, so
      // raw frames used to export with black padding / cropped content —
      // normalize everything onto one uniform box first (and cap the height,
      // or a full-page step freezes the encode).
      const frames = normalizeGifFrames(raw, { maxWidth });
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
