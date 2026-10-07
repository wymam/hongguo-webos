(function () {
  // Real 1x playback, instrumented to catch "plays a few seconds, then jumps
  // to the end and advances". Every media event and a 300ms position sample are
  // logged, so if the box ever teleports the timeline the trail is visible.
  var out = { events: [], samples: [], endDiag: null };
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
  function ev(tag) {
    var v = vid();
    out.events.push({
      t: Date.now() % 1000000, tag: tag,
      ct: v ? Math.round((v.currentTime || 0) * 100) / 100 : null,
      dur: v ? (Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : String(v.duration)) : null,
      ready: v ? v.readyState : null
    });
    if (out.events.length > 400) out.events.shift();
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
    click('content-1-0') || click('content-0-0');
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

    ['loadedmetadata', 'durationchange', 'timeupdate', 'ended', 'seeking', 'seeked',
     'waiting', 'stalled', 'playing', 'pause', 'error', 'canplay', 'loadeddata'].forEach(function (t) {
      v.addEventListener(t, function () { ev(t); });
    });

    // Sample at 300ms for the position trace.
    var sampling = true;
    (function sampleLoop() {
      if (!sampling) return;
      var vv = vid();
      if (vv) {
        out.samples.push({
          t: Date.now() % 1000000, ct: Math.round((vv.currentTime || 0) * 100) / 100,
          dur: Number.isFinite(vv.duration) ? Math.round(vv.duration * 100) / 100 : String(vv.duration),
          buf: (function () { try { var r = vv.buffered; return r && r.length ? Math.round(r.end(r.length - 1)) : 0; } catch (e) { return 0; } })()
        });
        if (out.samples.length > 600) out.samples.shift();
      }
      setTimeout(sampleLoop, 300);
    })();

    // Stop after the episode changes (auto-advance) or 110s.
    var t0 = Date.now();
    function watchChange() {
      var id = epId();
      if ((id && id !== out.startEp) || Date.now() - t0 > 110000) {
        sampling = false;
        out.endEp = id;
        out.changed = id !== out.startEp;
        out.elapsedMs = Date.now() - t0;
        return finish();
      }
      return sleep(500).then(watchChange);
    }
    function finish() {
      out.endDiag = window.__playerEndDiag || [];
      // Compress: keep only transitions in samples + every 15th.
      var trimmed = [];
      out.samples.forEach(function (s, i) {
        if (i % 12 === 0) trimmed.push(s);
      });
      out.samplesTrimmed = trimmed;
      out.sampleCount = out.samples.length;
      delete out.samples;
      return JSON.stringify(out, null, 2);
    }
    return watchChange();
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
