(function () {
  // 1x (真实播放速率) 完整监控一个固定 episode，统计 waiting/stall 与时间轴连续性。
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function vid() { return document.querySelector('.player-root video'); }
  function epId() { var v = vid(); if (!v) return null; var s = v.currentSrc || v.src || ''; var m = /\/media\/(\d+)/.exec(s); return m ? m[1] : s.split('/').pop(); }

  // 直接用 API 拿一个固定 episode，通过 mediaUrl 播放，避免每次点不同卡片。
  return window.__hongguoApi.getCategory('real-drama', 1, '', 50).then(function (cat) {
    var items = (cat && cat.items) || [];
    var ep = '';
    for (var i = 0; i < items.length; i++) { if (items[i] && items[i].firstEpisode) { ep = items[i].firstEpisode; break; } }
    if (!ep) throw new Error('no episode');
    out.episodeId = ep;
    var url = window.__hongguoApi.mediaUrl(ep);
    // 直接构造一个 video 元素测试（绕过 UI，纯媒体管线）
    var v = document.createElement('video');
    v.src = url; v.preload = 'auto';
    document.body.appendChild(v);
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
    return new Promise(function (resolve) { v.addEventListener('loadedmetadata', function () { resolve(v); }); v.addEventListener('error', function () { resolve(v); }); setTimeout(function () { resolve(v); }, 15000); });
  }).then(function (v) {
    out.duration = Math.round((v.duration || 0) * 100) / 100;
    var waiting = 0, waitingAt = [], stalls = 0, gapAt = [];
    v.addEventListener('waiting', function () { waiting++; waitingAt.push(Math.round(v.currentTime * 10) / 10); });
    v.play();

    var t0 = Date.now(); var prevCt = 0; var lastT = t0;
    var samples = [];
    var minAhead = 999;
    function ahead() {
      var ct = v.currentTime, b = v.buffered;
      for (var i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.05 && b.end(i) > ct) return b.end(i) - ct;
      return 0;
    }
    function sample() {
      var ct = v.currentTime, now = Date.now();
      var a = ahead(); if (a < minAhead) minAhead = a;
      if (now - lastT >= 1000) {
        var dt = ct - prevCt;
        samples.push({ t: Math.round((now - t0) / 1000), ct: Math.round(ct * 10) / 10, ahead: Math.round(a * 10) / 10 });
        if (dt < 0.15 && ct > 1 && ct < (v.duration || 999) - 3) { stalls++; gapAt.push(Math.round(ct * 10) / 10); }
        prevCt = ct; lastT = now;
      }
      if (ct >= (v.duration || 0) - 0.5 && (v.duration || 0) > 0) {
        // 播完了
        out.finished = true;
        out.waiting = waiting; out.waitingAt = waitingAt; out.stalls = stalls; out.gapAt = gapAt;
        out.minAhead = Math.round(minAhead * 10) / 10;
        out.samples = samples;
        out.ok = waiting <= 1 && stalls === 0;
        v.pause();
        return JSON.stringify(out, null, 2);
      }
      if (Date.now() - t0 > 120000) {
        out.finished = false;
        out.waiting = waiting; out.waitingAt = waitingAt; out.stalls = stalls; out.gapAt = gapAt;
        out.minAhead = Math.round(minAhead * 10) / 10;
        out.samples = samples;
        out.ok = waiting <= 1 && stalls === 0;
        v.pause();
        return JSON.stringify(out, null, 2);
      }
      return sleep(300).then(sample);
    }
    return sample();
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
