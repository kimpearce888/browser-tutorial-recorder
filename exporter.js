import {
  escapeHtml,
  sanitizeImageUrl,
  canvasSize, annotationBox, withAlpha
} from "./shared.js";
import { encodeGif } from "./gif-encoder.js";
import { getSettings } from "./settings-store.js";

function safeName(value) {



  const cleaned = (value || "tutorial")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 100)
    .toLowerCase();
  return cleaned || "tutorial";
}

export function download(name, content, type) {


  name = String(name || "download").replace(/[/\\:*?"<>|]/g, "-").slice(0, 200);
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // E3 fix: was 1500ms, which could truncate large downloads (multi-hundred-MB
  // JSON exports, large GIFs) if the browser hadn't finished reading the blob.
  // 30s is a safer upper bound; the blob is freed by GC even if this fires late.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function loadImage(source) {
  return new Promise((resolve, reject) => {
    // Sanitize the image URL as defense-in-depth. A crafted
    // tutorial JSON could set screenshot.image to "javascript:..." or another
    // non-image scheme. Modern browsers block Image.src = "javascript:..." but
    // sanitizing here ensures the URL is a valid data:image/... URL before
    // the Image element tries to load it. Matches the sanitization used in
    // editor.js, preview.js, and dashboard.js.
    const safe = sanitizeImageUrl(source);
    if (!safe) return reject(new Error("This step has no screenshot."));
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load a captured screenshot."));
    image.src = safe;
  });
}

// ---------------------------------------------------------------------------
// Canvas rendering (used by PNG / PDF / Markdown / HTML exports)
// ---------------------------------------------------------------------------

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export async function annotatedCanvas(step) {
  const image = await loadImage(step.screenshot?.image);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || canvasSize(step).width;
  canvas.height = image.naturalHeight || canvasSize(step).height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawAnnotations(ctx, image, step);
  return canvas;
}

export async function annotatedDataUrl(step, format = "png") {
  // P1-24 fix: use PNG by default for lossless UI screenshots.
  // JPEG was causing text degradation and compression artifacts.
  const canvas = await annotatedCanvas(step);
  if (format === "jpeg") return canvas.toDataURL("image/jpeg", 0.9);
  return canvas.toDataURL("image/png");
}

// Paint each annotation onto the export canvas (flattening blur / redaction).
// Fix H14: spotlight annotations are drawn LAST so the dark overlay doesn't
// hide the other annotations (which is what happens in the editor DOM).
function drawAnnotations(ctx, image, step) {
  const base = canvasSize(step);
  const sx = ctx.canvas.width / base.width;
  const sy = ctx.canvas.height / base.height;

  const annotations = step.annotations || [];
  // Draw non-spotlight annotations first, then spotlights on top — matches
  // the visual stacking in the editor where spotlight is a single overlay.
  const ordered = [
    ...annotations.filter((a) => a.type !== "spotlight"),
    ...annotations.filter((a) => a.type === "spotlight")
  ];

  for (const a of ordered) {
    const box = annotationBox(a);
    const x = box.x * sx;
    const y = box.y * sy;
    const width = box.width * sx;
    const height = box.height * sy;
    const rotation = Number(a.rotation || 0) * Math.PI / 180;

    ctx.save();
    ctx.globalAlpha = Number(a.opacity ?? 1);
    ctx.translate(x + width / 2, y + height / 2);
    ctx.rotate(rotation);

    if (a.type === "arrow") drawArrow(ctx, a, width, height);
    // v1.0.2 #2: pass the pre-translation canvas-space (x, y) as source
    // coordinates so drawBlur can crop the correct region from the image.
    else if (a.type === "blur") drawBlur(ctx, image, x, y, -width / 2, -height / 2, width, height, Number(a.blur || 10));
    else if (a.type === "redaction") {
      ctx.fillStyle = a.color || "#202b40";
      ctx.fillRect(-width / 2, -height / 2, width, height);
    } else if (a.type === "spotlight") {
      // Build the overlay-with-hole on a SEPARATE transparent canvas,
      // then composite the finished shape onto the main canvas in one
      // source-over draw. Drawing directly on `ctx` (which already has the
      // opaque screenshot painted into it) meant `destination-out` could
      // only make the already-darkened pixels more transparent — it couldn't
      // bring back the screenshot pixels that source-over had overwritten,
      // leaving a transparent hole instead of the highlighted content.
      const overlay = document.createElement("canvas");
      overlay.width = ctx.canvas.width;
      overlay.height = ctx.canvas.height;
      const octx = overlay.getContext("2d");
      octx.setTransform(ctx.getTransform()); // match translate + rotate
      // Opacity is already baked into withAlpha() below — don't also
      // set globalAlpha or the overlay ends up at opacity² and the hole-punch
      // is weakened, leaving a residual tint in the spotlighted area.
      octx.fillStyle = withAlpha(a.color || "#172238", a.opacity ?? 0.78);
      octx.fillRect(-ctx.canvas.width, -ctx.canvas.height, ctx.canvas.width * 2, ctx.canvas.height * 2);
      octx.globalCompositeOperation = "destination-out";
      octx.fillStyle = "#000";
      octx.fillRect(-width / 2, -height / 2, width, height);
      // Composite the finished overlay onto the main canvas in absolute coords.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(overlay, 0, 0);
    } else if (a.type === "marker") {
      ctx.fillStyle = a.color || "#ff7352";
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(width, height) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.max(10, Math.min(width, height) * 0.38)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(a.label || ""), 0, 0);
    } else if (a.type === "text") {
      ctx.fillStyle = a.background || "#202b40";
      roundedRect(ctx, -width / 2, -height / 2, width, height, 6 * sx);
      ctx.fill();
      ctx.fillStyle = a.textColor || "#fff";
      // E1 fix: the next 3 lines (ctx.font/textAlign/textBaseline) were
      // immediately overwritten by the P2-10 wrap fix below. Remove the dup.
      // P2-10 fix: wrap long text instead of clipping it
      const fontSize = Math.max(8, Number(a.fontSize || 22) * sx);
      ctx.font = `${a.fontWeight || 700} ${fontSize}px system-ui`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      // Word-wrap the text within the annotation box
      const maxTextWidth = width - 24 * sx;
      const text = String(a.text || "Add a note").slice(0, 500);
      const words = text.split(" ");
      let line = "";
      let lineY = -height / 2 + 10 * sy;
      const lineHeight = fontSize * 1.3;
      for (const word of words) {
        const testLine = line ? line + " " + word : word;
        const metrics = ctx.measureText(testLine);
        if (metrics.width > maxTextWidth && line) {
          ctx.fillText(line, -width / 2 + 12 * sx, lineY);
          line = word;
          lineY += lineHeight;
          if (lineY + lineHeight > height / 2) break; // stop if we exceed the box
        } else {
          line = testLine;
        }
      }
      if (line) ctx.fillText(line, -width / 2 + 12 * sx, lineY);
    } else {
      drawShape(ctx, a, width, height, sx);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

function drawShape(ctx, a, width, height, sx) {
  const stroke = a.color || "#4779f4";
  if (Number(a.fillOpacity || 0) > 0) {
    ctx.globalAlpha = (a.opacity ?? 1) * Number(a.fillOpacity);
    ctx.fillStyle = a.fillColor || stroke;
    if (a.type === "circle") {
      ctx.beginPath();
      ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-width / 2, -height / 2, width, height);
    }
    ctx.globalAlpha = a.opacity ?? 1;
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, Number(a.strokeWidth || 4) * sx);
  if (a.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    roundedRect(ctx, -width / 2, -height / 2, width, height, a.type === "highlight" ? 6 * sx : 3 * sx);
    ctx.stroke();
    if (a.type === "highlight") {
      ctx.globalAlpha = (a.opacity ?? 1) * 0.12;
      ctx.fillStyle = stroke;
      ctx.fill();
    }
  }
}

function drawArrow(ctx, a, width, height) {
  const x1 = width * Number(a.startX ?? 0) / 100 - width / 2;
  const y1 = height * Number(a.startY ?? 0) / 100 - height / 2;
  const x2 = width * Number(a.endX ?? 100) / 100 - width / 2;
  const y2 = height * Number(a.endY ?? 100) / 100 - height / 2;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(4, Number(a.arrowHeadSize || 14)) * ((width + height) / 2) / 100;

  ctx.strokeStyle = a.color || "#ff7352";
  ctx.fillStyle = a.color || "#ff7352";
  ctx.lineWidth = Math.max(1, Number(a.strokeWidth || 5) * ((width + height) / 2) / 100);
  ctx.lineCap = ["round", "square", "butt"].includes(a.arrowCap) ? a.arrowCap : "round";

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const spread = Math.PI / 6;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
  ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
}

// v1.0.2 #2: drawBlur now takes source coordinates (srcX, srcY) in addition
// to the destination coordinates (x, y). Uses the 9-arg drawImage form to
// crop the same region being blurred from the source image, instead of the
// 5-arg form which drew the ENTIRE screenshot squashed into the blur box.
// Without this fix, blur annotations showed a warped miniature of the whole
// page instead of blurring the sensitive content in place.
function drawBlur(ctx, image, srcX, srcY, x, y, width, height, amount) {
  const pad = Math.max(12, amount * 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.filter = `blur(${amount}px)`;
  ctx.drawImage(
    image,
    srcX - pad, srcY - pad, width + pad * 2, height + pad * 2,  // source crop
    x - pad, y - pad, width + pad * 2, height + pad * 2          // destination
  );
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Public export entry point
// ---------------------------------------------------------------------------

// GIF export: normalizes every frame to the first frame's aspect ratio with
// a white letterbox background so the GIF89a encoder doesn't have to deal
// with per-frame dimensions.
async function exportGif(tutorial) {
  const steps = tutorial.steps.filter((step) => step.screenshot?.image);
  if (!steps.length) throw new Error("There are no screenshots to export.");
  // E2/B3 fix: size guard must use the ACTUAL screenshot dimensions, not a
  // hardcoded 1280×720. A 4K screenshot (3840×2160) is ~31.6 MiB of RGBA per
  // frame, not ~3.5 MiB. The exporter holds both `sourceCanvases[]` and
  // `frames[].rgba` in memory simultaneously, so a 20-step 4K tutorial would
  // need ~1.2 GiB for those two arrays alone.
  //
  // We compute the peak estimate from the LARGEST step's screenshot
  // dimensions (the target frame size is derived from the first frame, but
  // each source canvas temporarily holds its own dimensions' worth of RGBA).
  // Use the stored screenshot width/height (CSS px); fall back to 1280×720
  // only if the record is missing dimensions.
  const perFrameBytes = (w, h) => (w | 0) * (h | 0) * 4;
  let maxFrameBytes = 1280 * 720 * 4;
  for (const step of steps) {
    const w = Number(step.screenshot?.width) || 1280;
    const h = Number(step.screenshot?.height) || 720;
    const b = perFrameBytes(w, h);
    if (b > maxFrameBytes) maxFrameBytes = b;
  }
  // sourceCanvases[] holds `steps.length` canvases at their native size,
  // and frames[] holds `steps.length` RGBA buffers at the target (first
  // frame) size. The peak is approximately steps.length × max(sourceSize, targetSize).
  // We use the max of the two for a conservative single-frame estimate.
  const estimatedBytes = steps.length * maxFrameBytes * 2; // ×2 for source + target
  const MEM_LIMIT = 250 * 1024 * 1024;
  if (estimatedBytes > MEM_LIMIT) {
    throw new Error(`GIF export would use ~${Math.round(estimatedBytes / 1024 / 1024)} MB of memory (based on actual screenshot dimensions). Try fewer steps or smaller screenshots.`);
  }
  const { gifSpeed } = await getSettings();

  // Render each annotated step to its own canvas first. M5: yield to the
  // event loop between frames so the UI stays responsive (the encoding itself
  // is still CPU-bound, but at least rendering pauses don't compound).
  const sourceCanvases = [];
  for (let i = 0; i < steps.length; i++) {
    sourceCanvases.push(await annotatedCanvas(steps[i]));
    // Yield so the browser can paint the loading indicator.
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  // Target dimensions: width from the first frame, height scaled to preserve
  // its aspect ratio. Subsequent frames are letterboxed onto this canvas.
  const first = sourceCanvases[0];
  const targetWidth = Math.max(64, first.width);
  const targetHeight = Math.max(64, first.height);

  const frames = [];
  for (let i = 0; i < sourceCanvases.length; i++) {
    const canvas = sourceCanvases[i];
    const out = document.createElement("canvas");
    out.width = targetWidth;
    out.height = targetHeight;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    // Letterbox: scale preserving aspect ratio, centred.
    const scale = Math.min(targetWidth / canvas.width, targetHeight / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    ctx.drawImage(canvas, (targetWidth - w) / 2, (targetHeight - h) / 2, w, h);
    const { data } = ctx.getImageData(0, 0, targetWidth, targetHeight);
    frames.push({
      width: targetWidth,
      height: targetHeight,
      rgba: new Uint8Array(data.buffer.slice(0)),
      delayMs: gifSpeed || 1200
    });
    // Yield between frames so the browser can paint / process events (M5).
    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  const blob = await encodeGif(frames, { loop: true });
  download(`${safeName(tutorial.title)}.gif`, blob, "image/gif");
}

// Plain-text export: a numbered list of step descriptions plus their action.
function exportText(tutorial) {
  const lines = [];
  lines.push(tutorial.title || "Untitled tutorial");
  lines.push("=".repeat(Math.max(8, (tutorial.title || "Untitled tutorial").length)));
  if (tutorial.description) lines.push(tutorial.description);
  lines.push("");
  tutorial.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.description || step.action || "Step"}`);
    if (step.target?.text) lines.push(`   Element: ${step.target.text}`);
    if (step.frame?.url) lines.push(`   URL: ${step.frame.url}`);
  });
  download(`${safeName(tutorial.title)}.txt`, lines.join("\n"), "text/plain");
}

async function exportTutorial(tutorial, kind, selectedStepIndex) {
  const name = safeName(tutorial.title);

  if (kind === "json") {
    download(`${name}.json`, JSON.stringify(tutorial, null, 2), "application/json");
    return;
  }

  if (kind === "png") {
    // Throw instead of silently no-oping when no step is selected.
    const step = tutorial.steps[selectedStepIndex];
    if (!step) throw new Error("Select a step before exporting PNG.");
    const canvas = await annotatedCanvas(step);
    await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          download(`${name}-step-${step.number}.png`, blob, "image/png");
          resolve();
        } else {
          reject(new Error("Could not encode PNG."));
        }
      }, "image/png");
    });
    return;
  }

  // PDF / print is handled by a dedicated print-export.html page.
  // Handle popup-blocked case (was silently returning).
  if (kind === "print" || kind === "pdf") {
    const popup = window.open(`print-export.html?id=${encodeURIComponent(tutorial.id)}`, "_blank");
    if (!popup) throw new Error("Popup blocked. Allow popups for this site to export PDF.");
    return;
  }

  if (kind === "gif") {
    await exportGif(tutorial);
    return;
  }

  if (kind === "text") {
    exportText(tutorial);
    return;
  }

  if (kind === "markdown") {
    // P2-15 fix: escape Markdown-sensitive characters in user text
    // E5 fix: drop `.` and `-` from the escape list (not special in body text),
    // and flatten newlines so multi-line descriptions don't split into multiple
    // paragraphs (which breaks the per-step ## Step N structure).
    const escapeMd = (text) => String(text || "")
      .replace(/([\\`*_{}\[\]()#+!|>])/g, "\\$1")
      .replace(/\r?\n/g, " ");
    const parts = [];
    for (const step of tutorial.steps) {
      const image = step.screenshot?.image ? await annotatedDataUrl(step) : "";
      parts.push(`## Step ${step.number}\n\n${escapeMd(step.description)}\n\n${image ? `![Step ${step.number}](${image})` : ""}`);
    }
    download(`${name}.md`, `# ${escapeMd(tutorial.title)}\n\n${escapeMd(tutorial.description)}\n\n${parts.join("\n\n")}`, "text/markdown");
    return;
  }

  if (kind === "html") {
    const parts = [];
    for (const step of tutorial.steps) {
      const image = step.screenshot?.image ? await annotatedDataUrl(step) : "";
      parts.push(`<article><h2>Step ${step.number}</h2><p>${escapeHtml(step.description || "")}</p>${image ? `<img src="${image}" alt="Step ${step.number}">` : ""}</article>`);
    }
    // v1.0.1: add viewport meta, print button, and better default styling.
    const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tutorial.title)}</title>
<style>
  body{font:16px system-ui;max-width:980px;margin:40px auto;padding:0 20px;color:#202b40;background:#fff}
  img{max-width:100%;height:auto;border-radius:12px;box-shadow:0 8px 30px #22304422}
  article{margin:35px 0;page-break-inside:avoid}
  h1{font-size:28px;margin:0 0 8px}
  .toolbar{position:sticky;top:0;background:#fff;padding:12px 0;border-bottom:1px solid #eef1f5;margin-bottom:24px;display:flex;gap:8px;z-index:10}
  .toolbar button{border:1px solid #d4dae4;background:#fff;border-radius:8px;padding:8px 16px;font:600 12px system-ui;cursor:pointer;color:#202b40}
  .toolbar button:hover{background:#f6f8fb}
  @media print{.toolbar{display:none}}
  @media (prefers-color-scheme:dark){
    body{background:#1a1f2e;color:#e8ecf4}
    .toolbar{background:#1a1f2e;border-color:#363d52}
    .toolbar button{background:#252b3d;border-color:#363d52;color:#e8ecf4}
    .toolbar button:hover{background:#2d3346}
  }
</style>
<h1>${escapeHtml(tutorial.title)}</h1>
<p>${escapeHtml(tutorial.description || "")}</p>
<div class="toolbar">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
${parts.join("")}`;
    download(`${name}.html`, html, "text/html");
  }
}

export { exportTutorial, exportGif, exportText, safeName };
