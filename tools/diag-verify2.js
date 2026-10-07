'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const crypto = require('crypto');
require('./../service/com.hongguowebos.app.service/crypto-shim.js');
const httpClient = require('./../service/com.hongguowebos.app.service/http-client.js');
if (typeof httpClient.create !== 'function') httpClient.create = function () { return httpClient; };
const VENDOR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');
const EP = process.argv[2] || '7691249364097829913';
const src = fs.readFileSync(VENDOR, 'utf8');
const ctx = vm.createContext({
  require: (n) => (n === 'node:crypto' || n === 'crypto') ? crypto : (function(){throw new Error(n)})(),
  Buffer, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  process: { env: {} }, axios: httpClient
});
vm.runInContext(src + '\nthis.api = { resolveStream, prepareHeader, remoteRange, decryptPartial };', ctx, { timeout: 10000 });
const api = ctx.api;

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const prepared = await api.prepareHeader(stream);
  const samples = prepared.samples;
  const MB = 1024 * 1024;
  // 拿真实 total
  const probe = await api.remoteRange(stream, 0, MB - 1);
  const total = probe.total;
  console.log('samples:', samples.length, 'moov:', prepared.header.length, 'total:', total);

  const picks = [0, 1, 2, 50, 200, 1000, 5000, samples.length - 3];
  for (let m = 1; m <= 8; m++) {
    const boundary = m * MB;
    const idx = samples.findIndex(s => s.start >= boundary - 3000 && s.start <= boundary + 3000);
    if (idx >= 0) picks.push(idx);
  }

  const seen = new Set();
  let mismatch = 0;
  for (const idx of picks) {
    if (seen.has(idx)) continue; seen.add(idx);
    const s = samples[idx];
    const rawA = await api.remoteRange(stream, s.start, s.end - 1);
    const decA = api.decryptPartial(rawA.data, s.start, stream.key, prepared);

    const segStart = Math.floor(s.start / MB) * MB;
    const segEnd = Math.min(segStart + MB - 1, total - 1);
    const rawB = await api.remoteRange(stream, segStart, segEnd);
    const decB = api.decryptPartial(rawB.data, segStart, stream.key, prepared);
    const subB = decB.subarray(s.start - segStart, s.end - segStart);

    const same = decA.equals(subB);
    if (!same) mismatch++;
    console.log(`sample[${idx}] start=${s.start} size=${s.end-s.start} same=${same}`);
  }
  console.log('\n结论:', mismatch === 0 ? '单样本解密 == 段解密（decryptPartial 无边界 bug）' : `${mismatch} 个样本不一致（有 bug）`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
