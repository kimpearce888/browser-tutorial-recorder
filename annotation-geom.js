// Pure annotation geometry shared by the editor canvas interactions.
// Kept free of DOM/canvas dependencies so the select / move / rotate /
// resize / crop logic can be unit-tested directly under Node.

export const RECT_TYPES = new Set(["highlight", "rectangle", "circle", "blur", "redaction", "spotlight"]);
export const HANDLE_TOL = 10;
export const HIT_TOL = 8;

// Keep the two coordinate conventions annotations use in lockstep:
// rect-like shapes store x/y/w/h (x2/y2 derived), arrows store x/y->x2/y2
// (w/h derived as the bounding box). Every mutation must call this.
export function syncGeom(a) {
  if (!a || !a.type) return a;
  if (a.type === "arrow") {
    a.w = Math.abs((a.x2 == null ? a.x : a.x2) - a.x);
    a.h = Math.abs((a.y2 == null ? a.y : a.y2) - a.y);
  } else if (RECT_TYPES.has(a.type)) {
    a.x2 = a.x + (a.w || 0);
    a.y2 = a.y + (a.h || 0);
  }
  return a;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function textBox(a) {
  const lines = String(a.text || "").split("\n");
  const estW = Math.max(40, ...lines.map((l) => l.length * (a.fontSize || 18) * 0.62));
  const w = a.w || estW;
  const h = a.h || Math.max(24, lines.length * (a.fontSize || 18) * 1.4);
  return { w, h };
}

// Topmost annotation under the canvas point, tested with the shape the user
// actually sees (segment for arrows, disc for markers, box for text and
// rects) — bounding-box-only testing made text and markers unselectable.
export function annotationHit(annotations, pt, tolScale = 1) {
  if (!Array.isArray(annotations) || !pt) return null;
  // Tolerances are image pixels; the editor passes 1/displayScale so hit
  // areas stay the same SIZE ON SCREEN whatever the zoom is.
  const tol = HIT_TOL * (tolScale || 1);
  const disc = 16 * (tolScale || 1);
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.type === "arrow") {
      if (distToSegment(pt.x, pt.y, a.x, a.y, a.x2 == null ? a.x : a.x2, a.y2 == null ? a.y : a.y2) <= tol) return a;
    } else if (a.type === "marker") {
      if (Math.hypot(pt.x - a.x, pt.y - a.y) <= disc) return a;
    } else if (a.type === "text") {
      const { w, h } = textBox(a);
      if (pt.x >= a.x - tol && pt.x <= a.x + w + tol && pt.y >= a.y - tol && pt.y <= a.y + h + tol) return a;
    } else {
      const w = a.w || 0, h = a.h || 0;
      if (pt.x >= a.x - tol && pt.x <= a.x + w + tol && pt.y >= a.y - tol && pt.y <= a.y + h + tol) return a;
    }
  }
  return null;
}

// Position of the rotate handle for arrows: hover, offset perpendicular from
// the segment midpoint, like presentation software draws it.
export function rotateHandlePos(a) {
  const x2 = a.x2 == null ? a.x : a.x2;
  const y2 = a.y2 == null ? a.y : a.y2;
  const mx = (a.x + x2) / 2, my = (a.y + y2) / 2;
  const ang = Math.atan2(y2 - a.y, x2 - a.x);
  return {
    hx: mx + Math.cos(ang - Math.PI / 2) * 26,
    hy: my + Math.sin(ang - Math.PI / 2) * 26
  };
}

export function handlesAt(a, pt, tolScale = 1) {
  if (!a || !pt) return null;
  const tol = HANDLE_TOL * (tolScale || 1);
  if (a.type === "arrow") {
    const x2 = a.x2 == null ? a.x : a.x2;
    const y2 = a.y2 == null ? a.y : a.y2;
    if (Math.hypot(pt.x - x2, pt.y - y2) <= tol) return "head";
    if (Math.hypot(pt.x - a.x, pt.y - a.y) <= tol) return "tail";
    const { hx, hy } = rotateHandlePos(a);
    if (Math.hypot(pt.x - hx, pt.y - hy) <= tol) return "rotate";
    return null;
  }
  if (a.type === "text" || a.type === "marker") return null;
  if (RECT_TYPES.has(a.type)) {
    const cx = a.x + (a.w || 0), cy = a.y + (a.h || 0);
    return Math.abs(pt.x - cx) <= tol && Math.abs(pt.y - cy) <= tol ? "se" : null;
  }
  return null;
}

