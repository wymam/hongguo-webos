(function () {
  // Deterministic test of the ended handler — the fix for
  // "播放几秒钟后就自动跳到下一集".
  //
  // Waiting for a real 100s episode to play out is flaky (a seek near the end
  // can stall on the upstream), so instead we CLEAR the diagnostic ring and
  // dispatch a synthetic `ended` on the real <video> with a controlled
  // currentTime. The handler reads exactly the same two fields it would in
  // production — video.duration and video.currentTime — so this exercises the
  // real guard.
  //
  //   Phase A: currentTime near duration  -> real finish -> 3s countdown -> advance
  //   Phase B: currentTime early          -> NOT a finish -> no banner, no advance
  var out = { phases: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() {
    var v = vid();
    if (!v) return null;
    var s = v.currentSrc || v.src || '';
    var m = /\/media\/(\d+)/.exec(s);
    return m ? m[1] : s.split('/').pop();
  }
  function banner() {
    var el = document.querySelector('.player-nextup');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null;
  }
  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(1000);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function waitMeta(n) {
    var v = vid();
    if (v && v.videoWidth > 0 && v.duration > 0) return Promise.resolve(v);
    if (n > 25) return Promise.resolve(v || null);
    return sleep(600).then(function () { return waitMeta(n + 1); });
  }

  // Watch for the banner and the episode change for `ms`, sampling at 200ms.
  function watch(startId, ms) {
    var t0 = Date.now();
    var rec = { bannerSeen: false, bannerFirstText: null, advanced: false, bannerToAdvanceMs: null, texts: [] };
    var bannerAt = null, changeAt = null;
    function sample() {
      var id = epId();
      var b = banner();
      if (b && bannerAt === null) { bannerAt = Date.now(); rec.bannerSeen = true; rec.bannerFirstText = b; }
      if (b && rec.texts.indexOf(b) < 0) rec.texts.push(b);
      if (id !== startId && changeAt === null) { changeAt = Date.now(); rec.advanced = true; }
      rec.elapsed = Date.now() - t0;
      if (changeAt !== null || Date.now() - t0 > ms) {
        rec.bannerToAdvanceMs = (bannerAt && changeAt) ? changeAt - bannerAt : null;
        rec.epIdAfter = id;
        return Promise.resolve(rec);
      }
      return sleep(200).then(sample);
    }
    return sample();
  }

  return ensureClean().then(function () {
    window.__playerEndDiag = [];       // only THIS run's events from here on
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(2000);
  }).then(function () {
    click('content-1-0') || click('content-0-0');
    return sleep(3000);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    if (!cells.length) throw new Error('no episodes');
    cells[0].click();
    return sleep(2500);
  }).then(function () { return waitMeta(0); })
  .then(function (v) {
    if (!v) throw new Error('no video');
    out.duration = Math.round(v.duration * 100) / 100;

    // ---------- Phase B first: a PREMATURE ended must not advance ----------
    window.__playerEndDiag = [];
    var idB = epId();
    try { v.pause(); } catch (e) {}
    try { v.currentTime = Math.min(5, (v.duration || 10) * 0.05); } catch (e) {}
    return sleep(400).then(function () {
      var v2 = vid();
      if (!v2) return null;
      v2.dispatchEvent(new Event('ended'));
      return watch(idB, 6000).then(function (rec) {
        rec.phase = 'B-premature';
        rec.firedAt = v2.currentTime;
        out.phases.push(rec);
        return null;
      });
    });
  }).then(function () {
    // ---------- Phase A: a REAL finish must dwell 3s, then advance ----------
    var v = vid();
    if (!v) throw new Error('video gone after phase B');
    window.__playerEndDiag = [];
    var idA = epId();
    try { v.pause(); } catch (e) {}
    try { v.currentTime = Math.max(0, (v.duration || 0) - 0.4); } catch (e) {}
    return sleep(500).then(function () {
      var v2 = vid();
      if (!v2) throw new Error('video gone');
      v2.dispatchEvent(new Event('ended'));
      return watch(idA, 9000);
    }).then(function (rec) {
      rec.phase = 'A-real-finish';
      out.phases.push(rec);
    });
  }).then(function () {
    out.endDiag = window.__playerEndDiag || [];
    out.autoplaySetting = (function () {
      try { return JSON.parse(localStorage.getItem('hongguo_settings') || '{}'); } catch (e) { return null; }
    })();
    var a = out.phases.find(function (p) { return p.phase === 'A-real-finish'; });
    var b = out.phases.find(function (p) { return p.phase === 'B-premature'; });
    out.verdict = {
      prematureDidNotAdvance: !!b && !b.advanced,
      prematureNoBanner: !!b && !b.bannerSeen,
      realFinishShowedBanner: !!a && a.bannerSeen,
      realFinishAdvanced: !!a && a.advanced,
      dwellMs: a ? a.bannerToAdvanceMs : null,
      dwellIsAbout3s: !!a && a.bannerToAdvanceMs >= 2500 && a.bannerToAdvanceMs <= 4200
    };
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    out.endDiag = window.__playerEndDiag || [];
    return JSON.stringify(out, null, 2);
  });
})()
