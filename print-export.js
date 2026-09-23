import { escapeHtml, dbGet, normalizeTutorial } from "./shared.js";
import { annotatedDataUrl } from "./exporter.js";
import { initTheme } from "./settings-store.js";

function showError(message) {
  const el = document.getElementById("content");
  if (!el) return;
  el.innerHTML = `<div class="page"><h1 style="color:#d9573b">Export error</h1><p>${escapeHtml(message)}</p>
    <p style="margin-top:20px;color:#768196;font-size:13px">Close this tab and try again from the editor's Export menu.</p></div>`;
}

async function render() {
  try {

    const id = new URLSearchParams(location.search).get("id");
    if (!id) {
      showError("No tutorial specified. Open this page from the editor's Export menu.");
      return;
    }

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

    const imgs = [...document.querySelectorAll("#content img")];
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }));

    await new Promise((r) => setTimeout(r, 100));

    const printBar = document.createElement("div");

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

  } catch (error) {
    showError(error?.message || String(error));
  }
}

initTheme().catch(() => {}).then(render).catch((error) => {
  showError(error?.message || String(error));
});
