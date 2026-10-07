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

// 判断一段解密后的数据是不是「合法 H.265 长度前缀」或「合法 raw AAC」。
// H.265 长度前缀：4 字节大端长度，后面跟 NAL 头 (0x00 0x00 0x01 或 0x26/0x02/... VCL)
function looksLikeH265(buf) {
  if (buf.length < 8) return false;
  const len = buf.readUInt32BE(0);
  if (len === 0 || len > buf.length - 4) return false;
  const nalType = (buf[4] >> 1) & 0x3f;
  return nalType >= 0 && nalType <= 40 && buf[4] !== 0 && buf[5] !== 0;
}

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const prepared = await api.prepareHeader(stream);
  const samples = prepared.samples;
  console.log('samples:', samples.length, 'total:', prepared.header.length);
  const key = stream.key;
  console.log('key:', key ? key.toString('hex').slice(0, 16) + '...' : '(none)');

  // 抽查样本：前 3 个、跨 1MiB 边界的、文件中部、后部
  const MB = 1024 * 1024;
  const picks = [0, 1, 2, 50, 200, 1000, samples.length - 3, samples.length - 1];
  // 加跨 1MiB 边界的样本
  for (let m = 1; m <= 3; m++) {
    const boundary = m * MB;
    const idx = samples.findIndex(s => s.start >= boundary - 2000 && s.start <= boundary + 2000);
    if (idx >= 0) picks.push(idx);
  }

  const seen = new Set();
  for (const idx of picks) {
    if (seen.has(idx)) continue; seen.add(idx);
    const s = samples[idx];
    const size = s.end - s.start;

    // 方式 A：单样本解密（直接对样本的加密数据 decryptPartial）
    const rawA = await api.remoteRange(stream, s.start, s.end - 1);
    const decA = api.decryptPartial(rawA.data, s.start, stream.key, prepared);

    // 方式 B：所在 1MiB 段解密，取样本子段
    const segStart = Math.floor(s.start / MB) * MB;
    const segEnd = Math.min(segStart + MB - 1, (prepared.header.length || 0) - 1);
    const rawB = await api.remoteRange(stream, segStart, segEnd);
    const decB = api.decryptPartial(rawB.data, segStart, stream.key, prepared);
    const subB = decB.subarray(s.start - segStart, s.end - segStart);

    const same = decA.equals(subB);
    console.log(`sample[${idx}] start=${s.start} size=${size} iv=${Buffer.from(s.iv).slice(0,8).toString('hex')} same(A vs B)=${same} h265=${looksLikeH265(decA)}`);
    if (!same) {
      console.log('  MISMATCH! A head:', decA.slice(0, 12).toString('hex'));
      console.log('            B head:', subB.slice(0, 12).toString('hex'));
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
