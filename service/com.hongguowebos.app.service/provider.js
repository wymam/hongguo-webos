// Provider layer: runs the vendored (GPL-3.0) red-berry signing source inside
// a vm context and exposes a small, data-shaped API to the Luna service.
//
// IMPORTANT — data-shape drift:
//   The vendored source was pinned 2026-09 and its own `itemToCard` reads
//   `row.url` / `row.title`, which the live site no longer emits. The live
//   site uses `series_id` / `series_name` / `series_cover`. It also moved
//   category routes to path form (/category/real-drama) and ranks to
//   /rank/hot-*. So we do our own route building and our own mapping, and we
//   use the vendored source only for what it uniquely provides:
//     * routerData()  — SSR _ROUTER_DATA fetch with the right UA/TLS behaviour
//     * the whole signing + CENC decryption chain for playback
//
// All upstream failures become Errors. We never return an empty list to
// disguise a broken upstream — the UI shows a real error state instead.
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

// crypto-shim patches crypto.createHash in place when SM3 is missing, so it
// must be required before the vendored source ever touches crypto.
var cryptoShim = require('./crypto-shim.js');
var crypto = require('crypto');
var httpClient = require('./http-client.js');
var deviceId = require('./device-id.js');

var SITE = 'https://hongguoduanju.com';
var VENDOR_FILE = path.join(__dirname, 'vendor', 'hongguo.cjs');

// The vendored call sites use axios.create({...}). Our shim is a plain
// function that already applies sane limits, so create() returns itself.
if (typeof httpClient.create !== 'function') {
  httpClient.create = function () { return httpClient; };
}

// Category routes that actually exist on the live site (probed 2026-10-07).
// /category/hot-* and /category/short-drama are 404 now.
var CATEGORY_ROUTES = {
  real: { route: 'real-drama', name: '真人剧' },
  comic: { route: 'comic-drama', name: '漫剧' },
  ai: { route: 'ai-drama', name: 'AI剧' }
};

var api = null;
var loadError = null;

function loadUpstream() {
  if (api) return api;
  if (loadError) throw loadError;

  var source;
  try {
    source = fs.readFileSync(VENDOR_FILE, 'utf8');
  } catch (e) {
    loadError = new Error('上游签名源缺失: ' + e.message);
    throw loadError;
  }

  // The upstream bans individual iid/device_id pairs (observed 2026-10-14:
  // Code 110001 "未知异常" for the pinned pair, Code 0 for fresh ones, same
  // signing code). Run the vendored source under the CURRENT identity so every
  // signed request — play, search, detail — carries it.
  source = deviceId.patch(source);

  var context = vm.createContext({
    require: function (name) {
      // The vendored source only ever asks for node:crypto.
      if (name === 'node:crypto' || name === 'crypto') return crypto;
      throw new Error('Unsupported module: ' + name);
    },
    Buffer: Buffer,
    URL: URL,
    URLSearchParams: URLSearchParams,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    Math: Math,
    JSON: JSON,
    process: { env: {} },
    axios: httpClient
  });

  var exportList = [
    'categoryPage', 'categoryData', 'itemToCard', 'appSearchPage', 'routerData',
    'resolveStream', 'prepareHeader', 'remoteRange', 'decryptPartial',
    'streamCache', 'videoInfoCache', 'pageCache', 'appSearchCache'
  ].join(', ');

  try {
    vm.runInContext(
      source + '\nthis.api = {' + exportList + '};',
      context,
      { timeout: 10000, filename: 'hongguo.cjs' }
    );
  } catch (e) {
    loadError = new Error('上游签名源求值失败: ' + e.message);
    throw loadError;
  }

  api = context.api;
  if (!api || typeof api.resolveStream !== 'function') {
    loadError = new Error('上游签名源导出异常');
    throw loadError;
  }

  // Hijack the vendored range reader so EVERY range read in the process —
  // including the ones inside prepareHeader, the step that opens playback and
  // the one the truncation kept killing — goes through fetchWholeRange and can
  // never see a short body. See fetchWholeRange for the measurements.
  originalRemoteRange = api.remoteRange;
  api.remoteRange = function (stream, start, end) {
    return fetchWholeRange(stream, start, end, 0);
  };

  return api;
}

// The upstream object currently in force.
//
// Only the rotation path changes it: reloadUpstream() rebuilds `api` under a
// new identity. So when `api` is set, that IS the live object; when it is not
// set, nothing in this process has loaded the vendored source and the caller's
// own object (a test stub, or a caller-supplied handle) must be kept.
function liveApi(fallback) {
  try {
    if (api) return api;
  } catch (e) { /* fall through to the caller's */ }
  return fallback;
}

// Drop the evaluated upstream and build it again. Required after a device
// rotation: the identity is baked into the vendored source at evaluation time,
// so the only way a new iid/device_id takes effect is a fresh runInContext —
// which also discards every cache the old identity filled (streamCache entries
// signed for the banned device are worthless to the new one).
function reloadUpstream() {
  api = null;
  loadError = null;
  return loadUpstream();
}

// The vendored source under the CURRENT device identity, rebuilt from scratch.
// Split out so the identity rotation can call it, and so tests can substitute
// a stub instead of re-evaluating the real vendored file (which would sign
// against the live upstream).
var applyRotation = reloadUpstream;

// The upstream's verdict on a banned identity, wrapped by the vendored code as
// "video_model failed: 未知异常" / "App search failed: ...". HTTP is 200 — this
// is a business-code rejection, not a transport failure, which is exactly why
// the transport-shaped retries never fired.
function isDeviceRejected(e) {
  var m = (e && e.message) || '';
  return /110001/.test(m) || /未知异常/.test(m) || /unknown error/i.test(m);
}

// ---------- shape adapters, matched to the LIVE field names ----------

function pickTagText(tags) {
  if (!tags) return '';
  if (Array.isArray(tags)) return tags.join(' ');
  return String(tags);
}

