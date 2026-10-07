(function () {
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) { var el = document.querySelector('[data-focus-id="' + id + '"]'); if (el) { el.click(); return true; } return false; }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-7-0"]'); if (nav) nav.click();
    return sleep(2500);
  }).then(function () {
    out.hasAccountSection = document.body.innerText.indexOf('账号') >= 0;
    out.hasLoginBtn = !!document.querySelector('[data-focus-id="settings-4-0"]');
    out.loginBtnText = (function () { var el = document.querySelector('[data-focus-id="settings-4-0"]'); return el ? (el.innerText || '').trim() : null; })();
    // 点击扫码登录
    click('settings-4-0');
    return sleep(3000);
  }).then(function () {
    var img = document.querySelector('.qr-code');
    out.qrImageShown = !!img;
    out.qrMessage = (function () { var el = document.querySelector('.qr-message'); return el ? (el.innerText || '').trim() : null; })();
    out.qrImageSrcPrefix = img ? (img.src || '').slice(0, 40) : null;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
