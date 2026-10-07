// Generates the webOS app icons for the red-berry client.
//
// webOS wants two PNGs in webos-meta: icon.png (80x80) and largeIcon.png
// (130x130). Rather than ship a binary blob we cannot regenerate, the icons are
// drawn here so they can be re-rendered at any size or colour with one command.
//
//   node tools/make-icons.js
//
// The mark is a simple round berry with a leaf, on the app's brand red — legible
// at 80px and recognisably not the Bilibili or Netflix mark.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'app', 'webos-meta');

// ---- minimal PNG encoder (RGBA, 8-bit) -----------------------------------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Each scanline is prefixed with filter byte 0 (None).
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- drawing -------------------------------------------------------------
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ];
}

// Blend a colour over the existing pixel using a 0..1 alpha.
function blend(rgba, idx, rgb, alpha) {
  if (alpha <= 0) return;
  const inv = 1 - alpha;
  const r = rgba[idx] * inv + rgb[0] * alpha;
  const g = rgba[idx + 1] * inv + rgb[1] * alpha;
  const b = rgba[idx + 2] * inv + rgb[2] * alpha;
  const a = rgba[idx + 3] / 255;
  rgba[idx] = Math.round(Math.min(255, r));
  rgba[idx + 1] = Math.round(Math.min(255, g));
  rgba[idx + 2] = Math.round(Math.min(255, b));
  rgba[idx + 3] = Math.round(Math.min(255, Math.max(a, alpha) * 255));
}

// 4x supersampling so the circle edges are smooth at small sizes.
function render(size) {
  const SS = 4;
  const W = size * SS;
  const rgba = Buffer.alloc(W * W * 4, 0);

  const bg = hexToRgb('#1b1c22');
  const berry = hexToRgb('#ff5c45');
  const berryDark = hexToRgb('#c9432f');
  const leaf = hexToRgb('#57c66a');
  const stem = hexToRgb('#8a5a3c');

  const cx = W * 0.5;
  const cy = W * 0.58;
  const radius = W * 0.31;
  const corner = W * 0.22;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;

      // Rounded-square background.
      const dx = Math.max(Math.abs(x - W / 2) - (W / 2 - corner), 0);
      const dy = Math.max(Math.abs(y - W / 2) - (W / 2 - corner), 0);
      const bgAlpha = Math.hypot(dx, dy) <= corner ? 1 : 0;
      blend(rgba, idx, bg, bgAlpha);

      // Berry body, with a subtle darker lower-right for volume.
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) {
        const shade = (x - cx + (y - cy)) / (radius * 2);
        const base = shade > 0.15 ? berryDark : berry;
        blend(rgba, idx, base, 1);
      }

      // Leaf: two overlapping ellipses forming a stylised pair.
      const lx1 = (x - (cx + radius * 0.34)) / (radius * 0.46);
      const ly1 = (y - (cy - radius * 0.92)) / (radius * 0.2);
      if (lx1 * lx1 + ly1 * ly1 <= 1) blend(rgba, idx, leaf, 1);

      const lx2 = (x - (cx - radius * 0.3)) / (radius * 0.4);
      const ly2 = (y - (cy - radius * 1.02)) / (radius * 0.18);
      if (lx2 * lx2 + ly2 * ly2 <= 1) blend(rgba, idx, leaf, 1);

      // Stem.
      if (Math.abs(x - cx) <= radius * 0.075 && y > cy - radius * 1.12 && y < cy - radius * 0.78) {
        blend(rgba, idx, stem, 1);
      }

      // Highlight.
      const hx = (x - (cx - radius * 0.33)) / (radius * 0.2);
      const hy = (y - (cy - radius * 0.36)) / (radius * 0.28);
      if (hx * hx + hy * hy <= 1) blend(rgba, idx, [255, 255, 255], 0.3);
    }
  }

  // Downsample SSxSS -> 1, averaging colour and alpha.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const alpha = rgba[idx + 3] / 255;
          r += rgba[idx] * alpha;
          g += rgba[idx + 1] * alpha;
          b += rgba[idx + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const oidx = (y * size + x) * 4;
      if (a > 0) {
        out[oidx] = Math.round(r / a);
        out[oidx + 1] = Math.round(g / a);
        out[oidx + 2] = Math.round(b / a);
      }
      out[oidx + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon.png', 80],
  ['largeIcon.png', 130]
];

for (const [name, size] of targets) {
  const png = encodePNG(size, size, render(size));
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}

console.log(`\nwrote to ${OUT_DIR}`);
