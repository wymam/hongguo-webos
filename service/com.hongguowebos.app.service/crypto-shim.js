// Crypto shims for the webOS TV JS service runtime.
//
// The red-berry (红果) API signing layer needs five primitives:
//   md5, sha512, sm3, aes-128-cbc, aes-128-ctr
//
// webOS 6+ runs its JS services on Node 16, whose bundled OpenSSL does
// expose md5/sha512/aes-128-cbc/aes-128-ctr, but node:crypto's SM3 digest
// is not registered (OpenSSL 1.1.1 supports SM3 only with the legacy
// provider enabled). So createHash('sm3') throws ERR_CRYPTO_INVALID_DIGEST
// and every signed request would fail.
//
// Rather than rewrite the vendored signing code, this module feature-detects
// SM3 and, only when missing, patches crypto.Hash so that createHash('sm3')
// transparently returns our pure-JS implementation. The signing layer is
// left byte-for-byte untouched.
//
// Must be required before the vendored source is evaluated.
'use strict';

var crypto = require('crypto');
var sm3js = require('./sm3.js');

var patched = false;

function sm3Available() {
  try {
    crypto.createHash('sm3');
    return true;
  } catch (e) {
    return false;
  }
}

if (!sm3Available()) {
  var RealHash = crypto.Hash;
  var realCreateHash = crypto.createHash;

  function createHash(algorithm, options) {
    if (String(algorithm).toLowerCase() === 'sm3') {
      return sm3js.createHash();
    }
    return realCreateHash.call(crypto, algorithm, options);
  }

  crypto.createHash = createHash;
  patched = true;
}

module.exports = {
  patched: patched,
  sm3Native: !patched,
  report: function () {
    return patched
      ? 'sm3: pure-JS shim installed (runtime has no native SM3)'
      : 'sm3: native (runtime provides it)';
  }
};
