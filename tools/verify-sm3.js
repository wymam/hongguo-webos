// Verifies the pure-JS SM3 against OpenSSL's implementation via node:crypto.
// Usage: node tools/verify-sm3.js
'use strict';

const crypto = require('crypto');
const sm3js = require('../service/com.hongguowebos.app.service/sm3.js');

// GB/T 32905-2016 published test vectors
const VECTORS = [
  ['abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'],
  ['abcd'.repeat(16), 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732']
];

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

console.log('--- GB/T 32905-2016 published vectors ---');
for (const [input, expected] of VECTORS) {
  check(JSON.stringify(input.slice(0, 24)), expected, sm3js.sm3Hex(input));
}

console.log('\n--- differential fuzz vs node:crypto ---');
let native = null;
try {
  native = crypto.createHash('sm3').update('x').digest('hex');
} catch (e) {
  console.log(`node:crypto has no SM3 here: ${e.message}`);
  console.log('(this is exactly the webOS 6 / Node 16 situation)');
}

if (native) {
  // run randomness over many sizes, especially around the 55/56/64 byte
  // padding boundaries which are the classic place to get SM3 wrong
  const sizes = [
    ...Array.from({ length: 200 }, (_, i) => i),
    55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129,
    1000, 4095, 4096, 4097, 100000, 1000000
  ];
  let ok = 0;
  for (const size of sizes) {
    const buf = crypto.randomBytes(size);
    const a = crypto.createHash('sm3').update(buf).digest('hex');
    const b = sm3js.sm3Hex(buf);
    if (a !== b) { check(`randomBytes(${size})`, a, b); }
    else ok++;
  }
  // incremental update path (the signing layer feeds multiple chunks)
  for (let i = 0; i < 50; i++) {
    const parts = Array.from({ length: 1 + (i % 7) }, () => crypto.randomBytes(1 + Math.floor(Math.random() * 300)));
    const join = Buffer.concat(parts);
    const a = crypto.createHash('sm3').update(join).digest('hex');
    let h = sm3js.createHash();
    for (const p of parts) h.update(p);
    const b = h.digest('hex');
    if (a !== b) { check(`chunked[${i}]`, a, b); } else ok++;
  }
  console.log(`PASS  ${ok} differential cases matched node:crypto byte-for-byte`);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
