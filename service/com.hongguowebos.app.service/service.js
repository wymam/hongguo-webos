// webOS JS Service for the red-berry (红果短剧) client.
//
// Runs on the TV as a Node service (webOS 6+ / Node 16) and exposes two things:
//
//   1. Luna methods  — luna://com.hongguowebos.app.service/<method>
//        getHome, getCategory, getSearch, getDetail, getDiagnostics
//      The web app calls these through PalmServiceBridge. This is the only way
//      out to the network: the browser side has no direct access to the
//      signed APIs.
//
//   2. A local HTTP media proxy on 127.0.0.1:7655
//        GET /media/<episodeId>   (HTTP Range aware)
//      Video cannot be handed to the TV player as a Luna payload, so the
//      player points at this loopback URL and we stream decrypted MP4 bytes
//      back with proper 206/Range semantics. Decryption happens per 1MiB
//      segment on demand, so nothing is written to disk.
//
// The vendored signing source (GPL-3.0) is loaded inside a vm context by
// provider.js and only for playback + SSR reads.

// compat must come first: it patches globals the rest of the stack relies on.
require('./compat');

var Service = require('webos-service');
var http = require('http');
var url = require('url');

var providerMod = require('./provider');
var provider = providerMod.provider;
var auth = require('./auth');

var SERVICE_ID = 'com.hongguowebos.app.service';

// The third argument is documented (webos-service/lib/service.js) and sets how
// long the bus tolerates "no active activities" before it terminates us.
//
// This matters more than it looks. The default is FIVE SECONDS, and when it
// fires the library calls `process.exit(0)` outright:
//
//     ActivityManager.prototype._startTimer = function() {
//       this._idleTimer = setTimeout(function() {
//         if (that.exitOnTimeout) { console.log("no active activities, exiting");
//                                   process.exit(0); }
//       }, this.idleTimeout * 1000);
//     };
//
// An explicit process.exit cannot be prevented by holding a timer open, so a
// `setInterval` keep-alive does nothing here (measured: the process still died,
// taking 127.0.0.1:7655 with it). Playback needs that port for minutes while it
// issues hundreds of Range requests, and every gap surfaces to the user as
// `MEDIA_ELEMENT_ERROR: Format error` — a codec-looking symptom with a
// lifecycle cause.
//
// 12 hours comfortably outlives any viewing session; the app calls `shutdown`
// on exit, and an idle service that does linger is harmless.
var service = new Service(SERVICE_ID, null, { idleTimer: 12 * 60 * 60 });

// Reuse TCP connections: a single playback session makes many sequential
// 1MiB segment fetches and TLS handshakes would dominate otherwise.
var MEDIA_PORT = 7655;
var SEG_SIZE = 1024 * 1024;

// ---------- error log ring ----------
// Keep the last N failures so getDiagnostics can report them without needing
// adb. Bounded so a long session cannot grow memory.
var LOG_LIMIT = 30;
var recentErrors = [];
function logErr(tag, detail) {
  var entry = { at: Date.now(), tag: tag, detail: String(detail || '') };
  recentErrors.push(entry);
  if (recentErrors.length > LOG_LIMIT) recentErrors.shift();
  console.error('[hongguo] ' + tag + ': ' + entry.detail);
}

// Never let an unexpected throw kill the service: webOS will not restart it.
process.on('uncaughtException', function (e) {
  logErr('uncaughtException', (e && e.stack) || e);
});
process.on('unhandledRejection', function (e) {
  logErr('unhandledRejection', (e && e.stack) || e);
});

// ---------- helpers ----------

// Wrap a promise-returning handler in the Luna success/failure contract.
function reply(message, promise) {
  try {
    promise.then(
      function (data) {
        message.respond(Object.assign({ returnValue: true }, data || {}));
      },
      function (e) {
        var errText = (e && e.message) || String(e);
        logErr('luna', errText);
        message.respond({
          returnValue: false,
          errorCode: (e && e.code) || 'ERROR',
          errorText: errText
        });
      }
    );
  } catch (e) {
    logErr('luna-sync', (e && e.message) || e);
    message.respond({
      returnValue: false,
      errorCode: 'ERROR',
      errorText: (e && e.message) || String(e)
    });
  }
}

