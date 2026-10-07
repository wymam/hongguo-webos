// Diagnoses the signed app-search endpoint. It answers HTTP 200 with a
// non-zero body `code`, which the vendored source reports as
// "App search failed: 200". This probe surfaces the raw body so we can tell a
// signature rejection from a retired endpoint.
//
// Usage: node tools/probe-search.js
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

// Rebuild the exact signed app-search request from the vendored internals
// (mirrors the block at hongguo.cjs:~405).
const suffix = `
this.raw = async function (kw, tabType) {
  const values = appSearchParams(kw, tabType, 20, {}, 1);
  const khronos = Math.floor(Date.now() / 1000);
  const ticket = Date.now();
  const query = pythonUrlEncode({ ...values, ts: String(khronos), _rticket: String(ticket) });
  const url = APP_SEARCH_API + '?' + query;
  const random = Math.floor(Math.random() * 65536);
  const body = null;
  const headers = {
    'User-Agent': APP_UA, Accept: 'application/json; charset=utf-8,application/x-protobuf',
    'x-ss-req-ticket': String(ticket), 'x-tt-request-tag': 't=0;n=0', 'sdk-version': '2',
    'passport-sdk-version': '50561', 'x-xs-from-web': '0', 'x-khronos': String(khronos),
    'x-ladon': be32(khronos).toString('base64'), 'x-argus': le32(khronos).toString('base64'),
    'x-gorgon': xGorgon(query, body, khronos, random), 'x-helios': helios(khronos),
    'x-medusa': buildMedusa(url, body, khronos), 'x-tt-dt': '',
  };
  const resp = await axios(url, { headers, timeout: 20000, responseType: 'text' });
  return { status: resp.status, body: String(resp.data).slice(0, 1000), url: url.slice(0, 160) };
};
`;

let ready = true;
try {
  vm.runInContext(src + suffix, ctx, { timeout: 10000 });
} catch (e) {
  ready = false;
  console.log('eval failed:', e.message);
  const names = [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  console.log('internal helpers matching search/sign/app:');
  console.log('  ' + names.filter((n) => /search|sign|app/i.test(n)).join(', '));
}

(async () => {
  // Also list the internal helper names so we can adapt if the suffix failed.
  if (!ready) {
    const names = [...src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    console.log('\ninternal functions found in vendor source:');
    console.log('  ' + names.filter((n) => /search|sign|App|app/i.test(n)).join(', '));
    return;
  }
  for (const [kw, tab] of [['总裁', 11], ['重生', 11], ['总裁', 19]]) {
    try {
      const r = await ctx.raw(kw, tab);
      console.log(`\nkw=${kw} tab=${tab}  HTTP ${r.status}`);
      console.log(`  url: ${r.url}...`);
      console.log(`  body: ${r.body}`);
    } catch (e) {
      console.log(`\nkw=${kw} tab=${tab}  ERROR: ${e.message}`);
    }
  }
})();
