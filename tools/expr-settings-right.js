(function () {
  // "左边菜单栏选择设置，按右方向键，不能落到设置的刷新诊断信息按钮上。"
  //
  // Drives the REAL key path: focus the 设置 rail item, press Right, then walk
  // Down and confirm we can reach each settings row — including 刷新诊断信息.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const DOWN = 40, UP = 38, RIGHT = 39, LEFT = 37;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30) : null;
  }
  function snap(tag) {
    out.steps.push(tag + '=' + cur() + '(' + curText() + ')');
  }

  // Leave any player first.
  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(1200);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  return ensureClean().then(function () {
    // Park focus on the 设置 rail item by clicking it (deterministic).
    // sidebar-7-0 is 设置 (0 搜索, 1 推荐, 2 真人剧, 3 漫剧, 4 AI剧, 5 收藏,
    // 6 观看记录, 7 设置) — verified with tools/expr-list-sidebar.js.
    var nav = document.querySelector('[data-focus-id="sidebar-7-0"]');
    out.sidebarId = nav ? 'sidebar-7-0' : null;
    out.sidebarText = nav ? (nav.innerText || '').trim() : null;
    if (nav) nav.click();
    return sleep(2200);
  }).then(function () {
    snap('onRail');
    out.pageEyebrow = (function () {
      var e = document.querySelector('.page-eyebrow');
      return e ? (e.innerText || '').trim() : null;
    })();
    key('ArrowRight', RIGHT);       // THE reported gesture
    return sleep(1600);
  }).then(function () {
    snap('afterRight');
    out.landedOnSettings = !!cur() && cur().indexOf('settings-') === 0;
    return sleep(300);
  }).then(function () {
    // Walk down through the settings rows.
    var seen = [cur()];
    function walk(i) {
      if (i >= 4) return Promise.resolve(seen);
      key('ArrowDown', DOWN);
      return sleep(450).then(function () {
        seen.push(cur());
        return walk(i + 1);
      });
    }
    return walk(0).then(function (s) { out.walk = s; });
  }).then(function () {
    out.walkTexts = out.walk.map(function () { return null; });
    // Which row is 刷新诊断信息?
    var btn = document.querySelector('[data-focus-id="settings-3-0"]');
    out.refreshButtonExists = !!btn;
    out.refreshButtonText = btn ? (btn.innerText || '').trim() : null;
    // Can we reach it? Re-land on row 0 and press Down 3 times.
    var first = document.querySelector('[data-focus-id="settings-0-0"]');
    if (first) first.click();
    return sleep(500);
  }).then(function () {
    snap('backToFirst');
    key('ArrowDown', DOWN); return sleep(400);
  }).then(function () {
    key('ArrowDown', DOWN); return sleep(400);
  }).then(function () {
    key('ArrowDown', DOWN); return sleep(500);
  }).then(function () {
    snap('after3Downs');
    out.reachedRefreshButton = cur() === 'settings-3-0';
    out.ok = out.landedOnSettings && out.reachedRefreshButton;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    return JSON.stringify(out, null, 2);
  });
})()
