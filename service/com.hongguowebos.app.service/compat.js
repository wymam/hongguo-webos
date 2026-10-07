// webOS runtime compatibility shims.
//
// Must be required FIRST in service.js, before any other module, because it
// patches globals the rest of the code depends on.
//
// webOS 6 runs its JS services on Node 16 (Chromium 79). Node 16 is modern
// enough for WHATWG URL, Buffer.from/subarray and String.includes, so most of
// the heavy legacy shimming that a Node 0.12 target would need is absent here.
// What remains genuinely necessary:
//   * a current CA bundle, because the TV's bundled roots can lag the public
//     PKI and byte-dance CDNs rotate certificates frequently
//   * String.prototype.replaceAll / Array.prototype.flat / Object.fromEntries,
//     which Node 16 has but are worth guarding since webOS vendors patch Node
//   * globalThis, absent only in truly ancient engines
//
// Every shim is feature-detected. Nothing here is assumed present.
'use strict';

// ---------- globalThis ----------
if (typeof globalThis === 'undefined') {
  /* eslint-disable no-global-assign */
  global.globalThis = global;
}

// ---------- String.prototype.replaceAll (Node 15+) ----------
if (typeof String.prototype.replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    writable: true,
    configurable: true,
    value: function (search, replacement) {
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError('replaceAll with a RegExp requires the global flag');
        }
        return this.replace(search, replacement);
      }
      // Escape regex metacharacters so the search is treated literally.
      var escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return this.replace(new RegExp(escaped, 'g'), replacement);
    }
  });
}

// ---------- Array.prototype.flat (Node 11+) ----------
if (typeof Array.prototype.flat !== 'function') {
  Object.defineProperty(Array.prototype, 'flat', {
    writable: true,
    configurable: true,
    value: function (depth) {
      var d = depth === undefined ? 1 : Number(depth);
      if (!(d >= 0)) d = 0;
      return d < 1
        ? Array.prototype.slice.call(this)
        : Array.prototype.reduce.call(this, function (acc, val) {
            return acc.concat(Array.isArray(val) ? val.flat(d - 1) : val);
          }, []);
    }
  });
}

// ---------- Object.fromEntries (Node 12+) ----------
if (typeof Object.fromEntries !== 'function') {
  Object.fromEntries = function (entries) {
    var out = {};
    var it = entries[Symbol.iterator]();
    for (var step = it.next(); !step.done; step = it.next()) {
      out[step.value[0]] = step.value[1];
    }
    return out;
  };
}

// ---------- Promise.allSettled (Node 12.9+) ----------
if (typeof Promise.allSettled !== 'function') {
  Promise.allSettled = function (promises) {
    return Promise.all(
      Array.prototype.map.call(promises, function (p) {
        return Promise.resolve(p).then(
          function (value) { return { status: 'fulfilled', value: value }; },
          function (reason) { return { status: 'rejected', reason: reason }; }
        );
      })
    );
  };
}

// ---------- CA bundle ----------
// The TV's built-in root store can be stale, and we talk to byte-dance CDNs
// whose leaf certificates rotate often. If a bundle ships alongside this
// service, prefer it; otherwise fall back to the runtime's own roots.
var fs = require('fs');
var path = require('path');
var tls = require('tls');

var caPath = path.join(__dirname, 'cacert.pem');
try {
  if (fs.existsSync(caPath)) {
    var bundle = fs.readFileSync(caPath);
    if (bundle && bundle.length > 1024) {
      tls.rootCertificates = tls.rootCertificates || [];
      // Node reads the default CA at context creation from this array.
      tls.rootCertificates = tls.rootCertificates.concat(
        bundle.toString('utf8').split(/(?=-----BEGIN CERTIFICATE-----)/)
          .map(function (s) { return s.trim(); })
          .filter(Boolean)
      );
    }
  }
} catch (e) {
  // A missing or unreadable bundle is not fatal: the runtime roots still work.
}

module.exports = {
  // Surface what we actually patched, for the diagnostics screen.
  applied: {
    globalThis: typeof globalThis !== 'undefined',
    replaceAll: typeof String.prototype.replaceAll === 'function',
    arrayFlat: typeof Array.prototype.flat === 'function',
    fromEntries: typeof Object.fromEntries === 'function',
    allSettled: typeof Promise.allSettled === 'function',
    caBundle: fs.existsSync(caPath)
  }
};
