// GIF89a encoder with LZW compression and fast uniform color quantization.
const R_STEPS = 6, G_STEPS = 7, B_STEPS = 6;
const PALETTE = [];
for (let r = 0; r < R_STEPS; r++)
  for (let g = 0; g < G_STEPS; g++)
    for (let b = 0; b < B_STEPS; b++)
      PALETTE.push([Math.round(r*255/(R_STEPS-1)), Math.round(g*255/(G_STEPS-1)), Math.round(b*255/(B_STEPS-1))]);
PALETTE.push([60,60,60],[120,120,120],[180,180,180],[220,220,220]);

const R_LUT = new Uint8Array(256), G_LUT = new Uint8Array(256), B_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  R_LUT[i] = Math.round(i*(R_STEPS-1)/255);
  G_LUT[i] = Math.round(i*(G_STEPS-1)/255);
  B_LUT[i] = Math.round(i*(B_STEPS-1)/255);
}

function quantize(rgba) {
  let hasTransparent = false;
  for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] < 128) { hasTransparent = true; break; } }
  const transparentIndex = hasTransparent ? 255 : 0;
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) { indices[i / 4] = transparentIndex; continue; }
    const idx = R_LUT[rgba[i]] * (G_STEPS * B_STEPS) + G_LUT[rgba[i + 1]] * B_STEPS + B_LUT[rgba[i + 2]];
    indices[i / 4] = idx < 252 ? idx : 0;
  }
  return { indices, hasTransparent, transparentIndex };
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1, codeSize = minCodeSize + 1;
  const dict = new Map();
  for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
  const writer = new BitWriter();
  writer.write(clearCode, codeSize);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const key = prefix + "," + indices[i];
    if (dict.has(key)) { prefix = key; }
    else {
      writer.write(dict.get(prefix), codeSize);
      if (nextCode < 4096) {
        dict.set(key, nextCode); nextCode++;
        // H31 fix: use > not >=. The code just assigned (nextCode-1) fits in
        // the current codeSize. The NEXT code (nextCode) may not. With >=,
        // codeSize increments when nextCode == 1<<codeSize, but the just-
        // assigned code (1<<codeSize - 1) hasn't been output yet — it would
        // be written at the new (larger) codeSize, but the decoder expects it
        // at the old codeSize. Using > means codeSize increments one code later,
        // so the just-assigned code is output at the correct (old) codeSize.
        // This was verified by an independent GIF decoder round-trip test.
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        writer.write(clearCode, codeSize);
        dict.clear();
        for (let j = 0; j < clearCode; j++) dict.set(String(j), j);
        nextCode = eoiCode + 1; codeSize = minCodeSize + 1;
      }
      prefix = String(indices[i]);
    }
  }
  writer.write(dict.get(prefix), codeSize);
  writer.write(eoiCode, codeSize);
  return writer.getBytes();
}

