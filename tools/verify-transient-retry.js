// Verifies the DNS-blip resilience added after a REAL on-device failure.
//
// Field evidence (getDiagnostics.recentErrors, 2026-10-11, the owner's TV):
//   { "at": 1791697551040, "tag": "media",
//     "detail": "7680977186605517849: DNS lookup failed" }
// ...on an episode that played fine seconds before and seconds after. Root
// cause, after reading the call chain: the resolve step (getStreamHandle ->
// provider.stream -> resolveStream -> fetchVideoInfo) had NO retry at all, and
// the classifier gating every retry budget did not recognise DNS failures
// anyway ("DNS lookup failed" matched none of its patterns, and ENOTFOUND was
// not in its code list). One resolver blip therefore became a 502.
//
// This script pins both fixes down:
//   1. classifiers — DNS failures ARE transient; hard errors are NOT
//   2. http-client — a refused-then-up server is survived; a dead one fails
//      after a bounded number of attempts; the real DNS-failure path works
//   3. resolveStreamResilient — transient failures retried, hard errors not
//
// Usage: node tools/verify-transient-retry.js
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const SVC = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service');
const providerMod = require(path.join(SVC, 'provider.js'));
const httpClient = require(path.join(SVC, 'http-client.js'));
const T = providerMod.__test;

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}`);
    console.log(`      ${e.message}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

