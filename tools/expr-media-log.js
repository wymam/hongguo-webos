(function () {
  // Play a fresh episode and, at the moment a forward jump is detected, grab
  // the service's media request log. The goal is to see exactly what Range the
  // player asked for right around the jump and what we answered.
  var out = { jumps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() { var v = vid(); if (!v) return null; var s = v.currentSrc || v.src || ''; var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop(); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function waitPlayer(n) { if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(1000); if (n > 25) return sleep(300); return sleep(800).then(function () { return waitPlayer(n + 1); }); }

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
    out.startEp = epId(); out.startDuration = v.duration;
    window.__playerEndDiag = [];
    var lastCt = 0; var captured = false;
    function onTu() {
      var ct = v.currentTime || 0; var d = ct - lastCt;
      if (lastCt > 0 && d > 5 && !captured) {
        captured = true;
        out.jumps.push({ from: lastCt, to: ct, at: Date.now() });
        // fetch media log now
        if (window.__hongguoApi && window.__hongguoApi.getDiagnostics) {
          window.__hongguoApi.getDiagnostics().then(function (diag) {
            out.diag = { media: diag.media, mediaLog: diag.mediaLog, recentErrors: diag.recentErrors };
            out.done = true;
          }, function (e) { out.diagErr = String(e && e.message || e); out.done = true; });
        } else { out.diag = 'no getDiagnostics'; out.done = true; }
      }
      lastCt = ct;
    }
    v.addEventListener('timeupdate', onTu);
    var t0 = Date.now();
    function poll() {
      if (out.done || Date.now() - t0 > 40000) {
        out.finalCt = vid() ? Math.round((vid().currentTime || 0) * 100) / 100 : null;
        out.endDiag = window.__playerEndDiag || [];
        return JSON.stringify(out, null, 2);
      }
      return sleep(300).then(poll);
    }
    return poll();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
