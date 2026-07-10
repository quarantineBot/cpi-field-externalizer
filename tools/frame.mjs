// Frame a screenshot onto an exact Chrome Web Store canvas (1280x800 or 640x400) — centered
// on a soft gradient with rounded corners + a light shadow. Dependency-free (built-in zlib).
//
//   node tools/frame.mjs <input.png> <output.png> [WxH]   (default 1280x800)
//
// Only handles 8-bit RGBA (colorType 6), non-interlaced PNGs (what Windows screenshots are).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname } from 'node:path';

// ---- decode ---------------------------------------------------------------
function decodePNG(buf) {
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error('need 8-bit RGBA, non-interlaced');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  let off = 8; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp, out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let r;
      if (ft === 0) r = v; else if (ft === 1) r = v + a; else if (ft === 2) r = v + b;
      else if (ft === 3) r = v + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = r & 255;
    }
  }
  return { w, h, rgba: out };
}

// ---- encode ---------------------------------------------------------------
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- compose --------------------------------------------------------------
const inRoundRect = (x, y, w, h, r) => { const rx = Math.min(x, w - 1 - x), ry = Math.min(y, h - 1 - y); if (rx >= r || ry >= r) return true; const dx = r - rx, dy = r - ry; return dx * dx + dy * dy <= r * r; };
function bilinear(src, sw, sh, fx, fy) {
  fx = Math.max(0, Math.min(sw - 1, fx)); fy = Math.max(0, Math.min(sh - 1, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const px = (x, y, c) => src[(y * sw + x) * 4 + c], L = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2].map((c) => Math.round(L(L(px(x0, y0, c), px(x1, y0, c), tx), L(px(x0, y1, c), px(x1, y1, c), tx), ty)));
}
function frame(img, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1), R = Math.round(0xea + (0xd8 - 0xea) * t), G = Math.round(0xf2 + (0xe4 - 0xf2) * t), B = Math.round(0xfb + (0xf1 - 0xfb) * t);
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; out[i] = R; out[i + 1] = G; out[i + 2] = B; out[i + 3] = 255; }
  }
  const pad = Math.round(W * 0.05), s = Math.min((W - pad * 2) / img.w, (H - pad * 2) / img.h);
  const dw = Math.round(img.w * s), dh = Math.round(img.h * s), dx = Math.round((W - dw) / 2), dy = Math.round((H - dh) / 2), rad = Math.round(W * 0.008);
  // soft shadow (offset translucent rounded rect)
  const shOff = Math.round(H * 0.014), alpha = 0.16;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    if (!inRoundRect(x, y, dw, dh, rad)) continue;
    const X = dx + x, Y = dy + y + shOff; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const i = (Y * W + X) * 4; out[i] = Math.round(out[i] * (1 - alpha)); out[i + 1] = Math.round(out[i + 1] * (1 - alpha)); out[i + 2] = Math.round(out[i + 2] * (1 - alpha));
  }
  // image with rounded corners
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    if (!inRoundRect(x, y, dw, dh, rad)) continue;
    const [R, G, B] = bilinear(img.rgba, img.w, img.h, (x + 0.5) / s - 0.5, (y + 0.5) / s - 0.5);
    const i = ((dy + y) * W + (dx + x)) * 4; out[i] = R; out[i + 1] = G; out[i + 2] = B; out[i + 3] = 255;
  }
  return out;
}

// ---- cli ------------------------------------------------------------------
const [, , input, output, size = '1280x800'] = process.argv;
if (!input || !output) { console.error('usage: node tools/frame.mjs <input.png> <output.png> [WxH]'); process.exit(1); }
const [W, H] = size.split('x').map(Number);
const img = decodePNG(await readFile(input));
const framed = frame(img, W, H);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, encodePNG(W, H, framed));
console.log(`framed ${input} (${img.w}x${img.h}) -> ${output} (${W}x${H})`);
