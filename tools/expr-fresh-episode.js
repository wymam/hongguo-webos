(function () {
  // 决定性实验：新鲜 episode（本机从未播过）× 纯 media 管线 × 两种 preload。
  // 若 fresh + 任何 preload 都会 teleport → Chromium 解复用器本身缺陷（与缓存无关）。
  // 若 fresh 正常而老 episode teleport → 陈旧媒体缓存是元凶 → cache-bust 可修。
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function runOne(url, preload, ms) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.src = url; v.preload = preload; v.muted = false;
      v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01';
      document.body.appendChild(v);
      var rec = { preload: preload, events: [], samples: [], teleports: [] };
      ['seeking', 'seeked', 'waiting', 'playing', 'canplay', 'ended', 'error', 'stalled'].forEach(function (n) {
        v.addEventListener(n, function () {
          rec.events.push({ t: Date.now() - rec.t0, ev: n, ct: Math.round(v.currentTime * 100) / 100, err: v.error ? v.error.code : null });
        });
      });
      rec.t0 = Date.now();
      var prevCt = -1, prevT = rec.t0;
      var iv = setInterval(function () {
        var ct = v.currentTime, now = Date.now();
        var ahead = 0, b = v.buffered;
        for (var i = 0; i < b.length; i++) if (b.start(i) <= ct + 0.05 && b.end(i) > ct) { ahead = b.end(i) - ct; break; }
        var ranges = [];
        for (var j = 0; j < b.length; j++) ranges.push([Math.round(b.start(j) * 10) / 10, Math.round(b.end(j) * 10) / 10]);
        rec.samples.push({ t: now - rec.t0, ct: Math.round(ct * 100) / 100, ahead: Math.round(ahead * 10) / 10, ranges: ranges, rs: v.readyState });
        if (prevCt >= 0 && ct - prevCt > 2 && (now - prevT) < 800) {
          rec.teleports.push({ t: now - rec.t0, from: Math.round(prevCt * 100) / 100, to: Math.round(ct * 100) / 100 });
        }
        prevCt = ct; prevT = now;
      }, 300);
      v.play().catch(function () {});
      setTimeout(function () {
        clearInterval(iv);
        rec.finalCt = Math.round(v.currentTime * 100) / 100;
        rec.duration = Math.round((v.duration || 0) * 100) / 100;
        rec.paused = v.paused; rec.ended = v.ended;
        v.pause(); v.removeAttribute('src'); v.load(); v.remove();
        resolve(rec);
      }, ms);
    });
  }

  // 取本机从未请求过的 episode：随机挑分类页靠后的卡片（避免与历次测试重复）
  var pick = 2 + Math.floor(Math.random() * 8);
  return window.__hongguoApi.getCategory('comic-drama', 1, '', 24).then(function (cat) {
    var item = (cat.items || [])[pick] || (cat.items || [])[3];
    if (!item) throw new Error('no item');
    out.pickIndex = pick;
    return window.__hongguoApi.getDetail(item.id);
  }).then(function (d) {
    // 两集分别测两种 preload —— 各自都是本机从未请求过的新鲜 URL
    var ei = Math.floor(Math.random() * Math.min(20, d.episodes.length - 1));
    var ep1 = d.episodes[ei].id, ep2 = d.episodes[ei + 1].id;
    out.series = d.title; out.epAuto = ep1; out.epMetadata = ep2;
    return runOne(window.__hongguoApi.mediaUrl(ep1), 'auto', 25000).then(function (r1) {
      out.auto = r1;
      return sleep(1000);
    }).then(function () {
      return runOne(window.__hongguoApi.mediaUrl(ep2), 'metadata', 25000);
    }).then(function (r2) {
      out.metadata = r2;
      return JSON.stringify(out, null, 1);
    });
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 1); });
})()
