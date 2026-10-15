// Device identity for the upstream app API.
//
// FIELD FINDING (2026-10-14, TV + local reproduction): every signed call from
// the pinned identity returned HTTP 200 with
//     { "Code": 110001, "Message": "未知异常", "BaseResp": { "StatusMessage": "unknown error" } }
// while freshly generated identities returned Code 0 on the very same request,
// with the very same signing code. The upstream bans individual iid/device_id
// pairs — the pinned pair that worked on 2026-10-11 had been refused by
// 2026-10-14. The signature algorithms were never the problem: two random
// identities passed immediately, and a full resolve -> prepare -> fetch ->
// decrypt path succeeded against a brand-new identity.
//
// So: keep ONE identity per install (real devices do not change theirs), and
// rotate it when the upstream says no. The rotation re-evaluates the vendored
// source with the new pair, which also discards every cache the old identity
// poisoned.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// The exact pair baked into vendor/hongguo.cjs (2026-09 pin). Kept as a
// literal so a rotation or a vendored refresh that keeps the same shape still
// matches; if the vendored block ever drifts, patch() leaves the source
// untouched and the pinned identity is used as-is (the old behaviour).
var PINNED_IID = '1905892595382586';
var PINNED_DEVICE_ID = '1905892595378490';
var PINNED_RE = new RegExp("iid: '" + PINNED_IID + "', device_id: '" + PINNED_DEVICE_ID + "'");

var ID_FILE = path.join(__dirname, '.device-id.json');

// Observed live ids are 16 digits starting with 19 (install-id and device-id
// ranges). Stay inside that envelope: an out-of-range value is a trivially
// detectable bot signal.
function randomId() {
  var head = 1900000000000000 + crypto.randomBytes(6).readUIntBE(0, 6) % 99000000000000;
  return String(head).slice(0, 16);
}

function generate() {
  return {
    iid: randomId(),
    device_id: randomId(),
    created_at: Date.now(),
    rotated: false
  };
}

function readFile() {
  try {
    var raw = fs.readFileSync(ID_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && /^\d{10,20}$/.test(String(parsed.iid)) && /^\d{10,20}$/.test(String(parsed.device_id))) {
      return parsed;
    }
  } catch (e) { /* cold start, or the install dir is read-only: fall through */ }
  return null;
}

function writeFile(ident) {
  try {
    fs.writeFileSync(ID_FILE, JSON.stringify(ident), 'utf8');
    return true;
  } catch (e) {
    // Not fatal: an in-memory identity still works, it just rotates on the
    // next launch instead of surviving it.
    return false;
  }
}

var current = readFile() || (function () {
  var ident = generate();
  writeFile(ident);
  return ident;
})();

// Persistence seam. Production uses the file next to this module; tests (and
// any platform with a better home for a small blob) can substitute their own.
var store = { read: readFile, write: writeFile };

module.exports = {
  // The identity in force. Stable for the life of the process.
  current: function () { return current; },

  // Rewrite the vendored DEVICE block with the current identity. Returns the
  // patched source; if the vendored pair has drifted, returns the source
  // unchanged (the caller then runs the pinned identity, as before).
  patch: function (source) {
    if (typeof source !== 'string' || source.indexOf(PINNED_IID) < 0) {
      return source;
    }
    return source.replace(PINNED_RE, "iid: '" + current.iid + "', device_id: '" + current.device_id + "'");
  },

  // Mint a new identity, persist it, and report it. The caller must then
  // re-evaluate the vendored source (see provider.reloadUpstream).
  rotate: function (reason) {
    var previous = current;
    current = generate();
    current.rotated = true;
    current.rotated_at = Date.now();
    if (reason) current.reason = String(reason).slice(0, 120);
    store.write(current);
    return { previous: previous, now: current };
  },

  // Test seam: adopt an explicit identity without touching the disk.
  force: function (ident) {
    current = {
      iid: String(ident.iid),
      device_id: String(ident.device_id),
      created_at: ident.created_at || Date.now(),
      rotated: !!ident.rotated
    };
    return current;
  },

  ID_FILE: ID_FILE,
  PINNED: { iid: PINNED_IID, device_id: PINNED_DEVICE_ID },

  // Substitute the persistence layer (tests keep everything in memory).
  __setStore: function (s) {
    store = {
      read: typeof s.read === 'function' ? s.read : readFile,
      write: typeof s.write === 'function' ? s.write : writeFile
    };
  }
};
