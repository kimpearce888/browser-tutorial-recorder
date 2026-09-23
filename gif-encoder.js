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
  if (!indices.length) { writer.write(eoiCode, codeSize); return writer.getBytes(); }
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const key = prefix + "," + indices[i];
    if (dict.has(key)) { prefix = key; }
    else {
      writer.write(dict.get(prefix), codeSize);
      if (nextCode < 4096) {
        dict.set(key, nextCode); nextCode++;
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

class BitWriter {
  constructor(initialSize = 65536) {
    this.buf = new Uint8Array(initialSize);
    this.pos = 0;
    this.current = 0;
    this.bitsUsed = 0;
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
  let total = 1;
  for (let i = 0; i < bytes.length; i += 255) total += 1 + Math.min(255, bytes.length - i);
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

const u16le = v => [v & 0xff, (v >> 8) & 0xff];

function buildGif(frames, options = {}) {
  const loop = options.loop !== false;
  const MAX_DIM = 65535;
  let width = frames.length ? Math.max(...frames.map(f => f.width)) : 1;
  let height = frames.length ? Math.max(...frames.map(f => f.height)) : 1;
  const scale = Math.min(width > MAX_DIM ? MAX_DIM / width : 1, height > MAX_DIM ? MAX_DIM / height : 1);

  if (scale < 1) {
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    frames = frames.map(f => {
      const fw = Math.round(f.width * scale), fh = Math.round(f.height * scale);
      const rgba = new Uint8Array(fw * fh * 4);
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        const si = (Math.floor(y / scale) * f.width + Math.floor(x / scale)) * 4;
        const di = (y * fw + x) * 4;
        rgba[di] = f.rgba[si]; rgba[di+1] = f.rgba[si+1]; rgba[di+2] = f.rgba[si+2]; rgba[di+3] = f.rgba[si+3];
      }
      return { ...f, width: fw, height: fh, rgba };
    });
  }

  const estimated = 32 + 768 + frames.length * (width * height + 768 + 64);
  let bytes = new Uint8Array(Math.max(estimated, 1024));
  let pos = 0;
  const push = (...vals) => { for (const v of vals) bytes[pos++] = v; };
  const pushBytes = arr => {
    if (arr instanceof Uint8Array) { bytes.set(arr, pos); pos += arr.length; }
    else { for (const v of arr) bytes[pos++] = v; }
  };
  const growIfNeeded = extra => {
    if (pos + extra + 16 > bytes.length) {
      const next = new Uint8Array(bytes.length * 2 + extra + 64);
      next.set(bytes); bytes = next;
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
    push(0x21, 0xf9, 4, hasTransparent ? 0x09 : 0x08);
    push(...u16le(Math.round((frame.delayMs ?? 100) / 10)));
    push(hasTransparent ? transparentIndex : 0, 0);
    push(0x2c, ...u16le(0), ...u16le(0), ...u16le(frame.width), ...u16le(frame.height), 0x87);
    growIfNeeded(768);
    for (let i = 0; i < 256; i++) { bytes[pos++] = PALETTE[i][0]; bytes[pos++] = PALETTE[i][1]; bytes[pos++] = PALETTE[i][2]; }
    push(8);
    const subBlock = subBlocks(lzwEncode(indices, 8));
    growIfNeeded(subBlock.length);
    pushBytes(subBlock);
  }
  push(0x3b);
  return bytes.subarray(0, pos);
}

export async function encodeGif(frames, options = {}) {
  return new Blob([buildGif(frames, options)], { type: "image/gif" });
}
