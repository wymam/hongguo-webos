'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
require('../service/com.hongguowebos.app.service/crypto-shim.js');
const httpClient = require('../service/com.hongguowebos.app.service/http-client.js');
if (typeof httpClient.create !== 'function') httpClient.create = function () { return httpClient; };
const VENDOR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');
const EP = process.argv[2] || '7691249364097829913';
const src = fs.readFileSync(VENDOR, 'utf8');
const context = vm.createContext({
  require: (n) => (n === 'node:crypto' || n === 'crypto') ? crypto : (function () { throw new Error('Unsupported: ' + n); })(),
  Buffer, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  process: { env: {} }, axios: httpClient
});
vm.runInContext(src + '\nthis.api = { resolveStream, prepareHeader, remoteRange, decryptPartial };', context, { timeout: 10000, filename: 'hongguo.cjs' });
const api = context.api;

function addCounter(iv, blocks) {
  const value = (iv.readBigUInt64BE(0) << 64n) | iv.readBigUInt64BE(8);
  const next = (value + BigInt(blocks)) & ((1n << 128n) - 1n);
  const r = Buffer.alloc(16);
  r.writeBigUInt64BE(next >> 64n, 0);
  r.writeBigUInt64BE(next & ((1n << 64n) - 1n), 8);
  return r;
}

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const prepared = await api.prepareHeader(stream);
  const key = stream.key;
  console.log('key hex:', key.toString('hex'), 'key length:', key.length);

  // First sample (in segment 1) — known to decrypt correctly.
  const s0 = prepared.samples[0];
  const raw0 = await api.remoteRange(stream, s0.start, s0.end - 1);
  const d0 = crypto.createDecipheriv('aes-128-ctr', key, addCounter(s0.iv, 0));
  const p0 = Buffer.concat([d0.update(raw0.data), d0.final()]);
  console.log('sample[0] start', s0.start, 'size', s0.end - s0.start, 'decrypted head:', p0.slice(0, 16).toString('hex'));

  // A sample fully inside segment 2.
  const s2 = prepared.samples.find((x) => x.start >= 1048576 && x.end <= 2097152);
  console.log('seg2 sample start', s2.start, 'size', s2.end - s2.start, 'iv', Buffer.from(s2.iv).toString('hex'));
  const raw2 = await api.remoteRange(stream, s2.start, s2.end - 1);
  const d2 = crypto.createDecipheriv('aes-128-ctr', key, addCounter(s2.iv, 0));
  const p2 = Buffer.concat([d2.update(raw2.data), d2.final()]);
  console.log('seg2 sample decrypted head:', p2.slice(0, 16).toString('hex'));
  console.log('seg2 sample raw head    :', raw2.data.slice(0, 16).toString('hex'));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