// Rotate an arrow around its segment midpoint, preserving its length: the
// angle delta between the pointer and the handle anchor is applied to both
// endpoints. Returns the new endpoints (does not mutate).
export function rotateAround(cx, cy, x1, y1, x2, y2, startAngle, pointerAngle) {
  const delta = pointerAngle - startAngle;
  const cos = Math.cos(delta), sin = Math.sin(delta);
  const rot = (ox, oy) => {
    const dx = ox - cx, dy = oy - cy;
    return [Math.round(cx + dx * cos - dy * sin), Math.round(cy + dx * sin + dy * cos)];
  };
  const [nx1, ny1] = rot(x1, y1);
  const [nx2, ny2] = rot(x2, y2);
  return { x: nx1, y: ny1, x2: nx2, y2: ny2 };
}

function extent(a) {
  if (a.type === "text") {
    const { w, h } = textBox(a);
    return { x1: a.x, y1: a.y, x2: a.x + w, y2: a.y + h };
  }
  if (a.type === "marker") {
    return { x1: a.x - 16, y1: a.y - 16, x2: a.x + 16, y2: a.y + 16 };
  }
  if (a.type === "arrow") {
    const x2 = a.x2 == null ? a.x : a.x2;
    const y2 = a.y2 == null ? a.y : a.y2;
    return { x1: Math.min(a.x, x2), y1: Math.min(a.y, y2), x2: Math.max(a.x, x2), y2: Math.max(a.y, y2) };
  }
  return { x1: a.x, y1: a.y, x2: a.x + (a.w || 0), y2: a.y + (a.h || 0) };
}

// Remap annotations after cropping the screenshot by (offX, offY) CSS pixels
// and drop the ones that ended up fully outside the cropped image.
export function cropRemap(annotations, offX, offY, cssW, cssH) {
  const moved = (annotations || []).map((a) => {
    const b = { ...a };
    b.x = a.x - offX;
    b.y = a.y - offY;
    if (a.x2 != null) { b.x2 = a.x2 - offX; b.y2 = a.y2 - offY; }
    return syncGeom(b);
  });
  return moved.filter((a) => {
    const e = extent(a);
    return e.x2 > 0 && e.y2 > 0 && e.x1 < cssW && e.y1 < cssH;
  });
}

/* ----------------------------------------------------------------
   Viewer scaling — how the editor displays a screenshot.
   "fit"  = fit width (capped at 1:1): the professional default. A
            1280×12000 full-page capture fills the pane's width and
            scrolls vertically instead of shrinking into an
            unrecognizable strip.
   "page" = fit the whole page inside the pane (old behavior).
   "custom" = explicit zoom factor around natural size (zoom buttons,
            Ctrl+wheel). Never below 5%, never above 400%.
   Pure so the zoom logic can be unit-tested without a DOM.
---------------------------------------------------------------- */
export const VIEWER_MIN_ZOOM = 0.05;
export const VIEWER_MAX_ZOOM = 4;

function clampZoom(z) {
  return Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, z));
}

export function viewerScale({ mode = "fit", factor = 1, natW, natH, wrapW, wrapH }) {
  if (!(natW > 0) || !(natH > 0) || !(wrapW > 0) || !(wrapH > 0)) return 1;
  const fitW = wrapW / natW;
  const fitPage = Math.min(fitW, wrapH / natH);
  if (mode === "page") return clampZoom(fitPage);
  if (mode === "custom") return clampZoom(Number(factor) || 1);
  // "fit" = fit width: fill the pane width, never upscale past 1:1.
  return Math.min(fitW, 1);
}