// A row from recommendList / video_list / search results -> our card shape.
//
// `firstEpisode` is carried along because the list payload has NO dimensions:
// knowing whether a series is portrait or landscape requires looking at the
// video itself, and that needs an episode id. The category rows ship the whole
// `vid_list`, so the first entry is free — and it saves a /detail round trip
// per card when the grid probes orientations in bulk.
function rowToCard(row) {
  var id = row && (row.series_id || row.id || row.seriesId);
  if (!id) return null;
  var vids = row && Array.isArray(row.vid_list) ? row.vid_list : [];
  return {
    id: String(id),
    title: row.series_name || row.series_title || row.title || '',
    cover: row.series_cover || row.cover || row.img || '',
    description: row.series_intro || row.description || '',
    badge: row.episode_right_text || (row.badge || ''),
    tags: pickTagText(row.tags || row.tag_infos),
    episodeCount: Number(row.episode_cnt || row.episodeCount || 0) || 0,
    firstEpisode: vids.length ? String(vids[0]) : ''
  };
}

function rowsToCards(rows) {
  var list = Array.prototype.slice.call(rows || []);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var card = rowToCard(list[i]);
    if (card && card.id && card.title) out.push(card);
  }
  return out;
}

// The home page's `page` payload carries homeSections[]. Each section has a
// title and a video_list. The first section is often a banner/hero row.
function sectionsFromHome(pageData) {
  var sections = [];
  var raw = (pageData && pageData.homeSections) || [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i] || {};
    var items = rowsToCards(s.video_list || s.videoList || []);
    if (!items.length) continue;
    sections.push({
      key: s.section_id || s.sectionId || ('sec' + i),
      title: s.section_title || s.sectionTitle || s.title || ('推荐 ' + (i + 1)),
      items: items
    });
  }
  return sections;
}

// selectorList -> [{ rowName, items: [{ id, name }] }] for a filter bar.
function filtersFromCategory(pageData) {
  var raw = (pageData && pageData.selectorList) || [];
  var groups = [];
  for (var i = 0; i < raw.length; i++) {
    var row = raw[i] || {};
    var items = [];
    var list = row.items || [];
    for (var j = 0; j < list.length; j++) {
      var it = list[j] || {};
      if (!it.selector_item_id) continue;
      items.push({ id: String(it.selector_item_id), name: it.show_name || String(it.selector_item_id) });
    }
    if (!items.length) continue;
    groups.push({ key: 'row' + (row.row_id != null ? row.row_id : i), name: row.row_name || ('筛选 ' + (i + 1)), items: items });
  }
  return groups;
}

function paginationFromCategory(pageData) {
  var p = (pageData && pageData.pagination) || {};
  return {
    total: Number(p.total || 0) || 0,
    page: Number(p.pageNum || 1) || 1,
    pageSize: Number(p.pageSize || 24) || 24,
    totalPages: Number(p.totalPages || 1) || 1
  };
}

function bannersFromHome(pageData) {
  var raw = (pageData && (pageData.bannerList || pageData.mBannerList)) || [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i] || {};
    var id = b.series_id;
    if (!id) continue;
    out.push({
      id: String(id),
      title: b.series_name || '',
      cover: b.background_cover_pc || b.background_cover || b.title_link_pc || b.title_link || b.series_cover || '',
      description: b.series_intro || '',
      badge: '',
      tags: pickTagText(b.tags),
      episodeCount: 0
    });
  }
  return out;
}

// ---------- URL builders against the live route shapes ----------

function categoryUrl(route, page, extraQuery) {
  var url = SITE + '/category/' + route;
  var qs = [];
  if (page && page > 1) qs.push('page=' + page);
  if (extraQuery) qs.push(extraQuery);
  return qs.length ? url + '?' + qs.join('&') : url;
}

function categoryPageData(data) {
  var ld = (data && data.loaderData) || {};
  // live key is the literal segment 'category_$'
  return ld['category_$'] || ld.category_page || ld.categoryRoute || null;
}

// One upstream category page, memoised for the life of the service.
//
// This exists for two reasons, and both are about the viewer's wait:
//
//   1. SPEED. A batch fans out over several upstream pages at once, and the
//      page that overruns the 50-item cut is partly shown in THIS batch and
//      partly in the NEXT one. Without a cache, stepping forward re-fetches
//      that boundary page from scratch. With one, the boundary page (and any
//      page already seen while paging around) is free.
//
//   2. STABILITY. The upstream list shifts under us between requests. Re-using
//      the page that was measured a moment ago keeps the de-dup and the
//      50-item cut aligned with what the viewer is looking at, instead of
//      silently reshuffling the screen they just left.
//
// Keyed by route AND page, so a genre change (different route) never reads a
// stale page. The TTL is short on purpose: long enough to cover a browsing
// session's back-and-forth, short enough that a returning viewer sees fresh
// content rather than a snapshot from an hour ago.
var CATEGORY_PAGE_TTL_MS = 5 * 60 * 1000;
var categoryPageCache = {};

function fetchCategoryPage(a, route, n) {
  var key = route + '#' + n;
  var hit = categoryPageCache[key];
  if (hit && Date.now() - hit.at < CATEGORY_PAGE_TTL_MS) return Promise.resolve(hit.value);
  return a.routerData(categoryUrl(route, n)).then(function (data) {
    var pageData = categoryPageData(data);
    if (!pageData || !Array.isArray(pageData.recommendList)) {
      throw new Error('分类数据结构已变化');
    }
    var value = {
      items: rowsToCards(pageData.recommendList),
      filters: filtersFromCategory(pageData),
      pagination: paginationFromCategory(pageData),
      page: n
    };
    categoryPageCache[key] = { at: Date.now(), value: value };
    return value;
  });
}

