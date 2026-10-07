(function () {
  // How fast IS one probe batch? Coverage is a throughput problem, so measure
  // it instead of guessing: N episodes in, wall-clock ms and hit-rate out.
  var out = { runs: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function timedRun(n, label) {
    var items = (window.__hongguoGridItems && window.__hongguoGridItems()) || [];
    var entries = [];
    var seen = {};
    for (var i = 0; i < items.length && entries.length < n; i++) {
      var it = items[i];
      if (!it || !it.firstEpisode || !it.id) continue;
      var k = String(it.id);
      if (seen[k]) continue;
      seen[k] = 1;
      entries.push({ seriesId: k, episodeId: String(it.firstEpisode) });
    }
    var t0 = Date.now();
    return window.__hongguoApi.getAspects(entries).then(function (r) {
      var ms = Date.now() - t0;
      out.runs.push({
        label: label, asked: entries.length, ms: ms,
        resolved: ((r && r.items) || []).length,
        msPerItem: entries.length ? Math.round(ms / entries.length) : null,
        sample: ((r && r.items) || []).slice(0, 3)
      });
      return null;
    }, function (e) {
      out.runs.push({ label: label, asked: entries.length, ms: Date.now() - t0, error: String((e && e.message) || e) });
      return null;
    });
  }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]');
    if (nav) nav.click();
    return sleep(5000);
  }).then(function () {
    if (!window.__hongguoApi || !window.__hongguoApi.getAspects) {
      out.error = 'getAspects not exposed on window.__hongguoApi';
      return null;
    }
    return timedRun(8, '8 episodes');
  }).then(function () {
    if (out.error) return null;
    return timedRun(24, '24 episodes (current batch size)');
  }).then(function () {
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
