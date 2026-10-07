(function () {
  // Paging chips only: from the LAST row of the category grid, does ArrowDown
  // reach 上一页/下一页, and does ArrowUp come back?
  //
  // (The previous probe mis-parsed the row number — it built the regex as
  //  `content(-?\d+)` instead of `content-(-?\d+)`, so every row read as -N and
  //  "last row" was always 0. Same walk, corrected arithmetic.)
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

  // Highest-numbered row registered in a group. NOTE the '-' after the prefix:
  // without it the regex swallows it into the row number and every row parses
  // as negative.
  function lastRowOf(group) {
    var max = null;
    (window.__hongguoFocus ? window.__hongguoFocus.list() : []).forEach(function (id) {
      var m = new RegExp('^' + group + '-(-?\\d+)-(\\d+)$').exec(id);
      if (!m) return;
      var r = parseInt(m[1], 10);
      if (max === null || r > max) max = r;
    });
    return max;
  }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]'); // 真人剧
    if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    var last = lastRowOf('content');
    out.gridLastRow = last;
    out.contentIds = (window.__hongguoFocus ? window.__hongguoFocus.list() : [])
      .filter(function (i) { return i.indexOf('content-') === 0; }).length;
    out.pageChips = ['page-0-0', 'page-0-1'].filter(function (id) {
      return !!document.querySelector('[data-focus-id="' + id + '"]');
    });
    if (last === null) return null;
    if (window.__hongguoFocus) window.__hongguoFocus.set('content-' + last + '-0');
    return sleep(600);
  }).then(function () {
    snap('onLastRow');
    key('ArrowDown', DOWN);
    return sleep(500);
  }).then(function () {
    snap('afterDown');
    out.downReachesPaging = !!cur() && String(cur()).indexOf('page-') === 0;
    out.pagingVisible = (function () {
      var el = document.querySelector('.focused');
      if (!el || !el.getBoundingClientRect) return null;
      var r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), onScreen: r.bottom > 0 && r.top < window.innerHeight };
    })();
    // Sideways inside the paging strip must not jump into the genre strip.
    key('ArrowRight', RIGHT);
    return sleep(420);
  }).then(function () {
    snap('pagingRight');
    out.pagingRightStaysInPaging = !!cur() && String(cur()).indexOf('page-') === 0;
    key('ArrowLeft', LEFT);
    return sleep(420);
  }).then(function () {
    snap('pagingLeft');
    key('ArrowUp', UP);
    return sleep(500);
  }).then(function () {
    snap('afterUp');
    out.upReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;
    out.ok = out.downReachesPaging && out.upReturnsToGrid && out.pagingRightStaysInPaging;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
