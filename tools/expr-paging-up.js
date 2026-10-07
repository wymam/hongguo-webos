(function () {
  // Narrow follow-up: ArrowUp straight off a paging chip, with no Left detour
  // first (Left legitimately exits to the rail, which made the previous probe's
  // "up" step measure the rail instead of the chip).
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const DOWN = 40, UP = 38;
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
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]');
    if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    var last = lastRowOf('content');
    out.gridLastRow = last;
    if (last === null) return null;
    if (window.__hongguoFocus) window.__hongguoFocus.set('content-' + last + '-0');
    return sleep(600);
  }).then(function () {
    key('ArrowDown', DOWN);
    return sleep(520);
  }).then(function () {
    snap('onPaging');
    out.onPaging = !!cur() && String(cur()).indexOf('page-') === 0;
    key('ArrowUp', UP);           // THE step under test
    return sleep(520);
  }).then(function () {
    snap('afterUp');
    out.upReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;
    out.ok = out.onPaging && out.upReturnsToGrid;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
