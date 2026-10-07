// Pure-JS SM3 (GB/T 32905-2016) implementation.
//
// Why this file exists:
//   The byte-dance signing layer (x-gorgon / x-helios / x-medusa) calls
//   crypto.createHash('sm3'). Node exposes SM3 through OpenSSL, but the
//   webOS TV JS service runtime is Node 16 (webOS 6+) and Node 16 ships
//   OpenSSL 1.1.1 without the SM3 digest wired into node:crypto's hash
//   list, so createHash('sm3') throws "Digest method not supported".
//   Verified output is byte-identical to OpenSSL's SM3, so the signature
//   layer is untouched.
//
// API mirrors node:crypto's Hash just enough for the signing layer:
//   var h = sm3.createHash(); h.update(buf); h.digest()  -> Buffer(32)
'use strict';

var IV = [
  0x7380166f | 0, 0x4914b2b9 | 0, 0x172442d7 | 0, 0xda8a0600 | 0,
  0xa96f30bc | 0, 0x163138aa | 0, 0xe38dee4d | 0, 0xb0fb0e4e | 0
];

function rotl(x, n) {
  n &= 31;
  return ((x << n) | (x >>> (32 - n))) | 0;
}

function p0(x) { return (x ^ rotl(x, 9) ^ rotl(x, 17)) | 0; }
function p1(x) { return (x ^ rotl(x, 15) ^ rotl(x, 23)) | 0; }

// T_j: 0x79cc4519 for j in [0,16), 0x7a879d8a for j in [16,64)
function tj(j) { return j < 16 ? 0x79cc4519 | 0 : 0x7a879d8a | 0; }

function ff(j, x, y, z) { return j < 16 ? (x ^ y ^ z) | 0 : ((x & y) | (x & z) | (y & z)) | 0; }
function gg(j, x, y, z) { return j < 16 ? (x ^ y ^ z) | 0 : ((x & y) | (~x & z)) | 0; }

function compress(v, block, offset) {
  var w = new Array(68);
  var wp = new Array(64);
  var i, t;

  for (i = 0; i < 16; i++) {
    var o = offset + i * 4;
    w[i] = ((block[o] << 24) | (block[o + 1] << 16) | (block[o + 2] << 8) | block[o + 3]) | 0;
  }
  for (i = 16; i < 68; i++) {
    // W_j = P1(W_{j-16} ^ W_{j-9} ^ ROTL(W_{j-3},15)) ^ ROTL(W_{j-13},7) ^ W_{j-6}
    t = (w[i - 16] ^ w[i - 9] ^ rotl(w[i - 3], 15)) | 0;
    w[i] = (p1(t) ^ rotl(w[i - 13], 7) ^ w[i - 6]) | 0;
  }
  // W'_j = W_j ^ W_{j+4}

  for (i = 0; i < 64; i++) wp[i] = (w[i] ^ w[i + 4]) | 0;

  var a = v[0], b = v[1], c = v[2], d = v[3];
  var e = v[4], f = v[5], g = v[6], h = v[7];
  var ss1, ss2, tt1, tt2;

  for (i = 0; i < 64; i++) {
    // SS1 = ROTL(ROTL(A,12) + E + ROTL(T_j, j mod 32), 7)
    ss1 = rotl((rotl(a, 12) + e + rotl(tj(i), i)) | 0, 7);
    ss2 = (ss1 ^ rotl(a, 12)) | 0;
    tt1 = (ff(i, a, b, c) + d + ss2 + wp[i]) | 0;
    tt2 = (gg(i, e, f, g) + h + ss1 + w[i]) | 0;
    d = c;
    c = rotl(b, 9);
    b = a;
    a = tt1;
    h = g;
    g = rotl(f, 19);
    f = e;
    e = p0(tt2);
  }

  v[0] = (v[0] ^ a) | 0;
  v[1] = (v[1] ^ b) | 0;
  v[2] = (v[2] ^ c) | 0;
  v[3] = (v[3] ^ d) | 0;
  v[4] = (v[4] ^ e) | 0;
  v[5] = (v[5] ^ f) | 0;
  v[6] = (v[6] ^ g) | 0;
  v[7] = (v[7] ^ h) | 0;
}

function toBuffer(value, encoding) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), encoding || 'utf8');
}

function Hash() {
  this._v = IV.slice();
  this._buf = Buffer.alloc(0);
  this._len = 0;
}

Hash.prototype.update = function (value, encoding) {
  var data = toBuffer(value, encoding);
  this._len += data.length;
  this._buf = Buffer.concat([this._buf, data]);
  var off = 0;
  while (this._buf.length - off >= 64) {
    compress(this._v, this._buf, off);
    off += 64;
  }
  if (off) this._buf = this._buf.subarray(off);
  return this;
};

Hash.prototype.digest = function (encoding) {
  var bitLenHi = Math.floor(this._len / 0x20000000) | 0; // (len*8) >>> 32
  var bitLenLo = (this._len << 3) | 0;

  var tail = this._buf;
  var padded = Buffer.alloc(((tail.length + 9 + 63) >> 6) << 6);
  tail.copy(padded, 0);
  padded[tail.length] = 0x80;
  // 64-bit big-endian bit length at the very end
  padded.writeUInt32BE(bitLenHi, padded.length - 8);
  padded.writeUInt32BE(bitLenLo, padded.length - 4);

  for (var off = 0; off < padded.length; off += 64) {
    compress(this._v, padded, off);
  }

  var out = Buffer.alloc(32);
  for (var i = 0; i < 8; i++) out.writeInt32BE(this._v[i], i * 4);
  this._v = IV.slice();
  this._buf = Buffer.alloc(0);
  this._len = 0;
  return encoding ? out.toString(encoding) : out;
};

// Convenience helpers matching the shape the signing layer expects.
function sm3(value, encoding) {
  return new Hash().update(value, encoding).digest();
}

function sm3Hex(value, encoding) {
  return sm3(value, encoding).toString('hex');
}

module.exports = {
  Hash: Hash,
  createHash: function () { return new Hash(); },
  sm3: sm3,
  sm3Hex: sm3Hex
};
