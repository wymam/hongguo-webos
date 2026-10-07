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
(async()=>{
  const stream=await api.resolveStream(EP,'auto');
  const head=await api.remoteRange(stream,0,1024*1024-1);
  const d=head.data;
  // find all 'frma' occurrences in the moov (plaintext) region
  let idx=0; const found=[];
  while((idx=d.indexOf('frma',idx))>=0){ found.push(d.toString('ascii',idx+4,idx+8)); idx+=4; }
  console.log('frma codecs found:', JSON.stringify(found));
  // find 'encv'/'enca' + surrounding, and any 'avc1'/'hvc1'/'hev1'/'mp4a'/'ac-3'/'ec-3' fourcc
  for(const cc of ['encv','enca','hvc1','hev1','avc1','mp4a','ac-3','ec-3','Opus','fLaC','stsd']){
    let i=0,c=0; while((i=d.indexOf(cc,i))>=0){ c++; i+=4; }
    console.log(`fourcc ${cc}: ${c} occurrences`);
  }
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
