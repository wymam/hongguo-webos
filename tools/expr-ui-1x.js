(function () {
  // 通过 UI 播放器，1x 播放，统计 waiting/stall —— 对比纯 media 管线，定位是否 UI/React 开销导致卡顿。
  var out = {};
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
    out.startEp = epId(); out.duration = Math.round((v.duration || 0) * 100) / 100;
    var waiting = 0, waitingAt = [], stalls = 0, gapAt = [];
    v.addEventListener('waiting', function () { waiting++; waitingAt.push(Math.round(v.currentTime * 10) / 10); });
    try { v.playbackRate = 1; } catch (e) {}
    try { v.play(); } catch (e) {}

    var t0 = Date.now(); var prevCt = 0; var lastT = t0;
    function sample() {
      var vv = vid(); var ct = vv ? vv.currentTime : 0; var now = Date.now();
      if (now - lastT >= 1000) {
        var dt = ct - prevCt;
        if (dt < 0.15 && ct > 1 && ct < (vv.duration || 999) - 3) { stalls++; gapAt.push(Math.round(ct * 10) / 10); }
        prevCt = ct; lastT = now;
      }
      var id = epId();
      if ((id !== out.startEp && id !== null) || Date.now() - t0 > 60000) {
        out.advanced = id !== out.startEp;
        out.waiting = waiting; out.waitingAt = waitingAt; out.stalls = stalls; out.gapAt = gapAt;
        out.ok = waiting <= 1 && stalls === 0;
        return JSON.stringify(out, null, 2);
      }
      return sleep(300).then(sample);
    }
    return sample();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