(async () => {
  console.log('--- transient classifiers ---');

  await check('ENOTFOUND (code only) counts as transient', () => {
    const e = new Error('getaddrinfo ENOTFOUND cdn.example');
    e.code = 'ENOTFOUND';
    assert.strictEqual(T.isTransientNetworkError(e), true);
  });

  await check('"DNS lookup failed" (rewritten message, the exact on-device case) counts as transient', () => {
    const e = new Error('DNS lookup failed');
    e.code = 'ENOTFOUND';
    assert.strictEqual(T.isTransientNetworkError(e), true);
    // And it must reach the range budget as well — THIS was the regression:
    assert.strictEqual(T.isTransientRangeError(e), true);
  });

  await check('EAI_AGAIN counts as transient', () => {
    const e = new Error('temporary failure in name resolution');
    e.code = 'EAI_AGAIN';
    assert.strictEqual(T.isTransientNetworkError(e), true);
  });

  await check('a hard upstream answer (404) is NOT transient', () => {
    assert.strictEqual(T.isTransientNetworkError(new Error('Request failed with status code 404')), false);
  });

  await check('short-read anomaly still counts as transient (regression guard)', () => {
    assert.strictEqual(T.isTransientRangeError(new Error('媒体 Range 长度异常: 0/262144')), true);
  });

  console.log('\n--- http-client: pre-connect retry ---');

  await check('request survives "connection refused, then server comes up"', async () => {
    const port = await freePort();
    const t0 = Date.now();
    let server = null;
    const p = httpClient.get(`http://127.0.0.1:${port}/ok`).then(
      (r) => ({ ok: true, ms: Date.now() - t0, status: r.status, data: r.data }),
      (e) => ({ ok: false, ms: Date.now() - t0, err: e })
    );
    setTimeout(() => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello');
      });
      server.listen(port, '127.0.0.1');
    }, 150);
    const res = await p;
    if (server) {
      await new Promise((r) => server.close(r));
    }
    assert.strictEqual(res.ok, true, 'request should recover, got: ' + (res.err && res.err.message));
    assert.strictEqual(res.data, 'hello');
    assert.ok(res.ms >= 200, `expected retry backoff first, total was only ${res.ms}ms`);
  });

  await check('persistent refusal fails after bounded retries (never hangs)', async () => {
    const port = await freePort(); // nothing listens here
    const t0 = Date.now();
    let err = null;
    try {
      await httpClient.get(`http://127.0.0.1:${port}/nope`);
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    assert.ok(err, 'should throw');
    assert.strictEqual(err.code, 'ECONNREFUSED');
    assert.ok(ms >= 900, `expected 2 backoffs (250+700ms), got ${ms}ms`);
    assert.ok(ms < 6000, `must stay bounded, got ${ms}ms`);
  });

  console.log('\n--- real DNS failure path ---');

  await check('DNS failure surfaces as "DNS lookup failed" after retries', async () => {
    const t0 = Date.now();
    let err = null;
    try {
      await httpClient.get(`http://blip-${Date.now()}.invalid/`);
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t0;
    assert.ok(err, 'should throw');
    assert.strictEqual(err.message, 'DNS lookup failed');
    assert.strictEqual(err.code, 'ENOTFOUND');
    assert.ok(ms >= 900, `expected retries before giving up, got ${ms}ms`);
  });

  console.log('\n--- resolveStreamResilient ---');

  await check('survives two transient failures then succeeds', async () => {
    let calls = 0;
    const a = {
      resolveStream: function () {
        calls++;
        if (calls <= 2) {
          const e = new Error('DNS lookup failed');
          e.code = 'ENOTFOUND';
          return Promise.reject(e);
        }
        return Promise.resolve({ url: 'http://example.test/stream.mp4', quality: 'auto', key: null });
      }
    };
    const stream = await T.resolveStreamResilient(a, '7680977186605517849');
    assert.strictEqual(calls, 3, `expected 3 attempts, got ${calls}`);
    assert.ok(stream.url);
  });

  await check('gives up immediately on non-transient errors', async () => {
    let calls = 0;
    const a = {
      resolveStream: function () {
        calls++;
        return Promise.reject(new Error('没有可用清晰度'));
      }
    };
    let threw = false;
    try {
      await T.resolveStreamResilient(a, '1');
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true);
    assert.strictEqual(calls, 1, `non-transient errors must not retry, got ${calls} calls`);
  });

  console.log('\n--- openStream: re-sign a poisoned URL ---');

  // Mock upstream whose behaviour is scripted by failure counters. Mirrors the
  // real shape: resolveStream (signs the URL) and prepareHeader (256KiB first
  // window) plus the two caches openStream is expected to drop between rounds.
  function mockUpstream(opts) {
    const state = { resolves: 0, prepares: 0, cacheDeletes: 0 };
    const a = {
      streamCache: { delete: function () { state.cacheDeletes++; } },
      videoInfoCache: { delete: function () { state.cacheDeletes++; } },
      resolveStream: function () {
        state.resolves++;
        if (state.resolves <= opts.resolveFails) {
          const e = new Error('DNS lookup failed');
          e.code = 'ENOTFOUND';
          return Promise.reject(e);
        }
        return Promise.resolve({ url: 'http://cdn.test/' + state.resolves + '.mp4', quality: 'auto', key: null });
      },
      prepareHeader: function () {
        state.prepares++;
        if (state.prepares <= opts.prepareFails) {
          return Promise.reject(new Error('媒体 Range 长度异常: 142/262144'));
        }
        return Promise.resolve({ total: 1000000, header: Buffer.alloc(0), samples: [] });
      },
      decryptPartial: function () { return Buffer.alloc(0); }
    };
    return { a: a, state: state };
  }

  await check('THE on-device case: prepare fails every retry on round 1, fresh URL fixes it on round 2', async () => {
    const { a, state } = mockUpstream({ resolveFails: 0, prepareFails: 7 });
    const handle = await T.openStream(a, '7692013453707332632');
    assert.ok(handle && typeof handle.chunk === 'function', 'should produce a playable handle');
    assert.strictEqual(state.resolves, 2, `expected a re-sign (2 resolves), got ${state.resolves}`);
    assert.strictEqual(state.prepares, 8, `expected 7 failed + 1 good prepare, got ${state.prepares}`);
    assert.strictEqual(state.cacheDeletes, 2, 'both caches must be dropped before re-signing');
  });

  await check('resolve exhausts round 1, then succeeds after a fresh sign', async () => {
    const { a, state } = mockUpstream({ resolveFails: 4, prepareFails: 0 });
    const handle = await T.openStream(a, '1');
    assert.ok(handle, 'should produce a handle');
    assert.strictEqual(state.resolves, 5, `expected 4 failed + 1 good resolve, got ${state.resolves}`);
  });

  await check('two full rounds of failure still terminate (bounded, honest error)', async () => {
    const { a, state } = mockUpstream({ resolveFails: 8, prepareFails: 0 });
    let err = null;
    const t0 = Date.now();
    try {
      await T.openStream(a, '1');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'should throw');
    assert.ok(/已换新签名 2 轮/.test(err.message), `error must say both rounds were tried, got: ${err.message}`);
    assert.strictEqual(state.resolves, 8, `expected 4+4 resolves, got ${state.resolves}`);
    assert.ok(Date.now() - t0 < 15000, 'must stay bounded');
  });

  console.log('\n--- fetchWholeRange: never hands back a short body ---');

  await check('a clean window costs exactly one read', async () => {
    let calls = 0;
    T.setOriginalRemoteRange(function (stream, s, e) {
      calls++;
      return Promise.resolve({ data: Buffer.alloc(e - s + 1), total: 10 * 1024 * 1024 });
    });
    const r = await T.fetchWholeRange({}, 0, 65535, 0);
    assert.strictEqual(r.data.length, 65536);
    assert.strictEqual(calls, 1, `should not retry a good read, got ${calls}`);
  });

  await check('THE device case: a persistently truncated 256KiB window is assembled from smaller reads', async () => {
    // Simulates the measured CDN behaviour: asks above 128KiB come back
    // truncated (half the size); asks at or below 128KiB come back complete.
    // This is 1:1 with what the live edge did — 262144-byte asks returned
    // 218/32768/131072 bytes across reruns, while small asks succeeded.
    const calls = [];
    T.setOriginalRemoteRange(function (stream, s, e) {
      const want = e - s + 1;
      calls.push([s, e]);
      if (want > 128 * 1024) {
        return Promise.resolve({ data: Buffer.alloc(Math.floor(want / 2)), total: 10 * 1024 * 1024 });
      }
      return Promise.resolve({ data: Buffer.alloc(want), total: 10 * 1024 * 1024 });
    });
    const t0 = Date.now();
    const r = await T.fetchWholeRange({}, 0, 262143, 0);
    assert.strictEqual(r.data.length, 262144, `expected the FULL range, got ${r.data.length}`);
    assert.ok(calls.some(function (c) { return c[1] - c[0] + 1 <= 128 * 1024; }),
      'expected at least one smaller ask (a split)');
    assert.ok(Date.now() - t0 < 30000, `must stay bounded, took ${Date.now() - t0}ms`);
  });

  await check('a piece that cannot go smaller gives up with an honest error (bounded)', async () => {
    T.setOriginalRemoteRange(function (stream, s, e) {
      return Promise.resolve({ data: Buffer.alloc(1), total: 1024 });
    });
    let err = null;
    const t0 = Date.now();
    try {
      await T.fetchWholeRange({}, 0, 32767, 0);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'should throw');
    assert.ok(/长度异常/.test(err.message), `expected a length-anomaly error, got: ${err.message}`);
    assert.ok(Date.now() - t0 < 30000, 'must stay bounded');
  });

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
