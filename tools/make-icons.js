#!/usr/bin/env node
// Rasterises tools/icon.svg into icons/icon{16,32,48,128}.png.
//
//   node tools/make-icons.js
//
// Written by hand rather than shelling out: there is no rasteriser on this
// machine (note that `convert` on Windows is the NTFS filesystem tool, not
// ImageMagick), and the mark is only rounded rectangles. Pure Node keeps icon
// generation reproducible with no dependency and no network.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "icons");
const SIZES = [16, 32, 48, 128];
const VIEWBOX = 24;
const SAMPLES = 4;                 // 4x4 supersampling per pixel

const GREY = [0x79, 0x81, 0x8a];
const AMBER = [0xd4, 0xa2, 0x4c];

// Optical sizing. The full mark has four bars at a 3.8-unit pitch; scaled to a
// 16px grid that is ~1.6px per bar with ~1px gaps, which cannot resolve and
// smears into a block. Below 24px a simplified variant is used instead: three
// bars, thicker, on geometry that lands on whole pixels at 16px (1 unit = 1.5px,
// so all coordinates are multiples of 1.5).
const SMALL_SHAPES = [
  { x: 3, y: 1.5,  w: 12,   h: 3,   r: 1.5, fill: () => GREY },
  { x: 3, y: 6.0,  w: 16.5, h: 3,   r: 1.5, fill: () => GREY },
  { x: 3, y: 10.5, w: 9,    h: 3,   r: 1.5, fill: () => GREY },
  { x: 3, y: 15.75, w: 18,  h: 4.5, r: 2.25, fill: () => AMBER,
    rotate: { deg: -11, cx: 12, cy: 18 } },
].map(s => ({ ...s, fill: s.fill() }));

// Geometry mirrors tools/icon.svg. Keep them in step.
const SHAPES = [
  { x: 3, y: 2.4,  w: 11.5, h: 2.4, r: 1.2, fill: GREY },
  { x: 3, y: 6.2,  w: 15,   h: 2.4, r: 1.2, fill: GREY },
  { x: 3, y: 10.0, w: 8.5,  h: 2.4, r: 1.2, fill: GREY },
  { x: 3, y: 13.8, w: 13,   h: 2.4, r: 1.2, fill: GREY },
  { x: 5.5, y: 18.0, w: 15.5, h: 3.6, r: 1.8, fill: AMBER,
    rotate: { deg: -13, cx: 13.25, cy: 19.8 } },
];

// Signed distance to a rounded box; negative inside.
function sdRoundBox(px, py, s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const hx = s.w / 2 - s.r;
  const hy = s.h / 2 - s.r;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - s.r;
}

// A shape rotated by θ is tested by rotating the sample point by −θ about the
// same pivot, then testing the axis-aligned box.
function toLocal(px, py, rot) {
  if (!rot) return [px, py];
  const t = (-rot.deg * Math.PI) / 180;
  const dx = px - rot.cx;
  const dy = py - rot.cy;
  return [
    rot.cx + dx * Math.cos(t) - dy * Math.sin(t),
    rot.cy + dx * Math.sin(t) + dy * Math.cos(t),
  ];
}

function render(size) {
  const px = new Uint8ClampedArray(size * size * 4);   // straight RGBA
  const scale = VIEWBOX / size;
  const step = 1 / SAMPLES;
  const offset = step / 2;
  const shapes = size < 24 ? SMALL_SHAPES : SHAPES;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const s of shapes) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            const ux = (x + offset + sx * step) * scale;
            const uy = (y + offset + sy * step) * scale;
            const [lx, ly] = toLocal(ux, uy, s.rotate);
            if (sdRoundBox(lx, ly, s) < 0) hits++;
          }
        }
        if (!hits) continue;

        const a = hits / (SAMPLES * SAMPLES);
        const i = (y * size + x) * 4;
        const dstA = px[i + 3] / 255;
        const outA = a + dstA * (1 - a);            // source-over
        if (outA <= 0) continue;
        for (let c = 0; c < 3; c++) {
          px[i + c] = (s.fill[c] * a + px[i + c] * dstA * (1 - a)) / outA;
        }
        px[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return px;
}

// ── Minimal PNG encoder (RGBA, 8-bit, no interlace) ─────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // colour type: RGBA
  ihdr[10] = 0;    // deflate
  ihdr[11] = 0;    // adaptive filtering
  ihdr[12] = 0;    // no interlace

  // Filter byte 0 (None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(render(size), size));
  console.log(`  wrote icons/icon${size}.png  (${fs.statSync(file).size} bytes)`);
}
console.log("\nSource: tools/icon.svg — edit SHAPES here to match if you change it.");
