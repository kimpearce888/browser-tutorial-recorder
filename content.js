(() => {
  "use strict";

  if (!/^https?:/i.test(location.protocol)) return;
  if (self.__btrActive) return;
  self.__btrActive = true;

  const IS_TOP = window.top === window;
  const FRAME_NONCE = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const MASK_CONTAINER_ID = "__btr-masks";
  const TYPE_IDLE_MS = 900;

  let attached = false;
  let paused = false;
  let sensitivePatterns = [];
  let excludedDomains = [];
  let autoPauseIdleSec = 0;
  let cursorEnabled = true;
  // Mirror of settings.cursorMarker (content scripts cannot import ES
  // modules) — sent along with every ATTACH_RECORDER, so ring style always
  // matches what the service worker stamps into the screenshot.
  const DEFAULT_RING = { color: "#ff7352", size: 1, fillOpacity: 0.15, glow: 0 };
  let cursorMarker = DEFAULT_RING;

  const masks = new Map();
  let maskScanTimer = null;
  let lastHeartbeat = 0;

  // ----------------------------------------------------------------
  // Click-point overlay, drawn INTO the page. NOTHING follows the
  // mouse — a ring appears only where the user actually clicks, stays
  // glued to that content (page-anchored) until the step's screenshot
  // has been taken, then fades. Between clicks the page is untouched,
  // exactly like standard tutorial recorders.
  // ----------------------------------------------------------------
  const CURSOR_LAYER_ID = "__btr-cursor-layer";
  const TOOLBAR_ID = "__btr-toolbar";
  const RING_HOLD_MS = 2600;
  let cursorLayer = null;
  const clickRings = new Set();
  let toolbar = null;
  let toolbarPauseBtn = null;
  let toolbarCount = null;
  let captureUiHidden = false;

  // Professional recorders never show their own UI inside the screenshots
  // they take. The service worker calls this around every captureVisibleTab:
  // the rings and toolbar vanish for the instant the frame is grabbed, then
  // come back. Ring state is preserved — only visibility toggles.
  function applyCaptureUiVisibility(show) {
    const vis = show ? "" : "none";
    if (cursorLayer && cursorLayer.isConnected) cursorLayer.style.display = vis;
    if (toolbar && toolbar.isConnected) toolbar.style.display = vis;
    captureUiHidden = !show;
  }

  function cursorOverlayOn() {
    return attached && !paused && cursorEnabled;
  }

  function ensureCursorLayer() {
    if (cursorLayer && cursorLayer.isConnected) return cursorLayer;
    cursorLayer = document.createElement("div");
    cursorLayer.id = CURSOR_LAYER_ID;
    cursorLayer.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    (document.body || document.documentElement).appendChild(cursorLayer);
    return cursorLayer;
  }

  // Click rings are anchored to PAGE coordinates so they stay glued to the
  // content they mark even when the page scrolls between the click and the
  // (rate-limited) screenshot that follows it.
  function positionClickRings() {
    const sx = window.scrollX || 0, sy = window.scrollY || 0;
    for (const ring of clickRings) {
      ring.style.transform = `translate3d(${Math.round(ring.__btrX - sx)}px,${Math.round(ring.__btrY - sy)}px,0)`;
    }
  }

  function retireRing(ring) {
    if (!clickRings.has(ring)) return;
    clearTimeout(ring.__btrFade);
    ring.style.opacity = "0";
    setTimeout(() => { ring.remove(); clickRings.delete(ring); }, 280);
  }

  // The service worker sends BTR_STEP_COUNT right after a step's screenshot
  // is committed, so retiring the OLDEST ring there maps 1:1 clicks -> shots
  // (captures are serialized in click order) without ever blinking a ring a
  // capture still needs.
  function retireOldestRing() {
    for (const ring of clickRings) { retireRing(ring); return; }
  }

  // Builds the DOM ring from the SAME spec the service worker stamps:
  // same color, same disc radius (11 × size css px), same fill strength,
  // same glow. Ring stroke 3px like the stamp, halo via box-shadow.
  function ringCssText(marker) {
    const m = marker || DEFAULT_RING;
    const r = Math.max(5, Math.round(11 * (m.size || 1)));
    const border = 3;
    const box = (r + border) * 2;
    const rgba = (opacity) => {
      const hex = String(m.color || "#ff7352").replace("#", "");
      const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
      const rn = parseInt(full.slice(0, 2), 16) || 0;
      const gn = parseInt(full.slice(2, 4), 16) || 0;
      const bn = parseInt(full.slice(4, 6), 16) || 0;
      return `rgba(${rn},${gn},${bn},${opacity})`;
    };
    const glow = Number(m.glow) > 0
      ? `, 0 0 ${Math.round(Number(m.glow) * 1.6)}px ${rgba(0.8)}, 0 0 ${Math.round(Number(m.glow) * 3)}px ${rgba(0.45)}`
      : "";
    return `position:absolute;left:0;top:0;width:${box - border * 2}px;height:${box - border * 2}px;`
      + `margin:${-(box / 2)}px 0 0 ${-(box / 2)}px;border-radius:50%;`
      + `border:${border}px solid ${rgba(0.95)};background:${rgba(m.fillOpacity == null ? 0.15 : m.fillOpacity)};`
      + `box-shadow:0 0 0 1px rgba(255,255,255,.55), 0 0 ${(r) * 0.9}px ${rgba(0.35)}${glow};`
      + `will-change:transform,opacity;transition:opacity .25s;`;
  }

  function spawnClickRing(clientX, clientY) {
    if (!cursorOverlayOn()) return;
    const layer = ensureCursorLayer();
    const ring = document.createElement("div");
    ring.__btrX = clientX + (window.scrollX || 0);
    ring.__btrY = clientY + (window.scrollY || 0);
    ring.style.cssText = ringCssText(cursorMarker);
    layer.appendChild(ring);
    clickRings.add(ring);
    positionClickRings();
    ring.__btrFade = setTimeout(() => retireRing(ring), RING_HOLD_MS);
  }

  function clearCursorOverlay() {
    for (const ring of clickRings) { clearTimeout(ring.__btrFade); ring.remove(); }
    clickRings.clear();
    if (cursorLayer) { cursorLayer.remove(); cursorLayer = null; }
  }

  // ----------------------------------------------------------------
  // In-page recording toolbar (top frames only). Its own interactions
  // are explicitly excluded from recording.
  // ----------------------------------------------------------------
  function inBtrUi(el) {
    return Boolean(el && el.closest && el.closest(`#${TOOLBAR_ID}`));
  }

  function removeToolbar() {
    if (toolbar) { toolbar.remove(); toolbar = null; toolbarPauseBtn = null; toolbarCount = null; }
  }

  function ensureToolbar() {
    if (!IS_TOP || !attached) return;
    if (toolbar && toolbar.isConnected) { syncToolbar(); return; }
    toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;
    toolbar.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;"
      + "background:rgba(21,22,26,.92);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:8px 14px;"
      + "font:600 13px/1 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);user-select:none;cursor:grab;";
    // Draggable like every professional recorder pill — it must never sit on
    // top of the content the user needs to click next.
    toolbar.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.tagName === "BUTTON") return;
      e.preventDefault();
      const rect = toolbar.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY;
      toolbar.style.right = "auto";
      toolbar.style.bottom = "auto";
      toolbar.style.left = `${rect.left}px`;
      toolbar.style.top = `${rect.top}px`;
      const onMove = (ev) => {
        const left = Math.min(Math.max(8, rect.left + ev.clientX - startX), Math.max(8, window.innerWidth - rect.width - 8));
        const top = Math.min(Math.max(8, rect.top + ev.clientY - startY), Math.max(8, window.innerHeight - rect.height - 8));
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    const dot = document.createElement("span");
    dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#d93025;box-shadow:0 0 6px #d93025;";
    toolbarCount = document.createElement("span");
    toolbarCount.style.cssText = "min-width:14px;text-align:center;font-variant-numeric:tabular-nums;";
    toolbarCount.textContent = "0";
    toolbarPauseBtn = document.createElement("button");
    toolbarPauseBtn.type = "button";
    toolbarPauseBtn.style.cssText = "border:0;background:rgba(255,255,255,.14);color:#fff;border-radius:999px;"
      + "padding:6px 12px;font:inherit;cursor:pointer;";
    toolbarPauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      safeSend({ type: "TOOLBAR_TOGGLE_PAUSE" });
    });
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.textContent = "\u23F9 Stop";
    stopBtn.style.cssText = "border:0;background:#d93025;color:#fff;border-radius:999px;"
      + "padding:6px 12px;font:inherit;cursor:pointer;";
    stopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      safeSend({ type: "TOOLBAR_STOP" });
    });
    toolbar.appendChild(dot);
    toolbar.appendChild(toolbarCount);
    toolbar.appendChild(toolbarPauseBtn);
    toolbar.appendChild(stopBtn);
    (document.body || document.documentElement).appendChild(toolbar);
    syncToolbar();
  }

  function syncToolbar() {
    if (!toolbarPauseBtn) return;
    toolbarPauseBtn.textContent = paused ? "\u25B6 Resume" : "\u23F8 Pause";
  }

  function safeSend(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* extension context gone */ }
  }

  function internalPage() {
    return !/^https?:/i.test(location.protocol);
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
  }

  function domainExcluded() {
    const host = hostnameOf(location.href);
    return excludedDomains.some((d) => host === d || host.endsWith("." + d));
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return "";
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
    if (el.id) {
      const id = el.id;
      try { if (el.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`; } catch { /* fallthrough */ }
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }

  function fieldLabel(el) {
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute("aria-label");
    if (explicit && explicit.trim()) return explicit.trim().slice(0, 60);
    if (el.labels && el.labels.length && el.labels[0]) {
      const t = el.labels[0].textContent || "";
      if (t.trim()) return t.trim().slice(0, 60);
    }
    const text = visibleText(el);
    const isButtonish = tag === "button" || (el.getAttribute("role") === "button") ||
      (tag === "input" && /^(submit|button)$/i.test(el.getAttribute("type") || ""));
    if (isButtonish && text) return text.slice(0, 60);
    if (text && tag !== "input" && tag !== "select" && tag !== "textarea") return text.slice(0, 60);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim().slice(0, 60);
    const name = el.getAttribute("name");
    if (name && name.trim()) return name.trim().slice(0, 60);
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim().slice(0, 60);
    if (el.id) return el.id.slice(0, 60);
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return `${type} field`;
    }
    if (tag === "select") return "dropdown";
    if (tag === "textarea") return "text area";
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    return text ? text.slice(0, 60) : tag;
  }

  function visibleText(el) {
    const direct = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent || "").trim())
      .join(" ")
      .trim();
    return direct || (el.textContent || "").trim();
  }

  // Professional guides quote the element the user interacts with —
  // Scribe/Tango write Click "Sign in", never "Click the Sign in".
  function q(s) {
    return `"${String(s == null ? "" : s).replace(/"/g, "'").slice(0, 60)}"`;
  }

  function describe(action, el, extra) {
    const label = fieldLabel(el);
    switch (action) {
      case "CLICK": return `Click ${q(label)}`;
      case "DOUBLE_CLICK": return `Double-click ${q(label)}`;
      case "RIGHT_CLICK": return `Right-click ${q(label)}`;
      case "MIDDLE_CLICK": return `Middle-click ${q(label)}`;
      case "TYPE": return extra && extra.text ? `Type ${q(extra.text)} into ${q(label)}` : `Type into ${q(label)}`;
      case "SELECT": return extra && extra.option ? `Select ${q(extra.option)} in ${q(label)}` : `Change ${q(label)}`;
      case "CHECKBOX": return el.checked ? `Check ${q(label)}` : `Uncheck ${q(label)}`;
      case "RADIO": return `Select the ${q(label)} option`;
      case "SUBMIT": return `Submit ${q(label)}`;
      case "KEYBOARD": return extra && extra.key ? `Press ${extra.key}` : "Press a key";
      case "SCROLL": return "Scroll the page";
      case "DROP": return `Drop content onto ${q(label)}`;
      default: return `Interact with ${q(label)}`;
    }
  }

  function isSensitiveField(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && type === "password") return true;
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/^(cc-|current-password|new-password|one-time-code)/.test(autocomplete)) return true;
    const hay = `${el.getAttribute("name") || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
    return sensitivePatterns.some((p) => p && hay.includes(p.toLowerCase()));
  }

  function ensureMaskContainer() {
    let container = document.getElementById(MASK_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = MASK_CONTAINER_ID;
      const style = container.style;
      style.position = "fixed";
      style.inset = "0";
      style.zIndex = "2147483646";
      style.pointerEvents = "none";
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function refreshMasks() {
    lastMaskRun = Date.now();
    if (!attached) { clearMasks(); return; }
    const container = ensureMaskContainer();
    const fields = collectSensitiveFields();
    const seen = new Set();
    for (const el of fields) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      seen.add(el);
      let mask = masks.get(el);
      if (!mask) {
        mask = document.createElement("div");
        mask.style.cssText = "position:fixed;background:#15161a;border-radius:4px;box-shadow:0 0 0 2px #15161a;";
        container.appendChild(mask);
        masks.set(el, mask);
      }
      const pad = 3;
      const geom = `${Math.max(0, rect.left - pad)},${Math.max(0, rect.top - pad)},${rect.width + pad * 2},${rect.height + pad * 2}`;
      if (mask.dataset.btrGeom !== geom) {
        mask.dataset.btrGeom = geom;
        const m = mask.style;
        m.left = `${Math.max(0, rect.left - pad)}px`;
        m.top = `${Math.max(0, rect.top - pad)}px`;
        m.width = `${rect.width + pad * 2}px`;
        m.height = `${rect.height + pad * 2}px`;
        m.display = "block";
      }
    }
    for (const [el, mask] of masks) {
      if (!seen.has(el)) {
        mask.remove();
        masks.delete(el);
      }
    }
  }

  function collectSensitiveFields(root = document) {
    const out = [];
    try {
      for (const el of root.querySelectorAll("input, textarea")) {
        if (isSensitiveField(el)) out.push(el);
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) out.push(...collectSensitiveFields(el.shadowRoot));
      }
    } catch { /* detached node */ }
    return out;
  }

  function clearMasks() {
    clearTimeout(maskScanTimer);
    clearTimeout(maskCatchup);
    maskCatchup = null;
    for (const [, mask] of masks) mask.remove();
    masks.clear();
    const container = document.getElementById(MASK_CONTAINER_ID);
    if (container) container.remove();
  }

  const MASK_MIN_GAP_MS = 1200;
  let lastMaskRun = 0;
  let maskCatchup = null;

  function scheduleMaskWork() {
    if (!attached) return;
    const gap = Date.now() - lastMaskRun;
    if (gap >= MASK_MIN_GAP_MS) { refreshMasks(); return; }
    if (maskCatchup) return;
    maskCatchup = setTimeout(() => { maskCatchup = null; refreshMasks(); }, MASK_MIN_GAP_MS - gap);
  }

  function startMaskLoop() {
    clearInterval(maskScanTimer);
    refreshMasks();
    maskScanTimer = setInterval(refreshMasks, 1500);
  }

  function cumulativeOffset() {
    if (IS_TOP) return { x: 0, y: 0 };
    try {
      let x = 0, y = 0;
      let w = window;
      while (w && w !== w.top) {
        const fe = w.frameElement;
        if (!fe) throw new Error("cross-origin");
        const r = fe.getBoundingClientRect();
        x += r.left;
        y += r.top;
        w = w.parent;
      }
      return { x, y, cached: true };
    } catch {
      return null;
    }
  }

  let offsetCache = null;
  let offsetCacheAt = 0;

  function requestOffsetViaHandshake() {
    if (IS_TOP) return Promise.resolve({ x: 0, y: 0 });
    if (offsetCache && Date.now() - offsetCacheAt < 1500) return Promise.resolve(offsetCache);
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onRes);
        if (val) { offsetCache = val; offsetCacheAt = Date.now(); }
        resolve(val);
      };
      const onRes = (e) => {
        const data = e.data;
        if (!data || data.type !== "BTR_OFFSET_RES" || data.nonce !== FRAME_NONCE) return;
        done({ x: data.x || 0, y: data.y || 0 });
      };
      window.addEventListener("message", onRes);
      try { window.parent.postMessage({ type: "BTR_OFFSET_REQ", nonce: FRAME_NONCE }, "*"); } catch { done(null); }
      setTimeout(() => done(null), 400);
    });
  }

  if (!IS_TOP) {
    window.addEventListener("message", (e) => {
      const data = e.data;
      if (!data || data.type !== "BTR_OFFSET_REQ") return;
      if (e.source !== window) return;
      try {
        let found = null;
        for (const fe of document.querySelectorAll("iframe, frame")) {
          if (fe.contentWindow === e.source) { found = fe; break; }
        }
        if (!found) return;
        const own = cumulativeOffset();
        const rect = found.getBoundingClientRect();
        const total = own ? { x: own.x + rect.left, y: own.y + rect.top } : { x: rect.left, y: rect.top };
        e.source.postMessage({ type: "BTR_OFFSET_RES", nonce: data.nonce, x: total.x, y: total.y }, "*");
      } catch { /* cannot help */ }
    });
  }

  function viewport() {
    return {
      width: IS_TOP ? document.documentElement.clientWidth : 0,
      height: IS_TOP ? document.documentElement.clientHeight : 0,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function hello() {
    if (internalPage()) return;
    safeSend({
      type: "CS_HELLO",
      isTop: IS_TOP,
      viewport: IS_TOP ? viewport() : null,
      url: location.href
    });
  }

  function sendEvent(event, el, domEvent, extra) {
    if (!attached || paused || internalPage() || domainExcluded()) return;
    if (domEvent && inBtrUi(domEvent.target)) return;
    const rect = el ? el.getBoundingClientRect() : null;
    const point = domEvent && Number.isFinite(domEvent.clientX)
      ? { x: Math.round(domEvent.clientX), y: Math.round(domEvent.clientY) }
      : (rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null);

    const message = {
      type: "REC_EVENT",
      event,
      url: location.href,
      frameUrl: location.href,
      isIframe: !IS_TOP,
      frameNonce: IS_TOP ? null : FRAME_NONCE,
      overlayActive: clickRings.size > 0,
      description: el ? describe(event, el, extra || {}) : (extra && extra.description) || "",
      viewport: viewport(),
      target: el ? {
        selector: buildSelector(el),
        tag: el.tagName.toLowerCase(),
        text: visibleText(el).slice(0, 60),
        placeholder: (el.getAttribute && el.getAttribute("placeholder")) || undefined,
        boundingBox: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        point,
        scrollY: Math.round(window.scrollY)
      } : (extra && extra.target) || null
    };

    const dispatch = (offset) => {
      if (!IS_TOP && offset && message.target) {
        if (message.target.point) {
          message.target.point = { x: Math.round(offset.x + message.target.point.x), y: Math.round(offset.y + message.target.point.y) };
        }
        if (message.target.boundingBox) {
          message.target.boundingBox = {
            x: Math.round(offset.x + message.target.boundingBox.x),
            y: Math.round(offset.y + message.target.boundingBox.y),
            width: message.target.boundingBox.width,
            height: message.target.boundingBox.height
          };
        }
      }
      safeSend(message);
    };

    if (IS_TOP) { dispatch({ x: 0, y: 0 }); return; }
    const direct = cumulativeOffset();
    if (direct) { dispatch(direct); return; }
    requestOffsetViaHandshake().then(dispatch);
  }

  const ACTIONABLE = "a,button,input,select,textarea,label,summary,[role='button'],[role='link'],[role='option'],[role='tab'],[role='menuitem'],[onclick],[contenteditable]:not([contenteditable='false'])";
  // Professional recorders capture every click on real content — modern SPA
  // apps delegate handlers from plain <div>/<span> nodes, which the old
  // ACTIONABLE-only match silently dropped. Bare container whitespace (clicks
  // that land on body/html or an empty wrapper) is still ignored.
  const CLICKABLE_FALLBACK = "h1,h2,h3,h4,h5,h6,p,span,li,td,th,img,label,strong,em,b,i,svg,[role]";

  document.addEventListener("click", (event) => {
    if (inBtrUi(event.target)) return;
    if (!(event.target instanceof Element)) return;
    const el = event.target.closest(ACTIONABLE) || event.target.closest(CLICKABLE_FALLBACK);
    if (!el || el === document.body || el === document.documentElement) return;
    const tag = el.tagName;
    if (tag === "INPUT" && /^(checkbox|radio)$/i.test(el.getAttribute("type") || "")) return;
    if (tag === "SELECT" || tag === "OPTION") return;
    if (el.closest("label") && tag === "INPUT") return;
    if (event.detail >= 2) {
      sendEvent("DOUBLE_CLICK", el, event);
      return;
    }
    sendEvent("CLICK", el, event);
  }, true);

  document.addEventListener("dblclick", (event) => {
    if (inBtrUi(event.target)) return;
    const el = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    if (el) sendEvent("DOUBLE_CLICK", el, event);
  }, true);

  document.addEventListener("contextmenu", (event) => {
    if (inBtrUi(event.target)) return;
    const el = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    if (el) sendEvent("RIGHT_CLICK", el, event);
  }, true);

  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1 || inBtrUi(event.target)) return;
    const el = event.target instanceof Element ? event.target.closest("a,[role='link']") : null;
    if (el) sendEvent("MIDDLE_CLICK", el, event);
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!(el instanceof Element) || inBtrUi(el)) return;
    if (el.tagName === "SELECT") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      sendEvent("SELECT", el, event, { option: opt ? (opt.textContent || "").trim().slice(0, 60) : null });
    } else if (el.tagName === "INPUT" && /^(checkbox)$/i.test(el.getAttribute("type") || "")) {
      sendEvent("CHECKBOX", el, event);
    } else if (el.tagName === "INPUT" && /^(radio)$/i.test(el.getAttribute("type") || "")) {
      sendEvent("RADIO", el, event);
    }
  }, true);

  const typeTimers = new WeakMap();
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName;
    const editable = tag === "TEXTAREA" || (tag === "INPUT" && !/^(checkbox|radio|button|submit|file|range|color)$/i.test(el.getAttribute("type") || "")) || el.isContentEditable;
    if (!editable) return;
    clearTimeout(typeTimers.get(el));
    typeTimers.set(el, setTimeout(() => {
      // Capture what was actually typed — professional guides write
      // Type "hello@site.com" into "Email". Sensitive fields are masked.
      const raw = el.isContentEditable ? (el.textContent || "") : (el.value || "");
      const text = isSensitiveField(el) ? "••••••" : raw.trim().slice(0, 120);
      sendEvent("TYPE", el, event, { text });
    }, TYPE_IDLE_MS));
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof Element) || inBtrUi(form)) return;
    const submitter = event.submitter || form.querySelector("button[type='submit'], button, input[type='submit']");
    sendEvent("SUBMIT", submitter instanceof Element ? submitter : form, event);
    if (event.submitter) {
      setTimeout(() => { suppressNextClick = submitter; setTimeout(() => { suppressNextClick = null; }, 300); }, 0);
    }
  }, true);

  let suppressNextClick = null;

  document.addEventListener("keydown", (event) => {
    if (!/^Enter|Escape|Tab$/.test(event.key)) return;
    const el = event.target;
    if (!(el instanceof Element)) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) return;
    const label = { Enter: "Enter", Escape: "Escape", Tab: "Tab" }[event.key];
    sendEvent("KEYBOARD", el, event, { key: label });
  }, true);

  // Scrolling is positioning, not an action — Scribe/Tango never commit a
  // step for it (the next click's screenshot naturally shows the scrolled
  // state), and neither do we anymore. It also killed the "4. Scroll the
  // page" noise steps.
  function onScroll() {
    positionClickRings();
    if (!attached) return;
    scheduleMaskWork();
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });

  document.addEventListener("drop", (event) => {
    if (inBtrUi(event.target)) return;
    const el = event.target instanceof Element ? event.target.closest("[role='button'],a,button,input,textarea,[contenteditable]") || event.target : null;
    if (el instanceof Element) sendEvent("DROP", el, event);
  }, true);

  let lastSpaUrl = location.href;
  function onSpaNavigation() {
    if (location.href === lastSpaUrl) return;
    lastSpaUrl = location.href;
    if (!attached || paused) return;
    safeSend({
      type: "REC_EVENT",
      event: "NAVIGATION",
      url: location.href,
      frameUrl: location.href,
      isIframe: false,
      description: "",
      viewport: viewport(),
      target: null
    });
  }
  try {
    const origPush = history.pushState && history.pushState.bind(history);
    const origReplace = history.replaceState && history.replaceState.bind(history);
    if (origPush) history.pushState = function (...args) { const r = origPush(...args); onSpaNavigation(); return r; };
    if (origReplace) history.replaceState = function (...args) { const r = origReplace(...args); onSpaNavigation(); return r; };
    window.addEventListener("popstate", onSpaNavigation);
    window.addEventListener("hashchange", onSpaNavigation);
  } catch { /* non-configurable history */ }

  window.addEventListener("resize", scheduleMaskWork, { passive: true });
  new MutationObserver(scheduleMaskWork).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("mousedown", (e) => {
    if (inBtrUi(e.target)) return;
    spawnClickRing(e.clientX, e.clientY);
    // Ask for the frame NOW, before this click's consequences render —
    // navigation, SPA route changes and menus all outrun a capture taken
    // after the click event. The service worker grabs the current view and
    // holds it; the click step reuses it, so the cursor ring sits on the
    // exact state the user saw. Non-click mousedowns (text selection, drags)
    // just let the held frame expire.
    if (e.button === 0 && attached && !paused) {
      safeSend({ type: "BTR_PRE_CAPTURE", viewport: viewport() });
    }
  }, { capture: true, passive: true });
  window.addEventListener("scroll", positionClickRings, { passive: true, capture: true });

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (data && (data.type === "BTR_OFFSET_REQ" || data.type === "BTR_OFFSET_RES")) {
      return;
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;
    if (message.type === "BTR_CAPTURE_UI") {
      applyCaptureUiVisibility(message.visible !== false);
      sendResponse({ ok: true, applied: true });
      return undefined;
    }
    if (message.type === "ATTACH_RECORDER") {
      attached = Boolean(message.recording);
      paused = Boolean(message.paused);
      excludedDomains = Array.isArray(message.excludedDomains) ? message.excludedDomains : [];
      sensitivePatterns = Array.isArray(message.sensitivePatterns) ? message.sensitivePatterns : [];
      autoPauseIdleSec = Number(message.autoPauseIdleSec) || 0;
      cursorEnabled = message.showCursor !== false;
      cursorMarker = (message.cursorMarker && typeof message.cursorMarker === "object") ? message.cursorMarker : DEFAULT_RING;
      if (attached) {
        startMaskLoop();
        ensureToolbar();
        if (toolbarCount && typeof message.stepCount === "number") toolbarCount.textContent = String(message.stepCount);
        if (paused) clearCursorOverlay();
      } else {
        clearMasks();
        clearCursorOverlay();
        removeToolbar();
      }
    } else if (message.type === "DETACH_RECORDER") {
      attached = false;
      paused = false;
      clearMasks();
      clearCursorOverlay();
      removeToolbar();
    } else if (message.type === "BTR_STEP_COUNT") {
      if (toolbarCount) toolbarCount.textContent = String(Number(message.count) || 0);
      retireOldestRing();
    }
    return undefined;
  });

  function heartbeatTick() {
    if (!attached || internalPage()) return;
    const nowTs = Date.now();
    if (nowTs - lastHeartbeat < 19000) return;
    lastHeartbeat = nowTs;
    safeSend({ type: "HEARTBEAT", isTop: IS_TOP, viewport: IS_TOP ? viewport() : null, url: location.href });
  }
  setInterval(heartbeatTick, 10000);

  hello();

  self.__btrTest = {
    buildSelector, fieldLabel, visibleText, describe, isSensitiveField,
    collectSensitiveFields, cumulativeOffset, viewport,
    getState: () => ({ attached, paused, sensitivePatterns, excludedDomains, cursorEnabled, cursorMarker }),
    cursorOverlayOn, spawnClickRing, ensureCursorLayer, ensureToolbar, inBtrUi,
    applyCaptureUiVisibility, ringCssText,
    captureUiHidden: () => captureUiHidden,
    clickRingCount: () => clickRings.size,
    lastRingEl: () => [...clickRings][clickRings.size - 1] || null,
    ids: { CURSOR_LAYER_ID, TOOLBAR_ID }
  };
})();