// ---------- resilient upstream range fetching ----------
//
// WHY THIS EXISTS
//
// The red-berry CDN intermittently answers a Range request with an EMPTY body
// while still reporting 200/206. On device this surfaced as the service error
// "媒体 Range 长度异常: 0/262144" and, for the viewer, as an episode that plays
// for a short while and then jumps to the next one — because header prep (which
// needs the first 256KiB) failed, the proxy 502'd, and the <video> gave up.
//
// Two things we measured before writing this:
//
//   1. It is NOT a byte ceiling. A 256KiB request fails with 0 bytes, then the
//      SAME request succeeds moments later. Sizes from 8KiB to 200KiB succeeded
//      consistently in one run; 256KiB failed; and on a retry pass even 256KiB
//      succeeded. So it is throttling/race, not a limit.
//   2. Because it is transient, the right response is retry with backoff —
//      optionally shrinking the window, since a smaller ask is likelier to be
//      granted while the client is being throttled.
//
// Never silently return short data: if every attempt fails, the error must
// propagate so the service can answer 502 rather than hand a truncated segment
// to the decoder (a truncated segment is far worse — it looks like corruption).
// Retry budget for an upstream range fetch.
//
// Measured on the owner's TV: the CDN intermittently returns an EMPTY body for
// a range it just served, so a single failure means nothing — it is throttling,
// not a hard error, and simply asking again usually works. 4 attempts was enough
// in the lab but still produced the occasional "播放失败" in the field, so the
// budget is now 7 with a longer tail. Worst case is ~9s of backoff before the
// player is told anything went wrong, which is well inside its patience and far
// better than surfacing an error the user has to dismiss.
var RANGE_ATTEMPTS = 7;
var RANGE_BACKOFF_MS = [0, 300, 700, 1300, 2000, 2600, 3200];

// Split pieces get a short budget. Persistence is the cure for throttling on
// the ORIGINAL window (it answers with an empty body, which clears); for a
// truncated piece the cure is splitting again, not waiting.
var SPLIT_ATTEMPTS = 3;

// Never split below this. 32KiB is what the CDN was measured serving intact
// most often (see fetchWholeRange), and it bounds the recursion depth.
var SPLIT_MIN = 32 * 1024;

// A stall watchdog would be ideal but the vendored client exposes no abort; the
// honest safeguard is the retry budget above plus the short-read guard in
// service.js, which refuses to emit a lying 206.

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// True for a network hiccup that is worth asking again about.
//
// Two branches, because both spellings occur in the wild and they carry
// different information:
//   * `e.code` — the original errno from Node (ENOTFOUND, EAI_AGAIN, ...),
//     preserved by http-client even when it rewrites the message.
//   * message text — some call sites only surface text, and http-client
//     rewrites ENOTFOUND into "DNS lookup failed" (see its on('error') block),
//     which matched NONE of the old patterns. On-device evidence that this
//     matters: `recentErrors: "7680977186605517849: DNS lookup failed"` — a
//     resolver blip that reached the viewer as a 502 even though every layer
//     above it already had a retry budget.
//
// "DNS lookup failed" / ENOTFOUND / EAI_AGAIN are PRE-CONNECT failures: the
// request never reached the server, so retrying is safe for any method.
function isTransientNetworkError(e) {
  var code = (e && e.code) || '';
  if (/^E(NOTFOUND|AI_AGAIN|CONNREFUSED|CONNRESET|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH|ADDRNOTAVAIL)$/.test(code)) {
    return true;
  }
  var m = (e && e.message) || '';
  return /DNS lookup failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timeout|50[234]/i.test(m);
}

function isTransientRangeError(e) {
  var m = (e && e.message) || '';
  // remoteRange throws "媒体 Range 长度异常: N/M" for a short or empty body, and
  // axios surfaces network hiccups as ECONNRESET/ETIMEDOUT/5xx-flavoured text.
  return /长度异常/.test(m) || isTransientNetworkError(e);
}

// Reference to the UNTOUCHED vendored range reader. loadUpstream() hijacks
// api.remoteRange to point at the completing wrapper below, so every range
// read in the process — including the ones deep inside the vendored
// prepareHeader — goes through it. Reaching back through the hijacked property
// would recurse into the wrapper; this module-scope reference is what keeps
// the chain finite.
var originalRemoteRange = null;

// Fetch [start, end] COMPLETELY, or throw.
//
// Retries the requested window first — that is what clears throttling, which
// answers with an EMPTY body. When the budget is spent and the window can
// still be split, the two halves are fetched and assembled instead of the
// shortfall being returned. That distinction is not academic; it comes from
// what was measured on the owner's TV (2026-10-11):
//
//   * A range request for 262144 bytes intermittently came back TRUNCATED but
//     non-empty — sizes observed: 218, 32768, 131072 bytes. Five identical
//     requests in a row gave 131072 / 131072 / 262144 / 32768 / 131072, i.e.
//     the truncation is random and size-related.
//   * Persistence does NOT reliably clear it: at 14:17 prepareHeader got
//     218/262144 on all seven attempts, then the same on seven attempts
//     against a FRESHLY SIGNED url (openStream's second round). Both exports
//     of the error end with 播放失败.
//   * A smaller ask usually does succeed, which is exactly what splitting
//     exploits.
//
// And "complete" is not a nicety: for prepareHeader — which must parse
// ftyp+moov out of the first 256KiB — a short body is fatal; and a short body
// forwarded onward as a 206 whose Content-Range promises the full window
// breaks Chromium's buffer model (the 跳绳/jump-to-end family of bugs).
function fetchWholeRange(stream, start, end, depth) {
  var want = end - start + 1;
  // Persist on the original window (throttling lives there and persistence
  // clears it); retry a split piece only briefly — splitting again, not
  // waiting, is the remedy for what a piece can hit.
  var maxAttempts = depth === 0 ? RANGE_ATTEMPTS : SPLIT_ATTEMPTS;
  var attempt = 0;

  function attemptOnce() {
    return originalRemoteRange(stream, start, end).then(function (remote) {
      var got = remote.data ? remote.data.length : 0;
      if (got === want) return remote;
      // Belt and braces — the vendored reader already rejects short reads,
      // so this branch only fires if that ever changes. The preview pinpoints
      // WHAT came back instead of just how much.
      var preview = '';
      if (got > 0) {
        try {
          var head = Buffer.from(remote.data).slice(0, 48)
            .toString('utf8').replace(/[^\x20-\x7e]+/g, '.');
          preview = ' body=' + JSON.stringify(head);
        } catch (e2) { /* preview is best-effort */ }
      }
      var err = new Error('媒体 Range 长度异常: ' + got + '/' + want + preview);
      err.__short = true;
      throw err;
    }).catch(function (e) {
      if (!isTransientRangeError(e)) throw e;
      attempt += 1;
      if (attempt < maxAttempts) {
        return sleep(RANGE_BACKOFF_MS[Math.min(attempt, RANGE_BACKOFF_MS.length - 1)] || 1800)
          .then(attemptOnce);
      }
      // Budget spent. Split and assemble rather than hand back a short body.
      if (want > SPLIT_MIN) {
        var half = Math.max(SPLIT_MIN, Math.floor(want / 2));
        return fetchWholeRange(stream, start, start + half - 1, depth + 1)
          .then(function (first) {
            return fetchWholeRange(stream, start + half, end, depth + 1)
              .then(function (rest) {
                return {
                  data: Buffer.concat([Buffer.from(first.data), Buffer.from(rest.data)]),
                  total: first.total || rest.total
                };
              });
          });
      }
      throw e;
    });
  }

  return attemptOnce();
}

