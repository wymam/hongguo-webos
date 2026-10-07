(function () {
  // Round 13, item 4 — final coverage check.
  //
  // The earlier version of this probe waited a fixed 6s per page, which
  // measured probe LATENCY, not coverage: a page that filled in over 40s
  // reported 2/72 and looked broken. Here each page is waited on until the
  // probe queue for it is empty (or a hard cap), because the requirement is
  // "载入的时候就要探测到" — eventually complete, not instantaneously complete.
  //
  // `pending` comes from the probe module itself, so this measures the real
  // queue rather than a guess at how long it ought to take.
  var out = { pages: [] };
  var CAP_MS = Number(window.__CAP_MS || 75000);
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var PAGES = [
    { id: 'sidebar-1-0', name: '推荐' },
    { id: 'sidebar-2-0', name: '真人剧' },
    { id: 'sidebar-3-0', name: '漫剧' },
    { id: 'sidebar-4-0', name: 'AI剧' },
    { id: 'sidebar-6-0', name: '观看记录' }
  ];

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  function report() {
    return (typeof window.__hongguoAspectReport === 'function')
      ? window.__hongguoAspectReport() : null;
  }

  // Wait until the badge count stops growing.
  //
  // NOT `pending === 0`, and here is why: `pending` describes whatever item
  // list the probe is currently holding, which lags the screen by one render.
  // Two category pages in a row both have 72 cards, so the probe's own
  // sampled-count check happily announces "this page is ready" while it is
  // still looking at the PREVIOUS page — and the wait returns instantly with
  // 0 badges. Counting badges in the DOM and stopping when they stop climbing
  // has no such ambiguity: it measures what the viewer sees.
  function waitStable() {
    var t0 = Date.now();
    var lastTagged = -1;
    var lastCards = -1;
    var stable = 0;
    function poll() {
      var cards = document.querySelectorAll('[data-focus-id^="content-"]').length;
      var tagged = document.querySelectorAll('.video-card-aspect').length;
      if (cards !== lastCards) { lastCards = cards; stable = 0; lastTagged = -1; }
      if (tagged === lastTagged) stable += 1;
      else { stable = 0; lastTagged = tagged; }

      var elapsed = Date.now() - t0;
      // 20 quiet samples = 14s with no new badge. A cold 72-card page takes
      // ~30s to fill, during which it adds badges every few seconds; 8 samples
      // (5.6s) declared "done" mid-fill and reported 0/72.
      // Hold until every card is badged or the budget runs out. A quiet-spell
      // heuristic ended the wait mid-fill whenever the upstream was slow, which
      // reported 0/72 for a page that was still working.
      var done = (cards > 0 && tagged >= cards) || elapsed > CAP_MS;
      if (done) {
        return Promise.resolve({ waited: elapsed, pending: (report() || {}).pending, report: report() });
      }
      return sleep(700).then(poll);
    }
    return poll();
  }

  function visit(i) {
    if (i >= PAGES.length) return Promise.resolve();
    var p = PAGES[i];
    var nav = document.querySelector('[data-focus-id="' + p.id + '"]');
    if (nav) nav.click();
    // 3s before measuring: a category page needs a network round-trip to render
    // cards, and the probe starts 250ms after that render.
    return sleep(3000).then(function () {
      return waitStable().then(function (w) {
        var cards = document.querySelectorAll('[data-focus-id^="content-"]');
        var tagged = document.querySelectorAll('.video-card-aspect').length;
        out.pages.push({
          page: p.name,
          cards: cards.length,
          tagged: tagged,
          waitedMs: w.waited,
          pendingLeft: w.pending,
          report: w.report
        });
        return visit(i + 1);
      });
    });
  }

  return ensureClean().then(function () {
    return visit(0);
  }).then(function () {
    var withCards = out.pages.filter(function (p) { return p.cards > 0; });
    out.summary = {
      pagesWithCards: withCards.length,
      fullyTagged: withCards.filter(function (p) { return p.tagged === p.cards; }).length,
      totalCards: withCards.reduce(function (a, p) { return a + p.cards; }, 0),
      totalTagged: withCards.reduce(function (a, p) { return a + p.tagged; }, 0),
      slowestPageMs: Math.max.apply(null, withCards.map(function (p) { return p.waitedMs; }))
    };
    out.ok = out.summary.pagesWithCards > 0 &&
      out.summary.fullyTagged === out.summary.pagesWithCards;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
