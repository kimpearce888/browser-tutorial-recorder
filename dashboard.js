import { bgCall } from "./common-ui.js";

const els = {
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  search: document.getElementById("search"),
  sort: document.getElementById("sort"),
  viewToggle: document.getElementById("view-toggle"),
  bulkbar: document.getElementById("bulkbar"),
  bulkCount: document.getElementById("bulk-count"),
  bulkExport: document.getElementById("bulk-export"),
  bulkDelete: document.getElementById("bulk-delete"),
  bulkClear: document.getElementById("bulk-clear")
};

let summaries = [];
let selected = new Set();
let listView = false;

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function load() {
  const res = await bgCall({ type: "GET_SUMMARIES" });
  summaries = res.summaries || [];
  render();
}

function filtered() {
  const q = els.search.value.trim().toLowerCase();
  let out = summaries.filter((s) =>
    !q || s.title.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q)
  );
  const [key, dir] = els.sort.value.split("-");
  const mul = dir === "asc" ? 1 : -1;
  out = out.slice().sort((a, b) => {
    if (key === "title") return a.title.localeCompare(b.title) * mul;
    if (key === "steps") return (a.stepCount - b.stepCount) * mul;
    return ((a.updatedAt || 0) - (b.updatedAt || 0)) * mul;
  });
  return out;
}

function dateLabel(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function render() {
  const items = filtered();
  els.list.classList.toggle("list-view", listView);
  els.list.innerHTML = "";
  els.empty.classList.toggle("hidden", items.length > 0);

  for (const s of items) {
    const card = document.createElement("article");
    card.className = "tut-card";
    if (listView) card.classList.add("list-view");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(s.id);
    checkbox.setAttribute("aria-label", `Select ${s.title}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(s.id); else selected.delete(s.id);
      updateBulkbar();
    });
    card.appendChild(checkbox);

    const thumb = document.createElement("div");
    thumb.className = "thumb" + (s.thumbnail ? "" : " placeholder");
    if (s.thumbnail) thumb.style.backgroundImage = `url("${s.thumbnail}")`;
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "tut-body";

    const title = document.createElement("div");
    title.className = "tut-title";
    title.textContent = s.title;
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "tut-meta";
    const mins = Math.round((s.durationMs || 0) / 60000);
    meta.innerHTML = `<span>${s.stepCount} steps</span><span>${dateLabel(s.updatedAt)}</span>` +
      (mins ? `<span>${mins} min</span>` : "");
    body.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "tut-actions";
    actions.appendChild(actionBtn("Edit", () => openEditor(s.id)));
    actions.appendChild(actionBtn("Preview", () => openPreview(s.id)));
    actions.appendChild(actionBtn("Export", () => exportOne(s)));
    body.appendChild(actions);

    card.appendChild(body);
    els.list.appendChild(card);
  }
  updateBulkbar();
}

function actionBtn(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn small";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function updateBulkbar() {
  els.bulkbar.classList.toggle("hidden", selected.size === 0);
  els.bulkCount.textContent = `${selected.size} selected`;
}

function openEditor(id) {
  location.href = `editor.html?id=${encodeURIComponent(id)}`;
}

function openPreview(id) {
  location.href = `preview.html?id=${encodeURIComponent(id)}`;
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportOne(s) {
  const res = await bgCall({ type: "GET_TUTORIAL", id: s.id });
  download(`${s.title.replace(/[^\w\u0080-\uffff -]/g, "").trim() || "tutorial"}.json`,
    new Blob([JSON.stringify(res.tutorial, null, 2)], { type: "application/json" }));
}

els.search.addEventListener("input", debounce(render, 200));
els.sort.addEventListener("change", render);
els.viewToggle.addEventListener("click", () => {
  listView = !listView;
  els.viewToggle.textContent = listView ? "☰ List" : "▦ Grid";
  render();
});
els.bulkClear.addEventListener("click", () => { selected.clear(); render(); });
els.bulkDelete.addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirm(`Delete ${selected.size} tutorial(s)? This cannot be undone.`)) return;
  for (const id of [...selected]) {
    await bgCall({ type: "DELETE_TUTORIAL", id });
  }
  selected.clear();
  await load();
});
els.bulkExport.addEventListener("click", async () => {
  for (const id of selected) {
    const res = await bgCall({ type: "GET_TUTORIAL", id });
    const name = (res.tutorial.title || "tutorial").replace(/[^\w\u0080-\uffff -]/g, "").trim() || "tutorial";
    download(`${name}.json`, new Blob([JSON.stringify(res.tutorial, null, 2)], { type: "application/json" }));
  }
});

load().catch((e) => console.error("[BTR] dashboard load failed:", e));
