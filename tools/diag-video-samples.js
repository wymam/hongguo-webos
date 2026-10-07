'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const crypto = require('crypto');
require('../service/com.hongguowebos.app.service/crypto-shim.js');
const httpClient = require('../service/com.hongguowebos.app.service/http-client.js');
if (typeof httpClient.create !== 'function') httpClient.create = function () { return httpClient; };
const VENDOR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');
const EP = process.argv[2] || '7691249364097829913';
const src = fs.readFileSync(VENDOR, 'utf8');
const ctx = vm.createContext({ require: (n) => (n === 'node:crypto' || n === 'crypto') ? crypto : (function(){throw new Error(n)})(), Buffer, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, process: { env: {} }, axios: httpClient });
vm.runInContext(src + '\nthis.api = { resolveStream, prepareHeader, remoteRange, decryptPartial };', ctx, { timeout: 10000 });
const api = ctx.api;
function addCounter(iv, blocks) {
  const v = (iv.readBigUInt64BE(0) << 64n) | iv.readBigUInt64BE(8);
  const n = (v + BigInt(blocks)) & ((1n << 128n) - 1n);
  const r = Buffer.alloc(16); r.writeBigUInt64BE(n >> 64n, 0); r.writeBigUInt64BE(n & ((1n << 64n) - 1n), 8); return r;
}
(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const prepared = await api.prepareHeader(stream);
  const key = stream.key;
  // Pick a spread of LARGE samples (video) across the file, decrypt each.
  const big = prepared.samples.filter((s) => s.end - s.start > 5000);
  console.log('big (video) samples:', big.length);
  const picks = [0, Math.floor(big.length * 0.05), Math.floor(big.length * 0.12), Math.floor(big.length * 0.25), Math.floor(big.length * 0.5), big.length - 1];
  for (const p of picks) {
    const s = big[p];
    const raw = await api.remoteRange(stream, s.start, Math.min(s.end - 1, s.start + 2047));
    const d = crypto.createDecipheriv('aes-128-ctr', key, addCounter(s.iv, 0));
    const dec = Buffer.concat([d.update(raw.data), d.final()]);
    const head = dec.slice(0, 12).toString('hex');
    const looksH265 = dec.length >= 4 && dec[2] === 0x01 && (dec[3] === 0x01 || dec[3] === 0x00);
    console.log(`big[${String(p).padStart(3)}] start=${s.start} size=${s.end - s.start} head=${head} ${looksH265 ? 'PLAINTEXT' : 'GARBAGE'}`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
