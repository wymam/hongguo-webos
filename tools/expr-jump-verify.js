(function () {
  // Verify the jump-recovery fix and capture the jump's anatomy.
  //
  // The bug: currentTime silently leaps from ~9s to the end (~98s) with no
  // `seeking` event, then `ended` fires and the episode auto-advances. The fix
  // intercepts a >5s forward jump in `timeupdate` and restores the position.
  //
  // This probe plays ~35s of a fresh episode at 1x and reports: every jump
  // detected, the buffered/seekable ranges AT the jump, whether recovery
  // restored continuity, and where playback ended up.
  var out = { events: [], jumps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() {
    var v = vid(); if (!v) return null;
    var s = v.currentSrc || v.src || '';
    var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop();
  }
  function ranges(r) {
    var outr = [];
    try { for (var i = 0; i < r.length; i++) outr.push([Math.round(r.start(i) * 10) / 10, Math.round(r.end(i) * 10) / 10]); } catch (e) {}
    return outr;
  }
  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function waitPlayer(n) {
    if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(1000);
    if (n > 25) return sleep(300);
    return sleep(800).then(function () { return waitPlayer(n + 1); });
  }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    // A different card than previous runs, to dodge any cached stream handle.
    click('content-0-0');
    return sleep(3500);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    if (!cells.length) throw new Error('no episodes');
    cells[0].click();
    return waitPlayer(0);
  }).then(function () {
    var v = vid();
    if (!v) throw new Error('no video');
    out.startEp = epId();
    out.startDuration = v.duration;
    window.__playerEndDiag = [];
    var lastCt = 0;

    function onTu() {
      var ct = v.currentTime || 0;
      var d = ct - lastCt;
      if (lastCt > 0 && d > 5) {
        out.jumps.push({
          from: Math.round(lastCt * 100) / 100,
          to: Math.round(ct * 100) / 100,
          buffered: ranges(v.buffered),
          seekable: ranges(v.seekable),
          ready: v.readyState,
          net: v.networkState,
          err: v.error ? v.error.code : null
        });
      }
      lastCt = ct;
    }
    v.addEventListener('timeupdate', onTu);
    ['ended', 'seeking', 'seeked', 'waiting', 'stalled', 'error'].forEach(function (t) {
      v.addEventListener(t, function () {
        out.events.push({ t: Date.now() % 1000000, tag: t, ct: Math.round((v.currentTime || 0) * 100) / 100 });
      });
    });

    var t0 = Date.now();
    var ep0 = out.startEp;
    function poll() {
      var id = epId();
      var ct = vid() ? vid().currentTime || 0 : 0;
      if ((id && id !== ep0) || Date.now() - t0 > 35000) {
        out.endedByAdvance = id !== ep0;
        out.finalCt = Math.round(ct * 100) / 100;
        out.finalEp = id;
        out.elapsedMs = Date.now() - t0;
        out.endDiag = window.__playerEndDiag || [];
        out.verdict = {
          jumpsDetected: out.jumps.length,
          recovered: out.jumps.length > 0 && !out.endedByAdvance,
          continuityHeld: !out.endedByAdvance && out.finalCt > 20
        };
        return JSON.stringify(out, null, 2);
      }
      return sleep(400).then(poll);
    }
    return poll();
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
