'use strict';
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
function boxAt(d, o, limit) { limit=limit||d.length; if(o<0||o+8>limit) return null; let s=d.readUInt32BE(o); const t=d.toString('ascii',o+4,o+8); let h=8; if(s===1){if(o+16>limit)return null;s=Number(d.readBigUInt64BE(o+8));h=16;} else if(s===0)s=limit-o; if(s<h||o+s>limit)return null; return {o,s,t,h,body:o+h}; }
function children(d,b){const out=[];let p=b.body;while(p+8<=b.o+b.s){const c=boxAt(d,p,b.o+b.s);if(!c)break;out.push(c);p+=c.s;}return out;}
function findIn(d,b,type){for(const c of children(d,b)) if(c.t===type) return c; return null;}
(async()=>{
  const stream=await api.resolveStream(EP,'auto');
  const head=await api.remoteRange(stream,0,1024*1024-1);
  const d=head.data;
  const ftyp=boxAt(d,0); const moov=boxAt(d,ftyp.s);
  for(const trak of children(d,moov)){
    if(trak.t!=='trak')continue;
    const mdia=findIn(d,trak,'mdia'); const hdlr=findIn(d,mdia,'hdlr');
    const handler=hdlr?d.toString('ascii',hdlr.body+8,hdlr.body+12):'?';
    const minf=findIn(d,mdia,'minf'); const stbl=findIn(d,minf,'stbl'); const stsd=findIn(d,stbl,'stsd');
    // stsd: version+flags(4) + entryCount(4) + entries. entry: size(4)+type(4)+...
    let p=stsd.body+8; let entryType='';
    while(p+8<=stsd.o+stsd.s){ const e=boxAt(d,p,stsd.o+stsd.s); if(!e)break; entryType=e.t; p=e.body; break; }
    console.log(`trak handler=${handler}  stsd entryType=${entryType}`);
    // walk into sinf -> frma
    if(entryType==='encv'||entryType==='enca'){
      const sinf=findIn(d,{o:stsd.o,s:stsd.s,body:stsd.body},'sinf');
      const frma=findIn(d,{o:stsd.o,s:stsd.s,body:stsd.body},'frma');
      if(frma) console.log(`   frma real codec = ${d.toString('ascii',frma.body,frma.body+4)}`);
      // also dump sample entry bytes to find esds/mp4a
    }
  }
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
