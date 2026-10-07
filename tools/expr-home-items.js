(function () {
  // The home feed never gets an orientation badge. Suspect: its rows do not
  // carry `vid_list[0]` the way category rows do, so there is no episode id to
  // probe. Print the raw keys of a few home items to settle it.
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
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(4000);
  }).then(function () {
    var items = (window.__hongguoGridItems && window.__hongguoGridItems()) || [];
    out.homeItems = items.length;
    out.homeKeys = items.length ? Object.keys(items[0]) : [];
    out.homeSample = items.slice(0, 3).map(function (i) {
      var o = {};
      Object.keys(i).forEach(function (k) {
        var v = i[k];
        o[k] = Array.isArray(v) ? '[' + v.length + ']' : (typeof v === 'object' ? '{obj}' : String(v).slice(0, 24));
      });
      return o;
    });
    out.homeWithFirstEpisode = items.filter(function (i) { return !!(i && i.firstEpisode); }).length;
    return sleep(500);
  }).then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]');
    if (nav) nav.click();
    return sleep(4000);
  }).then(function () {
    var items = (window.__hongguoGridItems && window.__hongguoGridItems()) || [];
    out.catItems = items.length;
    out.catKeys = items.length ? Object.keys(items[0]) : [];
    out.catWithFirstEpisode = items.filter(function (i) { return !!(i && i.firstEpisode); }).length;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
