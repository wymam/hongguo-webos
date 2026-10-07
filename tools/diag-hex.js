'use strict';
const mod = require('../service/com.hongguowebos.app.service/provider.js');
const provider = mod.provider;
const EP = process.argv[2] || '7691249364097829913';
const SEG = 1024 * 1024;
(async () => {
  const handle = await provider.stream(EP, false);
  console.log('total =', handle.total, 'keyed =', handle.keyed);
  for (let start = 0; start < 3 * SEG; start += SEG) {
    const end = Math.min(start + SEG - 1, handle.total - 1);
    const raw = await handle.chunk(start, end);
    const buf = Buffer.from(raw);
    console.log(`\n[${start}..${end}] len=${buf.length}`);
    console.log('  head:', buf.slice(0, 48).toString('hex'));
    // find first NAL-ish marker
    let idx = -1;
    for (let i = 0; i < buf.length - 3; i++) {
      if (buf[i] === 0 && buf[i+1] === 0 && (buf[i+2] === 1 || (buf[i+2] === 0 && buf[i+3] === 1))) { idx = i; break; }
    }
    console.log('  first start-code at byte', idx, idx >= 0 ? 'hex=' + buf.slice(idx, idx + 12).toString('hex') : '(none)');
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
