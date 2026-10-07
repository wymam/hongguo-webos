(function () {
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function waitPlayer(n) { if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(800); if (n > 25) return sleep(300); return sleep(700).then(function () { return waitPlayer(n + 1); }); }
  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]'); if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    click('content-1-0') || click('content-0-0'); return sleep(3500);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]'); if (!cells.length) throw new Error('no episodes');
    cells[0].click(); return waitPlayer(0);
  }).then(function () {
    var v = vid();
    try { v.playbackRate = 2; } catch (e) {}
    try { v.play(); } catch (e) {}
    return sleep(20000);  // let it play (and stutter) for 20s
  }).then(function () {
    try { var v = vid(); v.pause(); } catch (e) {}
    return window.__hongguoApi.getDiagnostics();
  }).then(function (d) {
    var log = (d && d.mediaLog) || [];
    out.media = d && d.media;
    out.mediaLogLen = log.length;
    // classify requests
    var short = 0, ok = 0, err503 = 0;
    for (var i = 0; i < log.length; i++) {
      if (log[i].short) short++; else ok++;
    }
    out.shortReads = short; out.okSegments = ok;
    // 503s show up as errors (mediaStats.errors), not in mediaLog
    out.recentErrors = (d && d.recentErrors) || [];
    // show the timeline of requests: start offsets
    var starts = log.map(function (e) { return e.start; });
    out.reqStarts = starts.slice(0, 60);
    out.reqCount = starts.length;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
