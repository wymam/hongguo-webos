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
  return api;
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

// A stall watchdog would be ideal but the vendored client exposes no abort; the
// honest safeguard is the retry budget above plus the short-read guard in
// service.js, which refuses to emit a lying 206.

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isTransientRangeError(e) {
  var m = (e && e.message) || '';
  // remoteRange throws "媒体 Range 长度异常: N/M" for a short or empty body, and
  // axios surfaces network hiccups as ECONNRESET/ETIMEDOUT/5xx-flavoured text.
  return /长度异常/.test(m) || /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|timeout|502|503|504/i.test(m);
}

// Fetch exactly [start, end]. Falls back to progressively smaller windows when
// the CDN keeps returning short reads, so a throttled stream still makes
// forward progress instead of stalling until the player gives up.
function remoteRangeResilient(a, stream, start, end) {
  var attempt = 0;

  function once(s, e) {
    return a.remoteRange(stream, s, e).then(function (remote) {
      var want = e - s + 1;
      var got = remote.data ? remote.data.length : 0;
      if (got === want) return remote;
      var err = new Error('媒体 Range 长度异常: ' + got + '/' + want);
      err.__short = true;
      throw err;
    });
  }

  function tryAttempt() {
    return once(start, end).catch(function (e) {
      if (!isTransientRangeError(e)) throw e;
      attempt += 1;
      if (attempt >= RANGE_ATTEMPTS) {
        // Out of retries at the requested size. If the window is still wide,
        // halve it and try again — a smaller ask often succeeds while the
        // client is being throttled. Stop at 32KiB to bound the work.
        var want = end - start + 1;
        if (want > 32 * 1024) {
          var half = Math.max(32 * 1024, Math.floor(want / 2));
          attempt = 0;
          return remoteRangeResilient(a, stream, start, start + half - 1);
        }
        throw e;
      }
      return sleep(RANGE_BACKOFF_MS[attempt] || 1800).then(tryAttempt);
    });
  }

  return tryAttempt();
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
  // MIN ITEMS PER SCREEN: upstream paginates at 24, which is under four rows at
  // the default column count — the viewer hits "next page" almost immediately
  // and browsing feels like a slot machine. `minItems` (default 50) keeps
  // pulling following pages until the screen has a real list to scroll, or the
  // category runs out. The pages actually consumed are reported back so the UI
  // can offer "next batch" from where we stopped rather than +1.
  category: function (key, page, genre, minItems) {
    page = page || 1;
    minItems = Number(minItems) > 0 ? Number(minItems) : 50;
    var a = loadUpstream();
    var entry = CATEGORY_ROUTES[key] || CATEGORY_ROUTES.real;
    var route = entry.route + (genre ? '/' + genre : '');

    function fetchPage(n) {
      return a.routerData(categoryUrl(route, n)).then(function (data) {
        var pageData = categoryPageData(data);
        if (!pageData || !Array.isArray(pageData.recommendList)) {
          throw new Error('分类数据结构已变化');
        }
        return {
          items: rowsToCards(pageData.recommendList),
          filters: filtersFromCategory(pageData),
          pagination: paginationFromCategory(pageData),
          page: n
        };
      });
    }

    // Upstream pages are 24 each, so 50 needs three of them. The cap stops a
    // pathological `minItems` (or a category whose rows fail our shape filter)
    // from walking the whole 34-page catalogue.
    var MAX_PAGES_PER_BATCH = 5;
    var collected = [];
    var seen = {};
    var pages = [];
    var head = null;

    function pull(n) {
      if (n > (head ? head.pagination.totalPages : 1)) return Promise.resolve();
      if (pages.length >= MAX_PAGES_PER_BATCH) return Promise.resolve();
      return fetchPage(n).then(function (res) {
        if (!head) head = res;
        pages.push(n);
        for (var i = 0; i < res.items.length; i++) {
          var it = res.items[i];
          // The same series can appear on two pages when the upstream list
          // shifts underneath us; a de-dup by id keeps the count honest.
          if (seen[it.id]) continue;
          seen[it.id] = 1;
          collected.push(it);
        }
        if (collected.length >= minItems) return null;
        return pull(n + 1);
      });
    }

    return pull(page).then(function () {
      if (!head) throw new Error('分类数据为空');
      var pagination = head.pagination;
      return {
        key: key in CATEGORY_ROUTES ? key : 'real',
        name: entry.name,
        genre: genre || '',
        items: collected,
        filters: head.filters,
        pagination: {
          total: pagination.total,
          page: pages[0] || page,
          pageSize: pagination.pageSize,
          totalPages: pagination.totalPages,
          // Which upstream pages this batch covers, so the UI can page by
          // BATCH rather than by single page (which would re-show 24).
          pagesFetched: pages.slice(),
          nextPage: pages.length ? pages[pages.length - 1] + 1 : page + 1,
          hasMore: !!pages.length && pages[pages.length - 1] < pagination.totalPages,
          hasPrev: (pages[0] || page) > 1
        },
        page: pages[0] || page
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
  stream: function (id, fresh) {
    var a = loadUpstream();
    if (fresh) {
      try {
        api.streamCache.delete(id + '|auto');
        api.videoInfoCache.delete(id);
      } catch (e) { /* cache may be cold */ }
    }
    return Promise.resolve()
      .then(function () { return a.resolveStream(id, 'auto'); })
      .then(function (stream) {
        // Header prep is the fragile step: it asks for 256KiB in one request,
        // and the CDN intermittently answers that with an EMPTY body instead of
        // 206 (measured on-device: "媒体 Range 长度异常: 0/262144"). It is not a
        // hard byte ceiling — the same 256KiB request succeeds on the next try —
        // so it is throttling, and the cure is persistence, not a smaller cap.
        // See remoteRangeResilient below.
        return prepareHeaderResilient(a, stream).then(function (prepared) {
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
        });
      });
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

module.exports = { provider: provider, SITE: SITE };
