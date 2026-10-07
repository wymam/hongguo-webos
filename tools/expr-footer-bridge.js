(function () {
  // PM retest #2 — the footer/header bridges.
  //
  // Three controls were painted but unreachable by D-pad, because they live in
  // a focus group the grid cannot reach by arithmetic:
  //   * 观看记录 → 清空观看记录   (group 'button', below the grid)
  //   * 真人剧   → 全部/类型筛选  (group 'filter', above the grid)
  //   * 真人剧   → 上一页/下一页  (group 'page', below the grid)
  // This drives the real key path and records where the ring actually lands.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const DOWN = 40, UP = 38, RIGHT = 39, ENTER = 13;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24) : null;
  }
  function snap(tag) { out.steps.push(tag + '=' + cur() + '(' + curText() + ')'); }

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(1000);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  function gotoRail(id) {
    var nav = document.querySelector('[data-focus-id="' + id + '"]');
    if (!nav) return sleep(400);
    nav.click();
    return sleep(2400);
  }

  // Highest-numbered row currently registered in a group.
  function lastRowOf(prefix) {
    var max = null;
    (window.__hongguoFocus ? window.__hongguoFocus.list() : []).forEach(function (id) {
      var m = new RegExp('^' + prefix + '(-?\\d+)-(\\d+)$').exec(id);
      if (!m) return;
      var r = parseInt(m[1], 10);
      if (max === null || r > max) max = r;
    });
    return max;
  }

  return ensureClean().then(function () {
    // ---- 1. 观看记录 → 清空观看记录 -------------------------------------
    return gotoRail('sidebar-6-0');
  }).then(function () {
    key('ArrowRight', RIGHT);
    return sleep(1600);
  }).then(function () {
    snap('history.afterRight');
    out.historyEntry = cur();
    // Walk down until we leave the card grid (or give up).
    var seen = [cur()];
    function walk(i) {
      if (i >= 14) return Promise.resolve(seen);
      if (cur() && String(cur()).indexOf('history-clear') === 0) return Promise.resolve(seen);
      key('ArrowDown', DOWN);
      return sleep(380).then(function () { seen.push(cur()); return walk(i + 1); });
    }
    return walk(0).then(function (s) { out.historyWalk = s; });
  }).then(function () {
    out.historyReachedClear = !!cur() && String(cur()).indexOf('history-clear') === 0;
    out.historyClearExists = !!document.querySelector('[data-focus-id="history-clear-0-0"]');
    out.historyClearVisible = (function () {
      var el = document.querySelector('[data-focus-id="history-clear-0-0"]');
      if (!el || !el.getBoundingClientRect) return null;
      var r = el.getBoundingClientRect();
      // Reached but scrolled out of sight is the failure mode this bridge
      // must avoid: the ring would be on a control nobody can see.
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), onScreen: r.bottom > 0 && r.top < window.innerHeight };
    })();
    // And back up again — a one-way trip would be just as broken.
    key('ArrowUp', UP);
    return sleep(500);
  }).then(function () {
    snap('history.afterUp');
    out.historyUpReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;

    // ---- 2. 真人剧 → 筛选条 / 翻页 --------------------------------------
    return gotoRail('sidebar-2-0');
  }).then(function () {
    key('ArrowRight', RIGHT);
    return sleep(1800);
  }).then(function () {
    snap('cat.afterRight');
    out.catEntry = cur();
    out.filterBarExists = !!document.querySelector('[data-focus-id="filter-0-0"]');
    key('ArrowUp', UP);
    return sleep(450);
  }).then(function () {
    snap('cat.afterUp');
    out.catUpReachesFilter = !!cur() && String(cur()).indexOf('filter-') === 0;
    key('ArrowDown', DOWN);
    return sleep(450);
  }).then(function () {
    snap('cat.afterDown');
    out.catDownReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;
    return sleep(200);
  }).then(function () {
    // Walk the filter strip sideways: Right from 全部 must stay in the strip.
    var f = document.querySelector('[data-focus-id="filter-0-0"]');
    if (f) f.click();
    return sleep(400);
  }).then(function () {
    key('ArrowRight', RIGHT);
    return sleep(380);
  }).then(function () {
    snap('cat.filterRight');
    out.filterRightStaysInStrip = !!cur() && String(cur()).indexOf('filter-') === 0;

    // ---- 3. 翻页 chips ---------------------------------------------------
    var last = lastRowOf('content');
    out.catLastRow = last;
    if (last === null) return null;
    var target = 'content-' + last + '-0';
    if (window.__hongguoFocus) window.__hongguoFocus.set(target);
    return sleep(700);
  }).then(function () {
    snap('cat.onLastRow');
    out.pageChips = ['page-0-0', 'page-0-1'].filter(function (id) {
      return !!document.querySelector('[data-focus-id="' + id + '"]');
    });
    key('ArrowDown', DOWN);
    return sleep(500);
  }).then(function () {
    snap('cat.afterDownFromLastRow');
    out.catDownReachesPaging = !!cur() && String(cur()).indexOf('page-') === 0;
    key('ArrowUp', UP);
    return sleep(500);
  }).then(function () {
    snap('cat.pagingUp');
    out.pagingUpReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;
    // Left/Right between 上一页 and 下一页 must not escape into the genre strip.
    if (out.catDownReachesPaging) {
      key('ArrowRight', RIGHT);
      return sleep(400).then(function () {
        snap('cat.pagingRight');
        out.pagingRightTarget = cur();
        return null;
      });
    }
    return null;
  }).then(function () {
    // ---- 4. 搜索：进入后是否自动打开键盘 --------------------------------
    return gotoRail('sidebar-0-0');
  }).then(function () {
    key('ArrowRight', RIGHT);
    return sleep(1500);
  }).then(function () {
    var el = document.activeElement;
    out.searchActiveTag = el ? el.tagName : null;
    out.searchActiveClass = el ? String(el.className || '') : null;
    out.searchInputFocused = !!(el && el.tagName === 'INPUT');
    return null;
  }).then(function () {
    out.ok = out.historyReachedClear && out.historyUpReturnsToGrid
      && out.catUpReachesFilter && out.catDownReturnsToGrid
      && out.catDownReachesPaging && out.pagingUpReturnsToGrid
      && out.searchInputFocused;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
