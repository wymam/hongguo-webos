// Diagnose whether the decrypted stream has a corrupt region around the jump
// point (~10-25s into the episode, i.e. a few MiB in).
//
// Downloads the first 8MiB in 1MiB steps through the SAME chunk() path the
// media proxy serves, then reports per-segment: length (a halved read would be
// < 1MiB) and the density of H.264 NAL start codes. A segment that decrypts to
// garbage has either far more or far fewer start codes than its neighbours.
'use strict';

const mod = require('../service/com.hongguowebos.app.service/provider.js');
const provider = mod.provider;

const EP = process.argv[2] || '7691249364097829913'; // the 188s episode that jumped
const SEG = 1024 * 1024;
const WINDOW = 8 * SEG;

function nalDensity(buf) {
  // Count 0x000001 / 0x00000001 start-code prefixes.
  let n = 0;
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) { n++; i += 2; }
      else if (buf[i + 2] === 0 && buf[i + 3] === 1) { n++; i += 3; }
    }
  }
  return n;
}

(async () => {
  console.log('resolving stream for episode', EP, '…');
  const handle = await provider.stream(EP, false);
  console.log('total =', handle.total, 'bytes =', (handle.total / 1024 / 1024).toFixed(1), 'MiB, keyed =', handle.keyed);

  const total = handle.total;
  const cap = Math.min(WINDOW, total);
  console.log('downloading first', (cap / 1024 / 1024).toFixed(1), 'MiB in', SEG / 1024, 'KiB steps\n');

  for (let start = 0; start < cap; start += SEG) {
    const end = Math.min(start + SEG - 1, total - 1);
    try {
      const raw = await handle.chunk(start, end);
      const buf = Buffer.from(raw);
      const nal = nalDensity(buf);
      const suspicious = buf.length < SEG - 1 ? ' (SHORT READ)' : '';
      console.log(
        `${String(start).padStart(9)}..${String(end).padStart(9)}  len=${String(buf.length).padStart(7)}  nal=${String(nal).padStart(4)}${suspicious}`
      );
    } catch (e) {
      console.log(`${String(start).padStart(9)}..${String(end).padStart(9)}  ERROR: ${e.message}`);
    }
  }
  console.log('\ndone');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