function toInt(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

// ---------- Luna methods ----------

service.register('getHome', function (message) {
  reply(message, provider.home());
});

service.register('getCategory', function (message) {
  var p = message.payload || {};
  reply(message, provider.category(p.key, toInt(p.page, 1), p.genre || '', toInt(p.minItems, 50)));
});

// Portrait/landscape for a batch of series, from the MP4 itself.
//
// `entries` is [{ seriesId, episodeId }]. The episodeId is what we probe (the
// list rows carry it as vid_list[0]); seriesId is echoed back so the caller can
// attach the result to the right card without keeping its own index.
//
// Capped: a hostile/accidental huge payload must not turn into an unbounded
// burst of upstream requests on a weak TV CPU.
service.register('getAspects', function (message) {
  var p = message.payload || {};
  var entries = Array.isArray(p.entries) ? p.entries.slice(0, 80) : [];
  if (!entries.length) {
    message.respond({ returnValue: true, items: [], probed: 0 });
    return;
  }
  reply(message, provider.aspects(entries, toInt(p.concurrency, 3)));
});

service.register('getSearch', function (message) {
  var p = message.payload || {};
  var kw = String(p.keyword || '').trim();
  if (!kw) {
    message.respond({ returnValue: false, errorCode: 'BAD_INPUT', errorText: '请输入搜索关键词' });
    return;
  }
  if (kw.length > 80) {
    message.respond({ returnValue: false, errorCode: 'BAD_INPUT', errorText: '关键词过长' });
    return;
  }
  reply(message, provider.search(kw, toInt(p.page, 1)));
});

service.register('getDetail', function (message) {
  var p = message.payload || {};
  var id = String(p.id || '').trim();
  if (!/^\d{1,30}$/.test(id)) {
    message.respond({ returnValue: false, errorCode: 'BAD_INPUT', errorText: '剧集编号无效' });
    return;
  }
  reply(message, provider.detail(id));
});

// Tells the web app whether the service is alive and what it can do.
service.register('ping', function (message) {
  message.respond({
    returnValue: true,
    service: SERVICE_ID,
    mediaPort: MEDIA_PORT,
    node: process.version,
    uptime: Math.round(process.uptime())
  });
});

// ---------- 扫码登录（抖音 / 番茄 App） ----------

service.register('qrStart', function (message) {
  reply(message, auth.qrStart());
});

service.register('qrPoll', function (message) {
  var p = message.payload || {};
  var token = String(p.token || '').trim();
  if (!token) {
    message.respond({ returnValue: false, errorCode: 'BAD_INPUT', errorText: '缺少登录 token' });
    return;
  }
  reply(message, auth.qrPoll(token));
});

service.register('qrFinalize', function (message) {
  var p = message.payload || {};
  var redirectUrl = String(p.redirectUrl || '').trim();
  reply(message, auth.qrFinalize(redirectUrl));
});

service.register('qrStatus', function (message) {
  reply(message, auth.qrStatus());
});

service.register('qrLogout', function (message) {
  message.respond(Object.assign({ returnValue: true }, auth.qrLogout()));
});

// ---------- 播放性能诊断 ----------
// Measure where a playback slowdown comes from: the network (download MB/s),
// the CPU (decrypt MB/s) or both (end-to-end chunk MB/s). A TV has a weak CPU
// and the CDN throttles, so before "optimising" blindly we quantify each leg.
var BENCH_SEGMENTS = 6;
var BENCH_DECRYPT_PASSES = 12;

function benchMedia(episodeId) {
  var MB = 1024 * 1024;
  var t0 = Date.now();
  return provider.stream(episodeId, false).then(function (h) {
    var total = h.total || 0;
    // Start well inside mdat so the sample is actually encrypted (moov is
    // plaintext and would flatter the decrypt number).
    var start = Math.min(Math.max(Math.floor(total * 0.4), MB), Math.max(0, total - MB * (BENCH_SEGMENTS + 1)));
    start = Math.floor(start / MB) * MB;
    if (start + MB > total) start = Math.max(0, total - MB * (BENCH_SEGMENTS + 1));

    // 1) download-only throughput
    var dlT0 = Date.now();
    var seq = Promise.resolve();
    var firstRaw = null;
    for (var i = 0; i < BENCH_SEGMENTS; i++) {
      (function (off) {
        seq = seq.then(function () {
          return h.rawChunk(off, Math.min(off + MB - 1, total - 1)).then(function (raw) {
            if (firstRaw === null) firstRaw = Buffer.from(raw);
            return raw.length;
          });
        });
      })(start + i * MB);
    }
    return seq.then(function () {
      var dlMs = Date.now() - dlT0;
      var dlMBps = (BENCH_SEGMENTS * MB / (dlMs || 1)) / 1024;

      // 2) decrypt-only throughput (re-decrypt the same 1MiB repeatedly)
      var decT0 = Date.now();
      var decBytes = 0;
      var payload = firstRaw || Buffer.alloc(MB);
      for (var p = 0; p < BENCH_DECRYPT_PASSES; p++) {
        h.decrypt(payload, start);
        decBytes += payload.length;
      }
      var decMs = Date.now() - decT0;
      var decMBps = (decBytes / (decMs || 1)) / 1024;

      // 3) end-to-end chunk throughput (network + decrypt together)
      var e2eT0 = Date.now();
      var e2eSeq = Promise.resolve();
      for (var j = 0; j < BENCH_SEGMENTS; j++) {
        (function (off) {
          e2eSeq = e2eSeq.then(function () {
            return h.chunk(off, Math.min(off + MB - 1, total - 1)).then(function (c) { return c.length; });
          });
        })(start + j * MB);
      }
      return e2eSeq.then(function () {
        var e2eMs = Date.now() - e2eT0;
        var e2eMBps = (BENCH_SEGMENTS * MB / (e2eMs || 1)) / 1024;

        return {
          episodeId: episodeId,
          total: total,
          quality: h.quality,
          keyed: h.keyed,
          segments: BENCH_SEGMENTS,
          downloadMBps: Math.round(dlMBps * 100) / 100,
          downloadMs: dlMs,
          decryptMBps: Math.round(decMBps * 100) / 100,
          decryptMs: decMs,
          endToEndMBps: Math.round(e2eMBps * 100) / 100,
          endToEndMs: e2eMs,
          totalMs: Date.now() - t0
        };
      });
    });
  });
}

service.register('benchMedia', function (message) {
  var p = message.payload || {};
  var ep = String(p.episodeId || '').trim();
  if (!/^\d{1,30}$/.test(ep)) {
    message.respond({ returnValue: false, errorCode: 'BAD_INPUT', errorText: '缺少 episodeId' });
    return;
  }
  reply(message, benchMedia(ep));
});

service.register('getDiagnostics', function (message) {
  var status;
  try {
    status = provider.status();
  } catch (e) {
    status = { upstream: 'error', error: (e && e.message) || String(e) };
  }
  var compat = {};
  try {
    compat = require('./compat').applied;
  } catch (e) { /* diagnostics must never throw */ }

  message.respond({
    returnValue: true,
    service: SERVICE_ID,
    mediaPort: MEDIA_PORT,
    node: process.version,
    uptime: Math.round(process.uptime()),
    upstream: status,
    compat: compat,
    media: {
      active: activeStreams,
      served: mediaStats.served,
      bytes: mediaStats.bytes,
      errors: mediaStats.errors
    },
    mediaLog: mediaLog.slice(-120),
    recentErrors: recentErrors.slice(-10)
  });
});

// ---------- local media proxy ----------

// Guard against the TV player opening many parallel connections; each one
// costs a remote fetch plus AES work on a weak CPU.
//
// 4 was too low: the player preloads several 1MiB segments at once, and any
// request over the cap got a 503. The player then had a hole in its buffer —
// when playback reached it, Chromium skipped to the end of what it HAD and
// fired `ended`, i.e. the "plays a few seconds then jumps to the end" bug.
// Raising the cap lets the preload finish contiguously. The CPU cost is real
// but bounded: a segment is one decrypt of at most 1MiB.
var MAX_ACTIVE_STREAMS = 16;
var activeStreams = 0;
var mediaStats = { served: 0, bytes: 0, errors: 0 };

// Ring buffer of recent media requests, so a jump/skip can be traced to the
// exact Range the player asked for and what we answered.
var mediaLog = [];
function logMedia(entry) {
  mediaLog.push(entry);
  if (mediaLog.length > 300) mediaLog.shift();
}

// Map of episodeId -> resolved stream handle, so prepareHeader (which costs a
// remote round trip and CENC index build) is not repeated per Range request.
//
// TTL is 2 minutes, not 5: the underlying CDN URL is signed and expires, and the
// failure mode when it does is a 502 on every Range (i.e. "播放失败" mid-episode).
// A shorter TTL means most stays-well-inside-the-signature-window cases simply
// re-resolve before they can break, and the fetchSegment retry above covers the
// rest.
var streamHandles = new Map();
var STREAM_TTL = 120000;

function getStreamHandle(episodeId) {
  var cached = streamHandles.get(episodeId);
  if (cached && Date.now() - cached.at < STREAM_TTL) return Promise.resolve(cached.handle);
  return provider.stream(episodeId, false).then(function (handle) {
    streamHandles.set(episodeId, { handle: handle, at: Date.now() });
    return handle;
  });
}

// Drop a cached handle so the next request re-resolves from upstream.
//
// This is the remedy for the classic "plays, then dies mid-episode" case: the
// resolved CDN URL carries a signature that expires well before our 5-minute
// TTL, so a handle that was perfectly good at minute 0 can start failing at
// minute 3. Without eviction every subsequent Range returns 502 and the viewer
// sees 播放失败 even though a fresh resolve would have worked instantly.
function evictStreamHandle(episodeId) {
  streamHandles.delete(episodeId);
}

// Parse `bytes=` / `bytes=-suffix` / `bytes=start-` per RFC 7233.
// Returns [start, end] inclusive, null when absent, or 'invalid'.
function parseRange(value, total) {
  if (!value) return null;
  var m = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!m) return 'invalid';
  var startRaw = m[1];
  var endRaw = m[2];
  if (startRaw === '' && endRaw === '') return 'invalid';

  if (startRaw === '') {
    var suffix = parseInt(endRaw, 10);
    if (isNaN(suffix) || suffix <= 0) return 'invalid';
    var start = Math.max(0, total - suffix);
    return [start, total - 1];
  }

  var s = parseInt(startRaw, 10);
  if (isNaN(s) || s >= total) return 'invalid';
  var e = endRaw === '' ? total - 1 : parseInt(endRaw, 10);
  if (isNaN(e) || e < s) return 'invalid';
  return [s, Math.min(e, total - 1)];
}

