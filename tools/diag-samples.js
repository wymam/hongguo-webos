'use strict';
// Load the vendored source exactly like provider.js, then read the RAW (still
// encrypted) moov and dump the sample tables, to find where sample indexing
// goes wrong (which is what leaves later segments undecrypted).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const cryptoShim = require('../service/com.hongguowebos.app.service/crypto-shim.js');
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
function findBox(data, type, start) {
  for (let o = Math.max(0, start || 0); o + 8 <= data.length; o++) {
    const b = readBox(data, o);
    if (b && b.type === type) return b;
  }
  return null;
}

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  console.log('stream url:', (stream.url || '').slice(0, 90));
  console.log('keyed:', !!stream.key);

  // raw head — moov is plaintext, mdat is still encrypted here.
  const head = await api.remoteRange(stream, 0, 1024 * 1024 - 1);
  const data = head.data;
  console.log('head total =', head.total, ' got =', data.length);

  const ftypSize = data.readUInt32BE(0);
  const moov = readBox(data, ftypSize);
  console.log('moov:', moov && moov.type, 'size', moov && moov.size, 'at', ftypSize);

  const moovBody = data.subarray(moov.bodyStart, moov.offset + moov.size);
  // find all trak
  const traks = [];
  let cursor = 0;
  for (;;) { const t = findBox(moovBody, 'trak', cursor); if (!t) break; traks.push(t); cursor = t.offset + t.size; }
  console.log('trak count =', traks.length);

  traks.forEach((trak, ti) => {
    const hdlr = findBox(moovBody, 'hdlr', trak.bodyStart);
    const handler = hdlr ? moovBody.toString('ascii', hdlr.bodyStart + 8, hdlr.bodyStart + 12) : '?';
    const stbl = findBox(moovBody, 'stbl', trak.bodyStart);
    const stsz = findBox(moovBody, 'stsz', stbl.bodyStart);
    const stsc = findBox(moovBody, 'stsc', stbl.bodyStart);
    const stco = findBox(moovBody, 'stco', stbl.bodyStart) || findBox(moovBody, 'co64', stbl.bodyStart);
    const saiz = findBox(moovBody, 'saiz', stbl.bodyStart);
    const saio = findBox(moovBody, 'saio', stbl.bodyStart);

    const sampleCount = stsz ? moovBody.readUInt32BE(stsz.bodyStart + 4) : 0;
    const chunkCount = stco ? moovBody.readUInt32BE(stco.bodyStart) : 0;
    const entryCount = stsc ? moovBody.readUInt32BE(stsc.bodyStart) : 0;
    console.log(`\ntrak[${ti}] handler=${handler}`);
    console.log('  sampleCount =', sampleCount, ' chunkCount =', chunkCount, ' stsc entries =', entryCount);
    if (stsc) {
      const entries = [];
      for (let i = 0; i < entryCount; i++) {
        const at = stsc.bodyStart + 4 + i * 12;
        entries.push({ firstChunk: moovBody.readUInt32BE(at), samplesPerChunk: moovBody.readUInt32BE(at + 4) });
      }
      console.log('  stsc entries:', JSON.stringify(entries));
    }
    if (stco) {
      const first = moovBody.readUInt32BE(stco.bodyStart + 4);
      const second = chunkCount > 1 ? moovBody.readUInt32BE(stco.bodyStart + 8) : -1;
      const last = chunkCount > 0 ? moovBody.readUInt32BE(stco.bodyStart + 4 + (chunkCount - 1) * 4) : -1;
      console.log('  stco first 3 offsets:', first, second, '... last =', last);
    }
    if (saiz) {
      const def = moovBody[saiz.bodyStart];
      const cnt = moovBody.readUInt32BE(saiz.bodyStart + 1);
      console.log('  saiz default =', def, ' count =', cnt);
    }
    if (saio) {
      const ver = moovBody.readUInt32BE(saio.bodyStart) >>> 24;
      const cnt = moovBody.readUInt32BE(saio.bodyStart + 4);
      const off = ver === 1 ? Number(moovBody.readBigUInt64BE(saio.bodyStart + 8)) : moovBody.readUInt32BE(saio.bodyStart + 8);
      console.log('  saio ver =', ver, ' count =', cnt, ' offset =', off);
    }
  });
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