// The byte path's historical entry point. Kept as a thin wrapper so the handle
// closures and the hijacked vendored reader share one implementation.
function remoteRangeResilient(a, stream, start, end) {
  return fetchWholeRange(stream, start, end, 0);
}

// prepareHeader, but tolerant of the throttling above. The vendored
// implementation requests a fixed 256KiB first window and treats a short read as
// fatal; we retry that whole step so a cold stream survives a throttled moment.
function prepareHeaderResilient(a, stream) {
  var attempt = 0;
  function tryOnce() {
    return a.prepareHeader(stream).catch(function (e) {
      if (!isTransientRangeError(e)) throw e;
      attempt += 1;
      if (attempt >= RANGE_ATTEMPTS) throw e;
      return sleep(RANGE_BACKOFF_MS[attempt] || 1800).then(tryOnce);
    });
  }
  return tryOnce();
}

// ---------- orientation probe internals ----------------------------------

var mp4box = require('./mp4box');

// episodeId -> { width, height }. Bounded so a long browsing session cannot
// grow without limit; entries are tiny and stable, so 1500 is plenty.
var aspectCache = new Map();
var ASPECT_CACHE_LIMIT = 1500;

// seriesId -> first episode id. Needed because the HOME feed ships `vid_list`
// as an EMPTY ARRAY (the field exists, it is just empty — verified against the
// live payload), so home cards have no episode id to probe with and could never
// earn a badge. The detail route does carry it, so resolve it there, once per
// series, and remember it. `''` is cached too, so a series that genuinely has
// no episode list is not re-fetched on every render.
var seriesVidCache = new Map();
var SERIES_VID_LIMIT = 800;

function firstEpisodeOf(a, seriesId) {
  if (seriesVidCache.has(seriesId)) return Promise.resolve(seriesVidCache.get(seriesId));
  return a.routerData(SITE + '/detail?series_id=' + seriesId).then(function (data) {
    var s = data && data.loaderData && data.loaderData.detail_page &&
      data.loaderData.detail_page.seriesDetail;
    var vids = s && Array.isArray(s.vid_list) ? s.vid_list : [];
    var ep = vids.length ? String(vids[0]) : '';
    if (seriesVidCache.size > SERIES_VID_LIMIT) {
      seriesVidCache.delete(seriesVidCache.keys().next().value);
    }
    seriesVidCache.set(seriesId, ep);
    return ep;
  }, function () {
    if (seriesVidCache.size > SERIES_VID_LIMIT) {
      seriesVidCache.delete(seriesVidCache.keys().next().value);
    }
    seriesVidCache.set(seriesId, '');
    return '';
  });
}

function rememberAspect(id, dim) {
  aspectCache.set(id, dim);
  if (aspectCache.size > ASPECT_CACHE_LIMIT) {
    // Map iterates in insertion order, so the first key is the oldest.
    aspectCache.delete(aspectCache.keys().next().value);
  }
}

// How much of the file one probe reads.
var PROBE_WINDOW = 128 * 1024;

// Read the real frame size of one episode without downloading it.
//
// NO prepareHeader, NO decrypt — and that is the whole point.
//
// prepareHeader() costs a 256KiB range of its own and then REFUSES any file
// whose `moov` is not immediately after `ftyp` (it throws 'MP4 moov 不在 ftyp
// 后'). That is the right call for playback, which needs a CENC sample index,
// but it is wasted work here: CENC encrypts the media samples in `mdat` only,
// so `moov` — and therefore `tkhd`, and therefore the frame size — is PLAINTEXT
// in the raw bytes. Reading them directly:
//   * halves the bytes per probe (one 128KiB range instead of 256KiB header +
//     another range),
//   * drops one round-trip,
//   * and succeeds on non-faststart files that prepareHeader rejects outright,
//     which is where most of the ~37% probe failures came from.
//
// A probe is COSMETIC — it only decides whether a card shows 竖 or 横 — so it
// is allowed to fail, and it retries each read once without backoff rather than
// spending the playback-grade budget (RANGE_ATTEMPTS + halving + sleep).
function probeRaw(a, stream) {
  function readOnce(start, end) {
    if (!(end >= start)) return Promise.resolve({ dim: null, total: 0 });
    return a.remoteRange(stream, start, end).then(function (remote) {
      return { dim: mp4box.parse(Buffer.from(remote.data)), total: remote.total || 0 };
    });
  }
  // One retry, no backoff: a short read under throttling often succeeds on the
  // second ask, and a badge is not worth 1.8s of sleeping per failure.
  function readWindow(start, end) {
    return readOnce(start, end).catch(function () { return readOnce(start, end); });
  }
  return readWindow(0, PROBE_WINDOW - 1).then(function (head) {
    if (head.dim) return head.dim;
    var total = head.total || 0;
    if (!total) return null;
    // Not faststart: `moov` sits at the tail.
    return readWindow(Math.max(0, total - PROBE_WINDOW), total - 1)
      .then(function (tail) { return tail.dim || null; });
  });
}

