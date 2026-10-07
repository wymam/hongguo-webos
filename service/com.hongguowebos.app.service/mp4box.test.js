// Local unit test for the MP4 dimension reader.
//
// Builds synthetic `moov`/`trak`/`tkhd` trees and checks we read back the exact
// frame size. Runs on the host (node tools/… is not needed) so a parser bug is
// caught before it ever reaches the TV.
'use strict';
var assert = require('assert');
var mp = require('./mp4box');

function u32(n) { var b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function box(type, payload) {
  var head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 4, 'latin1'); // type goes AFTER the 4-byte size
  return Buffer.concat([head, payload]);
}

// tkhd layout after version/flags:
//   v0 times 20 / v1 times 32, then reserved(8) layer(2) altgroup(2)
//   volume(2) reserved(2) = 16, matrix(36), width(4), height(4)
function tkhd(version, w, h) {
  var times = version === 1
    ? Buffer.concat([Buffer.alloc(8), Buffer.alloc(8), u32(1), u32(0), Buffer.alloc(8)])
    : Buffer.concat([u32(0), u32(0), u32(1), u32(0), u32(1000)]);
  return box('tkhd', Buffer.concat([
    Buffer.from([version, 0, 0, 0]),
    times,
    Buffer.alloc(16),
    Buffer.alloc(36),
    u32(w << 16), u32(h << 16)
  ]));
}

function hdlr(kind) {
  return box('hdlr', Buffer.concat([
    Buffer.from([0, 0, 0, 0]), Buffer.alloc(4),
    Buffer.from(kind, 'latin1'), Buffer.alloc(12)
  ]));
}

function movie(traks) {
  return box('moov', Buffer.concat(traks));
}
function trak(t, kind) {
  return box('trak', Buffer.concat([t, box('mdia', hdlr(kind || 'vide'))]));
}
var FTYP = box('ftyp', Buffer.alloc(16));
var FREE = box('free', Buffer.alloc(7));

var checks = 0;
function eq(name, got, want) {
  assert.deepStrictEqual(got, want, name + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  console.log('  PASS  ' + name + ' -> ' + JSON.stringify(got));
  checks++;
}

eq('portrait 1080x1920', mp.parse(Buffer.concat([FTYP, movie([trak(tkhd(0, 1080, 1920))])])), { width: 1080, height: 1920 });
eq('landscape 1920x1080', mp.parse(Buffer.concat([FTYP, movie([trak(tkhd(0, 1920, 1080))])])), { width: 1920, height: 1080 });
eq('tkhd v1 720x1280', mp.parse(movie([trak(tkhd(1, 720, 1280))])), { width: 720, height: 1280 });
eq('odd size 541x960', mp.parse(movie([trak(tkhd(0, 541, 960))])), { width: 541, height: 960 });

// Audio-first files: the first trak has no size, the video one does.
var audio = trak(box('tkhd', Buffer.concat([
  Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(2), u32(0), u32(1000),
  Buffer.alloc(16), Buffer.alloc(36), u32(0), u32(0)
])), 'soun');
eq('audio trak skipped', mp.parse(movie([audio, trak(tkhd(0, 1080, 1920))])), { width: 1080, height: 1920 });

// Non-video handler only: fall back to the first track with a real size.
eq('fallback when no vide handler', mp.parse(movie([trak(tkhd(0, 800, 600), 'hint')])), { width: 800, height: 600 });

// Size-zero tkhd (some files) must not be reported as 0x0.
eq('zero dimensions rejected', mp.parse(movie([
  trak(box('tkhd', Buffer.concat([
    Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(1), u32(0), u32(1000),
    Buffer.alloc(16), Buffer.alloc(36), u32(0), u32(0)
  ])))
])), null);

// No moov at all (the usual case for the tail-only fallback failing).
eq('no moov -> null', mp.parse(FTYP), null);
eq('empty -> null', mp.parse(Buffer.alloc(4)), null);
eq('null -> null', mp.parse(null), null);

// moov preceded AND followed by unrelated top-level boxes (real files).
eq('moov in the middle', mp.parse(Buffer.concat([FTYP, FREE, movie([trak(tkhd(0, 1080, 1920))]), FREE])), { width: 1080, height: 1920 });

console.log('\nmp4box: ' + checks + ' checks passed');