// M6: Use Uint8Array-backed BitWriter for ~10-50x faster encoding than
// pushing byte-by-byte to a plain JS array.
class BitWriter {
  constructor(initialSize = 65536) {
    this.buf = new Uint8Array(initialSize);
    this.pos = 0;        // byte index
    this.current = 0;    // current byte being built
    this.bitsUsed = 0;   // bits written to current byte
  }
  ensure(extra) {
    if (this.pos + extra + 4 > this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
  }
  write(code, size) {
    this.ensure(1);
    for (let i = 0; i < size; i++) {
      this.current |= ((code >> i) & 1) << this.bitsUsed;
      this.bitsUsed++;
      if (this.bitsUsed === 8) {
        this.buf[this.pos++] = this.current;
        this.current = 0;
        this.bitsUsed = 0;
        this.ensure(1);
      }
    }
  }
  getBytes() {
    if (this.bitsUsed > 0) this.buf[this.pos++] = this.current;
    return this.buf.subarray(0, this.pos);
  }
}

function subBlocks(bytes) {
  // M6: build directly into a Uint8Array. Pre-compute the size first so we
  // only allocate once.
  let total = 1; // trailing 0
  for (let i = 0; i < bytes.length; i += 255) {
    total += 1 + Math.min(255, bytes.length - i);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < bytes.length; i += 255) {
    const chunkLen = Math.min(255, bytes.length - i);
    out[p++] = chunkLen;
    out.set(bytes.subarray(i, i + chunkLen), p);
    p += chunkLen;
  }
  out[p] = 0;
  return out;
}

function u16le(value) { return [value & 0xff, (value >> 8) & 0xff]; }

function buildGif(frames, options = {}) {
  const loop = options.loop !== false;
  // P1-25 fix: GIF dimensions are 16-bit — clamp to 65535 max
  const MAX_GIF_DIM = 65535;
  let width = Math.max(...frames.map((f) => f.width));
  let height = Math.max(...frames.map((f) => f.height));
  // Scale down if any dimension exceeds the limit
  const scaleW = width > MAX_GIF_DIM ? MAX_GIF_DIM / width : 1;
  const scaleH = height > MAX_GIF_DIM ? MAX_GIF_DIM / height : 1;
  const scale = Math.min(scaleW, scaleH);
  if (scale < 1) {
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);
    // P2-22 fix: actually resize the RGBA data, not just the dimension fields
    frames = frames.map(f => {
      const fw = Math.round(f.width * scale);
      const fh = Math.round(f.height * scale);
      const newRgba = new Uint8Array(fw * fh * 4);
      // Nearest-neighbor downscale
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const srcX = Math.floor(x / scale);
          const srcY = Math.floor(y / scale);
          const srcIdx = (srcY * f.width + srcX) * 4;
          const dstIdx = (y * fw + x) * 4;
          newRgba[dstIdx] = f.rgba[srcIdx];
          newRgba[dstIdx + 1] = f.rgba[srcIdx + 1];
          newRgba[dstIdx + 2] = f.rgba[srcIdx + 2];
          newRgba[dstIdx + 3] = f.rgba[srcIdx + 3];
        }
      }
      return { ...f, width: fw, height: fh, rgba: newRgba };
    });
    width = newWidth;
    height = newHeight;
  }
  // Pre-allocate generously (header + palette + frames).
  // Each frame needs: 768 bytes for its own local color table + LZW data
  // (worst case ~1 byte/pixel for noisy/high-detail screenshots).
  // Add 768 per frame to the estimate so the buffer rarely needs to grow.
  const estimated = 32 + 768 + frames.length * (width * height + 768 + 64);
  // v1.0.2 #1: MUST be `let` — growIfNeeded reassigns it. Was `const`,
  // which threw "Assignment to constant variable" in strict mode (ES modules).
  let bytes = new Uint8Array(Math.max(estimated, 1024));
  let pos = 0;
  const push = (...vals) => { for (const v of vals) bytes[pos++] = v; };
  const pushBytes = (arr) => {
    if (arr instanceof Uint8Array) {
      bytes.set(arr, pos);
      pos += arr.length;
    } else {
      for (const v of arr) bytes[pos++] = v;
    }
  };
  const growIfNeeded = (extra) => {
    if (pos + extra + 16 > bytes.length) {
      const next = new Uint8Array(bytes.length * 2 + extra + 64);
      next.set(bytes);
      bytes = next;
    }
  };

  for (const c of "GIF89a") bytes[pos++] = c.charCodeAt(0);
  push(...u16le(width), ...u16le(height), 0x00, 0, 0);
  if (loop && frames.length > 1) {
    push(0x21, 0xff, 11);
    for (const c of "NETSCAPE2.0") bytes[pos++] = c.charCodeAt(0);
    push(3, 1, ...u16le(0), 0);
  }
  for (const frame of frames) {
    const { indices, hasTransparent, transparentIndex } = quantize(frame.rgba);
    push(0x21, 0xf9, 4);
    push(hasTransparent ? 0x09 : 0x08);
    push(...u16le(Math.round((frame.delayMs || 100) / 10)));
    push(hasTransparent ? transparentIndex : 0);
    push(0);
    push(0x2c, ...u16le(0), ...u16le(0), ...u16le(frame.width), ...u16le(frame.height));
    push(0x87);
    // Local color table (256 entries × 3 bytes).
    growIfNeeded(768);
    for (let i = 0; i < 256; i++) {
      bytes[pos++] = PALETTE[i][0];
      bytes[pos++] = PALETTE[i][1];
      bytes[pos++] = PALETTE[i][2];
    }
    push(8);
    const lzwBytes = lzwEncode(indices, 8);
    const subBlock = subBlocks(lzwBytes);
    growIfNeeded(subBlock.length);
    pushBytes(subBlock);
  }
  push(0x3b);
  return bytes.subarray(0, pos);
}

export async function encodeGif(frames, options = {}) {
  return new Blob([buildGif(frames, options)], { type: "image/gif" });
}
