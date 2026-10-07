(function () {
  // Why do a handful of cards never get a badge? Print the service's own
  // failure reasons (added to `aspects` for exactly this) plus how many page
  // items never had an episode id at all.
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
    var nav = document.querySelector('[data-focus-id="sidebar-3-0"]');
    if (nav) nav.click();
    return sleep(45000);   // let a cold page finish
  }).then(function () {
    var r = (typeof window.__hongguoAspectReport === 'function') ? window.__hongguoAspectReport() : null;
    out.report = r;
    var items = (window.__hongguoGridItems && window.__hongguoGridItems()) || [];
    out.items = items.length;
    out.withoutFirstEpisode = items.filter(function (i) { return !(i && i.firstEpisode); }).length;
    var map = {};
    try { map = JSON.parse(localStorage.getItem('hongguo_aspect') || '{}') || {}; } catch (e) {}
    out.stored = Object.keys(map).length;
    out.missing = items.filter(function (i) { return i && i.id && !map[String(i.id)]; })
      .slice(0, 10).map(function (i) {
        return { id: String(i.id), firstEpisode: String(i.firstEpisode || ''), title: (i.title || '').slice(0, 16) };
      });
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
