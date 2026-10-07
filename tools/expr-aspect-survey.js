(function () {
  // Sample the REAL intrinsic dimensions across several series.
  //
  // The orientation feature is only useful if red-berry actually mixes portrait
  // and landscape footage. This opens the first episode of N different cards in
  // turn and records videoWidth/videoHeight, so we know (a) whether the tag will
  // ever read 竖, and (b) how reliably detection succeeds.
  //
  // Navigation is defensive: the app may be sitting on any page when the probe
  // starts, so every round first returns to the home feed via the sidebar.
  var out = { probes: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  var store = window.__hongguoStorage || {};

  function onPlayer() { return !!document.querySelector('.player-root'); }

  function goHome() {
    // Leave the player if we are in it.
    if (onPlayer()) {
      var v = document.querySelector('video');
      if (v) { try { v.pause(); } catch (e) {} }
      click('player-back-0');
      return sleep(1800).then(goHomeToFeed);
    }
    return goHomeToFeed();
  }
  function goHomeToFeed() {
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(1800).then(function () {
      // Wait for grid cards.
      function w(n) {
        var c = document.querySelectorAll('[data-focus-id^="content-"]').length;
        if (c || n > 8) return Promise.resolve(c);
        return sleep(1000).then(function () { return w(n + 1); });
      }
      return w(0);
    });
  }

  function waitVideo(n) {
    var v = document.querySelector('.player-root video');
    if (v && v.videoWidth > 0 && v.videoHeight > 0) return Promise.resolve(v);
    if (n > 16) return Promise.resolve(v || null);
    return sleep(600).then(function () { return waitVideo(n + 1); });
  }

  function openRow1Card(i) {
    // content-1-<i> is the second grid row (first row is content-0-*).
    var id = 'content-1-' + i;
    if (!click(id)) return Promise.resolve('no-card:' + id);
    return sleep(2800).then(function () {
      var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
      if (!cells.length) return 'no-episodes';
      cells[0].click();
      return sleep(2500).then(function () { return 'ok'; });
    });
  }

  function loop(i) {
    if (i >= 5) return Promise.resolve();
    return goHome().then(function (cards) {
      out.probes.push({ i: i, gridCards: cards });
      return openRow1Card(i);
    }).then(function (st) {
      if (st !== 'ok') { out.probes[out.probes.length - 1].open = st; return; }
      return waitVideo(0).then(function (v) {
        var hist = store.getHistory ? store.getHistory() : [];
        var id = hist && hist.length ? String(hist[0].id) : null;
        var ent = id && store.getAspect ? store.getAspect(id) : null;
        var last = out.probes[out.probes.length - 1];
        last.seriesId = id;
        last.title = hist && hist.length ? hist[0].title : null;
        last.w = v ? v.videoWidth : null;
        last.h = v ? v.videoHeight : null;
        last.err = v && v.error ? v.error.code : null;
        last.stored = ent ? ent.aspect : null;
      });
    }).then(function () { return loop(i + 1); });
  }

  return loop(0).then(function () {
    var portrait = out.probes.filter(function (p) { return p.stored === 'portrait'; }).length;
    var landscape = out.probes.filter(function (p) { return p.stored === 'landscape'; }).length;
    out.summary = { total: out.probes.length, portrait: portrait, landscape: landscape };
    out.aspectMap = store.getAspectMap ? store.getAspectMap() : null;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    return JSON.stringify(out, null, 2);
  });
})()
