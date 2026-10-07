(function () {
  // Why does a 72-card page show only 2 badges? Compare, on the live page:
  //   - the series ids the grid is showing
  //   - the series ids currently stored in the aspect map
  //   - whether those items even carry a firstEpisode to probe with
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]');
    if (nav) nav.click();
    return sleep(6000);
  }).then(function () {
    var items = (window.__hongguoGridItems && window.__hongguoGridItems()) || [];
    out.gridItems = items.length;
    out.hasGridItemsHook = typeof window.__hongguoGridItems === 'function';
    out.hasReportHook = typeof window.__hongguoAspectReport === 'function';
    out.sample = items.slice(0, 6).map(function (i) {
      return { id: String(i && i.id), firstEpisode: String((i && i.firstEpisode) || ''), title: (i && i.title || '').slice(0, 12) };
    });
    out.withFirstEpisode = items.filter(function (i) { return !!(i && i.firstEpisode); }).length;

    var map = {};
    try { map = JSON.parse(localStorage.getItem('hongguo_aspect') || '{}') || {}; } catch (e) { map = {}; }
    var keys = Object.keys(map);
    out.storageKey = 'hongguo_aspect';
    out.mapSize = keys.length;
    out.mapKeysSample = keys.slice(0, 8);

    var ids = {};
    items.forEach(function (i) { if (i && i.id) ids[String(i.id)] = true; });
    out.overlap = keys.filter(function (k) { return ids[k]; }).length;
    out.mapKeysAlsoOnPage = keys.filter(function (k) { return ids[k]; }).slice(0, 8);

    out.report = (typeof window.__hongguoAspectReport === 'function')
      ? window.__hongguoAspectReport() : null;
    out.domTagged = document.querySelectorAll('.video-card-aspect').length;
    out.domCards = document.querySelectorAll('[data-focus-id^="content-"]').length;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
