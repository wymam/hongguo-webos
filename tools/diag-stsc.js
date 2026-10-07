'use strict';
// Dump the sample table (stsc/stsz/stco/saiz/saio) to find where sample indexing
// goes wrong. Run against the live stream via the same prepareHeader path, but
// we need the RAW moov, so re-read it directly.
const mod = require('../service/com.hongguowebos.app.service/provider.js');
const provider = mod.provider;
const vm = require('vm');
const fs = require('fs');

const EP = process.argv[2] || '7691249364097829913';
const VENDOR = require('path').join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');

function readBox(data, offset) {
  if (offset < 0 || offset + 8 > data.length) return null;
  let size = data.readUInt32BE(offset);
  const type = data.toString('ascii', offset + 4, offset + 8);
  let header = 8;
  if (size === 1) { if (offset + 16 > data.length) return null; size = Number(data.readBigUInt64BE(offset + 8)); header = 16; }
  else if (size === 0) size = data.length - offset;
  if (size < header || offset + size > data.length) return null;
  return { offset, size, type, header, bodyStart: offset + header };
}
function findBox(data, type, start = 0) {
  for (let o = Math.max(0, start); o + 8 <= data.length; o++) {
    const b = readBox(data, o);
    if (b && b.type === type) return b;
  }
  return null;
}

(async () => {
  // Get a stream and read the raw (encrypted-but-moov-plaintext) head.
  const status = provider.status();
  console.log('upstream:', status.upstream);
  // We can't reach the raw stream directly; instead evaluate the vendored rule
  // the same way provider does, to call resolveStream + remoteRange.
  const src = fs.readFileSync(VENDOR, 'utf8');
  const ctx = vm.createContext({ console, Buffer, require, process, setTimeout, clearTimeout, URL, URLSearchParams });
  // provider.js loads via compat + crypto-shim; replicate minimal:
  ctx.crypto = require('crypto');
  vm.runInContext(src, ctx);
  const rule = ctx.rule;
  console.log('rule title:', rule && rule.title);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