// Fallback for the files the raw read cannot make sense of. This is the
// expensive path — prepareHeader costs a 256KiB range and builds a CENC sample
// index — so it only runs when the cheap one came back empty. resolveStream is
// cached, so re-entering it here is free.
function probeViaHeader(a, stream) {
  return prepareHeaderResilient(a, stream).then(function (prepared) {
    var dim = mp4box.parse(Buffer.from(prepared.header));
    if (dim) return dim;
    var total = prepared.total || 0;
    if (!total) return null;
    var start = Math.max(0, total - mp4box.HEAD_BYTES);
    return a.remoteRange(stream, start, total - 1)
      .then(function (remote) {
        return mp4box.parse(Buffer.from(
          a.decryptPartial(remote.data, start, stream.key, prepared)
        ));
      })
      .catch(function () { return null; });
  });
}

function probeOne(episodeId) {
  var a = loadUpstream();
  return Promise.resolve()
    .then(function () { return a.resolveStream(episodeId, 'auto'); })
    .then(function (stream) {
      return probeRaw(a, stream).then(function (dim) {
        if (dim) return dim;
        return probeViaHeader(a, stream).catch(function () { return null; });
      });
    });
}

// Resolve the stream URL with the same persistence the data path gets.
//
// The resolve step (fetchVideoInfo -> signed request for the play URL) used to
// have NO retry at all: the byte path could survive seven throttles, but a
// single DNS blip on the very first call after a channel change surfaced to the
// viewer as `播放失败` — observed on-device as
//   recentErrors: "7680977186605517849: DNS lookup failed"
// on an episode that played perfectly seconds earlier and seconds later. One
// transient resolver failure must not be able to end a playback attempt.
//
// The retry is safe beyond pre-connect errors: fetchVideoInfo is a read-only
// query (it returns stream metadata; it never mutates upstream state), so even
// a connection reset mid-response can simply be asked again.
//
// Backoff is short because this sits on the open-a-stream critical path — the
// player is waiting with a spinner, and ~3s total is the patience budget.
var RESOLVE_ATTEMPTS = 4;
var RESOLVE_BACKOFF_MS = [0, 400, 900, 1800];
// Identity rotations allowed per open attempt. Three fresh identities are
// enough to prove the upstream is refusing us for a reason a new pair cannot
// fix (which is what a rotating refusal would look like).
var DEVICE_ROTATIONS = 3;
var ROTATE_BACKOFF_MS = 700;

function resolveStreamResilient(a, id) {
  var attempt = 0;
  var rotations = 0;
  function tryOnce() {
    return a.resolveStream(id, 'auto').catch(function (e) {
      // A banned identity is the one failure none of the transport retries can
      // clear: measured 2026-10-14, the very same request under a freshly
      // generated iid/device_id returned Code 0. So the cure is a new
      // identity, not another attempt — re-evaluate the vendored source under
      // it (which also drops the caches the banned device filled) and go
      // again. Bounded, because if three new identities are all refused the
      // upstream is refusing us for a reason a new pair cannot fix.
      if (isDeviceRejected(e) && rotations < DEVICE_ROTATIONS) {
        rotations += 1;
        deviceId.rotate('upstream rejected identity (110001)');
        a = applyRotation();
        return sleep(ROTATE_BACKOFF_MS).then(tryOnce);
      }
      if (!isTransientNetworkError(e)) throw e;
      attempt += 1;
      if (attempt >= RESOLVE_ATTEMPTS) throw e;
      return sleep(RESOLVE_BACKOFF_MS[attempt] || 1800).then(tryOnce);
    });
  }
  return tryOnce();
}

// Build the playable handle from a resolved stream + prepared header.
//
// Extracted so the open path (below) can retry the whole resolve+prepare pair:
// a handle closes over BOTH the signed URL and the header index, so a retry
// that signs a new URL must build a new handle rather than reuse pieces of the
// failed one.
function makeStreamHandle(a, stream, prepared) {
  return {
    total: prepared.total,
    quality: stream.quality || 'auto',
    keyed: !!stream.key,
    chunk: function (start, end) {
      return remoteRangeResilient(a, stream, start, end).then(function (remote) {
        return a.decryptPartial(remote.data, start, stream.key, prepared);
      });
    },
    // Diagnostics only: split the two halves of `chunk` so a slowdown
    // can be attributed to the network (rawChunk) or the CPU (decrypt).
    rawChunk: function (start, end) {
      return remoteRangeResilient(a, stream, start, end).then(function (remote) {
        return remote.data;
      });
    },
    decrypt: function (data, start) {
      return a.decryptPartial(data, start, stream.key, prepared);
    }
  };
}

// Open a stream, re-signing the URL when the first signed one proves unusable.
//
// On-device evidence (2026-10-11 14:10:30, the owner's TV):
//   recentErrors: "7692013453707332632: 媒体 Range 长度异常: 142/262144"
// prepareHeader asked for 256KiB and got a 142-byte body on every one of its
// seven tries — while the same episode served the full 256KiB fine a minute
// later (verified by hand: HTTP 206, size 262144, 0.14s). That signature is NOT
// the throttling the inner retry budget was tuned for: throttling answers with
// an EMPTY body, which persistence does fix. A short but NON-EMPTY body means
// the edge answered with something else entirely, and re-asking the same
// signed URL seven times cannot recover it.
//
// The byte path already had this escape — fetchSegment drops the handle and
// re-resolves when a segment fails. The header path did not, so one poisoned
// URL ended the whole attempt with 播放失败. This wraps resolve + prepare in
// one more layer: when the inner budgets are spent, drop the signed URL
// (including the 5-minute stream cache that would hand the same one right
// back) and sign a fresh one.
//
// Budget: 2 rounds. The typical poisoned-URL case recovers in ~11s (inner
// budget + 0.5s + one successful request), which is inside the player's
// patience; only a genuinely dead upstream pays the ~2x worst case. One round
// of re-signing is the sweet spot — enough to dodge a bad URL, short enough
// that a real outage still surfaces as an error instead of hanging forever.
var OPEN_ATTEMPTS = 2;
var OPEN_BACKOFF_MS = [0, 500];

