'use strict';
const mod = require('../service/com.hongguowebos.app.service/provider.js');
const provider = mod.provider;
const EP = process.argv[2] || '7691249364097829913';
(async () => {
  const handle = await provider.stream(EP, false);
  const raw = await handle.chunk(0, 1024 * 1024 - 1);
  const buf = Buffer.from(raw);
  // find moov box, read its size, then dump the mdat region right after it
  const ftypSize = buf.readUInt32BE(0);
  const moovSize = buf.readUInt32BE(ftypSize);
  const mdatAt = ftypSize + moovSize;
  console.log('ftyp size =', ftypSize, ' moov size =', moovSize, ' mdat starts at', mdatAt);
  console.log('mdat head hex:', buf.slice(mdatAt, mdatAt + 48).toString('hex'));
  // find mdat type marker
  console.log('at mdatAt-4 type:', buf.toString('ascii', mdatAt - 4, mdatAt));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
