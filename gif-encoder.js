const WEB_SAFE = [];
for (let r = 0; r < 6; r++) {
  for (let g = 0; g < 6; g++) {
    for (let b = 0; b < 6; b++) {
      WEB_SAFE.push([r * 51, g * 51, b * 51]);
    }
  }
}
const PALETTE = WEB_SAFE.slice(0, 216);
while (PALETTE.length < 256) PALETTE.push([0, 0, 0]);

function nearestIndex(r, g, b) {
  const qr = Math.min(5, Math.round(r / 51));
  const qg = Math.min(5, Math.round(g / 51));
  const qb = Math.min(5, Math.round(b / 51));
  return qr * 36 + qg * 6 + qb;
}

class ByteWriter {
  constructor() { this.bytes = []; }
  byte(v) { this.bytes.push(v & 0xff); return this; }
  short(v) { return this.byte(v & 0xff).byte((v >> 8) & 0xff); }
  ascii(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); return this; }
  bytes_(arr) { for (const v of arr) this.byte(v); return this; }
  toUint8() { return new Uint8Array(this.bytes); }
}

function lzwEncode(indexPixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const out = new ByteWriter();
  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.byte(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const resetDict = () => {
    dict = new Map();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  writeCode(clearCode);
  resetDict();

  let prefix = indexPixels[0];
  for (let i = 1; i < indexPixels.length; i++) {
    const k = indexPixels[i];
    const combo = (prefix << 8) | k;
    if (dict.has(combo)) {
      prefix = dict.get(combo);
    } else {
      writeCode(prefix);
      if (nextCode < 4096) {
        dict.set(combo, nextCode);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        nextCode++;
      } else {
        writeCode(clearCode);
        resetDict();
      }
      prefix = k;
    }
  }
  writeCode(prefix);
  writeCode(eoiCode);
  if (bitCount > 0) out.byte(bitBuffer & 0xff);

  return out.toUint8();
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

export function encodeGif(frames, delayMs = 500) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("encodeGif needs at least one frame.");
  }
  const delayCs = Math.max(2, Math.round(delayMs / 10));
  const width = frames[0].width;
  const height = frames[0].height;
  // Guard the one assumption the whole encoder rests on: every frame is read
  // at frame 0's dimensions. Mixed-size input used to render silently WRONG
  // content (black padding / cropped frames); exporter.normalizeGifFrames is
  // the caller-side normalizer — fail loudly if it was skipped.
  for (const f of frames) {
    if (f.width !== width || f.height !== height) {
      throw new Error("encodeGif: all frames must share one size — normalize them first (normalizeGifFrames).");
    }
  }

  const gif = new ByteWriter();
  gif.ascii("GIF89a");
  gif.short(width).short(height);
  gif.byte(0xf7).byte(0).byte(0);
  for (const [r, g, b] of PALETTE) gif.byte(r).byte(g).byte(b);
  // NETSCAPE2.0 looping extension — MUST be introduced as a proper
  // application extension block: 0x21 (ext intro) 0xFF (app label) 0x0B
  // (block size 11) + the 11-byte identifier. Writing the bare identifier
  // (the v2.0.0-v2.2.1 bug) left 'N' (0x4E) sitting where a decoder expects
  // a block introducer — every strict decoder (Chrome, ffmpeg) rejected the
  // whole file as corrupt.
  gif.byte(0x21).byte(0xff).byte(0x0b)
    .ascii("NETSCAPE2.0").byte(3).byte(1).short(0).byte(0);

  for (const frame of frames) {
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, width, height);
    const indices = new Uint8Array(width * height);
    for (let p = 0; p < data.length; p += 4) {
      indices[p / 4] = nearestIndex(data[p], data[p + 1], data[p + 2]);
    }
    gif.byte(0x21).byte(0xf9).byte(0x04).byte(0x04).short(delayCs).byte(0).byte(0);
    gif.byte(0x2c).short(0).short(0).short(width).short(height).byte(0x00);
    gif.byte(0x08);
    gif.bytes_(subBlocks(lzwEncode(indices, 8)));
  }

  gif.byte(0x3b);
  const bytes = gif.toUint8();
  return new Blob([bytes], { type: "image/gif" });
}

export function isGif(bytes) {
  return bytes && bytes.length > 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
}
