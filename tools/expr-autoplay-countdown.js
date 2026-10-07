(function () {
  // End-of-episode hand-off, measured on the real media element.
  //
  // Episode identity is read from the <video> src, NOT from .player-subtitle:
  // that node only exists while the control shelf is visible, so it vanishes
  // after the 5s auto-hide and makes a naive probe report a false "advanced".
  //
  // Expected: real finish -> .player-nextup banner appears -> ~3s later the
  // video src changes to the next episode.
  var out = { samples: [] };
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

  return ensureClean().then(function () {
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
  }).then(function () {
    return waitMeta(0);
  }).then(function (v) {
    if (!v) throw new Error('no video');
    out.duration = Math.round(v.duration * 100) / 100;
    out.epIdStart = epId();
    var target = Math.max(0, v.duration - 2.0);
    try { v.currentTime = target; } catch (e) {}
    try { v.play(); } catch (e) {}
    out.seekedTo = Math.round(target * 100) / 100;
    return null;
  }).then(function () {
    var t0 = Date.now();
    var bannerAt = null;
    var changeAt = null;
    function sample() {
      var id = epId();
      var b = banner();
      var v = vid();
      if (b && bannerAt === null) { bannerAt = Date.now(); out.bannerFirstText = b; }
      if (id !== out.epIdStart && changeAt === null) changeAt = Date.now();
      out.samples.push({
        t: Date.now() - t0,
        ep: id === out.epIdStart ? 'same' : 'CHANGED',
        banner: b ? b.replace(/本集播放完毕\s*/, '') : null,
        ct: v ? Math.round((v.currentTime || 0) * 10) / 10 : null,
        err: v && v.error ? v.error.code : null
      });
      if (changeAt !== null || Date.now() - t0 > 14000) {
        out.bannerSeen = bannerAt !== null;
        out.advanced = changeAt !== null;
        out.bannerToAdvanceMs = (bannerAt && changeAt) ? changeAt - bannerAt : null;
        out.epIdAfter = id;
        return Promise.resolve();
      }
      return sleep(250).then(sample);
    }
    return sample();
  }).then(function () {
    out.endDiag = window.__playerEndDiag || null;
    // Keep the sample list readable: only transitions + a little context.
    var trimmed = [];
    var prevKey = null;
    out.samples.forEach(function (s) {
      var k = s.ep + '|' + s.banner;
      if (k !== prevKey) { trimmed.push(s); prevKey = k; }
    });
    out.transitions = trimmed;
    out.sampleCount = out.samples.length;
    delete out.samples;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    out.endDiag = window.__playerEndDiag || null;
    delete out.samples;
    return JSON.stringify(out, null, 2);
  });
})()
