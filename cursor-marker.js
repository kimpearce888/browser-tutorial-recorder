// The click marker that lands on every captured screenshot — and its live
// in-page twin — is now fully configurable. One source of truth here:
// the service worker stamps it into the screenshot, the settings page
// previews it, and the content script mirrors it as a DOM ring (content
// scripts cannot import ES modules, so cursor-ring-css is duplicated there;
// this module stays the spec).

export const DEFAULT_CURSOR_MARKER = {
  color: "#ff7352",
  size: 1,        // 1 = classic 11px disc radius (in CSS px at capture scale)
  fillOpacity: 0.15,
  glow: 0         // blur radius in CSS px; 0 = crisp ring, >0 = soft glow
};

export const CURSOR_PRESETS = [
  { name: "Classic ring", color: "#ff7352", size: 1, fillOpacity: 0.15, glow: 0 },
  { name: "Yellow filled", color: "#ffd23f", size: 0.75, fillOpacity: 0.55, glow: 9 },
  { name: "High visibility", color: "#1a73e8", size: 1.2, fillOpacity: 0.22, glow: 6 },
  { name: "Emerald", color: "#1a7f4b", size: 1, fillOpacity: 0.3, glow: 4 },
  { name: "Magenta", color: "#d64cf0", size: 0.9, fillOpacity: 0.28, glow: 7 },
  { name: "Contrast dark", color: "#15161a", size: 0.9, fillOpacity: 0.2, glow: 0 },
  { name: "Light ring", color: "#ffffff", size: 1, fillOpacity: 0.08, glow: 4 }
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function normalizeCursorMarker(raw) {
  const m = (raw && typeof raw === "object") ? raw : {};
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    color: typeof m.color === "string" && HEX_RE.test(m.color.trim())
      ? m.color.trim().toLowerCase()
      : DEFAULT_CURSOR_MARKER.color,
    size: num(m.size, 0.5, 2, DEFAULT_CURSOR_MARKER.size),
    fillOpacity: num(m.fillOpacity, 0, 0.85, DEFAULT_CURSOR_MARKER.fillOpacity),
    glow: Math.round(num(m.glow, 0, 24, DEFAULT_CURSOR_MARKER.glow))
  };
}

export function alpha(color, opacity) {
  const hex = String(color || "").replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const o = Math.max(0, Math.min(1, opacity == null ? 1 : opacity));
  return `rgba(${r},${g},${b},${o})`;
}

// Disc radius in CSS pixels for a given marker config.
export function markerRadius(marker) {
  return 11 * (marker.size || 1);
}

// Draw the click marker EXACTLY as it is stamped into screenshots.
// Used by the service worker (real stamp) and the settings preview.
export function drawCursorMarker(ctx, point, scale, markerRaw) {
  const m = normalizeCursorMarker(markerRaw);
  const px = point.x * scale;
  const py = point.y * scale;
  const r = markerRadius(m) * scale;
  ctx.save();
  ctx.lineJoin = "round";
  // Soft glow / blur behind everything, when configured.
  if (m.glow > 0) {
    ctx.shadowColor = alpha(m.color, 0.85);
    ctx.shadowBlur = m.glow * scale;
  }
  // Filled centre.
  if (m.fillOpacity > 0) {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = alpha(m.color, m.fillOpacity);
    ctx.fill();
  }
  // Crisp ring.
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.lineWidth = 3 * scale;
  ctx.strokeStyle = alpha(m.color, 0.95);
  ctx.stroke();
  // Soft halo — keeps the classic look readable on any page.
  ctx.beginPath();
  ctx.arc(px, py, r * 1.45, 0, Math.PI * 2);
  ctx.lineWidth = 5 * scale;
  ctx.strokeStyle = alpha(m.color, 0.2);
  ctx.stroke();
  // The cursor glyph itself (white arrow with dark outline).
  ctx.translate((point.x - 2) * scale, (point.y - 2) * scale);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(2, 2);
  ctx.lineTo(2, 34);
  ctx.lineTo(10, 26);
  ctx.lineTo(17, 37);
  ctx.lineTo(23, 33);
  ctx.lineTo(16, 22);
  ctx.lineTo(28, 22);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#172238";
  ctx.stroke();
  ctx.restore();
}
