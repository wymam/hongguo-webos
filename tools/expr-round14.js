(function () {
  // Round 14, items 1-3 (category page).
  //   1. filter chips stay within 2 rows
  //   2. the page title (category name) is bigger than the "全部" chip
  //   3. pressing Down from the strip into the cards collapses the strip
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) { var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true }; window.dispatchEvent(new KeyboardEvent('keydown', init)); window.dispatchEvent(new KeyboardEvent('keyup', init)); }
  const UP = 38, DOWN = 40;
  function cur() { var el = document.querySelector('.focused'); return el ? el.getAttribute('data-focus-id') : null; }
  function snap(tag) { out.steps.push(tag + '=' + cur()); }
  function ensureClean() { function step(n) { if (!document.querySelector('.player-root') || n > 8) return sleep(900); window.dispatchEvent(new CustomEvent('tv-back')); return sleep(900).then(function () { return step(n + 1); }); } return step(0); }
  function px(el, p) { return el ? Math.round(parseFloat(window.getComputedStyle(el)[p] || '0')) : null; }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]'); if (nav) nav.click();
    return sleep(3500);
  }).then(function () {
    // item 1: chip rows <= 2
    var rows = {};
    [].slice.call(document.querySelectorAll('[data-focus-id^="filter-"]')).forEach(function (el) {
      var m = /^filter-(-?\d+)-(\d+)$/.exec(el.getAttribute('data-focus-id'));
      if (m) rows[m[1]] = (rows[m[1]] || 0) + 1;
    });
    var rowKeys = Object.keys(rows).sort();
    out.chipRows = rowKeys.length;
    out.chipRowKeys = rowKeys;
    out.chipsWithin2Rows = out.chipRows <= 2;

    // item 2: title vs chip font
    var title = document.querySelector('.category-title');
    var chip = document.querySelector('.filter-chip');
    out.titleText = title ? (title.innerText || '').trim() : null;
    out.titleFont = px(title, 'fontSize');
    out.chipFont = px(chip, 'fontSize');
    out.titleBiggerThanChip = !!(out.titleFont && out.chipFont && out.titleFont > out.chipFont);

    // strip visible initially?
    out.stripVisibleBefore = (function () {
      var el = document.querySelector('.filter-grid');
      return el && el.offsetHeight > 0 && window.getComputedStyle(el).opacity === '1';
    })();

    // item 3: walk up to strip, then down into cards -> strip collapses
    if (window.__hongguoFocus) window.__hongguoFocus.set('content-0-0');
    return sleep(600);
  }).then(function () {
    // up into strip
    key('ArrowUp', UP); return sleep(500);
  }).then(function () {
    snap('onStrip');
    out.reachedStrip = !!cur() && String(cur()).indexOf('filter-') === 0;
    // strip should now be expanded
    var el = document.querySelector('.filter-grid');
    out.stripVisibleOnStrip = el && el.offsetHeight > 0 && window.getComputedStyle(el).opacity === '1';
    // down into cards
    key('ArrowDown', DOWN); return sleep(600);
  }).then(function () {
    snap('afterDown');
    out.landedOnCards = !!cur() && String(cur()).indexOf('content-') === 0;
    var el = document.querySelector('.filter-grid');
    out.stripCollapsedAfterDown = el && (el.offsetHeight === 0 || window.getComputedStyle(el).opacity === '0');
    out.verdict = {
      item1_chipsWithin2Rows: out.chipsWithin2Rows,
      item2_titleBiggerThanChip: out.titleBiggerThanChip,
      item3_collapseOnDown: out.stripVisibleOnStrip && out.stripCollapsedAfterDown
    };
    out.ok = out.chipsWithin2Rows && out.titleBiggerThanChip && out.verdict.item3_collapseOnDown;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
