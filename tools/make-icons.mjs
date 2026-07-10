// Generate the extension icons (PNG) with zero dependencies — Node's built-in zlib only.
// Design: brand-blue rounded square with two overlapping white square outlines (the ⧉ mark).
// Run: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const BLUE = [10, 110, 209]; // #0a6ed1
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const radius = N * 0.2;
  const inCorner = (x, y) => {
    // transparent outside the rounded-rect corners
    const cx = Math.min(x, N - 1 - x), cy = Math.min(y, N - 1 - y);
    if (cx >= radius || cy >= radius) return false;
    return Math.hypot(radius - cx, radius - cy) > radius;
  };
  const stroke = Math.max(1, Math.round(N / 12));
  // two overlapping square outlines
  const side = Math.round(N * 0.4);
  const squares = [
    [Math.round(N * 0.2), Math.round(N * 0.2)],
    [Math.round(N * 0.4), Math.round(N * 0.4)],
  ].map(([x0, y0]) => [x0, y0, x0 + side, y0 + side]);
  const onOutline = (x, y) => squares.some(([x0, y0, x1, y1]) => {
    const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const innerInside = x >= x0 + stroke && x <= x1 - stroke && y >= y0 + stroke && y <= y1 - stroke;
    return inside && !innerInside;
  });
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (inCorner(x, y)) { buf[i + 3] = 0; continue; } // transparent
      const [r, g, b] = onOutline(x, y) ? WHITE : BLUE;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return png(N, N, buf);
}

await mkdir(new URL('../icons/', import.meta.url), { recursive: true });
for (const N of [16, 32, 48, 128]) {
  const out = new URL(`../icons/icon${N}.png`, import.meta.url);
  await writeFile(out, render(N));
  console.log(`wrote icons/icon${N}.png`);
}
