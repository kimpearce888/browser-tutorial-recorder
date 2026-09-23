import { escapeHtml, dbGet, normalizeTutorial } from "./shared.js";
import { annotatedDataUrl } from "./exporter.js";
import { initTheme } from "./settings-store.js";

// H20: render a user-visible error page instead of a blank screen if the
// print-export pipeline fails at any point.
function showError(message) {
  const el = document.getElementById("content");
  if (!el) return;
  el.innerHTML = `<div class="page"><h1 style="color:#d9573b">Export error</h1><p>${escapeHtml(message)}</p>
    <p style="margin-top:20px;color:#768196;font-size:13px">Close this tab and try again from the editor's Export menu.</p></div>`;
}

async function render() {
  try {
    // v1.0.9: fetch only the one tutorial we need via dbGet(id).
    // P1 v1.6.0 fix: removed the dbGetAll() fallback that loaded the entire
    // library just to find the "most recent" tutorial when no id was provided.
    // The exporter always opens print-export.html WITH an id, so the no-id
    // case is an error (user manually navigated here). Show an error instead
    // of loading every tutorial's screenshots into memory.
    const id = new URLSearchParams(location.search).get("id");
    if (!id) {
      showError("No tutorial specified. Open this page from the editor's Export menu.");
      return;
    }
    // F4 fix: normalize the tutorial on load so malformed records don't crash
    // the print-export pipeline (which expects sanitized annotation fields).
    // B13 fix: null-check BEFORE normalizeTutorial — normalizeTutorial(null)
    // throws, so the old code's `if (!tutorial)` branch was unreachable.
    const raw = await dbGet(id);
    const tutorial = raw ? normalizeTutorial(raw) : null;
    if (!tutorial) {
      showError("No tutorial found. The tutorial may have been deleted.");
      return;
    }
    const steps = tutorial.steps || [];
    if (!steps.length) {
      showError(`Tutorial "${tutorial.title || "Untitled"}" has no steps to export.`);
      return;
    }
    const html = [];
    html.push(`<div class="page cover">
      <div class="cover-top">
        <div class="cover-brand"><div class="cover-mark">↗</div><div class="cover-brand-name">Browser Tutorial Recorder</div></div>
        <div class="cover-title">${escapeHtml(tutorial.title || "Untitled tutorial")}</div>
        ${tutorial.description ? `<div class="cover-description">${escapeHtml(tutorial.description)}</div>` : ""}
      </div>
      <div class="cover-toc"><h2>Table of Contents</h2><ul class="cover-toc-list">
        ${steps.map((step, i) => `<li><span><span class="cover-toc-num">${i + 1}</span><span class="cover-toc-text">${escapeHtml((step.description || "Untitled step").slice(0, 70))}</span></span><span class="cover-toc-page">${i + 2}</span></li>`).join("")}
      </ul></div>
      <div class="cover-footer"><span>${steps.length} step${steps.length === 1 ? "" : "s"} · Generated ${new Date().toLocaleDateString()}</span><span>Browser Tutorial Recorder</span></div>
    </div>`);
    for (const step of steps) {
      let imageHtml;
      if (step.screenshot?.image) {
        try { imageHtml = `<img src="${await annotatedDataUrl(step)}" alt="Step ${step.number}">`; }
        catch (e) { imageHtml = `<div class="no-screenshot"><div class="no-screenshot-icon">⚠</div><span>Could not render</span></div>`; }
      } else { imageHtml = `<div class="no-screenshot"><div class="no-screenshot-icon">◌</div><span>No screenshot captured</span></div>`; }
      html.push(`<div class="page step-page">
        <div class="step-header"><div class="step-number">${step.number}</div><div class="step-title">${escapeHtml(step.description || "Untitled step")}</div></div>
        <div class="step-image-wrap">${imageHtml}</div>
        <div class="step-footer"><span>${escapeHtml(tutorial.title || "Untitled tutorial")}</span><span>Step ${step.number} of ${steps.length} · Page ${step.number + 1} of ${steps.length + 1}</span></div>
      </div>`);
    }
    document.getElementById("content").innerHTML = html.join("\n");
    // Wait for all images to finish loading before opening the print dialog
    // (H8). Previously this used a fixed 1-second timeout which broke for
    // large tutorials or slow image decoding.
    const imgs = [...document.querySelectorAll("#content img")];
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }));
    // Small extra delay so the browser has time to lay out the loaded images.
    await new Promise((r) => setTimeout(r, 100));

    // H27: show a "Ready to print" button instead of auto-printing. The user
    // can review the layout and click to open the print dialog when ready.
    const printBar = document.createElement("div");
    // H14 fix: add a "print-bar" class so print-export.css's @media print rule
    // can hide it (in case the user uses Ctrl+P / Cmd+P instead of the button,
    // which would otherwise leave the fixed-position bar visible on every page).
    printBar.className = "print-bar";
    printBar.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:#1b2333;color:#fff;border-radius:12px;padding:14px 24px;display:flex;gap:16px;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,.3);font:14px system-ui";
    printBar.innerHTML = `
      <span>PDF preview ready</span>
      <button type="button" id="printNow" style="border:0;background:#ff7352;color:#fff;border-radius:8px;padding:8px 18px;font:600 13px system-ui;cursor:pointer">Print / Save as PDF</button>
      <a href="dashboard.html" style="color:#aab6c9;text-decoration:none;font-size:12px">Cancel</a>
    `;
    document.body.appendChild(printBar);
    printBar.querySelector("#printNow").addEventListener("click", () => {
      printBar.remove();
      window.print();
    });
    // P1 fix: removed the auto-print timer entirely. The button should be
    // the only print action — any timer can surprise the user.
  } catch (error) {
    showError(error?.message || String(error));
  }
}

initTheme().catch(() => {}).then(render).catch((error) => {
  showError(error?.message || String(error));
});
