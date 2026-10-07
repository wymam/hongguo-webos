// Loads service.js outside the TV by stubbing the webos-service module the
// runtime normally injects. This exercises the real handlers and the local
// media proxy end to end, including a genuine Range request against a real
// decrypted video segment.
//
// Usage: node tools/verify-service.js
'use strict';

const path = require('path');
const http = require('http');
const Module = require('module');

const SVC_DIR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service');

// ---- stub 'webos-service' ------------------------------------------------
const registered = new Map();
const responses = [];

function makeService() {
  return {
    register(name, handler) {
      registered.set(name, handler);
      return { cancel() {} };
    },
    call() {},
    activity() {
      return { create() {}, complete() {} };
    }
  };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'webos-service') return 'webos-service-stub';
  return originalResolve.call(this, request, ...rest);
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'webos-service') return makeService;
  return originalLoad.call(this, request, ...rest);
};

// Capture respond() results so we can assert on handler output.
function invoke(method, payload) {
  const handler = registered.get(method);
  if (!handler) return Promise.reject(new Error(`method not registered: ${method}`));
  return new Promise((resolve) => {
    const message = {
      payload: payload || {},
      respond(obj) { resolve(obj); }
    };
    handler(message);
  });
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
}

(async () => {
  // Load the service. It starts the media proxy as a side effect.
  require(path.join(SVC_DIR, 'service.js'));
  // Give the listen() a moment to bind.
  await new Promise((r) => setTimeout(r, 400));

  console.log('--- registered Luna methods ---');
  const methods = [...registered.keys()].sort();
  console.log('      ' + methods.join(', '));
  for (const m of ['getHome', 'getCategory', 'getSearch', 'getDetail', 'ping', 'getDiagnostics']) {
    check(`registered: ${m}`, registered.has(m));
  }

  console.log('\n--- ping / getDiagnostics ---');
  const ping = await invoke('ping');
  check('ping returns returnValue:true', ping.returnValue === true);
  console.log(`      node=${ping.node} mediaPort=${ping.mediaPort}`);
  const diag = await invoke('getDiagnostics');
  check('diagnostics returns returnValue:true', diag.returnValue === true);
  check('diagnostics reports upstream ok', diag.upstream && diag.upstream.upstream === 'ok',
    JSON.stringify(diag.upstream));
  console.log(`      crypto: ${diag.upstream.crypto}`);
  console.log(`      compat patched: ${JSON.stringify(diag.compat)}`);

  console.log('\n--- getHome ---');
  const home = await invoke('getHome');
  check('getHome ok', home.returnValue === true, home.errorText || '');
  if (home.returnValue) {
    check('home has sections', Array.isArray(home.sections) && home.sections.length > 0);
    console.log(`      banners=${home.banners.length} sections=${home.sections.length}`);
  }

  console.log('\n--- getCategory ---');
  const cat = await invoke('getCategory', { key: 'real', page: 1 });
  check('getCategory ok', cat.returnValue === true, cat.errorText || '');
  if (cat.returnValue) {
    check('category has items', cat.items.length > 0);
    check('category has filters', Array.isArray(cat.filters) && cat.filters.length > 0);
    check('category has pagination', cat.pagination && cat.pagination.total > 0);
    console.log(`      ${cat.name}: ${cat.items.length} items, ${cat.filters.length} filter groups, total=${cat.pagination.total}`);
  }

  console.log('\n--- getSearch (expected gated) ---');
  const search = await invoke('getSearch', { keyword: '总裁' });
  if (search.returnValue) {
    console.log(`SKIP  search returned ${search.items.length} items (${search.source})`);
  } else {
    check('search fails with a descriptive code', search.errorCode === 'SEARCH_UNAVAILABLE' || !!search.errorText,
      search.errorText);
    console.log(`      ${search.errorCode}: ${search.errorText}`);
  }

  console.log('\n--- input validation ---');
  const badId = await invoke('getDetail', { id: 'abc' });
  check('getDetail rejects non-numeric id', badId.returnValue === false && badId.errorCode === 'BAD_INPUT');
  const emptyKw = await invoke('getSearch', { keyword: '   ' });
  check('getSearch rejects blank keyword', emptyKw.returnValue === false && emptyKw.errorCode === 'BAD_INPUT');

  console.log('\n--- getDetail + media proxy Range request ---');
  const seriesId = home.returnValue && home.sections[0].items[0].id;
  const detail = await invoke('getDetail', { id: seriesId });
  check('getDetail ok', detail.returnValue === true, detail.errorText || '');
  if (detail.returnValue) {
    console.log(`      ${detail.title}: ${detail.episodes.length} episodes`);
    const ep = detail.episodes[0].id;

    // Ask the media proxy for the first 64KiB and confirm real MP4 bytes.
    const first = await httpGet(`http://127.0.0.1:7655/media/${ep}`, { Range: 'bytes=0-65535' });
    check('media proxy HTTP 206', first.status === 206, `got ${first.status}`);
    check('content-type video/mp4', /video\/mp4/.test(first.headers['content-type'] || ''),
      first.headers['content-type']);
    check('content-range present', /^bytes 0-65535\//.test(first.headers['content-range'] || ''),
      first.headers['content-range']);
    check('body is 65536 bytes', first.body.length === 65536, `got ${first.body.length}`);
    check('body has MP4 ftyp box', first.body.subarray(0, 64).toString('latin1').includes('ftyp'),
      first.body.subarray(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));

    // An offset request proves the CENC sample index works past byte 0.
    const offset = await httpGet(`http://127.0.0.1:7655/media/${ep}`, { Range: 'bytes=1048576-1114111' });
    check('offset range HTTP 206', offset.status === 206);
    check('offset body length', offset.body.length === 65536, `got ${offset.body.length}`);
    console.log(`      first=${first.body.length}B  offset=${offset.body.length}B  total=${(first.headers['content-range'] || '').split('/')[1]}`);

    // HEAD must not send a body but must advertise the range.
    const head = await httpGet(`http://127.0.0.1:7655/media/${ep}`, { Range: 'bytes=0-1023' }, 'HEAD');
    check('HEAD returns 206 without body', head.status === 206 && head.body.length === 0,
      `status=${head.status} len=${head.body.length}`);

    // Malformed range -> 416
    const bad = await httpGet(`http://127.0.0.1:7655/media/${ep}`, { Range: 'bytes=abc' });
    check('malformed range -> 416', bad.status === 416, `got ${bad.status}`);

    // 404 for a non-media path
    const nf = await httpGet('http://127.0.0.1:7655/nope');
    check('unknown path -> 404', nf.status === 404, `got ${nf.status}`);

    // health endpoint
    const health = await httpGet('http://127.0.0.1:7655/health');
    check('health ok', health.status === 200 && JSON.parse(health.body.toString()).ok === true);
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('unexpected:', e);
  process.exit(1);
});

function httpGet(urlStr, headers, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(urlStr, { method: method || 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