function openStream(a, id) {
  var attempt = 0;

  function signAndPrepare() {
    return Promise.resolve()
      .then(function () { return resolveStreamResilient(a, id); })
      .then(function (stream) {
        // resolveStreamResilient may have rotated the device identity, which
        // re-evaluates the vendored source under the new pair. Take whatever
        // api is in force NOW so prepareHeader signs with the identity that
        // just succeeded rather than the one that was refused.
        var live = liveApi(a);
        return prepareHeaderResilient(live, stream).then(function (prepared) {
          return makeStreamHandle(live, stream, prepared);
        });
      });
  }

  function tryRound() {
    // An inner rotation replaces the evaluated upstream; take the live one so
    // this round signs with the identity currently in force.
    a = liveApi(a);
    return signAndPrepare().catch(function (e) {
      if (!isTransientRangeError(e)) throw e;
      attempt += 1;
      if (attempt >= OPEN_ATTEMPTS) {
        // Both rounds are spent. Say so — the raw message alone ("length
        // anomaly", "DNS lookup failed") does not reveal that a freshly
        // signed URL was already tried, which is the single most useful fact
        // when reading recentErrors after the fact.
        e.message = '开流失败（已换新签名 ' + OPEN_ATTEMPTS + ' 轮）: ' + e.message;
        throw e;
      }
      // Drop every cache that would hand the same signed URL back.
      try {
        a.streamCache.delete(id + '|auto');
        a.videoInfoCache.delete(id);
      } catch (e2) { /* cache may be cold */ }
      return sleep(OPEN_BACKOFF_MS[attempt] || 500).then(tryRound);
    });
  }

  return tryRound();
}

// ---------- public API ----------