function mediaServerHandler(req, res) {
  var parsed = url.parse(req.url, true);

  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active: activeStreams, served: mediaStats.served }));
    return;
  }

  var match = /^\/media\/(\d{1,30})$/.exec(parsed.pathname);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  if (activeStreams >= MAX_ACTIVE_STREAMS) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '2' });
    res.end('too many streams');
    mediaStats.errors++;
    return;
  }

  var episodeId = match[1];
  activeStreams++;
  pinActivity('media-' + episodeId);

  var finished = false;
  function done() {
    if (finished) return;
    finished = true;
    activeStreams--;
    unpinActivity();
  }
  res.on('close', done);
  res.on('finish', done);

  var headOnly = req.method === 'HEAD';

  // Fetch one segment, re-resolving the stream ONCE if the cached handle fails.
  //
  // A stale/expired upstream URL is indistinguishable from a transient throttle
  // at this layer, but it is recoverable by simply throwing the handle away and
  // resolving afresh — and that is cheap compared to showing the viewer an
  // error. The retry is deliberately single-shot: if a brand-new resolve also
  // fails, the problem is upstream and an error is the honest answer.
  var chunkAttempts = 0;
  function fetchSegment(h, s, e) {
    return h.chunk(s, e).catch(function (err) {
      if (chunkAttempts >= 1) throw err;
      chunkAttempts++;
      logErr('media', episodeId + ': retrying with a fresh stream handle (' +
        ((err && err.message) || err) + ')');
      evictStreamHandle(episodeId);
      return getStreamHandle(episodeId).then(function (fresh) {
        // The re-resolved stream can report a different total; if the requested
        // window now falls outside it, clamp rather than send a bad range.
        var effEnd = Math.min(e, (fresh.total || h.total) - 1);
        var effStart = Math.min(s, effEnd);
        return fresh.chunk(effStart, effEnd);
      });
    });
  }

  getStreamHandle(episodeId).then(function (handle) {
    var total = handle.total;
    var requested = parseRange(req.headers.range, total);

    if (requested === 'invalid') {
      res.writeHead(416, {
        'Content-Type': 'text/plain',
        'Content-Range': 'bytes */' + total
      });
      res.end();
      return;
    }

    // Clamp any request to one segment so a pathological Range cannot ask us
    // to decrypt tens of megabytes in a single response. An absent Range also
    // gets the first segment as a 206 (the player then Range-requests the rest
    // at its own pace).
    var start;
    var end;
    if (requested) {
      start = requested[0];
      end = Math.min(requested[1], start + SEG_SIZE - 1, total - 1);
    } else {
      start = 0;
      end = Math.min(total, SEG_SIZE) - 1;
    }
    var length = end - start + 1;

    if (headOnly) {
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(length),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      res.end();
      return;
    }

    // Decrypt the segment, then send. We fetch and decrypt the first segment
    // BEFORE writing headers so a failure can still produce a clean 502
    // instead of a truncated 206.
    return fetchSegment(handle, start, end).then(function (raw) {
      var body = Buffer.from(raw);
      // Never advertise more than we are actually sending. If the upstream
      // throttled us into a short read, report the SHORTER range we truly hold
      // rather than a Content-Range the media element would trust and then
      // stumble over mid-decode. The player simply issues the next Range for the
      // remainder, which is the correct HTTP behaviour.
      if (body.length < length) {
        mediaStats.errors++;
        logErr('media', episodeId + ': short read ' + body.length + '/' + length);
        if (body.length === 0) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('upstream returned no data');
          } else {
            res.destroy();
          }
          return;
        }
        end = start + body.length - 1;
      }
      logMedia({
        at: Date.now(), req: req.headers.range || '(none)',
        start: start, end: end, len: body.length, short: body.length < length,
        total: total, active: activeStreams
      });
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(body.length),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      });
      mediaStats.served++;
      mediaStats.bytes += body.length;
      res.end(body);
    });
  }).catch(function (e) {
    mediaStats.errors++;
    logErr('media', episodeId + ': ' + ((e && e.message) || e));
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('upstream unavailable');
  });
}

