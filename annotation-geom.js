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
export function annotationHit(annotations, pt) {
  if (!Array.isArray(annotations) || !pt) return null;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.type === "arrow") {
      if (distToSegment(pt.x, pt.y, a.x, a.y, a.x2 == null ? a.x : a.x2, a.y2 == null ? a.y : a.y2) <= HIT_TOL) return a;
    } else if (a.type === "marker") {
      if (Math.hypot(pt.x - a.x, pt.y - a.y) <= 16) return a;
    } else if (a.type === "text") {
      const { w, h } = textBox(a);
      if (pt.x >= a.x - HIT_TOL && pt.x <= a.x + w + HIT_TOL && pt.y >= a.y - HIT_TOL && pt.y <= a.y + h + HIT_TOL) return a;
    } else {
      const w = a.w || 0, h = a.h || 0;
      if (pt.x >= a.x - HIT_TOL && pt.x <= a.x + w + HIT_TOL && pt.y >= a.y - HIT_TOL && pt.y <= a.y + h + HIT_TOL) return a;
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

export function handlesAt(a, pt) {
  if (!a || !pt) return null;
  if (a.type === "arrow") {
    const x2 = a.x2 == null ? a.x : a.x2;
    const y2 = a.y2 == null ? a.y : a.y2;
    if (Math.hypot(pt.x - x2, pt.y - y2) <= HANDLE_TOL) return "head";
    if (Math.hypot(pt.x - a.x, pt.y - a.y) <= HANDLE_TOL) return "tail";
    const { hx, hy } = rotateHandlePos(a);
    if (Math.hypot(pt.x - hx, pt.y - hy) <= HANDLE_TOL) return "rotate";
    return null;
  }
  if (a.type === "text" || a.type === "marker") return null;
  if (RECT_TYPES.has(a.type)) {
    const cx = a.x + (a.w || 0), cy = a.y + (a.h || 0);
    return Math.abs(pt.x - cx) <= HANDLE_TOL && Math.abs(pt.y - cy) <= HANDLE_TOL ? "se" : null;
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
