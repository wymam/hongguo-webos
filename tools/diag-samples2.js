'use strict';
// Use the vendored prepareHeader/decryptPartial directly to see (a) how many
// samples the CENC index holds and where the first/last land, and (b) whether
// decrypting segment 2 (1-2MiB) actually yields plaintext.
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

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const prepared = await api.prepareHeader(stream);
  console.log('total =', prepared.total, ' header.length =', prepared.header.length, ' samples =', prepared.samples.length);

  if (prepared.samples.length) {
    const s = prepared.samples;
    console.log('first sample:', JSON.stringify(s[0]));
    console.log('sample[10]:', JSON.stringify(s[10]));
    console.log('last sample:', JSON.stringify(s[s.length - 1]));
    // how many samples fall in [1MiB, 2MiB)
    const lo = 1048576, hi = 2097152;
    const inSeg2 = s.filter((x) => x.end > lo && x.start < hi).length;
    console.log('samples overlapping segment [1MiB,2MiB):', inSeg2);
    // first sample whose start >= 1MiB
    const firstAfter = s.find((x) => x.start >= lo);
    console.log('first sample starting >= 1MiB:', JSON.stringify(firstAfter));
  }

  // decrypt segment 2 directly
  const seg2 = await api.remoteRange(stream, 1048576, 2097151);
  const dec = api.decryptPartial(seg2.data, 1048576, stream.key, prepared);
  console.log('\nsegment2 decrypted head hex:', dec.slice(0, 48).toString('hex'));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
