// End-to-end smoke test against the live red-berry endpoints, exercising the
// SAME code path webOS will use (vm + shimmed crypto + axios shim).
//
//   node tools/smoke-live.js          # normal run
//   node tools/smoke-live.js --nosm3  # force the SM3-less runtime path
//
// --nosm3 is the important one: it simulates webOS 6 / Node 16, where
// node:crypto has no SM3, so the pure-JS shim carries the signature layer.
// If signing still succeeds there, the app will sign correctly on the TV.
'use strict';

const forceShim = process.argv.includes('--nosm3');

if (forceShim) {
  const crypto = require('crypto');
  const pristine = crypto.createHash;
  crypto.createHash = function (algorithm, options) {
    if (String(algorithm).toLowerCase() === 'sm3') {
      const err = new Error('Digest method not supported');
      err.code = 'ERR_CRYPTO_INVALID_DIGEST';
      throw err;
    }
    return pristine.call(crypto, algorithm, options);
  };
  console.log('*** forcing the SM3-less runtime path (simulating webOS 6 / Node 16) ***\n');
}

const { provider } = require('../service/com.hongguowebos.app.service/provider.js');

const line = (s) => console.log(s);
let failures = 0;
// Content-signature guard: the red-berry API refuses unsigned requests, so a
// successful response is itself proof the signing chain works with our crypto.
function wantsSignatureProof(ok, label, extra) {
  if (!ok) { failures++; line(`  ^ FAIL: ${label} ${extra || ''}`); }
  else line(`  ^ signed request accepted -> SM3/signing chain verified`);
}

async function probe(label, fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    line(`PASS  ${label}  (${Date.now() - t0}ms)`);
    return v;
  } catch (e) {
    failures++;
    line(`FAIL  ${label}  (${Date.now() - t0}ms)`);
    line(`      ${e.message}`);
    return null;
  }
}

(async () => {
  line(`crypto status: ${JSON.stringify(provider.status())}\n`);

  line('--- home ---');
  const home = await probe('home()', () => provider.home());
  if (home) {
    line(`      banners=${home.banners.length}  sections=${home.sections.length}`);
    home.sections.slice(0, 3).forEach((s) => line(`      [${s.title}] ${s.items.length} items`));
    const first = (home.sections[0] && home.sections[0].items[0]) || home.banners[0];
    if (first) line(`      sample: ${first.id}  ${first.title}  cover=${first.cover ? 'ok' : 'MISSING'}`);
  }

  line('\n--- category ---');
  for (const key of ['real', 'comic', 'ai']) {
    const c = await probe(`category("${key}")`, () => provider.category(key, 1));
    if (c) line(`      ${c.name}: ${c.items.length} items, e.g. ${c.items[0] && c.items[0].title}`);
  }

  line('\n--- search (KNOWN GATED upstream — expected to be unavailable) ---');
  try {
    const search = await provider.search('总裁', 1);
    line(`PASS  search returned ${search.items.length} items via ${search.source}`);
    search.items.slice(0, 3).forEach((c) => line(`      ${c.id}  ${c.title}`));
    if (search.source === 'app') line('      ^ signed API answered -> signature chain proven on the search host too');
  } catch (e) {
    if (e.code === 'SEARCH_UNAVAILABLE') {
      // Not a regression: both the app API and the website SSR are gated for
      // non-app traffic as of 2026-10-07. The UI must surface this as
      // "search unavailable" rather than an empty list.
      line('SKIP  search gated upstream (expected)');
      line(`      ${e.detail || e.message}`);
    } else {
      failures++;
      line(`FAIL  search threw an unexpected error: ${e.message}`);
    }
  }

  line('\n--- detail ---');
  const candidate = (home && home.sections[0] && home.sections[0].items[0] && home.sections[0].items[0].id);
  if (!candidate) {
    line('SKIP  no series id available');
  } else {
    const detail = await probe(`detail(${candidate})`, () => provider.detail(candidate));
    if (detail) {
      line(`      ${detail.title}  rating=${detail.rating || '-'}  episodes=${detail.episodes.length}`);
      line(`      cover=${detail.cover ? 'ok' : 'MISSING'}  tags="${detail.tags}"`);

      line('\n--- stream (spade decrypt + CENC key + AES-CTR) ---');
      const ep = detail.episodes[0].id;
      const stream = await probe(`stream(${ep})`, () => provider.stream(ep, false));
      if (stream) {
        line(`      total=${stream.total} bytes  quality=${stream.quality}  keyed=${stream.keyed}`);
        const chunk = await probe('chunk(0, 65535)', () => stream.chunk(0, 65535));
        if (chunk) {
          const buf = Buffer.from(chunk);
          const head = buf.subarray(0, 16).toString('latin1');
          const hasFtyp = buf.subarray(0, 64).toString('latin1').indexOf('ftyp') >= 0;
          line(`      ${buf.length} bytes, head="${head.replace(/[^\x20-\x7e]/g, '.')}"`);
          if (hasFtyp) line('PASS  decrypted segment is a real MP4 (ftyp box present)');
          else { failures++; line('FAIL  decrypted segment is NOT an MP4'); }
          // A second, offset segment proves the CENC sample index works
          // beyond byte 0.
          const mid = await probe('chunk(1048576, 1114111)  <- offset segment', () => stream.chunk(1048576, 1114111));
          if (mid) line(`      offset segment: ${Buffer.from(mid).length} bytes`);
        }
      }
    }
  }

  line('');
  line(failures === 0 ? 'SMOKE TEST GREEN' : `SMOKE TEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('unexpected failure:', e);
  process.exit(1);
});
