(function () {
  if (window.__browserTutorialRecorderLoaded) return;
  window.__browserTutorialRecorderLoaded = true;

  const isTopFrame = window.top === window;

  let active = false;
  let paused = false;
  let excludedDomains = [];
  let lastEventKey = "";
  let lastEventAt = 0;

  let dragSource = null;

  const focusValues = new WeakMap();
  let overlayHost = null;
  let overlayRoot = null;
  let captureHost = null;
  let captureRoot = null;

  let maskedInputs = null;

  let sensitivePatterns = "password|passcode|secret|token|api.?key|authorization|credit.?card|card.?number|cvv|csc|cc-|security.?code|otp|one.?time";

  let autoPauseIdle = 0;
  let lastActivity = Date.now();
  let idleTimer = null;

  const frameNonce = isTopFrame ? null
    : (crypto?.randomUUID?.() || `btr-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const iframeRegistry = new Map();

  let cumulativeTransform = { offsetX: 0, offsetY: 0, scale: 1 };

  const cssEscape = (value) => {
    try { return CSS.escape(value); }
    catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  };

  const domainBlocked = () => {
    const host = location.hostname.toLowerCase();
    return excludedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  };

  const elementText = (el) => {
    if (!el) return "";

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {

      if (el.type === "submit" || el.type === "button" || el.type === "reset") {
        return (el.value || "").trim().replace(/\s+/g, " ").slice(0, 120);
      }

      return (el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.placeholder || el.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
    }
    return (el.innerText || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "").trim().replace(/\s+/g, " ").slice(0, 120);
  };

  const stableId = (id) => id && !/^\d+$/.test(id) && !/(react|vue|ember|random|uuid|select-\d+)/i.test(id) ? id : null;

  function isSensitive(element) {

    const input = element?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    if (!input) return false;
    if (input.type === "password") return true;

    const patterns = String(sensitivePatterns || "").trim();
    if (!patterns) return false;

    const doc = input.ownerDocument || document;
    let labelText = "";
    if (input.id) {
      const label = doc.querySelector(`label[for="${cssEscape(input.id)}"]`);
      if (label) labelText = label.textContent || "";
    }

    const wrappingLabel = input.closest("label");
    if (wrappingLabel) labelText = (labelText + " " + wrappingLabel.textContent).trim();
    const hay = [input.type, input.name, input.id, input.autocomplete, input.getAttribute("aria-label"), input.placeholder, labelText]
      .filter(Boolean).join(" ").toLowerCase();
    let re;
    try {
      re = new RegExp(patterns, "i");
    } catch (e) {
      re = /password|passcode|secret|token|api.?key|authorization|credit.?card|card.?number|cvv|cvc|csc|cc-|security.?code|otp|one.?time/i;
    }
    return re.test(hay);
  }

  function selectors(element) {
    if (!element || element.nodeType !== 1) return [];
    const list = [];
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy");
    if (testId) {

      const attrName = element.hasAttribute("data-testid") ? "data-testid"
        : element.hasAttribute("data-test") ? "data-test" : "data-cy";
      list.push(`[${attrName}="${cssEscape(testId)}"]`);
    }

    const id = stableId(element.id);
    if (id) list.push(`#${cssEscape(id)}`);

    const aria = element.getAttribute("aria-label");
    if (aria) list.push(`${element.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`);

    const name = element.getAttribute("name");
    if (name) list.push(`${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`);

    const role = element.getAttribute("role");
    if (role) list.push(`[role="${cssEscape(role)}"]`);

    let node = element;
    const parts = [];
    for (let i = 0; node && node.nodeType === 1 && i < 5; i++, node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const sid = stableId(node.id);
      if (sid) { parts.unshift(`${part}#${cssEscape(sid)}`); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    if (parts.length) list.push(parts.join(" > "));

    if (element.tagName === "BUTTON" || element.tagName === "A") {
      const label = elementText(element).slice(0, 60);

      if (label && element.hasAttribute("aria-label")) {
        list.push(`${element.tagName.toLowerCase()}[aria-label="${cssEscape(label)}"]`);
      }
    }
    return [...new Set(list)].slice(0, 8);
  }

  function targetOf(element, point) {
    const el = element && element.nodeType === 1 ? element : document.documentElement;
    const rect = el.getBoundingClientRect();
    const hasPoint = Number.isFinite(point?.clientX) && Number.isFinite(point?.clientY);
    const x = hasPoint ? point.clientX : rect.left + rect.width / 2;
    const y = hasPoint ? point.clientY : rect.top + rect.height / 2;
    return {
      tag: el.tagName.toLowerCase(),
      text: elementText(el),
      role: el.getAttribute("role") || (el.tagName === "BUTTON" ? "button" : null),
      ariaLabel: el.getAttribute("aria-label"),
      name: el.getAttribute("name"),
      selectors: selectors(el),
      boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      point: hasPoint ? { x, y } : null
    };
  }

  function describe(kind, element, extra = {}) {

    let label;
    if (element?.tagName === "SELECT") {
      label = element.getAttribute?.("aria-label") || element.getAttribute?.("title") || element.name || "";
    } else {
      label = elementText(element) || element?.getAttribute?.("aria-label") || element?.getAttribute?.("placeholder") || element?.getAttribute?.("title");
    }

    const fallback = (() => {
      const tag = element?.tagName?.toLowerCase() || "element";
      const role = element?.getAttribute?.("role");
      if (role) return `the ${role}`;
      if (tag === "a") return "the link";
      if (tag === "button") return "the button";
      if (tag === "input") return `the ${element?.type || "input"} field`;
      if (tag === "select") return "the dropdown";
      if (tag === "textarea") return "the text field";
      return tag;
    })();
    if (kind === "TYPE") return label ? `Enter your ${label.toLowerCase()}.` : "Enter text in the selected field.";
    if (kind === "SELECT") return label ? `Choose an option from ${label}.` : "Choose an option from the dropdown.";
    if (kind === "CHECKBOX") return `Select the ${label || "confirmation"} checkbox.`;
    if (kind === "RADIO") return `Choose ${label || "the selected option"}.`;
    if (kind === "DOUBLE_CLICK") return `Double-click ${label || fallback}.`;
    if (kind === "RIGHT_CLICK") return `Right-click ${label || fallback}.`;
    if (kind === "MIDDLE_CLICK") return `Open ${label || "the selected link"} in a new tab.`;
    if (kind === "NEW_TAB") return "Continue in the new tab.";
    if (kind === "NEW_WINDOW") return "Continue in the new window.";
    if (kind === "SUBMIT") return `Submit ${label || "the form"}.`;
    if (kind === "SCROLL") return `Scroll ${extra.direction || "down"} ${extra.distance ? `${Math.round(Number(extra.distance))}px ` : ""}to continue.`;
    if (kind === "KEYBOARD") return `Press ${extra.key || "a key"}${label ? ` in ${label}` : ""}.`;
    if (kind === "DROP") return `Drag ${extra?.source?.text || "the item"} onto ${label || fallback}.`;
    return `${kind === "NAVIGATION" ? "Open" : "Click"} ${label || fallback}.`;
  }

  function createStatusOverlay() {
    if (!isTopFrame || overlayHost) return;
    overlayHost = document.createElement("div");
    overlayHost.dataset.btrOverlay = "status";
    overlayHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:18px;right:18px;pointer-events:none;";
    overlayRoot = overlayHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .bar{font:600 12px system-ui;color:#fff;background:#1b2333;border:1px solid #37445b;border-radius:999px;
           padding:8px 12px;box-shadow:0 10px 32px #0b112055;display:flex;gap:10px;align-items:center}
      .dot{width:7px;height:7px;background:#ff7352;border-radius:50%;box-shadow:0 0 0 4px #ff735233}
      .muted{color:#aab6c9;font-weight:500}`;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.innerHTML = `<span class="dot"></span><span>Recording</span><span class="muted" data-count>0 steps</span>`;
    overlayRoot.append(style, bar);
    document.documentElement.appendChild(overlayHost);
  }

  function updateStatus(count) {
    const node = overlayRoot?.querySelector?.("[data-count]");
    if (node) node.textContent = `${count || 0} steps`;
  }

  function updateOverlayToPaused() {
    if (!overlayRoot) return;
    const bar = overlayRoot.querySelector(".bar");
    if (!bar) return;
    bar.style.background = "#3a4258";
    bar.style.borderColor = "#4a5468";
    const dot = bar.querySelector(".dot");
    if (dot) {
      dot.style.background = "#7a8499";
      dot.style.boxShadow = "0 0 0 4px #7a849933";
    }
    const label = bar.querySelector("span:nth-child(2)");
    if (label) label.textContent = "Paused";
  }

  function updateOverlayToRecording() {
    if (!overlayRoot) return;
    const bar = overlayRoot.querySelector(".bar");
    if (!bar) return;
    bar.style.background = "#1b2333";
    bar.style.borderColor = "#37445b";
    const dot = bar.querySelector(".dot");
    if (dot) {
      dot.style.background = "#ff7352";
      dot.style.boxShadow = "0 0 0 4px #ff735233";
    }
    const label = bar.querySelector("span:nth-child(2)");
    if (label) label.textContent = "Recording";
  }

  function hideStatus() {
    overlayHost?.remove();
    overlayHost = null;
    overlayRoot = null;
  }

  function showCaptureOverlay(payload) {

    const isMaskOnly = payload?.maskOnly === true;
    if (!isMaskOnly) {
      clearCapture();
    }

    if (isMaskOnly) {

      if (maskedInputs) return;
    }

    if (!isMaskOnly) {
      captureHost = document.createElement("div");
      captureHost.dataset.btrOverlay = "capture";
      captureHost.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
      captureRoot = captureHost.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = `
        .cursor{position:fixed;width:30px;height:38px;filter:drop-shadow(0 2px 4px #0006)}
        .cursor svg{display:block}
        .click{position:fixed;width:22px;height:22px;border:3px solid #ff7352;border-radius:50%;
               background:#ff735226;box-shadow:0 0 0 5px #ff735233}`;
      captureRoot.appendChild(style);

      if (payload?.point) {
        const click = document.createElement("div");
        click.className = "click";
        Object.assign(click.style, { left: `${payload.point.x - 11}px`, top: `${payload.point.y - 11}px` });
        captureRoot.appendChild(click);
      }

      if (payload?.showCursor && payload?.point) {
        const cursor = document.createElement("div");
        cursor.className = "cursor";
        cursor.innerHTML = `<svg width="30" height="38" viewBox="0 0 30 38">
          <path d="M2 2 L2 34 L10 26 L17 37 L23 33 L16 22 L28 22 Z" fill="#fff"
                stroke="#172238" stroke-width="2" stroke-linejoin="round"/></svg>`;
        Object.assign(cursor.style, { left: `${payload.point.x - 2}px`, top: `${payload.point.y - 2}px` });
        captureRoot.appendChild(cursor);
      }

      document.documentElement.appendChild(captureHost);
    }

    maskedInputs = [];

    const toMask = new Set();

    const FIELD_SELECTOR = "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='button']):not([type='submit']):not([type='image']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false']), input[type='password']";

    const collectFields = (root) => {
      if (!root || !root.querySelectorAll) return;
      try {
        const fields = root.querySelectorAll(FIELD_SELECTOR);
        for (const el of fields) {

          const ac = (el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
          const acSensitive = ac && /^(cc-|current-password|new-password|one-time-code)/.test(ac);
          if (el.type === "password" || acSensitive || /password/i.test(ac) || isSensitive(el)) {
            toMask.add(el);
          }
        }

        const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of allEls) {
          if (el.shadowRoot) collectFields(el.shadowRoot);

          if (el.tagName === "IFRAME") {
            try {
              const doc = el.contentDocument;
              if (doc) collectFields(doc);
            } catch (_) {  }
          }
        }
      } catch (_) {  }
    };
    collectFields(document);

    toMask.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const doc = el.ownerDocument || document;
      const overlay = doc.createElement("div");
      overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#1b2333;z-index:2147483645;display:flex;align-items:center;justify-content:center;font:600 14px system-ui;color:#7a8499;pointer-events:none;border-radius:${getComputedStyle(el).borderRadius};`;
      overlay.textContent = "••••";
      overlay.dataset.btrMask = "true";
      doc.documentElement.appendChild(overlay);
      maskedInputs.push({ overlay, element: el });
    });
  }

  function refreshMasks() {
    if (!maskedInputs) return;

    const FIELD_SELECTOR = "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='button']):not([type='submit']):not([type='image']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false']), input[type='password']";
    const collectFields = (root) => {
      if (!root || !root.querySelectorAll) return;
      try {
        const fields = root.querySelectorAll(FIELD_SELECTOR);
        for (const el of fields) {
          const ac = (el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
          const acSensitive = ac && /^(cc-|current-password|new-password|one-time-code)/.test(ac);
          if (el.type === "password" || acSensitive || /password/i.test(ac) || isSensitive(el)) {

            if (!maskedInputs.some((m) => m.element === el)) {
              const doc = el.ownerDocument || document;
              const overlay = doc.createElement("div");
              overlay.style.cssText = `position:fixed;background:#1b2333;z-index:2147483645;display:flex;align-items:center;justify-content:center;font:600 14px system-ui;color:#7a8499;pointer-events:none;border-radius:${getComputedStyle(el).borderRadius};`;
              overlay.textContent = "••••";
              overlay.dataset.btrMask = "true";
              doc.documentElement.appendChild(overlay);
              maskedInputs.push({ overlay, element: el });
            }
          }
        }
        const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of allEls) {
          if (el.shadowRoot) collectFields(el.shadowRoot);
          if (el.tagName === "IFRAME") {
            try {
              const doc = el.contentDocument;
              if (doc) collectFields(doc);
            } catch (_) {  }
          }
        }
      } catch (_) {  }
    };
    collectFields(document);

    for (const { overlay, element } of maskedInputs) {
      if (!overlay || !element) continue;
      if (!element.isConnected) {
        overlay.style.display = "none";
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) {
        overlay.style.display = "none";
        continue;
      }
      overlay.style.display = "flex";
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    }
  }

  function clearCapture() {
    captureHost?.remove();
    captureHost = null;
    captureRoot = null;

    if (maskedInputs) {
      for (const { overlay } of maskedInputs) {
        overlay?.remove();
      }
      maskedInputs = null;
    }
  }

  const CLICK_EVENTS = new Set([
    "CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "MIDDLE_CLICK",
    "CHECKBOX", "RADIO", "SELECT", "SUBMIT", "DROP"
  ]);

  function send(kind, element, event, extra = {}) {
    if (!active || paused || domainBlocked() || !element || isSensitive(element)) return Promise.resolve({ ok: false });

    const isClick = CLICK_EVENTS.has(kind);
    const point = isClick && event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      ? { clientX: event.clientX, clientY: event.clientY }
      : null;

    const target = targetOf(element, point);
    const cursorPoint = point || (target.point ? { clientX: target.point.x, clientY: target.point.y } : null);

    const navUrl = kind === "NAVIGATION" || kind === "NEW_TAB" || kind === "NEW_WINDOW" ? (extra.navigationUrl || "") : "";
    const key = `${kind}:${target.selectors[0] || target.tag}:${Math.round(target.boundingBox.x)}:${Math.round(target.boundingBox.y)}:${navUrl}`;
    if (kind !== "CLICK" && kind !== "DOUBLE_CLICK" && key === lastEventKey && Date.now() - lastEventAt < 500 && kind !== "TYPE") return Promise.resolve({ ok: false, deduped: true });
    lastEventKey = key;
    lastEventAt = Date.now();

    const message = {
      type: "RECORD_EVENT",
      event: kind,
      eventId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: describe(kind, element, extra),
      target,
      url: location.href,

      viewport: {
        width: topLevelViewport?.width || innerWidth,
        height: topLevelViewport?.height || innerHeight,
        devicePixelRatio: devicePixelRatio || 1
      },
      frame: { id: 0, url: location.href, isTop: isTopFrame },
      cursor: cursorPoint ? { x: cursorPoint.clientX, y: cursorPoint.clientY, visible: true } : null,

      ...(kind === "CLICK" ? { doubleClickDescription: describe("DOUBLE_CLICK", element, extra) } : {}),

      ...(frameNonce ? { frameNonce } : {}),

      ...(!isTopFrame ? { frameTransform: cumulativeTransform } : {}),
      ...extra
    };

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) { resolve({ ok: false }); return; }

          if (response?.ok && isTopFrame) updateStatus(response.stepNumber);
          resolve(response || { ok: false });
        });
      } catch (e) {

        resolve({ ok: false });
      }
    });
  }

  const ACTIONABLE = "button,a,input,select,textarea,[role='button'],[role='option'],[contenteditable]:not([contenteditable='false']),[tabindex]";

  document.addEventListener("contextmenu", (event) => {
    const el = event.target?.closest?.("a,button,input,select,textarea,[role='button'],[role='link']");
    if (el) send("RIGHT_CLICK", el, event);
  }, true);

  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const el = event.target?.closest?.("a,button,[role='link']");
    if (el) send("MIDDLE_CLICK", el, event);
  }, true);

  let suppressClickSubmitter = null;
  let suppressClickTimer = null;

  document.addEventListener("click", (event) => {

    if (suppressClickSubmitter && (event.target === suppressClickSubmitter || event.target?.closest?.(ACTIONABLE) === suppressClickSubmitter)) {
      return;
    }
    const el = event.target?.closest?.(ACTIONABLE);
    if (!el) return;
    if (el.matches("input[type='checkbox']") || el.matches("input[type='radio']")) return;

    if (el.tagName === "SELECT") return;

    if (event.detail === 2) {
      send("DOUBLE_CLICK", el, event);
      return;
    }

    if (event.detail >= 3) return;

    send("CLICK", el, event);
  }, true);

  document.addEventListener("change", (event) => {
    const el = event.target;
    if (!el || isSensitive(el)) return;
    if (el.tagName === "SELECT") {
      send("SELECT", el, event, {
        selectedValue: el.value,
        selectedText: el.selectedOptions?.[0]?.textContent?.trim() || ""
      });
    } else if (el.matches?.("input[type='checkbox']")) {
      send("CHECKBOX", el, event, { checked: el.checked });
    } else if (el.matches?.("input[type='radio']")) {
      send("RADIO", el, event, { checked: el.checked });
    }
  }, true);

  const EDITABLE_SELECTOR = "input:not([type='password']),textarea,[contenteditable]:not([contenteditable='false'])";
  document.addEventListener("focus", (event) => {
    const el = event.target;
    if (el?.matches?.(EDITABLE_SELECTOR) && !isSensitive(el)) {
      focusValues.set(el, el.value ?? el.textContent ?? "");
    }
  }, true);

  document.addEventListener("blur", (event) => {
    const el = event.target;
    if (el?.matches?.(EDITABLE_SELECTOR) && !isSensitive(el)) {
      const oldValue = focusValues.get(el) ?? "";
      const newValue = el.value ?? el.textContent ?? "";

      if (newValue !== oldValue) {

        const lengthDelta = newValue.length - oldValue.length;
        send("TYPE", el, event, {
          inputLength: newValue.length,
          charactersAdded: Math.max(0, lengthDelta),
          charactersRemoved: Math.max(0, -lengthDelta),
          isPaste: lengthDelta > 50
        });
      }
      focusValues.delete(el);
    }
  }, true);

  let isReSubmitting = false;
  document.addEventListener("submit", (event) => {

    if (isReSubmitting) return;

    const form = event.target;
    if (form?.tagName !== "FORM") return;
    const submitter = event.submitter || form.querySelector("button[type='submit'], input[type='submit']");
    const el = submitter || form;
    if (isSensitive(el)) return;

    if (!active || paused || domainBlocked()) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    suppressClickSubmitter = submitter || form;
    clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => { suppressClickSubmitter = null; }, 500);

    (async () => {
      try {

        await Promise.race([
          send("SUBMIT", el, event),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 5000))
        ]);
      } catch (_) {

      } finally {

        isReSubmitting = true;
        try {
          if (typeof form.requestSubmit === "function") {

            form.requestSubmit(submitter || undefined);
          } else {

            form.submit();
          }
        } catch (_) {

          try { form.submit(); } catch (__) {  }
        } finally {

          setTimeout(() => { isReSubmitting = false; }, 0);
        }
      }
    })();
  }, true);

  document.addEventListener("keydown", (event) => {
    const keys = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!keys.includes(event.key) && !(event.ctrlKey || event.metaKey)) return;
    const el = event.target?.closest?.(ACTIONABLE);
    if (el && !isSensitive(el)) {

      if (event.key === "Enter") {
        const isSubmitButton = el.tagName === "BUTTON" && (el.type === "submit" || el.type === "button");
        const isInForm = el.closest("form");
        if (isSubmitButton || isInForm) return;
      }
      send("KEYBOARD", el, event, {
        key: event.key,
        modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }
      });
    }
  }, true);

  document.addEventListener("dragstart", (event) => {
    dragSource = event.target?.closest?.("[draggable='true']") || event.target?.closest?.(ACTIONABLE) || null;
  }, true);

  document.addEventListener("dragend", () => {
    dragSource = null;
  }, true);

  document.addEventListener("drop", (event) => {
    if (!dragSource) return;
    const dest = event.target?.closest?.("*") || event.target;
    send("DROP", dest, event, { source: targetOf(dragSource, event), destination: targetOf(dest, event) });
    dragSource = null;
  }, true);

  const scrollStates = new WeakMap();

  function resolveScrollTarget(event) {

    if (!event) return window;
    const t = event.target;
    if (t === document || t === document.documentElement) return window;

    if (t instanceof ShadowRoot) return t.host || window;
    if (t.nodeType === 1) return t;
    return window;
  }

  function currentScrollPosition(scroller) {
    if (scroller === window) {
      return { top: scrollY, left: scrollX };
    }
    return {
      top: scroller.scrollTop || 0,
      left: scroller.scrollLeft || 0
    };
  }

  let isCaptureScrolling = false;
  function handleScrollEvent(event) {
    if (!active || paused) return;

    if (isCaptureScrolling) return;
    const scroller = resolveScrollTarget(event);
    if (!scroller) return;
    const pos = currentScrollPosition(scroller);

    let state = scrollStates.get(scroller);
    if (!state) {
      state = { timer: null, startTop: pos.top, startLeft: pos.left };
      scrollStates.set(scroller, state);
    } else if (state.timer === null) {

      state.startTop = pos.top;
      state.startLeft = pos.left;
    }

    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const state2 = scrollStates.get(scroller);
      if (!state2) return;

      const currentPos = currentScrollPosition(scroller);
      const distance = Math.abs(currentPos.top - state2.startTop);
      const horizontalDistance = Math.abs(currentPos.left - state2.startLeft);
      const threshold = Math.max(160, innerHeight * 0.25);

      if (distance >= threshold || horizontalDistance >= Math.max(160, innerWidth * 0.25)) {
        const targetEl = scroller === window ? (document.scrollingElement || document.body) : scroller;
        const direction = (distance >= horizontalDistance)
          ? (currentPos.top > state2.startTop ? "down" : "up")
          : (currentPos.left > state2.startLeft ? "right" : "left");
        send("SCROLL", targetEl, null, {
          direction,
          distance: Math.max(distance, horizontalDistance),
          viewportPosition: currentPos.top,
          isNestedScroller: scroller !== window
        });
        state2.startTop = currentPos.top;
        state2.startLeft = currentPos.left;
      }
      state2.timer = null;
    }, 550);
  }
  window.addEventListener("scroll", handleScrollEvent, { passive: true });

  document.addEventListener("scroll", handleScrollEvent, { passive: true, capture: true });

  function bumpActivity() { lastActivity = Date.now(); }

  function startIdleCheck() {
    if (idleTimer) clearInterval(idleTimer);
    if (!autoPauseIdle) return;
    lastActivity = Date.now();
    idleTimer = setInterval(() => {
      if (!active || paused) return;
      if (Date.now() - lastActivity > autoPauseIdle * 1000) {
        paused = true;
        try { chrome.runtime.sendMessage({ type: "PAUSE_FROM_IDLE" }).catch(() => {}); } catch (e) {}
      }
    }, 1000);
  }

  function stopIdleCheck() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  ["keydown", "click", "wheel"].forEach((evt) => {
    document.addEventListener(evt, bumpActivity, { passive: true, capture: true });
  });
  window.addEventListener("scroll", bumpActivity, { passive: true });

  let topLevelViewport = isTopFrame
    ? { width: innerWidth, height: innerHeight }
    : null;
  if (isTopFrame) {
    window.addEventListener("resize", () => {
      topLevelViewport = { width: innerWidth, height: innerHeight };
    }, { passive: true });
  }

  window.addEventListener("message", (event) => {
    if (event.source === window) return;
    const data = event.data;
    if (!data || data.type !== "BTR_FRAME_HANDSHAKE") return;
    if (!data.nonce) return;

    const findIframeByWindow = (root, source) => {
      if (!root || !root.querySelectorAll) return null;
      const iframes = root.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          if (iframe.contentWindow === source) return iframe;
        } catch (_) {  }
      }

      const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of allEls) {
        if (el.shadowRoot) {
          const found = findIframeByWindow(el.shadowRoot, source);
          if (found) return found;
        }
        if (el.tagName === "IFRAME") {
          try {
            const doc = el.contentDocument;
            if (doc) {
              const found = findIframeByWindow(doc, source);
              if (found) return found;
            }
          } catch (_) {  }
        }
      }
      return null;
    };
    const matchedIframe = findIframeByWindow(document, event.source);
    if (!matchedIframe) return;

    if (iframeRegistry) {
      for (const [oldNonce, entry] of iframeRegistry) {
        if (entry.iframe === matchedIframe && oldNonce !== data.nonce) {
          iframeRegistry.delete(oldNonce);
        }
      }
      iframeRegistry.set(data.nonce, { iframe: matchedIframe, innerWidth: Number(data.innerWidth) || 0, innerHeight: Number(data.innerHeight) || 0 });
    }

    sendTransformToChild(matchedIframe, data.nonce, Number(data.innerWidth) || 0, Number(data.innerHeight) || 0);
  });

  function sendTransformToChild(iframeEl, nonce, childInnerWidth, childInnerHeight) {
    if (!iframeEl) return;
    const rect = iframeEl.getBoundingClientRect();

    if (!childInnerWidth || !childInnerHeight) {

      childInnerWidth = rect.width || 1;
      childInnerHeight = rect.height || 1;
    }
    const scaleX = rect.width > 0 ? rect.width / childInnerWidth : 1;
    const scaleY = rect.height > 0 ? rect.height / childInnerHeight : 1;

    const parentScaleX = cumulativeTransform.scaleX ?? cumulativeTransform.scale ?? 1;
    const parentScaleY = cumulativeTransform.scaleY ?? cumulativeTransform.scale ?? 1;
    const childTransform = {
      offsetX: cumulativeTransform.offsetX + parentScaleX * rect.left,
      offsetY: cumulativeTransform.offsetY + parentScaleY * rect.top,
      scaleX: parentScaleX * scaleX,
      scaleY: parentScaleY * scaleY,
      scale: cumulativeTransform.scale * Math.sqrt(scaleX * scaleY)
    };
    try {
      iframeEl.contentWindow?.postMessage({
        type: "BTR_FRAME_HANDSHAKE_ACK",
        nonce,
        transform: childTransform,
        parentViewport: topLevelViewport || { width: innerWidth, height: innerHeight }
      }, "*");
    } catch (_) {  }
  }

  let transformRefreshTimer = null;
  function scheduleTransformRefresh() {
    if (!iframeRegistry || iframeRegistry.size === 0) return;

    for (const [nonce, entry] of iframeRegistry) {
      if (!entry.iframe || !entry.iframe.isConnected) {
        iframeRegistry.delete(nonce);
      }
    }
    if (iframeRegistry.size === 0) return;
    if (transformRefreshTimer) return;
    transformRefreshTimer = setTimeout(() => {
      transformRefreshTimer = null;
      if (!iframeRegistry) return;
      for (const [nonce, entry] of iframeRegistry) {
        if (entry.iframe && entry.iframe.isConnected) {
          sendTransformToChild(entry.iframe, nonce, entry.innerWidth, entry.innerHeight);
        }
      }
    }, 100);
  }

  window.addEventListener("scroll", scheduleTransformRefresh, { passive: true });

  document.addEventListener("scroll", scheduleTransformRefresh, { passive: true, capture: true });
  window.addEventListener("resize", scheduleTransformRefresh, { passive: true });

  if (typeof MutationObserver !== "undefined") {
    try {
      const mo = new MutationObserver(() => {

        if (!iframeRegistry || iframeRegistry.size === 0) return;
        scheduleTransformRefresh();
      });
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden"]
      });
    } catch (_) {  }
  }

  const iframeResizeObserver = (typeof ResizeObserver !== "undefined")
    ? new ResizeObserver((entries) => {

        if (!iframeRegistry || iframeRegistry.size === 0) return;
        for (const entry of entries) {
          for (const [nonce, reg] of iframeRegistry) {
            if (reg.iframe === entry.target) {
              scheduleTransformRefresh();
              return;
            }
          }
        }
      })
    : null;

  if (iframeRegistry && iframeResizeObserver) {
    const origSet = iframeRegistry.set.bind(iframeRegistry);
    iframeRegistry.set = function(nonce, entry) {
      origSet(nonce, entry);
      if (entry?.iframe) {
        try { iframeResizeObserver.observe(entry.iframe); } catch (_) {  }
      }
      return iframeRegistry;
    };
    const origDelete = iframeRegistry.delete.bind(iframeRegistry);
    iframeRegistry.delete = function(nonce) {
      const entry = iframeRegistry.get(nonce);
      if (entry?.iframe) {
        try { iframeResizeObserver.unobserve(entry.iframe); } catch (_) {  }
      }
      return origDelete(nonce);
    };

    const origClear = iframeRegistry.clear.bind(iframeRegistry);
    iframeRegistry.clear = function() {
      for (const [, entry] of iframeRegistry) {
        if (entry?.iframe) {
          try { iframeResizeObserver.unobserve(entry.iframe); } catch (_) {  }
        }
      }
      return origClear();
    };
  }

  if (!isTopFrame && frameNonce) {
    const sendHandshake = (attempt) => {
      try {
        window.parent.postMessage({
          type: "BTR_FRAME_HANDSHAKE",
          nonce: frameNonce,
          url: location.href,
          innerWidth: innerWidth,
          innerHeight: innerHeight
        }, "*");
      } catch (_) {  }

      if (attempt < 5 && handshakeRetry !== null) {
        handshakeRetry = setTimeout(() => sendHandshake(attempt + 1), 100 * Math.pow(2, attempt));
      }
    };
    let handshakeRetry = 0;
    let lastInnerWidth = innerWidth;
    let lastInnerHeight = innerHeight;

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.type !== "BTR_FRAME_HANDSHAKE_ACK" || data.nonce !== frameNonce) return;
      if (data.transform) {
        cumulativeTransform = data.transform;
      }
      if (data.parentViewport) {
        topLevelViewport = data.parentViewport;
      }

      if (handshakeRetry !== null && handshakeRetry > 0) {
        clearTimeout(handshakeRetry);
      }
      handshakeRetry = null;
    });

    let resizeRehandshakeTimer = null;
    window.addEventListener("resize", () => {
      if (innerWidth === lastInnerWidth && innerHeight === lastInnerHeight) return;
      lastInnerWidth = innerWidth;
      lastInnerHeight = innerHeight;
      if (resizeRehandshakeTimer) clearTimeout(resizeRehandshakeTimer);
      resizeRehandshakeTimer = setTimeout(() => {
        resizeRehandshakeTimer = null;

        handshakeRetry = 1;
        sendHandshake(0);
      }, 200);
    }, { passive: true });

    handshakeRetry = 1;
    sendHandshake(0);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.type === "RECORDER_STOP") {
      (async () => {

        if (active && document.activeElement) {
          const el = document.activeElement;
          const EDITABLE_SELECTOR_FLUSH = "input:not([type='password']),textarea,[contenteditable]:not([contenteditable='false'])";
          if (el.matches?.(EDITABLE_SELECTOR_FLUSH) && !isSensitive(el)) {
            const oldValue = focusValues.get(el) ?? "";
            const newValue = el.value ?? el.textContent ?? "";
            if (newValue !== oldValue) {
              const lengthDelta = newValue.length - oldValue.length;
              await send("TYPE", el, null, {
                inputLength: newValue.length,
                charactersAdded: Math.max(0, lengthDelta),
                charactersRemoved: Math.max(0, -lengthDelta),
                isPaste: lengthDelta > 50
              });
            }
            focusValues.delete(el);
          }
        }
        active = false;
        paused = false;
        stopIdleCheck();
        hideStatus();
        clearCapture();
        lastEventKey = "";
        lastEventAt = 0;
        suppressClickSubmitter = null;
        clearTimeout(suppressClickTimer);
        if (transformRefreshTimer) { clearTimeout(transformRefreshTimer); transformRefreshTimer = null; }
        if (iframeRegistry) iframeRegistry.clear();
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (message.type === "RECORDER_START" || message.type === "RECORDER_ATTACH") {
      excludedDomains = message.excludedDomains || [];

      if (message.settings && typeof message.settings.sensitivePatterns === "string") {
        sensitivePatterns = message.settings.sensitivePatterns;
      }
      if (message.settings && typeof message.settings.autoPauseIdle === "number") {
        autoPauseIdle = message.settings.autoPauseIdle;
      }
      const isExcluded = domainBlocked();
      active = true;

      clearCapture();

      if (isExcluded) {

        paused = true;
        if (isTopFrame) {
          createStatusOverlay();
          updateOverlayToPaused();
        }
      } else {

        paused = message.paused === true;
        if (isTopFrame) createStatusOverlay();
      }

      if (message.settings && typeof message.settings.autoPauseIdle === "number") startIdleCheck();

      if (isTopFrame) { sendResponse({ ok: true }); return; }
    }
    if (message.type === "RECORDER_PAUSE") {
      paused = true;
      if (isTopFrame) updateOverlayToPaused();
    }
    if (message.type === "RECORDER_RESUME") {

      if (domainBlocked()) {
        paused = true;
        if (isTopFrame) updateOverlayToPaused();
      } else {
        paused = false;
        lastActivity = Date.now();
        if (active && isTopFrame) {
          createStatusOverlay();
          updateOverlayToRecording();
        }
      }
    }
    if (message.type === "HIDE_STATUS" && isTopFrame) {
      hideStatus();

      setTimeout(() => sendResponse({ ok: true }), 50);
      return true;
    }
    if (message.type === "SHOW_STATUS" && isTopFrame && active && !paused) {
      createStatusOverlay();
      updateStatus(message.count || 0);
    }
    if (message.type === "PREPARE_CAPTURE") showCaptureOverlay(message);
    if (message.type === "CLEAR_CAPTURE") clearCapture();

    if (message.type === "HIDE_FIXED_ELEMENTS") {
      try {

        const hidden = window.__btr_hidden_fixed || [];
        const visit = (root) => {
          if (!root || !root.querySelectorAll) return;
          const allEls = root.querySelectorAll("*");
          for (const el of allEls) {
            if (!el.style) continue;
            const style = getComputedStyle(el);
            if ((style.position === "fixed" || style.position === "sticky") && el !== document.body) {

              if (el.style.visibility === "hidden") continue;
              hidden.push({ el, visibility: el.style.visibility });
              el.style.visibility = "hidden";
            }

            if (el.shadowRoot) visit(el.shadowRoot);
          }
        };
        visit(document);
        window.__btr_hidden_fixed = hidden;
      } catch (_) {  }
    }
    if (message.type === "RESTORE_FIXED_ELEMENTS") {
      try {
        if (window.__btr_hidden_fixed) {
          for (const { el, visibility } of window.__btr_hidden_fixed) {
            try { el.style.visibility = visibility; } catch (_) {  }
          }
          delete window.__btr_hidden_fixed;
        }
      } catch (_) {  }
    }

    if (message.type === "CAPTURE_SCROLL_START") {
      isCaptureScrolling = true;
    }
    if (message.type === "CAPTURE_SCROLL_END") {
      isCaptureScrolling = false;
    }

    if (message.type === "REFRESH_MASKS") {
      try {
        refreshMasks();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return true;
    }

    if (message.type === "GET_IFRAME_OFFSET" && isTopFrame && iframeRegistry) {
      try {
        let offset = null;

        if (message.nonce) {
          const entry = iframeRegistry.get(message.nonce);

          const iframeEl = entry?.iframe || entry;
          if (iframeEl && typeof iframeEl.getBoundingClientRect === "function") {
            const rect = iframeEl.getBoundingClientRect();
            offset = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          }
        }

        if (!offset && message.url) {
          const iframes = document.querySelectorAll("iframe");
          for (const iframe of iframes) {
            let src = iframe.src || "";
            try { if (src) src = new URL(src, location.href).href; } catch (_) {}
            if (src && src === message.url) {
              const rect = iframe.getBoundingClientRect();
              offset = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
              break;
            }
          }
        }
        sendResponse({ ok: !!offset, offset });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return true;
    }

    if (!active || !isTopFrame) return;

    if (message.type === "RECORDER_NAVIGATION") {
      send("NAVIGATION", document.body, null, { navigationUrl: message.url || location.href });
    }
    if (message.type === "RECORDER_NEW_TAB") {
      send("NEW_TAB", document.body, null, { navigationUrl: message.url || location.href });
    }
    if (message.type === "RECORDER_NEW_WINDOW") {
      send("NEW_WINDOW", document.body, null, { navigationUrl: message.url || location.href });
    }
  });

  let lastSpaUrl = location.href;
  const patchHistoryMethod = (method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      if (active && !paused && !domainBlocked() && isTopFrame && location.href !== lastSpaUrl) {
        lastSpaUrl = location.href;
        send("NAVIGATION", document.body, null, { navigationUrl: location.href });
      }
      return result;
    };
  };
  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
  window.addEventListener("popstate", () => {
    if (active && !paused && !domainBlocked() && isTopFrame && location.href !== lastSpaUrl) {
      lastSpaUrl = location.href;
      send("NAVIGATION", document.body, null, { navigationUrl: location.href });
    }
  });
})();
