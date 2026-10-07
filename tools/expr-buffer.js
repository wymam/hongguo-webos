(function () {
  // Watch the player's buffer during real playback (2x rate to stress the
  // pipeline) and report whether it ever runs dry — i.e. the direct evidence
  // of the "卡顿" the user sees.
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() { var v = vid(); if (!v) return null; var s = v.currentSrc || v.src || ''; var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop(); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function waitPlayer(n) { if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(1000); if (n > 25) return sleep(300); return sleep(800).then(function () { return waitPlayer(n + 1); }); }

  function bufferAhead(v) {
    var ct = v.currentTime, b = v.buffered;
    if (!b || !b.length) return 0;
    for (var i = 0; i < b.length; i++) {
      if (b.start(i) <= ct + 0.05 && b.end(i) > ct) return b.end(i) - ct;
    }
    // currentTime not covered by any range = a gap right at the playhead
    var nearest = 0;
    for (var j = 0; j < b.length; j++) { if (b.end(j) - ct > nearest) nearest = b.end(j) - ct; }
    return nearest;
  }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]'); if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    click('content-1-0') || click('content-0-0'); return sleep(3500);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]'); if (!cells.length) throw new Error('no episodes');
    cells[0].click(); return waitPlayer(0);
  }).then(function () {
    var v = vid(); if (!v) throw new Error('no video');
    out.startEp = epId(); out.duration = Math.round((v.duration || 0) * 100) / 100;

    var waiting = 0, stalled = 0, waitingAt = [], gapAt = [];
    function onWaiting() { waiting++; waitingAt.push(Math.round(v.currentTime * 10) / 10); }
    function onStalled() { stalled++; }
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onStalled);

    try { v.currentTime = 0; } catch (e) {}
    try { v.playbackRate = 2; } catch (e) { out.rateSet = false; }
    out.rate = v.playbackRate;
    try { v.play(); } catch (e) {}

    var t0 = Date.now();
    var minAhead = 999; var samples = []; var lastAhead = -1;
    var prevCt = 0; var stalls = 0; var lastSample = Date.now();

    function sample() {
      var vv = vid();
      var ct = vv ? vv.currentTime : 0;
      var ahead = vv ? bufferAhead(vv) : 0;
      if (ahead < minAhead) minAhead = ahead;
      var now = Date.now();
      // detect a playback stall: currentTime barely moved but clock advanced
      if (now - lastSample >= 1000) {
        var dt = ct - prevCt;
        samples.push({ t: Math.round((now - t0) / 1000), ct: Math.round(ct * 10) / 10, ahead: Math.round(ahead * 10) / 10 });
        if (dt < 0.3 && ct > 1 && ct < (vv.duration || 999) - 3) {
          stalls++;
          if (stalls <= 5) gapAt.push(Math.round(ct * 10) / 10);
        }
        prevCt = ct; lastSample = now;
      }
      if (waiting > 0 && waitingAt.length && !out.firstWaitingAt) out.firstWaitingAt = waitingAt[0];
      if (Date.now() - t0 > 45000) {
        v.removeEventListener('waiting', onWaiting);
        v.removeEventListener('stalled', onStalled);
        try { v.playbackRate = 1; } catch (e) {}
        out.waiting = waiting; out.stalled = stalled;
        out.minBufferAhead = Math.round(minAhead * 10) / 10;
        out.rate = v.playbackRate;
        out.samples = samples;
        out.stallCount = stalls;
        out.gapAt = gapAt;
        out.verdict = {
          everRanDry: minAhead <= 0.2,
          hadWaiting: waiting > 0,
          hadStall: stalls > 0
        };
        out.ok = !out.verdict.hadWaiting && !out.verdict.hadStall;
        return JSON.stringify(out, null, 2);
      }
      return sleep(300).then(sample);
    }
    return sample();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
