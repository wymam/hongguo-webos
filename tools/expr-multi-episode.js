(function () {
  // Round 13, item 6 — play 2-3 FULL episodes back to back and prove that a
  // hand-off only ever happens when an episode actually finished.
  //
  // This is the regression nobody wants back: "视频播放几秒钟后就自动跳到下一集".
  // The earlier probes tested the ended-handler with a synthetic `ended` event
  // (deterministic, but it never plays a whole file) or seeked to `duration-2`
  // (which can stall on the upstream and never really finish). Neither plays a
  // real episode end to end, so neither can answer "does it still jump early?".
  //
  // HOW A FULL EPISODE FITS IN A PROBE
  //   Playback is sped up (playbackRate) so a ~100s episode finishes in ~25s.
  //   The rate is VERIFIED first — if the box ignores it we fall back to
  //   seeking near the end rather than silently measuring 1x and timing out.
  //   The last 10% is played at 1x so the real end-of-media path fires.
  //
  // WHAT COUNTS AS A PREMATURE HANDOFF
  //   The episode id changes while currentTime is still far from duration.
  //   Everything else (banner, dwell, next id) is recorded as supporting
  //   evidence.
  var out = { episodes: [], rateProbe: null };
  var WANT_EPISODES = 3;
  var FAST = 4;

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
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function waitMeta(n) {
    var v = vid();
    if (v && v.videoWidth > 0 && v.duration > 0) return Promise.resolve(v);
    if (n > 30) return Promise.resolve(v || null);
    return sleep(700).then(function () { return waitMeta(n + 1); });
  }

  // Does playbackRate actually apply on this box?
  function checkRate() {
    var v = vid();
    if (!v) return Promise.resolve(false);
    var before = v.currentTime || 0;
    try { v.playbackRate = FAST; } catch (e) { return Promise.resolve(false); }
    var applied = v.playbackRate;
    try { v.play(); } catch (e) {}
    return sleep(3000).then(function () {
      var delta = (v.currentTime || 0) - before;
      out.rateProbe = { requested: FAST, applied: applied, advancedIn3s: Math.round(delta * 100) / 100 };
      // Expect roughly 3*FAST seconds of media in 3 wall-clock seconds.
      return applied >= FAST && delta > FAST * 3 * 0.5;
    });
  }

  // Watch one episode run to its end and hand over. Resolves on the handover
  // (or when the budget is exhausted).
  function watchEpisode(startId, durationMsBudget) {
    var t0 = Date.now();
    var bannerAt = null;
    var changeAt = null;
    var ctBefore = 0;
    var durBefore = 0;
    var maxCt = 0;
    var rec = { startId: startId };
    function sample() {
      var v = vid();
      var id = epId();
      var b = banner();
      if (v) {
        if (id === startId) {
          ctBefore = v.currentTime || 0;
          if (ctBefore > maxCt) maxCt = ctBefore;
          durBefore = v.duration || durBefore;
        }
      }
      if (b && bannerAt === null) { bannerAt = Date.now(); rec.bannerFirstText = b; }
      if (id !== startId && changeAt === null) { changeAt = Date.now(); rec.nextId = id; }

      if (changeAt !== null || Date.now() - t0 > durationMsBudget) {
        rec.advanced = changeAt !== null;
        rec.bannerSeen = bannerAt !== null;
        rec.bannerToAdvanceMs = (bannerAt && changeAt) ? changeAt - bannerAt : null;
        rec.ctAtHandover = Math.round((ctBefore || 0) * 100) / 100;
        rec.maxCt = Math.round(maxCt * 100) / 100;
        rec.duration = Math.round((durBefore || 0) * 100) / 100;
        rec.playedRatio = rec.duration ? Math.round((rec.maxCt / rec.duration) * 1000) / 1000 : null;
        rec.elapsedMs = Date.now() - t0;
        rec.premature = rec.advanced && rec.playedRatio !== null && rec.playedRatio < 0.9;
        return Promise.resolve(rec);
      }
      return sleep(400).then(sample);
    }
    return sample();
  }

  return ensureClean().then(function () {
    out.autoplaySetting = (function () {
      try { return JSON.parse(localStorage.getItem('hongguo_settings') || '{}'); } catch (e) { return null; }
    })();
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    click('content-1-0') || click('content-0-0');
    return sleep(3500);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    out.episodeCells = cells.length;
    if (!cells.length) throw new Error('no episode cells');
    cells[0].click();
    return waitMeta(0);
  }).then(function (v) {
    if (!v) throw new Error('no video');
    return checkRate().then(function (fastOk) {
      out.usingFastPlayback = fastOk;
      if (!fastOk) { try { v.playbackRate = 1; } catch (e) {} }
      return null;
    });
  }).then(function () {
    // ---- play WANT_EPISODES episodes end to end --------------------------
    function runOne(i) {
      if (i >= WANT_EPISODES) return Promise.resolve();
      var v = vid();
      if (!v) { out.episodes.push({ index: i, error: 'video gone' }); return Promise.resolve(); }
      var startId = epId();
      var dur = v.duration || 0;
      var budget = out.usingFastPlayback
        ? Math.min(150000, Math.round((dur / FAST) * 1000) + 70000)
        : 150000;

      window.__playerEndDiag = [];
      // Rewind to the start so this really is a full episode, then run it.
      try { v.currentTime = 0; } catch (e) {}
      try { v.playbackRate = out.usingFastPlayback ? FAST : 1; } catch (e) {}
      try { v.play(); } catch (e) {}

      // Slow back down for the closing stretch so the genuine end-of-media
      // path fires rather than a rate-dependent one.
      var slowAt = dur * 0.9;
      var slowed = false;
      var tick = setInterval(function () {
        var vv = vid();
        if (!vv) return;
        if (!slowed && vv.currentTime >= slowAt) {
          slowed = true;
          try { vv.playbackRate = 1; } catch (e) {}
        }
      }, 500);

      return watchEpisode(startId, budget).then(function (rec) {
        clearInterval(tick);
        rec.index = i + 1;
        rec.endDiag = window.__playerEndDiag || [];
        out.episodes.push(rec);
        // Let the next episode settle before watching it.
        return sleep(4000).then(function () { return waitMeta(0); });
      }).then(function () {
        return runOne(i + 1);
      });
    }
    return runOne(0);
  }).then(function () {
    out.endDiag = window.__playerEndDiag || [];
    var done = out.episodes.filter(function (e) { return !e.error; });
    out.verdict = {
      episodesPlayed: done.length,
      allAdvanced: done.length > 0 && done.every(function (e) { return e.advanced; }),
      nonePremature: done.every(function (e) { return !e.premature; }),
      allShowedBanner: done.every(function (e) { return e.bannerSeen; }),
      dwellOk: done.every(function (e) {
        return e.bannerToAdvanceMs >= 2500 && e.bannerToAdvanceMs <= 4500;
      }),
      ratios: done.map(function (e) { return e.playedRatio; }),
      dwells: done.map(function (e) { return e.bannerToAdvanceMs; }),
      ids: done.map(function (e) { return e.startId; }),
      nextIds: done.map(function (e) { return e.nextId; })
    };
    out.ok = out.verdict.episodesPlayed >= 2 && out.verdict.allAdvanced &&
      out.verdict.nonePremature && out.verdict.allShowedBanner;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
