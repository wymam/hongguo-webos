// Compares the two signed endpoints to localise the failure.
//   * video (multi_video_model) — KNOWN WORKING (stream playback proved it)
//   * search (bookapi/search/tab) — returns HTTP 200 with an EMPTY body
//
// An empty 200 on one and a valid payload on the other points at signature
// validation rather than network/TLS, so this probe dumps the response headers
// and byte length for both.
//
// Usage: node tools/probe-signed-compare.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SVC = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service');
require(path.join(SVC, 'crypto-shim.js'));
const crypto = require('crypto');
const httpClient = require(path.join(SVC, 'http-client.js'));
httpClient.create = () => httpClient;

const src = fs.readFileSync(path.join(SVC, 'vendor', 'hongguo.cjs'), 'utf8');

const ctx = vm.createContext({
  require: (n) => {
    if (n === 'node:crypto' || n === 'crypto') return crypto;
    throw new Error('Unsupported module: ' + n);
  },
  Buffer, URL, URLSearchParams, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, process: { env: {} }, axios: httpClient
});

const suffix = `
this.searchReq = function (kw, tabType) {
  const values = appSearchParams(kw, tabType, 20, {}, 1);
  const khronos = Math.floor(Date.now() / 1000);
  const ticket = Date.now();
  const query = pythonUrlEncode({ ...values, ts: String(khronos), _rticket: String(ticket) });
  return { url: APP_SEARCH_API + '?' + query, headers: {
    'User-Agent': APP_UA, Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-ss-req-ticket': String(ticket), 'x-tt-request-tag': 't=0;n=0', 'sdk-version': '2',
    'passport-sdk-version': '50561', 'x-xs-from-web': '0', 'x-khronos': String(khronos),
    'x-ladon': be32(khronos).toString('base64'), 'x-argus': le32(khronos).toString('base64'),
    'x-gorgon': xGorgon(query, null, khronos, Math.floor(Math.random() * 65536)),
    'x-helios': helios(khronos), 'x-medusa': buildMedusa(APP_SEARCH_API + '?' + query, null, khronos),
    'x-tt-dt': '',
  }, query, khronos };
};
this.videoReq = function (vid) { return signedVideoRequest(JSON.stringify({ biz_param: {}, mixed_video_id_map: { '1004': [String(vid)] } })); };
this.service = { VIDEO_UA: VIDEO_UA, APP_UA: APP_UA, VIDEO_API: VIDEO_API, APP_SEARCH_API: APP_SEARCH_API };
`;

vm.runInContext(src + suffix, ctx, { timeout: 10000 });

async function inspect(label, req) {
  console.log(`\n${'='.repeat(68)}\n${label}\n${'='.repeat(68)}`);
  console.log(`  host: ${new URL(req.url).host}`);
  console.log(`  query len: ${req.query ? req.query.length : '(json body)'}`);
  const signedHeaders = req.headers || {};
  console.log(`  signature headers present: ${['x-gorgon', 'x-ladon', 'x-helios', 'x-medusa', 'x-khronos']
    .map((h) => `${h}=${signedHeaders[h] ? 'y' : 'n'}`).join(' ')}`);
  try {
    const r = await httpClient(req.url, {
      headers: signedHeaders,
      method: req.body ? 'POST' : 'GET',
      data: req.body,
      timeout: 20000,
      responseType: 'text'
    });
    const body = String(r.data || '');
    console.log(`  HTTP ${r.status}  body ${body.length} bytes`);
    console.log(`  content-type: ${r.headers['content-type'] || '(none)'}`);
    console.log(`  content-length: ${r.headers['content-length'] || '(none)'}`);
    console.log(`  server: ${r.headers.server || '(none)'}`);
    // Surface any anti-bot / verification markers
    const interesting = Object.keys(r.headers).filter((h) => /verify|bot|risk|passport|token|challenge/i.test(h));
    if (interesting.length) {
      for (const h of interesting) console.log(`  ${h}: ${r.headers[h]}`);
    }
    if (body) console.log(`  body head: ${body.slice(0, 300)}`);
    else console.log('  body is EMPTY (typical of a rejected signature)');
  } catch (e) {
    console.log(`  REQUEST ERROR: ${e.message}`);
  }
}

(async () => {
  const svc = ctx.service;
  console.log(`VIDEO_API       ${svc.VIDEO_API}`);
  console.log(`APP_SEARCH_API  ${svc.APP_SEARCH_API}`);
  console.log(`VIDEO_UA  ${svc.VIDEO_UA.slice(0, 60)}...`);
  console.log(`APP_UA    ${svc.APP_UA.slice(0, 60)}...`);

  await inspect('signed VIDEO endpoint (known good)', ctx.videoReq('7691249364097829913'));
  await inspect('signed SEARCH endpoint (returns empty)', ctx.searchReq('总裁', 11));
})().catch((e) => { console.error(e); process.exit(1); });
