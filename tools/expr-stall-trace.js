(function () {
  // 卡顿现场取证：UI 播放器 1x 完整播放一集，记录
  //  1) waiting/stalled/playing 事件（带墙钟，与服务端 mediaLog.at 同一时钟，可直接对表）
  //  2) 每 300ms 采样 {wall, ct, ahead(缓冲余量), readyState}
  //  3) 主线程 jank 探测：50ms setTimeout 链的实际漂移，>100ms 记一次（主线程被占）
  // 最后附带服务端 mediaLog（含 resolveMs/fetchMs/decryptMs/serveMs）。
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() { var v = vid(); if (!v) return null; var s = v.currentSrc || v.src || ''; var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop(); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function waitPlayer(n) { if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(1000); if (n > 25) return sleep(300); return sleep(800).then(function () { return waitPlayer(n + 1); }); }

  // 主线程 jank 探测（先于播放启动，覆盖整个播放期）
  var jank = [];
  var jankStop = false;
  (function loop(prev) {
    if (jankStop) return;
    setTimeout(function () {
      var now = performance.now();
      var drift = now - prev - 50;
      if (drift > 100) jank.push({ wall: Date.now(), drift: Math.round(drift) });
      loop(now);
    }, 50);
  })(performance.now());

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
    out.playWallStart = Date.now();
    var events = [];
    ['waiting', 'stalled', 'playing', 'canplay', 'seeking', 'seeked', 'suspend', 'progress'].forEach(function (name) {
      if (name === 'progress') return; // 太频繁，不记
      v.addEventListener(name, function () {
        events.push({ wall: Date.now(), ev: name, ct: Math.round(v.currentTime * 100) / 100 });
      });
    });
    try { v.playbackRate = 1; } catch (e) {}
    try { v.play(); } catch (e) {}

    var t0 = Date.now(); var prevCt = 0; var lastT = t0;
    var stalls = 0, gapAt = [];
    var samples = [];
    var minAhead = 999;
    function aheadOf(vv) {
      var ct = vv.currentTime, b = vv.buffered;
      for (var i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.05 && b.end(i) > ct) return b.end(i) - ct;
      return 0;
    }
    function finish(done) {
      jankStop = true;
      out.advanced = done === 'advanced';
      out.finished = done === 'ended';
      out.stalls = stalls; out.gapAt = gapAt;
      out.minAhead = Math.round(minAhead * 10) / 10;
      out.events = events;
      out.jank = jank;
      // 采样瘦身：缓冲余量 <3s 的全留（卡顿现场），其余每 10 个抽 1
      out.samples = samples.filter(function (s, i) { return s.ahead < 3 || i % 10 === 0; });
      // 拉服务端 mediaLog 对表
      return window.__hongguoApi.getDiagnostics().then(function (diag) {
        var log = (diag && diag.mediaLog) || [];
        // 只留本集时间窗内的
        var t1 = out.playWallStart - 5000, t2 = Date.now() + 2000;
        out.mediaLog = log.filter(function (e) { return e.at >= t1 && e.at <= t2; });
        out.errors = (diag && diag.errors) || [];
        return JSON.stringify(out, null, 1);
      }).catch(function () { return JSON.stringify(out, null, 1); });
    }
    function sample() {
      var vv = vid(); var ct = vv ? vv.currentTime : 0; var now = Date.now();
      var a = vv ? aheadOf(vv) : 0;
      if (a < minAhead) minAhead = a;
      samples.push({ wall: now, ct: Math.round(ct * 10) / 10, ahead: Math.round(a * 10) / 10, rs: vv ? vv.readyState : -1 });
      if (now - lastT >= 1000) {
        var dt = ct - prevCt;
        if (dt < 0.15 && ct > 1 && ct < (vv.duration || 999) - 3) { stalls++; gapAt.push(Math.round(ct * 10) / 10); }
        prevCt = ct; lastT = now;
      }
      var id = epId();
      if (id !== out.startEp && id !== null) return finish('advanced');
      if (ct >= (vv.duration || 0) - 0.5 && (vv.duration || 0) > 0) return finish('ended');
      if (Date.now() - t0 > 150000) return finish('timeout');
      return sleep(300).then(sample);
    }
    return sample();
  }).catch(function (e) { jankStop = true; out.error = String((e && e.message) || e); return JSON.stringify(out, null, 1); });
})()