var provider = {
  // Home feed: banner + sectioned rows from the live `loaderData.page`.
  home: function () {
    var a = loadUpstream();
    return Promise.resolve()
      .then(function () { return a.routerData(SITE + '/'); })
      .then(function (data) {
        var ld = (data && data.loaderData) || {};
        var pageData = ld.page || ld.home_page || ld['home_$'];
        if (!pageData) throw new Error('首页数据结构已变化');
        var sections = sectionsFromHome(pageData);
        var banners = bannersFromHome(pageData);
        if (!sections.length && !banners.length) {
          throw new Error('首页未返回任何内容');
        }
        return { banners: banners, sections: sections };
      });
  },

  // Category listing. `key` is one of CATEGORY_ROUTES; falls back to real-drama.
  // `genre` is an optional selector_item_id (e.g. 'romance') which maps to a
  // sub-route /category/<route>/<genre>.
  //
  // A BATCH IS A SCREEN, AND A SCREEN IS EXACTLY `minItems` (50) ITEMS.
  //
  // Upstream paginates at 24, which is under five rows — the viewer hit "next
  // page" almost immediately and browsing felt like a slot machine. So a batch
  // collects consecutive upstream pages and returns exactly `minItems`, which
  // at the default 5-column grid is a perfectly full 10 rows with no ragged
  // tail ("每页剧集每行5个，一共10行 50个").
  //
  // BATCHES TILE: 50 is never a multiple of 24, so page-aligned batches cannot
  // line up with the 50-item screen. The batch therefore STARTS at
  // (page, skip) — item `skip` of upstream page `page` — and reports where the
  // next one starts. The UI echoes those coordinates back. Without the skip,
  // the 22 items that straddle the cut would be either repeated on every
  // screen or silently dropped.
  //
  // SPEED: the pages a batch spans are fetched CONCURRENTLY. The first page is
  // fetched alone (it is the only way to learn the upstream page size and total
  // page count), then the rest are issued in one `Promise.all` rather than
  // chained. Three sequential round trips to the upstream is the visible
  // "waiting for 剧集" delay; one round trip plus fan-out is close to a third
  // of it.
  category: function (key, page, genre, minItems, skip) {
    page = page || 1;
    skip = Number(skip) > 0 ? Number(skip) : 0;
    minItems = Number(minItems) > 0 ? Number(minItems) : 50;
    var a = loadUpstream();
    var entry = CATEGORY_ROUTES[key] || CATEGORY_ROUTES.real;
    var route = entry.route + (genre ? '/' + genre : '');

    function fetchPage(n) {
      return fetchCategoryPage(a, route, n);
    }

    // Upstream pages are 24 each, so 50 needs three of them. The cap stops a
    // pathological `minItems` (or a category whose rows fail our shape filter)
    // from walking the whole catalogue.
    var MAX_PAGES_PER_BATCH = 6;

    return fetchPage(page).then(function (first) {
      if (!first) throw new Error('分类数据为空');
      var pagination = first.pagination || {};
      var perPage = pagination.pageSize > 0 ? pagination.pageSize : 24;
      var totalPages = pagination.totalPages > 0 ? pagination.totalPages : 1;

      // How many upstream pages this batch can possibly touch. `skip` eats into
      // the first page, so account for it rather than assuming a whole page.
      var usableFirst = Math.max(0, perPage - skip);
      var pagesNeeded = Math.ceil(Math.max(0, minItems - usableFirst) / perPage) + 1;
      pagesNeeded = Math.min(MAX_PAGES_PER_BATCH, Math.max(1, pagesNeeded));

      var wanted = [];
      for (var i = 1; i < pagesNeeded; i++) {
        var n = page + i;
        if (n > totalPages) break;
        wanted.push(n);
      }
      if (!wanted.length) return [first];
      // Fan out: these are independent, so the batch costs one round trip of
      // latency (the first page, already done) plus one in parallel, instead
      // of one per page.
      return Promise.all(wanted.map(function (n) {
        return fetchPage(n).catch(function () { return null; });
      })).then(function (rest) {
        return [first].concat(rest.filter(Boolean));
      });
    }).then(function (pages) {
      var head = pages[0];
      if (!head) throw new Error('分类数据为空');
      var pagination = head.pagination;
      var totalPages = pagination.totalPages > 0 ? pagination.totalPages : 1;
      var perPage = pagination.pageSize > 0 ? pagination.pageSize : 24;

      var ordered = pages.slice().sort(function (x, y) { return x.page - y.page; });

      // Walk the fetched pages IN ORDER, starting at (page, skip), keeping the
      // upstream's own ordering and de-duplicating by id (the same series can
      // appear on two pages when the upstream list shifts underneath us).
      var shown = [];
      var seen = {};
      var cursorPage = page;
      var cursorSkip = skip;
      var exhausted = false;

      for (var i = 0; i < ordered.length && shown.length < minItems; i++) {
        var pg = ordered[i];
        if (pg.page < page) continue;
        var items = pg.items || [];
        var from = pg.page === page ? skip : 0;
        for (var k = from; k < items.length && shown.length < minItems; k++) {
          var it = items[k];
          cursorPage = pg.page;
          cursorSkip = k + 1;
          if (!it || !it.id || seen[it.id]) continue;
          seen[it.id] = 1;
          shown.push(it);
        }
        // The cursor ran off the end of this page: the next batch starts at
        // the top of the following one.
        if (cursorSkip >= items.length) {
          cursorPage = pg.page + 1;
          cursorSkip = 0;
        }
      }

      // We stopped mid-page: the remainder of that page belongs to the next
      // batch, which is exactly what (cursorPage, cursorSkip) addresses.
      var atEnd = cursorPage > totalPages;
      if (atEnd && shown.length === 0) throw new Error('分类数据为空');

      var pagesFetched = [];
      for (var c = 0; c < ordered.length; c++) {
        if (ordered[c].page >= page) pagesFetched.push(ordered[c].page);
      }

      return {
        key: key in CATEGORY_ROUTES ? key : 'real',
        name: entry.name,
        genre: genre || '',
        items: shown,
        filters: head.filters,
        pagination: {
          total: pagination.total,
          page: page,
          skip: skip,
          pageSize: pagination.pageSize,
          totalPages: pagination.totalPages,
          // Which upstream pages this batch covers, for diagnostics.
          pagesFetched: pagesFetched,
          // Where the NEXT batch begins. The UI echoes these straight back, so
          // batches tile the catalogue with no gap and no repeat.
          nextPage: cursorPage,
          nextSkip: cursorSkip,
          hasMore: !atEnd,
          hasPrev: page > 1 || skip > 0
        },
        page: page
      };
    });
  },

  // Search.
  //
  // KNOWN BROKEN as of 2026-10-07, and this is reported honestly rather than
  // masked as an empty result:
  //   * The 番茄 app endpoint returns HTTP 200 with a zero-length body for all
  //     non-app traffic (unsigned requests too), i.e. edge-level gating, not a
  //     signing bug. The signing chain itself is proven good on the video
  //     endpoint, which answers with a real JSON body.
  //   * The website's SSR search always yields an empty searchList and echoes
  //     back query:"" — the query is ignored server-side; the real list is
  //     fetched client-side through the same gated API.
  // We still attempt both paths, so if the gate ever lifts, search starts
  // working without a code change. When both return nothing we throw a
  // descriptive error so the UI can explain the situation.
  search: function (keyword, page) {
    page = page || 1;
    var a = loadUpstream();
    var tried = [];

    return Promise.resolve()
      .then(function () {
        return a.appSearchPage(keyword, 11, page, 20).then(function (result) {
          var rows = (result && result.list) || [];
          if (!rows.length) { tried.push('app:empty'); return null; }
          var cards = [];
          for (var i = 0; i < rows.length; i++) {
            var r = rows[i] || {};
            var card = rowToCard(r) || {
              id: r.book_id || r.series_id || r.id,
              title: r.book_name || r.title || r.name || '',
              cover: r.thumb_url || r.cover_url || r.cover || r.img || '',
              description: r.abstract || r.description || '',
              badge: '', tags: '', episodeCount: 0
            };
            if (card && card.id && card.title) {
              card.id = String(card.id);
              cards.push(card);
            }
          }
          if (!cards.length) { tried.push('app:unmapped'); return null; }
          return { items: cards, page: page, source: 'app' };
        }).catch(function (e) {
          tried.push('app:' + e.message);
          return null;
        });
      })
      .then(function (hit) {
        if (hit) return hit;
        return a.routerData(SITE + '/search?query=' + encodeURIComponent(keyword) + '&page=' + page)
          .then(function (data) {
            var ld = (data && data.loaderData) || {};
            var pageData = ld.search_page || ld['search_(keyword)/page'] || ld['search_$'];
            var items = (pageData && Array.isArray(pageData.searchList))
              ? rowsToCards(pageData.searchList)
              : [];
            if (items.length) return { items: items, page: page, source: 'web' };
            tried.push('web:empty');
            var err = new Error('搜索暂不可用（上游已限制该接口）');
            err.code = 'SEARCH_UNAVAILABLE';
            err.detail = tried.join(' | ');
            throw err;
          });
      });
  },

  // Series detail: metadata + episode list from vid_list.
  detail: function (id) {
    var a = loadUpstream();
    return Promise.resolve()
      .then(function () { return a.routerData(SITE + '/detail?series_id=' + id); })
      .then(function (data) {
        var series = data && data.loaderData && data.loaderData.detail_page &&
          data.loaderData.detail_page.seriesDetail;
        if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length) {
          throw new Error('剧集不存在或分集暂不可用');
        }
        var episodes = series.vid_list.map(function (vid, index) {
          return { id: String(vid), title: '第 ' + (index + 1) + ' 集', number: index + 1 };
        });
        var seen = {};
        for (var i = 0; i < episodes.length; i++) {
          if (!/^\d+$/.test(episodes[i].id)) throw new Error('分集数据异常');
          if (seen[episodes[i].id]) throw new Error('分集数据异常');
          seen[episodes[i].id] = 1;
        }
        var social = (data.loaderData.detail_page.seriesSocialInfo) || {};
        return {
          id: String(id),
          title: series.series_name || '',
          cover: series.series_cover || '',
          description: series.series_intro || '',
          badge: series.episode_right_text || '',
          tags: pickTagText(series.tags),
          episodeCount: episodes.length,
          totalEpisodeCount: Number(series.series_episode_info && series.series_episode_info.episode_total_cnt) || episodes.length,
          rating: social.rating != null ? String(social.rating) : '',
          episodes: episodes
        };
      });
  },

  // Resolve a playable stream handle for one episode.
  // Resolve a playable stream handle for one episode.
  //
  // The header step inside is the fragile one (it asks for 256KiB in a single
  // request), and the pair resolve+prepare is wrapped in openStream so that a
  // poisoned signed URL gets replaced rather than retried. See openStream for
  // the on-device evidence that motivated the extra round.
  stream: function (id, fresh) {
    var a = loadUpstream();
    if (fresh) {
      try {
        api.streamCache.delete(id + '|auto');
        api.videoInfoCache.delete(id);
      } catch (e) { /* cache may be cold */ }
    }
    return openStream(a, id);
  },

  // ---------- orientation probing (portrait vs landscape) -----------------
  //
  // Reported per SERIES at browse time so every card can carry the badge, not
  // just the ones already watched.
  //
  // Each probe costs one stream resolve plus a 256KiB header fetch and a
  // 256KiB decrypt, so this is deliberately:
  //   * cached forever per episode id (a series' framing does not change),
  //   * bounded to a small concurrency (the CDN throttles hard — see the
  //     Range notes above — and a 70-item burst would trip it),
  //   * NEVER fatal: one failed probe contributes nothing and the rest still
  //     resolve. A grid missing one badge is fine; a grid that failed to load
  //     because of a badge is not.
  aspects: function (entries, concurrency) {
    var a = loadUpstream();
    var list = Array.prototype.slice.call(entries || []);
    var out = [];
    var wanted = [];
    var errors = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var ep = String(e.episodeId || e.episode || '');
      var sid = String(e.seriesId || '');
      // No episode id is NOT a skip: home cards never have one (their vid_list
      // is empty), and the worker below resolves it from the series id. Only a
      // row with neither identifier is unusable.
      if (!/^\d{1,30}$/.test(ep)) {
        if (!sid) continue;
        ep = '';
      }
      var hit = ep ? aspectCache.get(ep) : null;
      if (hit) { out.push({ episodeId: ep, seriesId: sid, width: hit.width, height: hit.height, cached: true }); continue; }
      wanted.push({ episodeId: ep, seriesId: sid });
    }

    // Capped: the caller may ask for more parallelism than the CDN will
    // tolerate, and a throttled burst fails slower than a smaller one.
    var lanes = Math.min(12, Number(concurrency) > 0 ? Number(concurrency) : 3);
    var next = 0;

    function worker() {
      function step() {
        if (next >= wanted.length) return Promise.resolve();
        var item = wanted[next++];
        // Resolve the episode id first when the caller could not supply one.
        var idReady = item.episodeId
          ? Promise.resolve(item.episodeId)
          : firstEpisodeOf(a, item.seriesId);
        return idReady.then(function (ep) {
          item.episodeId = ep;
          if (!ep) return null;
          return probeOne(ep);
        }).then(function (dim) {
          if (dim) {
            rememberAspect(item.episodeId, dim);
            out.push({
              episodeId: item.episodeId, seriesId: item.seriesId,
              width: dim.width, height: dim.height, cached: false
            });
          }
          return step();
        }, function (e) {
          // Swallow: a single unreadable episode must not void the batch. But
          // RECORD why — the first probe implementation was silently failing on
          // ~37% of episodes and the only way to see it was to add this.
          if (errors.length < 8) {
            errors.push({ episodeId: item.episodeId, reason: String((e && e.message) || e).slice(0, 120) });
          }
          return step();
        });
      }
      return step();
    }

    var lanes2 = [];
    for (var l = 0; l < lanes && l < wanted.length; l++) lanes2.push(worker());
    return Promise.all(lanes2).then(function () {
      return { items: out, probed: wanted.length, failed: errors.length, errors: errors };
    });
  },

  // Cache identities exposed for the service's own bookkeeping.
  caches: function () {
    var a = loadUpstream();
    return [a.streamCache, a.videoInfoCache, a.pageCache, a.appSearchCache];
  },

  // Diagnostics for an on-device self-check screen.
  status: function () {
    var out = { upstream: 'not-loaded', crypto: cryptoShim.report() };
    try {
      loadUpstream();
      out.upstream = 'ok';
    } catch (e) {
      out.upstream = 'error';
      out.error = e.message;
    }
    return out;
  },

  CATEGORY_ROUTES: CATEGORY_ROUTES,
  SITE: SITE
};

