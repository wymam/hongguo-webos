// Proves the SM3 shim works on a runtime that lacks native SM3 (i.e. webOS 6 /
// Node 16). We simulate that by making the real SM3 unavailable to
// crypto.createHash, then exercising the shimmed path.
//
// Usage: node tools/verify-sm3-shim.js
'use strict';

const crypto = require('crypto');
const sm3js = require('../service/com.hongguowebos.app.service/sm3.js');

let failures = 0;
function check(label, expected, actual) {
  const ok = expected === actual;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      expected ${expected}`);
    console.log(`      actual   ${actual}`);
  }
}

// Ground truth collected while native SM3 is still reachable.
const cases = [];
for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 4096, 300000]) {
  const buf = Buffer.from(Array.from({ length: Math.min(size, 4096) }, (_, i) => (i * 31 + size) & 0xff));
  cases.push([size, buf, crypto.createHash('sm3').update(buf).digest('hex')]);
}
const truth = cases.map(([, , h]) => h);

// --- simulate "runtime without native SM3" -------------------------------
// Save the pristine createHash, then install a stub that refuses 'sm3'
// exactly the way Node 16 does.
const pristineCreateHash = crypto.createHash;
crypto.createHash = function (algorithm, options) {
  if (String(algorithm).toLowerCase() === 'sm3') {
    const err = new Error('Digest method not supported');
    err.code = 'ERR_CRYPTO_INVALID_DIGEST';
    throw err;
  }
  return pristineCreateHash.call(crypto, algorithm, options);
};

// Now load the shim against the crippled runtime.
delete require.cache[require.resolve('../service/com.hongguowebos.app.service/crypto-shim.js')];
const shim = require('../service/com.hongguowebos.app.service/crypto-shim.js');

console.log('--- shim activation ---');
console.log(`patched: ${shim.patched}  (expected true on a SM3-less runtime)`);
console.log(shim.report());
check('shim engaged', 'true', String(shim.patched));

console.log('\n--- shimmed createHash("sm3") output ---');
for (let i = 0; i < cases.length; i++) {
  const [size, buf] = cases[i];
  check(`size ${size}`, truth[i], crypto.createHash('sm3').update(buf).digest('hex'));
}

console.log('\n--- non-sm3 algorithms still route to native crypto ---');
check('md5 intact', '900150983cd24fb0d6963f7d28e17f72',
  crypto.createHash('md5').update('abc').digest('hex'));
check('sha512 intact', true,
  crypto.createHash('sha512').update('abc').digest('hex') ===
  'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
