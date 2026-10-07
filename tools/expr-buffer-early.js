(function () {
  // Dense sampling of the FIRST 20s to see exactly how Chromium fills the
  // buffer and where it runs dry (the startup 卡顿).
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function waitPlayer(n) { if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(800); if (n > 25) return sleep(300); return sleep(700).then(function () { return waitPlayer(n + 1); }); }

  function ranges(v) {
    var b = v.buffered, arr = [];
    for (var i = 0; i < b.length; i++) arr.push([Math.round(b.start(i) * 10) / 10, Math.round(b.end(i) * 10) / 10]);
    return arr;
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
    out.duration = Math.round((v.duration || 0) * 100) / 100;
    var waiting = 0, waitingAt = [];
    v.addEventListener('waiting', function () { waiting++; waitingAt.push(Math.round(v.currentTime * 10) / 10); });
    try { v.currentTime = 0; } catch (e) {}
    try { v.playbackRate = 2; } catch (e) {}
    try { v.play(); } catch (e) {}

    var t0 = Date.now(); var samples = [];
    function sample() {
      var vv = vid();
      var ct = vv.currentTime;
      var rs = ranges(vv);
      var lastEnd = rs.length ? rs[rs.length - 1][1] : 0;
      samples.push({ t: Math.round((Date.now() - t0) / 100) / 10, ct: Math.round(ct * 10) / 10, ready: vv.readyState, ranges: rs, bufEnd: Math.round(lastEnd * 10) / 10 });
      if (Date.now() - t0 > 22000) {
        try { vv.playbackRate = 1; } catch (e) {}
        out.waiting = waiting; out.waitingAt = waitingAt;
        out.samples = samples;
        return JSON.stringify(out, null, 2);
      }
      return sleep(200).then(sample);
    }
    return sample();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