// Bound the upstream's otherwise unbounded caches during long sessions.
var sweep = setInterval(function () {
  var caches;
  try {
    caches = provider.caches();
  } catch (e) {
    return;
  }
  var now = Date.now();
  for (var c = 0; c < caches.length; c++) {
    var cache = caches[c];
    if (!cache || typeof cache.forEach !== 'function') continue;
    var expired = [];
    cache.forEach(function (value, key) {
      if (value && typeof value === 'object' && now - (value.time || 0) > 300000) {
        expired.push(key);
      }
    });
    for (var i = 0; i < expired.length; i++) cache.delete(expired[i]);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  }
}, 60000);
if (sweep.unref) sweep.unref();

module.exports = {
  provider: provider,
  SITE: SITE,
  // Test hooks for tools/verify-transient-retry.js — the retry classifiers and
  // the resolver wrapper are otherwise module-private, and their behaviour is
  // the very thing that regressed on-device (a DNS blip escaped every layer).
  __test: {
    isTransientNetworkError: isTransientNetworkError,
    isTransientRangeError: isTransientRangeError,
    isDeviceRejected: isDeviceRejected,
    resolveStreamResilient: resolveStreamResilient,
    openStream: openStream,
    fetchWholeRange: fetchWholeRange,
    deviceId: deviceId,
    // Substitute what a device rotation yields (tests avoid re-evaluating the
    // real vendored source, which would sign against the live upstream).
    setRotationReload: function (fn) { applyRotation = fn; },
    // Lets a test drive fetchWholeRange without loading the vm upstream. The
    // hook is what loadUpstream() itself sets in production.
    setOriginalRemoteRange: function (fn) { originalRemoteRange = fn; }
  }
};
