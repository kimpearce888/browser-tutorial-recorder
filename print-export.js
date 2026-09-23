import { bgCall } from "./common-ui.js";
import { annotatedCanvas } from "./exporter.js";

(async () => {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) throw new Error("Missing tutorial id.");
  const tutorial = (await bgCall({ type: "GET_TUTORIAL", id })).tutorial;

  document.getElementById("title").textContent = tutorial.title;
  const mins = Math.round((tutorial.durationMs || 0) / 60000);
  document.getElementById("meta").textContent =
    `${tutorial.steps.length} steps${mins ? ` · ~${mins} min` : ""} · ${new Date(tutorial.updatedAt).toLocaleString()}`;

  const container = document.getElementById("steps");
  for (const step of tutorial.steps) {
    const section = document.createElement("section");
    section.className = "step";
    const h2 = document.createElement("h2");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(step.number);
    h2.appendChild(num);
    h2.appendChild(document.createTextNode(step.description || ""));
    section.appendChild(h2);
    try {
      const canvas = await annotatedCanvas(step);
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      img.alt = `Step ${step.number}`;
      section.appendChild(img);
    } catch {
      const p = document.createElement("p");
      p.textContent = "Screenshot unavailable for this step.";
      section.appendChild(p);
    }
    if (step.url) {
      const p = document.createElement("p");
      p.className = "url";
      p.textContent = step.url;
      section.appendChild(p);
    }
    container.appendChild(section);
  }

  await new Promise((r) => setTimeout(r, 350));
  window.print();
})().catch((e) => {
  document.getElementById("title").textContent = "Print export failed";
  document.getElementById("meta").textContent = e.message;
});
