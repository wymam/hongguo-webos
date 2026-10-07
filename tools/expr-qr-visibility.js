(function () {
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-7-0"]'); if (nav) nav.click();
    return sleep(2500);
  }).then(function () {
    var btn = document.querySelector('[data-focus-id="settings-4-0"]');
    out.loginBtnFound = !!btn;
    if (btn) btn.click();
    return sleep(3500);
  }).then(function () {
    var img = document.querySelector('.qr-code');
    var panel = document.querySelector('.qr-panel');
    var vp = document.querySelector('.config-options');
    out.qrShown = !!img;
    if (img && panel && vp) {
      var ir = img.getBoundingClientRect();
      var pr = panel.getBoundingClientRect();
      var vr = vp.getBoundingClientRect();
      out.imgRect = { top: Math.round(ir.top), bottom: Math.round(ir.bottom), h: Math.round(ir.height), w: Math.round(ir.width) };
      out.vpRect = { top: Math.round(vr.top), bottom: Math.round(vr.bottom), h: Math.round(vr.height) };
      out.fullyInViewport = ir.top >= vr.top - 2 && ir.bottom <= vr.bottom + 2;
      out.panelFullyInViewport = pr.top >= vr.top - 2 && pr.bottom <= vr.bottom + 2;
      // scrollable? scrollTop 可读说明 overflow-y 生效
      out.vpScrollable = vp.scrollHeight > vp.clientHeight;
      out.vpScrollTop = Math.round(vp.scrollTop);
      // 图片是否真正解码完成（naturalWidth > 0）
      out.imgDecoded = img.naturalWidth + 'x' + img.naturalHeight;
    }
    return JSON.stringify(out, null, 2);
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
