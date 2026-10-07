(function () {
  var out = {};
  return Promise.resolve()
    .then(function () {
      if (!window.__hongguoApi || !window.__hongguoApi.qrStart) { out.error = 'qrStart 未暴露'; return null; }
      return window.__hongguoApi.qrStart();
    })
    .then(function (r) {
      if (out.error) return null;
      out.start = r;
      if (r && r.returnValue === false) { out.fail = r.errorText; return null; }
      out.token = r && r.token;
      out.hasQrcode = !!(r && r.qrcode && r.qrcode.length > 100);
      out.qrcodeLen = r && r.qrcode ? r.qrcode.length : 0;
      out.expireTime = r && r.expireTime;
      out.webName = r && r.webName;
      // 也查一下登录态
      return window.__hongguoApi.qrStatus();
    })
    .then(function (s) {
      if (out.error) return null;
      out.status = s;
      return JSON.stringify(out, null, 2);
    })
    .catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
