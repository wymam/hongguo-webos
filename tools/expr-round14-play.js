(function () {
  // Round 14, item 4 — real 1x playback of a full episode, watching for any
  // silent jump / premature end and confirming a clean hand-off to the next
  // episode (with the 3s dwell), i.e. the fixed "plays a few seconds then
  // skips to the end" bug must NOT happen.
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() { var v = vid(); if (!v) return null; var s = v.currentSrc || v.src || ''; var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop(); }
  function banner() { var el = document.querySelector('.player-nextup'); return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null; }
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
    window.__playerEndDiag = [];
    try { v.currentTime = 0; } catch (e) {}
    try { v.play(); } catch (e) {}

    var t0 = Date.now(); var bannerAt = null; var changeAt = null; var maxCt = 0; var durBefore = v.duration;
    function sample() {
      var vv = vid(); var id = epId();
      if (vv && id === out.startEp) { if (vv.currentTime > maxCt) maxCt = vv.currentTime; durBefore = vv.duration || durBefore; }
      var b = banner();
      if (b && bannerAt === null) { bannerAt = Date.now(); out.bannerText = b; }
      if (id !== out.startEp && changeAt === null) { changeAt = Date.now(); out.nextEp = id; }
      if (changeAt !== null || Date.now() - t0 > 130000) {
        out.advanced = changeAt !== null;
        out.maxCt = Math.round(maxCt * 100) / 100;
        out.playedRatio = durBefore ? Math.round((maxCt / durBefore) * 1000) / 1000 : null;
        out.bannerSeen = bannerAt !== null;
        out.bannerToAdvanceMs = (bannerAt && changeAt) ? changeAt - bannerAt : null;
        out.elapsedMs = Date.now() - t0;
        out.endDiag = window.__playerEndDiag || [];
        out.verdict = {
          noPrematureAdvance: !out.advanced || (out.playedRatio !== null && out.playedRatio >= 0.98),
          playedToEnd: out.playedRatio !== null && out.playedRatio >= 0.98,
          showedBanner: out.bannerSeen,
          dwellAbout3s: out.bannerToAdvanceMs !== null && out.bannerToAdvanceMs >= 2500 && out.bannerToAdvanceMs <= 4500,
          anySilentJump: (out.endDiag || []).some(function (e) { return e.wasSilentJump; })
        };
        out.ok = out.verdict.playedToEnd && out.verdict.noPrematureAdvance && !out.verdict.anySilentJump;
        return JSON.stringify(out, null, 2);
      }
      return sleep(500).then(sample);
    }
    return sample();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