var mediaServer = http.createServer(mediaServerHandler);

// Never let a socket error crash the service.
mediaServer.on('clientError', function (err, socket) {
  try {
    socket.destroy();
  } catch (e) { /* already closed */ }
});

// If the port is taken (a stale instance, or another app using it), walk up.
var portAttempts = 0;
mediaServer.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE' && portAttempts < 8) {
    portAttempts++;
    MEDIA_PORT++;
    setTimeout(function () {
      mediaServer.listen(MEDIA_PORT, '127.0.0.1');
    }, 200);
    return;
  }
  logErr('media-server', (e && e.message) || e);
});

mediaServer.listen(MEDIA_PORT, '127.0.0.1', function () {
  console.log('[hongguo] media proxy listening on 127.0.0.1:' + MEDIA_PORT);
});

// Periodic cache hygiene so a long session does not accumulate resolved
// stream handles for every episode ever played.
setInterval(function () {
  var now = Date.now();
  streamHandles.forEach(function (v, k) {
    if (now - v.at > STREAM_TTL) streamHandles.delete(k);
  });
}, 60000).unref();

// ---------- activity pinning ----------
// Belt and braces alongside the long idleTimer above: while a media stream is
// actually in flight we hold a real activity, so the bus has an explicit reason
// not to reap us even if a shorter idle timeout is ever configured (or the TV
// overrides ours). Reference-counted, because up to MAX_ACTIVE_STREAMS requests
// can overlap and only the last one leaving should release the pin.
var pinnedActivity = null;
var pinCount = 0;

function pinActivity(label) {
  pinCount++;
  if (pinnedActivity || !service.activityManager || !service.activityManager.create) return;
  try {
    service.activityManager.create(label || 'media-stream', function (activity) {
      pinnedActivity = activity;
    });
  } catch (e) {
    logErr('activity', 'pin failed: ' + ((e && e.message) || e));
  }
}

function unpinActivity() {
  pinCount = Math.max(0, pinCount - 1);
  if (pinCount > 0) return;
  var act = pinnedActivity;
  pinnedActivity = null;
  if (!act || !service.activityManager || !service.activityManager.complete) return;
  try {
    service.activityManager.complete(act, {});
  } catch (e) {
    logErr('activity', 'unpin failed: ' + ((e && e.message) || e));
  }
}

// Called by the web app on app exit so we do not linger for the whole TV
// session after the user leaves.
service.register('shutdown', function (message) {
  message.respond({ returnValue: true, bye: true });
  try { if (mediaServer.close) mediaServer.close(); } catch (e) { /* ignore */ }
  setTimeout(function () { process.exit(0); }, 100);
});

console.log('[hongguo] service ready, node ' + process.version);