/* ----------------------------------------------------------------
   Crop marquee management — the standard crop-tool interaction set:
   drag outside the box to draw a new one, drag inside to move it,
   grab one of 8 handles to resize. Pure + unit-testable.
---------------------------------------------------------------- */
export const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function cropRect(crop) {
  if (!crop) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(crop.x1, crop.x2);
  const y = Math.min(crop.y1, crop.y2);
  return { x, y, w: Math.abs(crop.x2 - crop.x1), h: Math.abs(crop.y2 - crop.y1) };
}

// The 8 handle anchors in image pixels (corners + edge midpoints).
export function cropHandlePositions(crop) {
  const r = cropRect(crop);
  const mx = r.x + r.w / 2, my = r.y + r.h / 2;
  return {
    nw: [r.x, r.y],
    n: [mx, r.y],
    ne: [r.x + r.w, r.y],
    e: [r.x + r.w, my],
    se: [r.x + r.w, r.y + r.h],
    s: [mx, r.y + r.h],
    sw: [r.x, r.y + r.h],
    w: [r.x, my]
  };
}

// What a pointer at `pt` interacts with, priority order: handles (they
// reach slightly outside the box; the NEAREST wins when tolerances
// overlap), the box interior (move), otherwise nothing (start a fresh
// marquee). tolScale converts screen px to image px like annotationHit's
// tolScale.
export function cropHitTest(crop, pt, tolScale = 1) {
  if (!crop || !pt) return null;
  const tol = 12 * (tolScale || 1);
  const handles = cropHandlePositions(crop);
  let best = null;
  let bestD = Infinity;
  for (const handle of CROP_HANDLES) {
    const [hx, hy] = handles[handle];
    const d = Math.hypot(pt.x - hx, pt.y - hy);
    if (d <= tol && d < bestD) { best = handle; bestD = d; }
  }
  if (best) return best;
  const r = cropRect(crop);
  if (pt.x >= r.x - tol && pt.x <= r.x + r.w + tol && pt.y >= r.y - tol && pt.y <= r.y + r.h + tol) {
    return "move";
  }
  return null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Produce the next crop rect for a drag. Mutates nothing; clamped to the
// image bounds. kind: "new" | "move" | "resize".
export function applyCropDrag(crop, kind, handle, anchor, pt, bounds) {
  const W = bounds && bounds.w > 0 ? bounds.w : Infinity;
  const H = bounds && bounds.h > 0 ? bounds.h : Infinity;
  const px = clamp(pt.x, 0, W);
  const py = clamp(pt.y, 0, H);
  if (kind === "new") {
    return { x1: anchor.x, y1: anchor.y, x2: px, y2: py };
  }
  if (kind === "move") {
    const dx = px - anchor.x, dy = py - anchor.y;
    const r = cropRect(crop);
    const shiftX = clamp(dx, -r.x, r.w >= W ? 0 : W - r.x - r.w);
    const shiftY = clamp(dy, -r.y, r.h >= H ? 0 : H - r.y - r.h);
    return { x1: crop.x1 + shiftX, y1: crop.y1 + shiftY, x2: crop.x2 + shiftX, y2: crop.y2 + shiftY };
  }
  if (kind === "resize") {
    const next = { ...crop };
    if (handle.includes("w")) next.x1 = px;
    if (handle.includes("e")) next.x2 = px;
    if (handle.includes("n")) next.y1 = py;
    if (handle.includes("s")) next.y2 = py;
    return next;
  }
  return { ...crop };
}

/* ----------------------------------------------------------------
   Numbered markers: professional recorders number sequentially
   across the WHOLE tutorial, not restarting at 1 in every step.
   The next number is one past the highest number already placed.
---------------------------------------------------------------- */
export function nextMarkerNumber(steps) {
  let max = 0;
  for (const s of steps || []) {
    for (const a of (s && s.annotations) || []) {
      if (a && a.type === "marker" && Number.isFinite(a.number)) max = Math.max(max, a.number);
    }
  }
  return max + 1;
}
