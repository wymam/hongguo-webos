(function () {
  // Issue #2 hunt: "还存在播放失败的情况".
  //
  // The service reports zero errors, so this exercises the paths most likely to
  // fail in the field and records exactly where a failure occurs:
  //   * cold start of an episode that has never been streamed
  //   * several different episodes in a row (each a fresh upstream resolve)
  //   * a mid-playback seek (new Range window)
  //   * the same episode twice (cache vs cold)
  var out = { runs: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  function media() {
    var v = document.querySelector('video');
    if (!v) return { present: false };
    return {
      present: true,
      src: (v.currentSrc || v.src || '').split('/').pop(),
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      err: v.error ? { code: v.error.code, message: v.error.message } : null,
      currentTime: Math.round((v.currentTime || 0) * 10) / 10,
      duration: Math.round((v.duration || 0) * 10) / 10,
      bufferedEnd: v.buffered && v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) * 10) / 10 : 0,
      // Is the UI showing the failure panel?
      errorPanel: !!document.querySelector('.player-error'),
      errorText: (document.querySelector('.player-error p') || {}).textContent || null
    };
  }

  function waitPlayable(maxMs) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        var m = media();
        if (m.present && (m.readyState >= 2 || m.errorPanel || (m.err && m.err.code))) return resolve(Date.now() - t0);
        if (Date.now() - t0 > maxMs) return resolve(-1);
        setTimeout(tick, 300);
      })();
    });
  }

  function startEpisode(epIndex) {
    // Back out of the player first if one is open.
    var back = document.querySelector('[data-focus-id="player-back-0"]');
    if (back) back.click();
    return sleep(1400).then(function () {
      var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
      if (!cells.length) return null;
      var target = cells[epIndex] || cells[0];
      var id = target.getAttribute('data-focus-id');
      target.click();
      return sleep(1200).then(function () { return id; });
    });
  }

  function testEpisode(epIndex, label) {
    return startEpisode(epIndex).then(function (id) {
      if (!id) { out.runs.push({ label: label, ep: id, verdict: 'NO_CELL' }); return; }
      return waitPlayable(25000).then(function (ms) {
        var m = media();
        out.runs.push({
          label: label,
          ep: id,
          waitMs: ms,
          src: m.src,
          readyState: m.readyState,
          networkState: m.networkState,
          err: m.err,
          errorPanel: m.errorPanel,
          errorText: m.errorText,
          duration: m.duration,
          bufferedEnd: m.bufferedEnd,
          verdict: m.errorPanel ? 'UI_ERROR' : (m.err ? 'MEDIA_ERR_' + m.err.code : (m.readyState >= 2 ? 'PLAYABLE' : 'NOT_READY'))
        });
        return sleep(1500);
      });
    });
  }

  // Get to a detail page with episodes.
  return Promise.resolve()
    .then(function () {
      if (document.querySelector('[data-focus-id^="episode-"]')) return null;
      var cards = document.querySelectorAll('.video-card');
      if (!cards.length) {
        if (window.__hongguoFocus) window.__hongguoFocus.set('sidebar-1-0');
        return sleep(400).then(function () {
          key('Enter');
          return sleep(4000).then(function () {
            var c = document.querySelectorAll('.video-card');
            if (c.length) c[0].click();
            return sleep(4000);
          });
        });
      }
      cards[0].click();
      return sleep(4000);
    })
    .then(function () { return testEpisode(0, 'ep-1-cold'); })
    .then(function () { return testEpisode(1, 'ep-2'); })
    .then(function () { return testEpisode(2, 'ep-3'); })
    .then(function () { return testEpisode(5, 'ep-6'); })
    .then(function () { return testEpisode(0, 'ep-1-warm'); })
    .then(function () {
      // Force a cold re-resolve of the same episode via the retry path.
      var v = document.querySelector('video');
      if (v) {
        out.seekTest = { before: media() };
        try { v.currentTime = Math.max(1, (v.duration || 60) * 0.75); } catch (e) { out.seekTest.seekThrew = String(e); }
        return sleep(4000).then(function () {
          out.seekTest.after = media();
        });
      }
      return null;
    })
    .then(function () {
      var bad = out.runs.filter(function (r) { return r.verdict !== 'PLAYABLE'; });
      out.summary = {
        total: out.runs.length,
        playable: out.runs.filter(function (r) { return r.verdict === 'PLAYABLE'; }).length,
        failed: bad.length,
        failures: bad.map(function (r) { return { label: r.label, verdict: r.verdict, err: r.err, errorText: r.errorText }; })
      };
      return JSON.stringify(out, null, 2);
    })
    .catch(function (e) { out.error = String(e && e.message || e); return JSON.stringify(out, null, 2); });
})()
