// Content script: listens to user interactions on the page and forwards
// them to the background service worker for screenshot capture.
// Runs as a classic IIFE (content scripts cannot use ES module imports).

(function () {
  if (window.__browserTutorialRecorderLoaded) return;
  window.__browserTutorialRecorderLoaded = true;

  const isTopFrame = window.top === window;

  let active = false;
  let paused = false;
  let excludedDomains = [];
  let lastEventKey = "";
  let lastEventAt = 0;
  // P1-1 v1.5.1: scrollTimer / scrollStart removed — per-element scroll state
  // now lives in a WeakMap inside handleScrollEvent. See comments there.
  let dragSource = null;
  // Track focus values to detect actual changes before recording TYPE events.
  const focusValues = new WeakMap();
  let overlayHost = null;
  let overlayRoot = null;
  let captureHost = null;
  let captureRoot = null;
  // P0 fix: track masked inputs so they can be restored after screenshot
  let maskedInputs = null;
  // Configurable sensitive-field regex; defaults to the same patterns the
  // background service worker ships. Updated from RECORDER_START / ATTACH.
  // NH1 fix: expanded default regex to also catch HTML5 payment autocomplete tokens
  // (cc-number, cc-csc, cc-exp, cc-name, cc-type) that the previous regex
  // missed ("cc-number" does not contain "credit" or "card"). Also added
  // security.?code for the CSC field often labeled differently from "cvv".
  let sensitivePatterns = "password|passcode|secret|token|api.?key|authorization|credit.?card|card.?number|cvv|csc|cc-|security.?code|otp|one.?time";
  // Auto-pause-after-N-seconds-of-inactivity (0 disables). From settings.
  let autoPauseIdle = 0;
  let lastActivity = Date.now();
  let idleTimer = null;

  // P1-2 v1.5.1 → v1.5.2: Cross-origin iframe coordinate translation.
  //
  // Clicks that originate in an iframe carry frame-local clientX/clientY,
  // but the screenshot captures the whole top-level viewport. Without
  // translation, the editor would draw the cursor/halo at the wrong location.
  //
  // v1.5.2 redesign: instead of the background querying the top-level frame
  // for each iframe's offset on every click (which only worked for ONE level
  // of nesting and didn't handle CSS scaling), each iframe's content script
  // now computes its own CUMULATIVE TRANSFORM at init time and includes it
  // in every RECORD_EVENT message. The transform is:
  //
  //   topLevelPoint = transform.offset + transform.scale * frameLocalPoint
  //
  // This handles:
  //   - Arbitrary nesting depth (iframe → iframe → iframe → ... → top)
  //   - CSS scaling (`transform: scale(0.8)` on an iframe shrinks its
  //     rendered size relative to its internal viewport, so the cumulative
  //     scale accumulates multiplicatively)
  //   - Cross-origin iframes (postMessage works across origins; the parent
  //     reads only event.source matching, never the child's DOM)
  //
  // Handshake protocol:
  //   1. Each non-top frame generates a nonce and sends a BTR_FRAME_HANDSHAKE
  //      postMessage to its parent. The message includes the iframe's own
  //      innerWidth/innerHeight (so the parent can compute the scale).
  //   2. The parent matches event.source to one of its <iframe> elements,
  //      reads the iframe's getBoundingClientRect(), and replies via
  //      postMessage with:
  //        - parentCumulativeOffset (the parent's own cumulative offset)
  //        - parentCumulativeScale (the parent's own cumulative scale)
  //        - rectInParent (the iframe's rect in the parent's coordinate system)
  //      The parent computes the iframe's scale as
  //        rectInParent.width / iframeReportedInnerWidth
  //      and the iframe's cumulative transform as:
  //        offset = parentCumulativeOffset + parentCumulativeScale * rectInParent.left/top
  //        scale  = parentCumulativeScale * (rectInParent.width / iframeReportedInnerWidth)
  //   3. The iframe stores its cumulative transform and includes it in every
  //      RECORD_EVENT message. Background uses the transform (no per-click
  //      lookup needed).
  //
  // Until the handshake completes (e.g., parent not yet loaded), the iframe
  // uses identity transform {offset: {x:0, y:0}, scale: 1} — clicks in those
  // first few hundred ms may have frame-local coords. Acceptable trade-off.
  const frameNonce = isTopFrame ? null
    : (crypto?.randomUUID?.() || `btr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // C5 fix: every frame needs its own iframeRegistry, not just the top frame.
  // The old `isTopFrame ? new Map() : null` meant intermediate iframes couldn't
  // maintain registries for their OWN child iframes — so transforms for
  // deeply-nested iframes (iframe → iframe → iframe) went stale after the
  // initial handshake when an ancestor scrolled or resized.
  // Now every frame has a registry. The existing `isTopFrame` checks around
  // top-level-only behavior (e.g., status overlay) remain unchanged.
  const iframeRegistry = new Map();
  // Every frame's cumulative transform from its own coordinate system to
  // the top-level viewport. Top frame: identity. Iframes: computed via the
  // handshake. Background reads this via the FRAME_TRANSFORM message field.
  let cumulativeTransform = { offsetX: 0, offsetY: 0, scale: 1 };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const cssEscape = (value) => {
    try { return CSS.escape(value); }
    catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  };

  const domainBlocked = () => {
    const host = location.hostname.toLowerCase();
    return excludedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  };

  // v1.2.1 #1: Never fall back to .value for labeling — it leaks the user's
  // typed text (emails, names, search queries) into step descriptions and
  // exports. For inputs/textareas, derive the label from accessibility
  // metadata only. The .value fallback is reserved for <input type="submit">
  // where the value IS the button label.
  const elementText = (el) => {
    if (!el) return "";
    // For form fields, never read .value (privacy)
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      // type="submit"/"button" — the value IS the label
      if (el.type === "submit" || el.type === "button" || el.type === "reset") {
        return (el.value || "").trim().replace(/\s+/g, " ").slice(0, 120);
      }
      // Everything else: use accessibility metadata only
      return (el.getAttribute?.("aria-label") || el.getAttribute?.("title") || el.placeholder || el.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
    }
    return (el.innerText || el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "").trim().replace(/\s+/g, " ").slice(0, 120);
  };

  const stableId = (id) => id && !/^\d+$/.test(id) && !/(react|vue|ember|random|uuid|select-\d+)/i.test(id) ? id : null;

  function isSensitive(element) {
    // NH2 + NH3 fix: broaden selector to include the boolean-shorthand
    // contenteditable and <select> elements (previously only
    // [contenteditable='true'] and input/textarea matched).
    const input = element?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
    if (!input) return false;
    if (input.type === "password") return true;
    // P2 fix: empty regex matches everything — treat empty as "no patterns"
    const patterns = String(sensitivePatterns || "").trim();
    if (!patterns) return false;
    // P1-4 fix: include associated <label> text in the detection haystack.
    // v1.6.3 fix: use input.ownerDocument (not the outer `document`) so that
    // fields inside same-origin iframes find their <label> in the iframe's
    // own document, not the parent's. Without this, label-based sensitivity
    // detection silently failed for anything inside an iframe.
    const doc = input.ownerDocument || document;
    let labelText = "";
    if (input.id) {
      const label = doc.querySelector(`label[for="${cssEscape(input.id)}"]`);
      if (label) labelText = label.textContent || "";
    }
    // Also check <label> that wraps the input
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

  // Build a list of CSS selectors that should match this element, most specific first.
  function selectors(element) {
    if (!element || element.nodeType !== 1) return [];
    const list = [];
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy");
    if (testId) {
      // P2 fix: use the correct attribute name, not always data-testid
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

    // Walk up a few parents to build a structural path.
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
      // P2 fix: only generate aria-label selector if the element actually
      // has an aria-label attribute. Using text as aria-label when none
      // exists produces a selector that won't match.
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
    // v1.2.1 #7: for SELECT, use the dropdown's label (aria-label/name),
    // not elementText which returns the selected option's text.
    let label;
    if (element?.tagName === "SELECT") {
      label = element.getAttribute?.("aria-label") || element.getAttribute?.("title") || element.name || "";
    } else {
      label = elementText(element) || element?.getAttribute?.("aria-label") || element?.getAttribute?.("placeholder") || element?.getAttribute?.("title");
    }
    // B24: if we can't find any label, use the tag name + position context
    // so the step description is at least identifiable (was "the selected element").
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

  // ---------------------------------------------------------------------------
  // Status overlay (recording badge, top frame only)
  // ---------------------------------------------------------------------------

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

  // Reflect the paused state in the badge so the user gets visual feedback (H7).
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

  // H15: restore the recording-appearance after a pause→resume transition.
  // createStatusOverlay is a no-op when the overlay already exists, so we
  // need to explicitly revert the paused styles.
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

  // ---------------------------------------------------------------------------
  // Capture overlay (cursor + click halo painted just before screenshot)
  // ---------------------------------------------------------------------------

  function showCaptureOverlay(payload) {
    // v1.6.7 fix: don't clearCapture() when maskOnly is true. The previous
    // code called clearCapture() unconditionally at the top, which meant the
    // all-frame maskOnly broadcast would erase the cursor/halo that the
    // event's own frame had just painted in the first PREPARE_CAPTURE call.
    // Now we only clear (and rebuild) when this is NOT a mask-only call.
    const isMaskOnly = payload?.maskOnly === true;
    if (!isMaskOnly) {
      clearCapture();
    }
    // P0-2 v1.5.2 fix: when payload.maskOnly is true, ONLY apply sensitive-field
    // masks — do NOT paint the cursor or click halo. The background sends
    // maskOnly:true when broadcasting PREPARE_CAPTURE to ALL frames (so every
    // frame masks its own sensitive fields). Without this check, every frame
    // would paint the cursor/halo at the event's frame-local coordinates,
    // producing duplicate/misplaced cursor indicators in screenshots of
    // iframe-containing pages.
    //
    // The event's own frame (frameId === sender.frameId) gets the full
    // payload (maskOnly absent or false) and paints the cursor/halo there.
    // Other frames get maskOnly:true and skip cursor/halo painting.
    if (isMaskOnly) {
      // Still need to set up maskedInputs for REFRESH_MASKS to work.
      // But DON'T clearCapture() — the event frame's cursor/halo must survive.
      // Only apply masks if we haven't already (the event frame already has
      // masks from its first PREPARE_CAPTURE call; other frames need them).
      // We check if maskedInputs is already populated (event frame) and skip
      // re-masking in that case.
      if (maskedInputs) return; // already has masks from the first call
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

    // P0 fix: mask sensitive inputs before screenshot so passwords/tokens
    // don't appear in the captured image. Use overlay divs instead of mutating
    // .value (P0-03 fix: framework-controlled inputs can revert mutations).
    // P1-13 fix: also mask textarea and contenteditable elements.
    // P0-3 fix: use the SAME isSensitive() check as event filtering, which
    // includes associated <label> text. Previously the masking code had its
    // own separate hay construction that missed labels.
    maskedInputs = [];

    // P1-7 v1.5.2 fix: discover sensitive fields RECURSIVELY — descend into
    // shadow DOM roots and same-origin iframe documents. The previous code
    // used document.querySelectorAll which only sees the top-level light DOM;
    // a <input type="password"> inside a custom element's shadow root would
    // escape masking and appear in the screenshot — a serious privacy leak.
    //
    // The traversal mirrors the fixed/sticky-hiding traversal in
    // captureFullPage: walk the document, descend into every shadowRoot,
    // and descend into every same-origin iframe's contentDocument. Cross-origin
    // iframes can't be inspected from here — their own content script masks
    // their fields (PREPARE_CAPTURE is broadcast to all frames).
    const toMask = new Set();
    // NH2 fix: use [contenteditable]:not([contenteditable='false']) instead of
    // [contenteditable='true'] so the boolean shorthand (<div contenteditable>) and
    // the empty-string form (<div contenteditable="">) are also matched.
    // NH3 fix: include `select` so sensitive SELECT elements (security-question
    // answers, account pickers, country selectors) are masked during capture.
    const FIELD_SELECTOR = "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='button']):not([type='submit']):not([type='image']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false']), input[type='password']";

    const collectFields = (root) => {
      if (!root || !root.querySelectorAll) return;
      try {
        const fields = root.querySelectorAll(FIELD_SELECTOR);
        for (const el of fields) {
          // Always mask password fields explicitly; others via isSensitive()
          // NH1 fix: also explicitly mask fields whose autocomplete attr starts
          // with cc-, one-time-code, current-password, or new-password — these
          // are HTML5 standard tokens that may not match the regex if the field
          // has no other identifying name/id/label.
          const ac = (el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
          const acSensitive = ac && /^(cc-|current-password|new-password|one-time-code)/.test(ac);
          if (el.type === "password" || acSensitive || /password/i.test(ac) || isSensitive(el)) {
            toMask.add(el);
          }
        }
        // Recurse into shadow roots of every element in this root.
        const allEls = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const el of allEls) {
          if (el.shadowRoot) collectFields(el.shadowRoot);
          // Recurse into same-origin iframes (cross-origin throws on contentDocument).
          if (el.tagName === "IFRAME") {
            try {
              const doc = el.contentDocument;
              if (doc) collectFields(doc);
            } catch (_) { /* cross-origin — its own content script masks */ }
          }
        }
      } catch (_) { /* permission issues, detached nodes, etc. */ }
    };
    collectFields(document);

    // P0-03 fix: use overlay divs instead of mutating .value
    // P1-6 v1.5.1 fix: store the element alongside its overlay so we can
    //   re-query the rect at the LATEST possible moment (REFRESH_MASKS message)
    //   — layout shifts during the 220ms captureDelay could leave masks
    //   misaligned with the elements they cover, exposing sensitive values.
    // v1.6.3 fix: create the overlay in the element's OWNER document (not
    //   always the outer `document`) and append it there. For fields inside
    //   same-origin iframes, getBoundingClientRect() returns coordinates
    //   relative to the IFRAME's viewport. If we appended the overlay to the
    //   outer document, the mask would render at the wrong position. By
    //   appending to the iframe's own documentElement, the overlay's
    //   position:fixed coordinates are interpreted in the iframe's coordinate
    //   system, which matches the field's getBoundingClientRect() — so the
    //   mask appears over the right element.
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

  // P1-6 v1.5.1 fix: re-anchor every mask to its element's CURRENT rect.
  // Called by the background right before captureVisibleTab, so any layout
  // shift that happened during the 220ms captureDelay is corrected.
  function refreshMasks() {
    if (!maskedInputs) return;
    // C1 fix: full-page capture re-discovers sensitive fields on every refresh.
    // The masks are position:fixed, so when the page scrolls, the sensitive
    // element moves but the mask doesn't. Also, lazy-loaded content may have
    // introduced NEW sensitive fields since the initial PREPARE_CAPTURE.
    // Re-run the discovery and add overlays for any new fields found.
    const FIELD_SELECTOR = "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='button']):not([type='submit']):not([type='image']):not([type='reset']), textarea, select, [contenteditable]:not([contenteditable='false']), input[type='password']";
    const collectFields = (root) => {
      if (!root || !root.querySelectorAll) return;
      try {
        const fields = root.querySelectorAll(FIELD_SELECTOR);
        for (const el of fields) {
          const ac = (el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
          const acSensitive = ac && /^(cc-|current-password|new-password|one-time-code)/.test(ac);
          if (el.type === "password" || acSensitive || /password/i.test(ac) || isSensitive(el)) {
            // Only add if not already masked
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
            } catch (_) { /* cross-origin — its own content script masks */ }
          }
        }
      } catch (_) { /* permission issues, detached nodes, etc. */ }
    };
    collectFields(document);

    // Now reposition all masks (old + new) to their elements' current rects.
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
    // P0-03 fix: remove overlay divs (no value restoration needed)
    if (maskedInputs) {
      for (const { overlay } of maskedInputs) {
        overlay?.remove();
      }
      maskedInputs = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Send an event to the background service worker
  // ---------------------------------------------------------------------------

  // Events that originate from a pointer click — only these carry a usable
  // clientX/clientY. Other event types (TYPE, KEYBOARD, SCROLL, NAVIGATION)
  // should not attach a synthetic point.
  const CLICK_EVENTS = new Set([
    "CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "MIDDLE_CLICK",
    "CHECKBOX", "RADIO", "SELECT", "SUBMIT", "DROP"
  ]);

  // v1.5.1 P0-1 v3 fix: send() now returns a Promise that resolves once the
  // background has fully processed the event (screenshot captured + persisted +
  // overlays cleaned up). Existing callers can ignore the return value; the
  // SUBMIT handler awaits it so we can guarantee the screenshot is taken
  // BEFORE native navigation runs (see submit listener below).
  function send(kind, element, event, extra = {}) {
    if (!active || paused || domainBlocked() || !element || isSensitive(element)) return Promise.resolve({ ok: false });

    // P0-1 v2: removed cross-origin iframe blocking. The manifest has
    // "all_frames": true, so the content script runs in all frames.
    // Cross-origin iframe interactions should be recorded — the screenshot
    // is of the whole visible tab, so the iframe's content is visible.
    // P1-2 (v1.5.1): coordinates are translated to top-level viewport space
    // in the background via the FRAME_OFFSET query (see background.js), so
    // the cursor/halo is drawn at the correct location even for iframe clicks.

    const isClick = CLICK_EVENTS.has(kind);
    const point = isClick && event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      ? { clientX: event.clientX, clientY: event.clientY }
      : null;

    const target = targetOf(element, point);
    const cursorPoint = point || (target.point ? { clientX: target.point.x, clientY: target.point.y } : null);

    // Debounce identical clicks so a single user action only records once.
    // For NAVIGATION events, include the URL in the key so consecutive SPA
    // navigations to different URLs aren't dropped (B7/L7).
    // v1.6.5 fix: exempt CLICK from content-side dedup entirely. The background's
    // recordClickWithDedup() handles double-click detection via a 150ms hold +
    // event.detail. If content deduped a second CLICK (e.g., when event.detail
    // doesn't reach 2 due to focus-stealing or programmatic clicks), the
    // background would never see it and the double-click would be lost.
    // Other event types (SCROLL, KEYBOARD, etc.) still dedup normally.
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
      // P1-1 v1.5.2 fix: report the TOP-LEVEL viewport dimensions (not the
      // iframe's own). The screenshot captures the whole tab, so storing
      // iframe viewport dims here would mismatch the screenshot's actual size.
      // For the top frame, topLevelViewport is just {innerWidth, innerHeight}.
      // For iframes, it's filled in by the parent via BTR_FRAME_HANDSHAKE_ACK.
      // Fall back to the local viewport if the handshake hasn't completed yet.
      viewport: {
        width: topLevelViewport?.width || innerWidth,
        height: topLevelViewport?.height || innerHeight,
        devicePixelRatio: devicePixelRatio || 1
      },
      frame: { id: 0, url: location.href, isTop: isTopFrame },
      cursor: cursorPoint ? { x: cursorPoint.clientX, y: cursorPoint.clientY, visible: true } : null,
      // P0-2 v2 (v1.5.1): for CLICK events, pre-compute the DOUBLE_CLICK
      // description so the background can convert a held CLICK to a
      // DOUBLE_CLICK step without needing to re-run describe() (which
      // only content has access to). Background uses this field only
      // when a second CLICK arrives on the same element within 150ms.
      ...(kind === "CLICK" ? { doubleClickDescription: describe("DOUBLE_CLICK", element, extra) } : {}),
      // P1-2 v1.5.2: include the cumulative transform from this frame's
      // coordinate system to the top-level viewport. Background applies this
      // transform to target.point / boundingBox / cursor to translate them
      // to viewport space. For the top frame, the transform is identity
      // ({offset: 0, scale: 1}). For iframes, it's filled in by the parent
      // via the BTR_FRAME_HANDSHAKE_ACK handshake.
      // Also include the frameNonce for backwards-compat with the old
      // GET_IFRAME_OFFSET lookup path (still works as a fallback).
      ...(frameNonce ? { frameNonce } : {}),
      // Only include the transform if it's non-identity (saves bandwidth
      // and avoids breaking tests that expect plain messages from top frame).
      ...(!isTopFrame ? { frameTransform: cumulativeTransform } : {}),
      ...extra
    };

    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
          // v1.0.3: response now returns stepNumber (not the full step object).
          if (response?.ok && isTopFrame) updateStatus(response.stepNumber);
          resolve(response || { ok: false });
        });
      } catch (e) {
        // Content script context may be torn down — resolve gracefully.
        resolve({ ok: false });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // DOM event listeners
  // ---------------------------------------------------------------------------

  // lastPointer tracking removed (M12: dead code — set but never read).
  // Keeping a pointermove listener would let us paint a cursor on
  // non-click events, but the current design only marks click points.

  // D12 fix: use [contenteditable]:not([contenteditable='false']) (matching
  // the sensitivity check and TYPE tracking) instead of [contenteditable='true'].
  // The boolean shorthand (<div contenteditable>) was masked and tracked for
  // TYPE events but wasn't actionable for clicks — the two parts of the
  // recorder disagreed about what constitutes an actionable editable element.
  const ACTIONABLE = "button,a,input,select,textarea,[role='button'],[role='option'],[contenteditable]:not([contenteditable='false']),[tabindex]";

  // P0-2 fix: click handler moved below (combined with double-click state machine)

  document.addEventListener("contextmenu", (event) => {
    const el = event.target?.closest?.("a,button,input,select,textarea,[role='button'],[role='link']");
    if (el) send("RIGHT_CLICK", el, event);
  }, true);

  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const el = event.target?.closest?.("a,button,[role='link']");
    if (el) send("MIDDLE_CLICK", el, event);
  }, true);

  // P0-2 v2 fix (v1.5.1): removed the in-content double-click hold entirely.
  // Previously the content script held each CLICK for 150ms before sending,
  // to detect a possible second click (and convert to DOUBLE_CLICK). That
  // introduced a small but real loss window: if the click caused immediate
  // navigation, the page tore down before the 150ms timer fired, and
  // flushPendingClick() had to send the message during pagehide — which is
  // not guaranteed to be delivered before the document is destroyed.
  //
  // The new approach: send the CLICK message IMMEDIATELY in the capture
  // phase. The IPC is queued synchronously by chrome.runtime.sendMessage,
  // so it's already in flight by the time the click handler returns and the
  // browser proceeds with its default action (potential navigation).
  //
  // Double-click detection now lives in the BACKGROUND service worker,
  // whose 150ms timer is independent of any page's lifecycle. See
  // recordClickWithDedup() in background.js.
  //
  // dblclick listener is now a no-op: background detects double-clicks by
  // observing two CLICK messages on the same element within 150ms. We keep
  // the listener registered (as a no-op) so future per-element dblclick
  // metadata could be attached if needed.

  // P1-1: set by the submit handler so the click that triggered the submit
  // doesn't also produce a duplicate CLICK step. Declared up here because
  // the click listener (below) reads it before the submit listener sets it.
  // B9 fix: scope suppression to the specific submitter element instead of
  // a global boolean. The old global flag swallowed ANY click within 500ms of
  // a submit — including an unrelated click on another control. Now we store
  // the submitter element and only suppress clicks whose target matches it.
  let suppressClickSubmitter = null;
  let suppressClickTimer = null;

  document.addEventListener("click", (event) => {
    // B9 fix: only suppress the click if its target is the submitter that
    // triggered the recent submit. The old global flag swallowed any click
    // within 500ms of a submit.
    if (suppressClickSubmitter && (event.target === suppressClickSubmitter || event.target?.closest?.(ACTIONABLE) === suppressClickSubmitter)) {
      return;
    }
    const el = event.target?.closest?.(ACTIONABLE);
    if (!el) return;
    if (el.matches("input[type='checkbox']") || el.matches("input[type='radio']")) return;
    // P1 v1.6.0 fix: skip <select> elements entirely — clicking a <select>
    // just opens the dropdown. The semantic action (selecting an option)
    // fires a `change` event, which the change listener records as SELECT.
    // Without this skip, a single select-option action produced two steps:
    //   1. CLICK (from the click handler classifying tagName==="SELECT" as SELECT)
    //   2. SELECT (from the change listener)
    if (el.tagName === "SELECT") return;

    // P2-1 v1.5.2 fix: use event.detail to detect double-clicks RELIABLY
    // instead of relying on a 150ms timer. event.detail is the click count
    // from the current click sequence (set by the browser based on the OS's
    // configured double-click interval — typically 200-500ms). When detail>=2,
    // the browser itself has confirmed this is a double-click.
    //
    // v1.6.7 fix: only send DOUBLE_CLICK for detail === 2. For detail >= 3
    // (triple-click, quadruple-click), the first DOUBLE_CLICK has already
    // been sent and the prior CLICK has been retracted. Sending another
    // DOUBLE_CLICK for detail=3 would produce a duplicate step with no
    // preceding CLICK to retract. Most apps treat triple-click as a single
    // semantic action (e.g., select-all), so suppressing the additional
    // DOUBLE_CLICK messages is the correct behavior.
    if (event.detail === 2) {
      send("DOUBLE_CLICK", el, event);
      return;
    }
    // detail >= 3: suppress — the double-click was already recorded at detail=2
    if (event.detail >= 3) return;
    // P0-2 v2: send immediately — no holding. Background deduplicates
    // potential double-clicks via recordClickWithDedup().
    send("CLICK", el, event);
  }, true);

  document.addEventListener("dblclick", (_event) => {
    // No-op. P2-1 v1.5.2: double-clicks are now detected via event.detail
    // in the click handler above (event.detail >= 2 means the browser itself
    // confirmed a double-click). The dblclick listener is kept registered
    // for future use (e.g., per-element dblclick metadata) but currently
    // does nothing.
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

  // Track focus to detect actual value changes (avoid recording TYPE for untouched fields).
  // B10 fix: use [contenteditable]:not([contenteditable='false']) (matching
  // the sensitivity check) instead of [contenteditable='true']. The boolean
  // shorthand (<div contenteditable>) and empty-string form (<div contenteditable="">)
  // are valid HTML and were missed by the old selector — the field was detected
  // as sensitive (so masking painted over it) but TYPE events weren't recorded.
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
      // Only record TYPE if the value actually changed.
      if (newValue !== oldValue) {
        // v1.0.1: include a safe representation of what changed so the
        // tutorial step is more useful. We never store the full value
        // (privacy) — only the length and whether it was a paste.
        const lengthDelta = newValue.length - oldValue.length;
        send("TYPE", el, event, {
          inputLength: newValue.length,
          charactersAdded: Math.max(0, lengthDelta),
          charactersRemoved: Math.max(0, -lengthDelta),
          isPaste: lengthDelta > 50 // heuristic: large insertions are pastes
        });
      }
      focusValues.delete(el);
    }
  }, true);

  // P0-1 v3 fix (v1.5.1): guarantee the SUBMIT screenshot is captured BEFORE
  // native navigation. The previous v1.5.0 approach was fire-and-forget —
  // it relied on the 220ms captureDelay being long enough that the screenshot
  // would complete before the browser navigated. That is a race: fast forms
  // can navigate in <220ms, leaving a screenshot of the post-navigation page.
  //
  // New approach:
  //   1. event.preventDefault() — stops the native navigation
  //   2. await send("SUBMIT", ...) — background captures + persists the step
  //   3. form.requestSubmit(submitter) — re-triggers native submission with
  //      ALL native semantics preserved (formaction, formmethod, formtarget,
  //      constraint validation, named-"submit"-field forms). requestSubmit
  //      is supported in Chrome 76+, Firefox 86+, Safari 16+ — modern enough.
  //
  // Why requestSubmit instead of form.submit()? form.submit() does NOT:
  //   - fire the submit event
  //   - pass the submitter (so formaction/formmethod/formtarget are lost)
  //   - run constraint validation (it bypasses required/pattern checks)
  //   - work on forms that have a named input called "submit" (because
  //     form.submit becomes that input element, shadowing the method)
  // requestSubmit() does all of the above correctly.
  let isReSubmitting = false;
  document.addEventListener("submit", (event) => {
    // P0-1 v3: when WE re-trigger the submit via requestSubmit, let the
    // event pass through natively so it actually navigates.
    if (isReSubmitting) return;

    const form = event.target;
    if (form?.tagName !== "FORM") return;
    const submitter = event.submitter || form.querySelector("button[type='submit'], input[type='submit']");
    const el = submitter || form;
    if (isSensitive(el)) return;

    // C3 fix: do NOT preventDefault unless the recorder is actually active
    // and not paused and not on an excluded domain. The previous code called
    // event.preventDefault() unconditionally on every page where the content
    // script is injected (i.e., every URL via <all_urls> + all_frames:true),
    // which broke site analytics, custom submit handlers, and any listener
    // checking event.defaultPrevented. The re-trigger via requestSubmit()
    // below fires a fresh submit event, so other listeners saw the event twice.
    if (!active || paused || domainBlocked()) return;

    // B7 fix: the recorder's capture-phase listener runs BEFORE the site's
    // own submit listeners (capture phase fires top-down). If we only call
    // preventDefault(), the site's listeners still fire on the original event
    // — and then fire AGAIN when we call form.requestSubmit() below. For AJAX
    // sites whose handler performs side effects regardless of
    // defaultPrevented (common pattern: e.preventDefault(); fetch(...)), this
    // caused duplicate API requests / duplicate processing.
    //
    // stopImmediatePropagation() prevents any OTHER submit listeners on this
    // same element from seeing the original event. The site's handler will
    // only see the second (re-triggered) submit event from requestSubmit(),
    // which is the one that actually performs the native submission.
    event.preventDefault();
    event.stopImmediatePropagation();

    // Suppress the click that triggered this submit (prevents duplicate
    // CLICK + SUBMIT steps for the same user action).
    // B9 fix: scope to the specific submitter element + timeout to clean up.
    suppressClickSubmitter = submitter || form;
    clearTimeout(suppressClickTimer);
    suppressClickTimer = setTimeout(() => { suppressClickSubmitter = null; }, 500);
    // P0-2 v2 (v1.5.1): no more in-content pendingClick state to clear.
    // The click that triggered this submit was already sent to background
    // immediately (see click handler). The background's click-dedup logic
    // will commit it as a CLICK step (or convert to DOUBLE_CLICK if a
    // second click arrives within 150ms). The suppressClickForSubmit flag
    // above ensures the next click (if any) within 500ms is ignored by the
    // click handler, avoiding duplicate CLICK steps for the submit action.

    // Async: capture the screenshot, then re-trigger native submission.
    // Wrapped in IIFE so the submit listener returns synchronously (it
    // already called preventDefault synchronously, which is what matters).
    (async () => {
      try {
        // Race the capture against a 5s timeout so a hung background SW
        // can't permanently block form submission. If the capture times
        // out we still re-trigger the submit so the user isn't stuck.
        await Promise.race([
          send("SUBMIT", el, event),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 5000))
        ]);
      } catch (_) {
        // Capture failed — still re-submit below.
      } finally {
        // Always re-trigger native submission — even if capture failed,
        // we don't want to leave the user unable to submit their form.
        isReSubmitting = true;
        try {
          if (typeof form.requestSubmit === "function") {
            // requestSubmit fires a fresh submit event with the submitter
            // bound, so formaction/formmethod/formtarget are honored and
            // constraint validation runs. If validation fails, no submit
            // event fires (and the form stays on the page) — that's the
            // correct native behavior.
            form.requestSubmit(submitter || undefined);
          } else {
            // Legacy fallback for ancient browsers (Chrome <76). Loses
            // formaction/formmethod semantics but at least navigates.
            form.submit();
          }
        } catch (_) {
          // Last-resort: try plain submit() if requestSubmit threw
          // (e.g., the submitter isn't actually form-associated).
          try { form.submit(); } catch (__) { /* give up gracefully */ }
        } finally {
          // Reset on the next microtask so the re-triggered submit event
          // (which fires synchronously inside requestSubmit) sees the flag.
          // Using setTimeout(0) is safer than a sync reset because
          // requestSubmit may queue the event asynchronously in some UAs.
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
      // P0-3 fix: if Enter is pressed on a submit button or inside a form,
      // suppress the KEYBOARD event — the subsequent click/submit event
      // will carry the semantic meaning. This prevents duplicate
      // KEYBOARD + SUBMIT/CLICK steps for the same user action.
      if (event.key === "Enter") {
        const isSubmitButton = el.tagName === "BUTTON" && (el.type === "submit" || el.type === "button");
        const isInForm = el.closest("form");
        if (isSubmitButton || isInForm) return; // let click/submit handle it
      }
      send("KEYBOARD", el, event, {
        key: event.key,
        modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }
      });
    }
  }, true);

  document.addEventListener("dragstart", (event) => {
    dragSource = event.target?.closest?.("*") || null;
  }, true);

  // P2 fix: clear dragSource on dragend (cancelled drag) so a later
  // unrelated drop doesn't use a stale source.
  document.addEventListener("dragend", () => {
    dragSource = null;
  }, true);

  document.addEventListener("drop", (event) => {
    if (!dragSource) return;
    const dest = event.target?.closest?.("*") || event.target;
    send("DROP", dest, event, { source: targetOf(dragSource, event), destination: targetOf(dest, event) });
    dragSource = null;
  }, true);

  // P1 fix: also detect scroll events on nested scrollable containers,
  // not just window. Many modern apps use overflow:auto/scroll divs.
  // P1-1 v1.5.1 fix: per-element scroll state. The old code used module-level
  // `scrollTimer` and `scrollStart`, which were SHARED across all scrollable
  // elements. If a sidebar scrolled and then the main content scrolled before
  // the 550ms timer completed, the calculation compared positions of TWO
  // DIFFERENT elements — producing bogus distances or suppressing legitimate
  // SCROLL events. Now we use a WeakMap keyed by the actual scrolling element.
  // P1-1 v1.5.1 fix: record the ACTUAL scrolling element as the SCROLL target,
  // not always document.scrollingElement. The screenshot cursor/halo should
  // point at the element the user actually scrolled, so the tutorial step is
  // self-explanatory ("Scroll the sidebar down" rather than the ambiguous
  // "Scroll down" with no visible context).
  const scrollStates = new WeakMap(); // element -> { timer, startTop, startLeft }

  function resolveScrollTarget(event) {
    // The scroll event's target is the document for window scrolls, or
    // the actual element for nested scrolls. We normalize to the
    // "scroller" — the element whose scrollTop/scrollLeft changed.
    if (!event) return window;
    const t = event.target;
    if (t === document || t === document.documentElement) return window;
    // Shadow roots can be targets of scroll events that bubble across
    // shadow boundaries; resolve to the host element.
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
    // D7 fix: ignore scroll events generated by the full-page capture loop.
    // The capture code sets this flag before calling window.scrollTo() so
    // the recorder doesn't capture SCROLL steps for its own programmatic
    // scrolling. The flag is cleared after the capture completes.
    if (isCaptureScrolling) return;
    const scroller = resolveScrollTarget(event);
    if (!scroller) return;
    const pos = currentScrollPosition(scroller);

    let state = scrollStates.get(scroller);
    if (!state) {
      state = { timer: null, startTop: pos.top, startLeft: pos.left };
      scrollStates.set(scroller, state);
    } else if (state.timer === null) {
      // Previous timer already fired (or never set) — start a new measurement.
      state.startTop = pos.top;
      state.startLeft = pos.left;
    }

    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const state2 = scrollStates.get(scroller);
      if (!state2) return;
      // H12 fix: re-read the CURRENT scroll position inside the timeout.
      // The old code used `pos` captured 550ms ago — if the user kept
      // scrolling during the debounce window, the recorded distance,
      // direction, and viewport position were all wrong.
      const currentPos = currentScrollPosition(scroller);
      const distance = Math.abs(currentPos.top - state2.startTop);
      const horizontalDistance = Math.abs(currentPos.left - state2.startLeft);
      const threshold = Math.max(160, innerHeight * 0.25);
      // Record if EITHER vertical or horizontal travel crossed the threshold.
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
  // P1 fix: capture scroll on elements with overflow
  document.addEventListener("scroll", handleScrollEvent, { passive: true, capture: true });

  // ---------------------------------------------------------------------------
  // Idle auto-pause (only when autoPauseIdle > 0)
  // ---------------------------------------------------------------------------

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

  // P1-5 fix: removed "pointermove" from activity bumpers — mouse movement
  // alone shouldn't count as recording activity. Only deliberate interactions
  // (clicks, key presses, scroll, wheel) should reset the idle timer.
  ["keydown", "click", "wheel"].forEach((evt) => {
    document.addEventListener(evt, bumpActivity, { passive: true, capture: true });
  });
  window.addEventListener("scroll", bumpActivity, { passive: true });

  // ---------------------------------------------------------------------------
  // P1-2 v1.5.2: Cross-origin iframe coordinate translation via cumulative
  // transform handshake. See the design comment near `cumulativeTransform`
  // above for the full protocol.
  // ---------------------------------------------------------------------------

  // P1-1 v1.5.2 fix: store the TOP-LEVEL viewport dimensions on iframe
  // events, not the iframe's own innerWidth/innerHeight. The screenshot is
  // of the whole tab; storing iframe viewport dims caused the editor's
  // aspect ratio, annotation positioning, crop calculations, and export
  // scaling to be inconsistent with the actual screenshot.
  // For the top frame, this is just the current innerWidth/innerHeight.
  // For iframes, this is filled in by the parent in the BTR_FRAME_HANDSHAKE_ACK.
  // v1.6.5 fix: top frame updates topLevelViewport on window.resize so the
  // stored viewport dims don't become stale after the user resizes the browser.
  let topLevelViewport = isTopFrame
    ? { width: innerWidth, height: innerHeight }
    : null;
  if (isTopFrame) {
    window.addEventListener("resize", () => {
      topLevelViewport = { width: innerWidth, height: innerHeight };
    }, { passive: true });
  }

  // Every frame listens for handshake messages from children and replies with
  // the child's cumulative transform (parent's transform + iframe's rect/scale).
  // This is what makes arbitrary nesting depth work — each level just adds its
  // own contribution on top of whatever its parent told it.
  //
  // P1-3 v1.5.3 fix: the parent ALSO re-broadcasts updated transforms to all
  // registered children on layout changes (scroll, resize, MutationObserver,
  // ResizeObserver on iframes). Without this, the stored transform becomes
  // stale after the iframe moves (e.g., page scroll, sticky header changes,
  // banners appearing) or after the iframe itself is resized (responsive
  // layouts). The stored transform was correct only at handshake time.
  window.addEventListener("message", (event) => {
    if (event.source === window) return; // skip same-frame messages
    const data = event.data;
    if (!data || data.type !== "BTR_FRAME_HANDSHAKE") return;
    if (!data.nonce) return;

    // F6 fix: find the iframe element whose contentWindow === event.source.
    // The old code used document.querySelectorAll("iframe") which only
    // searches the top-level light DOM — an iframe inside a shadow root
    // is invisible to that query. Use recursive traversal (same pattern
    // used for sensitive-field masking and nested-scroller discovery).
    const findIframeByWindow = (root, source) => {
      if (!root || !root.querySelectorAll) return null;
      const iframes = root.querySelectorAll("iframe");
      for (const iframe of iframes) {
        try {
          if (iframe.contentWindow === source) return iframe;
        } catch (_) { /* cross-origin: contentWindow comparison is allowed */ }
      }
      // Recurse into shadow roots and same-origin iframes
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
          } catch (_) { /* cross-origin — skip */ }
        }
      }
      return null;
    };
    const matchedIframe = findIframeByWindow(document, event.source);
    if (!matchedIframe) return;

    // Cache the iframe element so we don't re-scan on every handshake retry.
    // (Children may re-send handshakes if their first attempt raced ahead
    // of the parent's load event.)
    // E8 fix: before registering a new nonce for this iframe, remove any
    // EXISTING registry entries whose iframe element is the same — a
    // navigation/reload generates a new nonce, and the old entry becomes
    // stale (the iframe element is still connected, so the isConnected
    // check doesn't prune it). The wrapped delete() handles unobserve.
    if (iframeRegistry) {
      for (const [oldNonce, entry] of iframeRegistry) {
        if (entry.iframe === matchedIframe && oldNonce !== data.nonce) {
          iframeRegistry.delete(oldNonce);
        }
      }
      iframeRegistry.set(data.nonce, { iframe: matchedIframe, innerWidth: Number(data.innerWidth) || 0, innerHeight: Number(data.innerHeight) || 0 });
    }

    // Compute and send the child's transform.
    sendTransformToChild(matchedIframe, data.nonce, Number(data.innerWidth) || 0, Number(data.innerHeight) || 0);
  });

  // P1-3 v1.5.3 fix: compute and send an updated transform to a child iframe.
  // Called on initial handshake AND on layout changes (scroll/resize/mutation).
  function sendTransformToChild(iframeEl, nonce, childInnerWidth, childInnerHeight) {
    if (!iframeEl) return;
    const rect = iframeEl.getBoundingClientRect();
    // If we don't know the child's inner dimensions, query them via postMessage
    // (the child will reply with another BTR_FRAME_HANDSHAKE).
    if (!childInnerWidth || !childInnerHeight) {
      // Use the rect itself as a fallback (scale = 1).
      childInnerWidth = rect.width || 1;
      childInnerHeight = rect.height || 1;
    }
    const scaleX = rect.width > 0 ? rect.width / childInnerWidth : 1;
    const scaleY = rect.height > 0 ? rect.height / childInnerHeight : 1;
    // B6 fix: use the parent's INDEPENDENT scaleX/scaleY (not the geometric
    // mean `scale`) for the offset computation. The old code used
    // `cumulativeTransform.scale` which is `sqrt(scaleX*scaleY)` — a geometric
    // mean that doesn't correspond to any actual axis transform. For a nested
    // iframe under non-uniform scaling (e.g. scaleX=0.5, scaleY=1), the
    // offset was wrong, displacing clicks/cursor/annotations in the child.
    // Fall back to `scale` only if scaleX/scaleY aren't set (older parent).
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
    } catch (_) { /* cross-origin postMessage rejected */ }
  }

  // P1-3 v1.5.3 fix: re-broadcast transforms to all registered children when
  // layout changes. Debounced so a burst of scroll events doesn't flood
  // postMessage with redundant updates.
  let transformRefreshTimer = null;
  function scheduleTransformRefresh() {
    if (!iframeRegistry || iframeRegistry.size === 0) return;
    // NM7 fix: prune disconnected iframes from the registry before refreshing.
    // Without this, removed iframes (page navigation, SPA destroying an iframe)
    // leak in iframeRegistry and the ResizeObserver keeps observing them.
    for (const [nonce, entry] of iframeRegistry) {
      if (!entry.iframe || !entry.iframe.isConnected) {
        iframeRegistry.delete(nonce);
      }
    }
    if (iframeRegistry.size === 0) return;
    if (transformRefreshTimer) return; // already scheduled
    transformRefreshTimer = setTimeout(() => {
      transformRefreshTimer = null;
      if (!iframeRegistry) return;
      for (const [nonce, entry] of iframeRegistry) {
        if (entry.iframe && entry.iframe.isConnected) {
          sendTransformToChild(entry.iframe, nonce, entry.innerWidth, entry.innerHeight);
        }
      }
    }, 100); // 100ms debounce
  }

  // Listen for layout changes that could move or resize an iframe.
  // P1-3: page scroll moves iframes (rect.top decreases as page scrolls down).
  // P1-4: window resize changes viewport dimensions and iframe sizes.
  // Both top frame and intermediate frames may have child iframes, so
  // both need to listen for layout changes.
  window.addEventListener("scroll", scheduleTransformRefresh, { passive: true });
  // G4 fix: also listen for scroll events on nested scrollable containers
  // (e.g., a <div style="overflow:auto"> containing an iframe). These fire as
  // document-level scroll events in the capture phase — the existing window
  // scroll listener doesn't catch them. Without this, an iframe's position
  // changes when its container scrolls, but the parent doesn't refresh the
  // child's transform — clicks inside the iframe use stale coordinates.
  document.addEventListener("scroll", scheduleTransformRefresh, { passive: true, capture: true });
  window.addEventListener("resize", scheduleTransformRefresh, { passive: true });

  // P1-3: MutationObserver for layout-affecting DOM changes (sticky header
  // appearing, banner appearing, content above the iframe expanding/collapsing).
  // We debounce via scheduleTransformRefresh.
  // M19 fix: scheduleTransformRefresh already early-returns when
  // iframeRegistry is empty (no child iframes), so the observer callback is a
  // no-op in that case. The observer itself still fires on every DOM mutation
  // though, which on SPA-heavy pages can be hundreds of times per second.
  // We keep the observer attached (it's cheap to register) but the early
  // return in scheduleTransformRefresh means no work is done unless there are
  // actual child iframes to update.
  if (typeof MutationObserver !== "undefined") {
    try {
      const mo = new MutationObserver(() => {
        // M19 fix: skip entirely when there are no child iframes to update.
        if (!iframeRegistry || iframeRegistry.size === 0) return;
        scheduleTransformRefresh();
      });
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden"]
      });
    } catch (_) { /* MutationObserver unavailable */ }
  }

  // P1-4: ResizeObserver on iframes — when an iframe is resized (responsive
  // layout, iframe width attribute changed, parent container resized), its
  // scale changes. We register the observer when the iframe is registered
  // (in the handshake handler above) so we don't need to scan the DOM again.
  // We use a single ResizeObserver for all iframes (more efficient than one
  // per iframe).
  const iframeResizeObserver = (typeof ResizeObserver !== "undefined")
    ? new ResizeObserver((entries) => {
        // Only refresh if the resize actually affected a registered iframe.
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

  // When a new iframe is registered, observe it for resize.
  // We wrap iframeRegistry.set to add the observer.
  if (iframeRegistry && iframeResizeObserver) {
    const origSet = iframeRegistry.set.bind(iframeRegistry);
    iframeRegistry.set = function(nonce, entry) {
      origSet(nonce, entry);
      if (entry?.iframe) {
        try { iframeResizeObserver.observe(entry.iframe); } catch (_) { /* skip */ }
      }
      return entry;
    };
    const origDelete = iframeRegistry.delete.bind(iframeRegistry);
    iframeRegistry.delete = function(nonce) {
      const entry = iframeRegistry.get(nonce);
      if (entry?.iframe) {
        try { iframeResizeObserver.unobserve(entry.iframe); } catch (_) { /* skip */ }
      }
      return origDelete(nonce);
    };
    // C10 fix: wrap Map.clear() too. The old code only wrapped set/delete,
    // but RECORDER_STOP calls iframeRegistry.clear() which invokes the
    // NATIVE Map.clear — bypassing the delete wrapper and leaving iframe
    // elements retained by the ResizeObserver.
    const origClear = iframeRegistry.clear.bind(iframeRegistry);
    iframeRegistry.clear = function() {
      for (const [, entry] of iframeRegistry) {
        if (entry?.iframe) {
          try { iframeResizeObserver.unobserve(entry.iframe); } catch (_) { /* skip */ }
        }
      }
      return origClear();
    };
  }

  // Iframe side: send the handshake to the parent. Retry a few times in case
  // the parent's content script hasn't loaded its listener yet (e.g., parent
  // is still parsing or its content script was injected after the child's).
  //
  // P1-4 v1.5.3 fix: when the iframe is resized (innerWidth/innerHeight
  // changes), re-send the handshake so the parent can recompute the scale
  // (rect.width / innerWidth). Without this, the stored scale becomes stale
  // after a responsive resize.
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
      } catch (_) { /* sandboxed iframe without allow-same-origin */ }
      // Retry up to 5 times with exponential backoff if no ACK received.
      // The ACK handler clears `handshakeRetry` once it fires.
      if (attempt < 5 && handshakeRetry !== null) {
        handshakeRetry = setTimeout(() => sendHandshake(attempt + 1), 100 * Math.pow(2, attempt));
      }
    };
    let handshakeRetry = 0; // will be set to null once ACK arrives
    let lastInnerWidth = innerWidth;
    let lastInnerHeight = innerHeight;
    // Listen for the parent's ACK.
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
      // Cancel any pending retries.
      if (handshakeRetry !== null && handshakeRetry > 0) {
        clearTimeout(handshakeRetry);
      }
      handshakeRetry = null;
    });
    // P1-4: on resize, re-send the handshake so the parent updates our scale.
    // Debounced so a dragging-resize doesn't flood the parent.
    let resizeRehandshakeTimer = null;
    window.addEventListener("resize", () => {
      if (innerWidth === lastInnerWidth && innerHeight === lastInnerHeight) return;
      lastInnerWidth = innerWidth;
      lastInnerHeight = innerHeight;
      if (resizeRehandshakeTimer) clearTimeout(resizeRehandshakeTimer);
      resizeRehandshakeTimer = setTimeout(() => {
        resizeRehandshakeTimer = null;
        // Re-trigger the handshake (with retries).
        handshakeRetry = 1;
        sendHandshake(0);
      }, 200);
    }, { passive: true });
    // Kick off the handshake.
    handshakeRetry = 1; // truthy placeholder so the retry check works
    sendHandshake(0);
  }

  // ---------------------------------------------------------------------------
  // Message listener (from background service worker)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // G1 fix: RECORDER_STOP now uses await internally (for the TYPE flush),
    // so the listener must return true to keep the response channel open.
    // We wrap the handler in an async IIFE and call sendResponse when done.
    if (message.type === "RECORDER_STOP") {
      (async () => {
        // G1 fix: flush the currently-focused editable field's TYPE state
        // before deactivating, and AWAIT the send() so the background receives
        // the TYPE event before it finalizes the session.
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
      return true; // keep the channel open for the async sendResponse
    }
    if (message.type === "RECORDER_START" || message.type === "RECORDER_ATTACH") {
      excludedDomains = message.excludedDomains || [];
      // D4 fix: use typeof check instead of truthiness. An empty string is
      // falsy, so the old `if (message.settings?.sensitivePatterns)` ignored
      // it — clearing the patterns in Settings didn't clear them live.
      if (message.settings && typeof message.settings.sensitivePatterns === "string") {
        sensitivePatterns = message.settings.sensitivePatterns;
      }
      if (message.settings && typeof message.settings.autoPauseIdle === "number") {
        autoPauseIdle = message.settings.autoPauseIdle;
      }
      const isExcluded = domainBlocked();
      active = true; // always active — domain filtering happens at the event level
      // P1-11 fix: the old code set active = !wasDomainBlocked, which made
      // the `if (active && wasDomainBlocked)` branch impossible. Now we
      // keep active=true and set paused=true on excluded domains so the
      // badge shows "Paused".
      // M16 fix: clear any stale capture overlays from a prior crashed session
      // before (re-)attaching. Without this, a SW restart leaves cursor/halo/mask
      // overlays painted on the page.
      clearCapture();
      // M14 fix: pause iframes on excluded domains too (not just the top frame).
      // Previously only `isExcluded && isTopFrame` paused, so iframes on excluded
      // domains kept their listeners running and wasted CPU.
      if (isExcluded) {
        // M14 fix: pause on excluded domains for ALL frames (top + iframes),
        // not just the top frame. Previously only `isExcluded && isTopFrame`
        // paused, so iframes on excluded domains kept their listeners running
        // and wasted CPU computing elements/queries that send() would discard.
        paused = true;
        if (isTopFrame) {
          createStatusOverlay();
          updateOverlayToPaused();
        }
      } else {
        // v1.6.5 fix: always reset `paused` from the session's actual status
        // when on an allowed domain. The previous code only reset paused when
        // `!wasActive` (first activation), so navigating from an excluded domain
        // back to an allowed domain left paused=true permanently — the badge
        // stayed "Paused" and interactions weren't captured.
        paused = message.paused === true;
        if (isTopFrame) createStatusOverlay();
      }
      // Both RECORDER_START and RECORDER_ATTACH can start the idle check.
      // C6 fix: ALWAYS call startIdleCheck() when autoPauseIdle is received,
      // even if the value is 0. The old code only called it when truthy
      // (`if (message.settings?.autoPauseIdle) startIdleCheck()`) — so if the
      // user disabled auto-pause (set to 0) mid-recording, the existing
      // interval was never cleared and evaluated `elapsed > 0` → immediate
      // pause. startIdleCheck() already has `if (!autoPauseIdle) return;`
      // which clears the timer and exits cleanly when the value is 0.
      if (message.settings && typeof message.settings.autoPauseIdle === "number") startIdleCheck();
      // E1 fix: acknowledge RECORDER_START / RECORDER_ATTACH so the background
      // knows the content script received the message and initialized. Without
      // this, the background's `if (!ack)` check fires and deletes the session
      // — START_RECORDING always fails in production (the test mock hid this
      // by always returning {ok:true} from sendMessage).
      if (isTopFrame) sendResponse({ ok: true });
      return true; // keep the channel open for sendResponse
    }
    if (message.type === "RECORDER_PAUSE") {
      paused = true;
      if (isTopFrame) updateOverlayToPaused();
    }
    if (message.type === "RECORDER_RESUME") {
      // P0-3 fix: don't blindly resume if on an excluded domain
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
      // setTimeout (not rAF) so the response fires even when the tab is
      // hidden / backgrounded (B1). rAF is throttled or paused for
      // background tabs, which previously hung the capture pipeline.
      setTimeout(() => sendResponse({ ok: true }), 50);
      return true;
    }
    if (message.type === "SHOW_STATUS" && isTopFrame && active && !paused) {
      createStatusOverlay();
      updateStatus(message.count || 0);
    }
    if (message.type === "PREPARE_CAPTURE") showCaptureOverlay(message);
    if (message.type === "CLEAR_CAPTURE") clearCapture();
    // v1.6.7: hide/restore fixed/sticky elements in ALL frames during
    // full-page capture. The top-level frame already does this via
    // chrome.scripting.executeScript, but cross-origin iframes can't be
    // reached from the parent. These messages let each frame handle its own
    // fixed/sticky elements.
    if (message.type === "HIDE_FIXED_ELEMENTS") {
      try {
        // v1.7.2 fix: append to existing array instead of overwriting it.
        // The top-level scripting.executeScript may have already populated
        // window.__btr_hidden_fixed (with shadow DOM elements). Overwriting
        // would lose those references, making them permanently hidden.
        // Also: recurse into shadow DOM roots (the scripting.executeScript
        // does this for the top-level document, but cross-origin iframes
        // only get this broadcast handler — they need shadow DOM traversal too).
        const hidden = window.__btr_hidden_fixed || [];
        const visit = (root) => {
          if (!root || !root.querySelectorAll) return;
          const allEls = root.querySelectorAll("*");
          for (const el of allEls) {
            if (!el.style) continue;
            const style = getComputedStyle(el);
            if ((style.position === "fixed" || style.position === "sticky") && el !== document.body) {
              // Skip if already hidden (avoid duplicates when scripting.executeScript already ran)
              if (el.style.visibility === "hidden") continue;
              hidden.push({ el, visibility: el.style.visibility });
              el.style.visibility = "hidden";
            }
            // Recurse into shadow DOM
            if (el.shadowRoot) visit(el.shadowRoot);
          }
        };
        visit(document);
        window.__btr_hidden_fixed = hidden;
      } catch (_) { /* ignore */ }
    }
    if (message.type === "RESTORE_FIXED_ELEMENTS") {
      try {
        if (window.__btr_hidden_fixed) {
          for (const { el, visibility } of window.__btr_hidden_fixed) {
            try { el.style.visibility = visibility; } catch (_) { /* element gone */ }
          }
          delete window.__btr_hidden_fixed;
        }
      } catch (_) { /* ignore */ }
    }
    // D7 fix: set/clear the flag that suppresses SCROLL recording during
    // full-page capture's programmatic scrolling.
    if (message.type === "CAPTURE_SCROLL_START") {
      isCaptureScrolling = true;
    }
    if (message.type === "CAPTURE_SCROLL_END") {
      isCaptureScrolling = false;
    }
    // P1-6 v1.5.1: re-anchor masks right before captureVisibleTab so layout
    // shifts during captureDelay don't expose sensitive values. The background
    // sends REFRESH_MASKS after the captureDelay wait, immediately before
    // calling chrome.tabs.captureVisibleTab.
    if (message.type === "REFRESH_MASKS") {
      try {
        refreshMasks();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
      return true;
    }
    // P1-2 v1.5.1: respond to GET_IFRAME_OFFSET queries from background.
    // The background sends this when it received a CLICK from a non-top
    // frame and needs to translate the frame-local click coordinates to
    // top-level viewport coordinates.
    if (message.type === "GET_IFRAME_OFFSET" && isTopFrame && iframeRegistry) {
      try {
        let offset = null;
        // Primary lookup: by nonce (handles same-URL iframes correctly).
        if (message.nonce) {
          const entry = iframeRegistry.get(message.nonce);
          // v1.7.1 fix: iframeRegistry stores {iframe, innerWidth, innerHeight},
          // not the iframe element directly. The previous code called
          // .getBoundingClientRect() on the wrapper object, which would throw
          // (the wrapper has no getBoundingClientRect method), falling into
          // the catch block and returning {ok: false}.
          const iframeEl = entry?.iframe || entry;
          if (iframeEl && typeof iframeEl.getBoundingClientRect === "function") {
            const rect = iframeEl.getBoundingClientRect();
            offset = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          }
        }
        // Fallback: by URL match (covers iframes that haven't sent a
        // handshake yet — e.g., loaded before the recorder started).
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

    // Navigation-type events only fire from the top frame.
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
})();
