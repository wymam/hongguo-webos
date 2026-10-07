(function () {
  // Round 13, item 4 — "所有剧集在载入的时候就要探测到画面是竖还是横，不要出现
  // 某些页面有标识、有些页面没标识".
  //
  // So this walks EVERY grid page the app has and compares, per page:
  //   cards rendered  vs  cards actually carrying a .video-card-aspect tag
  // Both numbers come from the real DOM, because "some pages have it and some
  // don't" is a rendering claim, not an API claim.
  var out = { pages: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var PAGES = [
    { id: 'sidebar-1-0', name: '推荐' },
    { id: 'sidebar-2-0', name: '真人剧' },
    { id: 'sidebar-3-0', name: '漫剧' },
    { id: 'sidebar-4-0', name: 'AI剧' },
    { id: 'sidebar-5-0', name: '收藏' },
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

  function measure(name) {
    var cards = [].slice.call(document.querySelectorAll('[data-focus-id^="content-"]'));
    var tagged = cards.filter(function (c) { return !!c.querySelector('.video-card-aspect'); });
    var marks = {
      portrait: document.querySelectorAll('.video-card-aspect.portrait').length,
      landscape: document.querySelectorAll('.video-card-aspect.landscape').length
    };
    var rep = null;
    if (typeof window.__hongguoAspectReport === 'function') {
      try { rep = window.__hongguoAspectReport(); } catch (e) { rep = { error: String(e.message || e) }; }
    }
    out.pages.push({
      page: name,
      cards: cards.length,
      tagged: tagged.length,
      tagRatio: cards.length ? Math.round((tagged.length / cards.length) * 100) / 100 : null,
      marks: marks,
      report: rep
    });
    return null;
  }

  function visit(i) {
    if (i >= PAGES.length) return Promise.resolve();
    var p = PAGES[i];
    var nav = document.querySelector('[data-focus-id="' + p.id + '"]');
    if (nav) nav.click();
    // The probe runs 250ms after the grid renders and then talks to the
    // service, so give it a generous window before measuring.
    return sleep(6000).then(function () {
      measure(p.name);
      return visit(i + 1);
    });
  }

  return ensureClean().then(function () {
    return visit(0);
  }).then(function () {
    out.summary = (function () {
      var withCards = out.pages.filter(function (p) { return p.cards > 0; });
      var full = withCards.filter(function (p) { return p.tagged === p.cards; });
      return {
        pagesWithCards: withCards.length,
        pagesFullyTagged: full.length,
        pagesUntagged: withCards.filter(function (p) { return p.tagged === 0; }).map(function (p) { return p.page; }),
        totalCards: withCards.reduce(function (a, p) { return a + p.cards; }, 0),
        totalTagged: withCards.reduce(function (a, p) { return a + p.tagged; }, 0)
      };
    })();
    out.allPagesTagged = out.summary.pagesWithCards > 0 &&
      out.summary.pagesFullyTagged === out.summary.pagesWithCards;
    out.ok = out.allPagesTagged && out.summary.totalTagged > 0;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
