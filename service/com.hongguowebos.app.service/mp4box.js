// Minimal MP4 box reader — just enough to answer "is this portrait or
// landscape?" without downloading the whole file.
//
// Why the service has to do it:
//   The list rows carry NO dimension field (verified against the live payload:
//   the only keys are episode_cnt / series_cover / tags / vid_list …). The cover
//   image is always a 2:3 poster, so it says nothing about the footage. The one
//   place the real frame size exists is the MP4's own `tkhd` box — which lives
//   inside the encrypted stream, i.e. behind the signing/decryption layer the
//   browser cannot reach.
//
// Cost control: `moov` is fetched by asking for the FIRST 256 KiB only. Nearly
// every short-drama file is web-optimised (faststart), so `moov` sits at the
// front. When it does not, we fall back to the LAST 256 KiB before giving up —
// never the whole episode.
'use strict';

var HEAD_BYTES = 256 * 1024;

function boxAt(buf, pos, limit) {
  if (pos + 8 > limit) return null;
  var size = buf.readUInt32BE(pos);
  var type = buf.toString('latin1', pos + 4, pos + 8);
  var header = 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    // 64-bit largesize: hi << 32 | lo. Kept in two 32-bit reads so we never
    // exceed Number's safe range in a single multiply on older engines.
    var hi = buf.readUInt32BE(pos + 8);
    var lo = buf.readUInt32BE(pos + 12);
    size = hi * 4294967296 + lo;
    header = 16;
  } else if (size === 0) {
    size = limit - pos; // extends to end of container
  }
  if (size < header || pos + size > limit) return null;
  return { type: type, start: pos, header: header, end: pos + size };
}

function findChild(buf, start, end, type) {
  var p = start;
  var guard = 0;
  while (p < end && guard++ < 4096) {
    var b = boxAt(buf, p, end);
    if (!b) return null;
    if (b.type === type) return b;
    p = b.end;
  }
  return null;
}

// true when this trak holds video (mdia/hdlr handler_type == 'vide').
function isVideoTrak(buf, trak) {
  var mdia = findChild(buf, trak.start + trak.header, trak.end, 'mdia');
  if (!mdia) return false;
  var hdlr = findChild(buf, mdia.start + mdia.header, mdia.end, 'hdlr');
  if (!hdlr) return false;
  var at = hdlr.start + hdlr.header + 8; // version/flags(4) + pre_defined(4)
  if (at + 4 > hdlr.end) return false;
  return buf.toString('latin1', at, at + 4) === 'vide';
}

// width/height in tkhd are 16.16 fixed point.
function tkhdSize(buf, trak) {
  var t = findChild(buf, trak.start + trak.header, trak.end, 'tkhd');
  if (!t) return null;
  var c = t.start + t.header;               // content starts at version/flags
  if (c + 4 > t.end) return null;
  var version = buf[c];
  // version/flags(4) + times(20 or 32) + reserved(8) + layer(2) +
  // alternate_group(2) + volume(2) + reserved(2) + matrix(36)
  var off = c + 4 + (version === 1 ? 32 : 20) + 52;
  if (off + 8 > t.end) return null;
  var w = buf.readUInt32BE(off) / 65536;
  var h = buf.readUInt32BE(off + 4) / 65536;
  if (!(w > 0) || !(h > 0)) return null;
  return { width: Math.round(w), height: Math.round(h) };
}

// -> { width, height } or null.
function parse(buf) {
  if (!buf || buf.length < 16) return null;
  var moov = findChild(buf, 0, buf.length, 'moov');
  if (!moov) return null;

  var fallback = null;
  var p = moov.start + moov.header;
  var guard = 0;
  while (p < moov.end && guard++ < 4096) {
    var b = boxAt(buf, p, moov.end);
    if (!b) break;
    if (b.type === 'trak') {
      var dim = tkhdSize(buf, b);
      if (dim) {
        if (isVideoTrak(buf, b)) return dim;
        if (!fallback) fallback = dim;
      }
    }
    p = b.end;
  }
  // No explicit video handler (rare): the first track with a real size will do.
  return fallback;
}

module.exports = {
  HEAD_BYTES: HEAD_BYTES,
  parse: parse,
  boxAt: boxAt,
  findChild: findChild,
  tkhdSize: tkhdSize,
  isVideoTrak: isVideoTrak
};
