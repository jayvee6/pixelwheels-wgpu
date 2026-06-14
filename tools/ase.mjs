// Minimal, dependency-free Aseprite (.ase/.aseprite) decoder.
// Decodes the documented binary format (https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md),
// composites visible layers with normal (src-over) blending, and returns flattened RGBA frames.
//
// Supported: color depth 32 (RGBA), 16 (grayscale), 8 (indexed); cel types 0 (raw) and 2 (zlib image)
// and 1 (linked). Tilemap cels (type 3) and non-normal blend modes are not needed by the assets we use
// and are treated as normal/skip — the decoder logs if it hits one so we never silently produce wrong art.
import { inflateSync } from "node:zlib";

const readU16 = (b, o) => b[o] | (b[o + 1] << 8);
const readU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const readI16 = (b, o) => { const v = readU16(b, o); return v >= 0x8000 ? v - 0x10000 : v; };

/**
 * @param {Buffer} buf  raw .ase bytes
 * @returns {{width:number,height:number,frames:{rgba:Uint8Array,duration:number}[]}}
 */
export function decodeAse(buf) {
  // ---- Header (128 bytes) ----
  const magic = readU16(buf, 4);
  if (magic !== 0xa5e0) throw new Error(`not an Aseprite file (magic ${magic.toString(16)})`);
  const frameCount = readU16(buf, 6);
  const width = readU16(buf, 8);
  const height = readU16(buf, 10);
  const depth = readU16(buf, 12); // bits per pixel: 32 / 16 / 8
  const transparentIndex = buf[28];

  let palette = null; // Uint8Array of RGBA, 4 bytes per entry (for indexed mode)

  // Layer metadata accumulates across frames (layer chunks appear in frame 0).
  const layers = [];

  /** Composite a decoded cel image (RGBA) onto the frame canvas at (cx,cy) with given opacity. */
  function blit(dst, cel) {
    const { x: cx, y: cy, w, h, rgba, opacity } = cel;
    for (let y = 0; y < h; y++) {
      const dy = cy + y;
      if (dy < 0 || dy >= height) continue;
      for (let x = 0; x < w; x++) {
        const dx = cx + x;
        if (dx < 0 || dx >= width) continue;
        const si = (y * w + x) * 4;
        let sa = rgba[si + 3] * opacity / 255;
        if (sa <= 0) continue;
        const di = (dy * width + dx) * 4;
        const da = dst[di + 3] / 255;
        const outA = sa / 255 + da * (1 - sa / 255);
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const sc = rgba[si + c], dc = dst[di + c];
          dst[di + c] = Math.round((sc * (sa / 255) + dc * da * (1 - sa / 255)) / outA);
        }
        dst[di + 3] = Math.round(outA * 255);
      }
    }
  }

  /** Convert raw cel pixel bytes (in source color depth) to RGBA. */
  function celToRgba(raw, w, h) {
    const out = new Uint8Array(w * h * 4);
    if (depth === 32) {
      out.set(raw.subarray(0, w * h * 4));
    } else if (depth === 16) {
      for (let i = 0; i < w * h; i++) {
        const v = raw[i * 2], a = raw[i * 2 + 1];
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
        out[i * 4 + 3] = a;
      }
    } else { // 8-bit indexed
      for (let i = 0; i < w * h; i++) {
        const idx = raw[i];
        if (idx === transparentIndex) { out[i * 4 + 3] = 0; continue; }
        const p = idx * 4;
        out[i * 4] = palette ? palette[p] : idx;
        out[i * 4 + 1] = palette ? palette[p + 1] : idx;
        out[i * 4 + 2] = palette ? palette[p + 2] : idx;
        out[i * 4 + 3] = palette ? palette[p + 3] : 255;
      }
    }
    return out;
  }

  const frames = [];
  // cels[frameIndex][layerIndex] = cel  (kept so linked cels can reference earlier frames)
  const celsByFrame = [];

  let off = 128;
  for (let f = 0; f < frameCount; f++) {
    const frameBytes = readU32(buf, off);
    const frameEnd = off + frameBytes;
    const oldChunks = readU16(buf, off + 6);
    const duration = readU16(buf, off + 8);
    const newChunks = readU32(buf, off + 12);
    const chunkCount = newChunks !== 0 ? newChunks : oldChunks;

    let p = off + 16;
    const frameCels = [];
    celsByFrame[f] = frameCels;

    for (let c = 0; c < chunkCount; c++) {
      const chunkSize = readU32(buf, p);
      const chunkType = readU16(buf, p + 4);
      const data = p; // absolute offset of chunk start; fields are relative to p+6

      if (chunkType === 0x2004) {
        // Layer chunk. Data fields (relative to p+6): 0 WORD flags, 2 WORD type, 4 WORD childLevel,
        // 6 WORD defW, 8 WORD defH, 10 WORD blendMode, 12 BYTE opacity, 13..15 reserved, 16 STRING name.
        const flags = readU16(buf, p + 6);
        const blendMode = readU16(buf, p + 16);
        const opacity = buf[p + 18];
        const nameLen = readU16(buf, p + 22);
        const name = buf.toString("utf8", p + 24, p + 24 + nameLen);
        const visible = (flags & 1) !== 0;
        if (blendMode !== 0) console.warn(`[ase] layer "${name}" uses blend mode ${blendMode} — treated as normal`);
        layers.push({ name, visible, opacity });
      } else if (chunkType === 0x2019) {
        // New palette chunk. data: newSize DWORD, first DWORD, last DWORD, 8 reserved, then entries.
        if (!palette) palette = new Uint8Array(256 * 4).fill(0);
        const first = readU32(buf, p + 10);
        const last = readU32(buf, p + 14);
        const count = last - first + 1;
        let q = p + 6 + 20;
        for (let i = 0; i < count; i++) {
          const entryFlags = readU16(buf, q); q += 2;
          const r = buf[q], g = buf[q + 1], b = buf[q + 2], a = buf[q + 3]; q += 4;
          if (entryFlags & 1) { const nl = readU16(buf, q); q += 2 + nl; }
          const idx = (first + i) * 4;
          palette[idx] = r; palette[idx + 1] = g; palette[idx + 2] = b; palette[idx + 3] = a;
        }
      } else if (chunkType === 0x2005) {
        // Cel chunk
        const layerIndex = readU16(buf, p + 6);
        const cx = readI16(buf, p + 8);
        const cy = readI16(buf, p + 10);
        const celOpacity = buf[p + 12];
        const celType = readU16(buf, p + 13);
        if (celType === 0 || celType === 2) {
          const w = readU16(buf, p + 22);
          const h = readU16(buf, p + 24);
          const pixStart = p + 26;
          const pixEnd = data + chunkSize;
          let raw;
          if (celType === 2) raw = inflateSync(buf.subarray(pixStart, pixEnd));
          else raw = buf.subarray(pixStart, pixEnd);
          const rgba = celToRgba(raw, w, h);
          frameCels[layerIndex] = { x: cx, y: cy, w, h, rgba, opacity: celOpacity };
        } else if (celType === 1) {
          // Linked cel: reuse the same layer's cel from a previous frame.
          const linkFrame = readU16(buf, p + 22);
          const src = celsByFrame[linkFrame]?.[layerIndex];
          if (src) frameCels[layerIndex] = { ...src, x: cx, y: cy, opacity: celOpacity };
        } else {
          console.warn(`[ase] unsupported cel type ${celType} (layer ${layerIndex}) — skipping`);
        }
      }
      p += chunkSize;
    }

    // Composite this frame's cels in layer order.
    const canvas = new Uint8Array(width * height * 4);
    for (let li = 0; li < frameCels.length; li++) {
      const cel = frameCels[li];
      const layer = layers[li];
      if (!cel) continue;
      if (layer && !layer.visible) continue;
      const layerOpacity = layer ? layer.opacity : 255;
      blit(canvas, { ...cel, opacity: (cel.opacity * layerOpacity) / 255 });
    }
    frames.push({ rgba: canvas, duration });
    off = frameEnd;
  }

  return { width, height, frames };
}
