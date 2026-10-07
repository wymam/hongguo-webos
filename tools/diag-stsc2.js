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
function boxAt(d,o,limit){limit=limit||d.length;if(o<0||o+8>limit)return null;let s=d.readUInt32BE(o);const t=d.toString('ascii',o+4,o+8);let h=8;if(s===1){if(o+16>limit)return null;s=Number(d.readBigUInt64BE(o+8));h=16;}else if(s===0)s=limit-o;if(s<h||o+s>limit)return null;return{o,s,t,h,body:o+h};}
function children(d,b){const out=[];let p=b.body;while(p+8<=b.o+b.s){const c=boxAt(d,p,b.o+b.s);if(!c)break;out.push(c);p+=c.s;}return out;}
function findIn(d,b,type){for(const c of children(d,b))if(c.t===type)return c;return null;}
(async()=>{
  const stream=await api.resolveStream(EP,'auto');
  const head=await api.remoteRange(stream,0,1024*1024-1);
  const d=head.data;
  const ftyp=boxAt(d,0); const moov=boxAt(d,ftyp.s);
  for(const trak of children(d,moov)){
    if(trak.t!=='trak')continue;
    const mdia=findIn(d,trak,'mdia'); const hdlr=findIn(d,mdia,'hdlr');
    const handler=hdlr?d.toString('ascii',hdlr.body+8,hdlr.body+12):'?';
    const minf=findIn(d,mdia,'minf'); const stbl=findIn(d,minf,'stbl');
    const stsz=findIn(d,stbl,'stsz'); const stsc=findIn(d,stbl,'stsc'); const stco=findIn(d,stbl,'stco')||findIn(d,stbl,'co64');
    const n=stsz?d.readUInt32BE(stsz.body+4):0;
    const chunkCount=stco?d.readUInt32BE(stco.body):0;
    const entryCount=stsc?d.readUInt32BE(stsc.body):0;
    const entries=[];
    for(let i=0;i<entryCount;i++){const at=stsc.body+4+i*12;entries.push([d.readUInt32BE(at),d.readUInt32BE(at+4)]);}
    // simulate vendor's samplesPerChunk
    let total=0; let prev=0;
    const spc=[];
    for(let chunk=0;chunk<chunkCount;chunk++){
      let sel=0; for(const e of entries) if(e[0]<=chunk+1) sel=e[1];
      spc.push(sel); total+=sel;
    }
    console.log(`trak ${handler}: n=${n} chunkCount=${chunkCount} stsc=${JSON.stringify(entries)} sum(samplesPerChunk)=${total} ${total===n?'OK':'MISMATCH!'}`);
    if(total!==n) console.log(`   first 8 spc=${JSON.stringify(spc.slice(0,8))}`);
  }
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
