'use strict';
// Read saiz/saio correctly (sequential box walk) and report the per-sample
// auxiliary-info size for BOTH tracks, to confirm whether audio uses
// subsample encryption (auxSize > 8) while the vendored buildSamples only
// handles the auxSize==8 full-sample case.
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const crypto = require('crypto');
require('../service/com.hongguowebos.app.service/crypto-shim.js');
const httpClient = require('../service/com.hongguowebos.app.service/http-client.js');
if (typeof httpClient.create !== 'function') httpClient.create = function () { return httpClient; };
const VENDOR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');
const EP = process.argv[2] || '7691249364097829913';
const src = fs.readFileSync(VENDOR, 'utf8');
const ctx = vm.createContext({ require: (n) => (n === 'node:crypto' || n === 'crypto') ? crypto : (function(){throw new Error(n)})(), Buffer, URL, URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, process: { env: {} }, axios: httpClient });
vm.runInContext(src + '\nthis.api = { resolveStream, remoteRange };', ctx, { timeout: 10000 });
const api = ctx.api;

function boxAt(d, o, limit) {
  limit = limit || d.length;
  if (o < 0 || o + 8 > limit) return null;
  let size = d.readUInt32BE(o); const type = d.toString('ascii', o+4, o+8); let hdr = 8;
  if (size === 1) { if (o+16>limit) return null; size = Number(d.readBigUInt64BE(o+8)); hdr = 16; }
  else if (size === 0) size = limit - o;
  if (size < hdr || o + size > limit) return null;
  return { o, size, type, hdr, body: o + hdr };
}
function children(d, box) {
  const out = []; let p = box.body;
  while (p + 8 <= box.o + box.size) { const b = boxAt(d, p, box.o + box.size); if (!b) break; out.push(b); p += b.size; }
  return out;
}
function findIn(d, box, type) {
  for (const c of children(d, box)) if (c.type === type) return c;
  return null;
}

(async () => {
  const stream = await api.resolveStream(EP, 'auto');
  const head = await api.remoteRange(stream, 0, 1024*1024-1);
  const d = head.data;
  const ftyp = boxAt(d, 0);
  const moov = boxAt(d, ftyp.size);
  for (const trak of children(d, moov)) {
    if (trak.type !== 'trak') continue;
    const mdia = findIn(d, trak, 'mdia');
    const hdlr = findIn(d, mdia, 'hdlr');
    const handler = hdlr ? d.toString('ascii', hdlr.body + 8, hdlr.body + 12) : '?';
    const minf = findIn(d, mdia, 'minf');
    const stbl = findIn(d, minf, 'stbl');
    const saiz = findIn(d, stbl, 'saiz');
    const saio = findIn(d, stbl, 'saio');
    const stsz = findIn(d, stbl, 'stsz');
    // saiz: version+flags(4) [+ aux_info_type(4)+param(4) if flags&1], then default(1)+count(4)+sizes
    const flags = saiz ? d.readUInt32BE(saiz.body) & 0xffffff : 0;
    const base = saiz ? saiz.body + 4 + ((flags & 1) ? 8 : 0) : 0;
    const defaultSize = saiz ? d[base] : -1;
    const count = saiz ? d.readUInt32BE(base + 1) : 0;
    const stszCount = stsz ? d.readUInt32BE(stsz.body + 4) : 0;
    // saio flags
    const saioFlags = saio ? d.readUInt32BE(saio.body) & 0xffffff : 0;
    const saioBase = saio ? saio.body + 4 + ((saioFlags & 1) ? 8 : 0) : 0;
    const saioVer = saio ? d[saio.body] : 0;
    const saioWidth = saioVer === 1 ? 8 : 4;
    const auxOffset = saio ? (saioWidth === 8 ? Number(d.readBigUInt64BE(saioBase + 4)) : d.readUInt32BE(saioBase + 4)) : -1;

    // first few aux sizes
    const sizes = [];
    if (defaultSize > 0) { for (let i = 0; i < Math.min(6, count); i++) sizes.push(defaultSize); }
    else { for (let i = 0; i < Math.min(6, count); i++) sizes.push(d[base + 5 + i]); }

    console.log(`trak handler=${handler}  flags=0x${flags.toString(16)}  defaultSize=${defaultSize}  count=${count}  stszCount=${stszCount}  auxOffset=${auxOffset}`);
    console.log(`   first aux sizes: ${JSON.stringify(sizes)}`);
    // dump first aux entry bytes
    if (auxOffset >= 0) {
      const n = defaultSize || (sizes[0] || 8);
      console.log(`   aux[0..${n}] @${auxOffset}: ${d.slice(auxOffset, auxOffset + Math.min(n, 24)).toString('hex')}`);
    }
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
