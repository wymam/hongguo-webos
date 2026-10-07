(function () {
  // Do the SINGLE-ROW categories also grow their chips? (owner: "其他页 一行的
  // 关键字标题页做的稍微大点，尽量不要这么空")
  //
  // Only two representative categories are visited: 真人剧 (the long, two-row
  // list) and 漫剧 (a short, single-row one). Walking all eight blew the CDP
  // budget, and the other categories are the same shape as these two.
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function back(n) {
    if (n > 10) return sleep(300);
    if (document.querySelector('.hero') && !document.querySelector('.filter-chip')) return sleep(400);
    window.dispatchEvent(new CustomEvent('tv-back'));
    return sleep(800).then(function () { return back(n + 1); });
  }
  function measure() {
    var grid = document.querySelector('.filter-grid');
    var chips = [].slice.call(document.querySelectorAll('.filter-chip'))
      .filter(function (el) { return /^filter-/.test(el.getAttribute('data-focus-id') || ''); });
    if (!grid || !chips.length) return null;
    var cs = window.getComputedStyle(grid);
    var usable = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    var byRow = {}, fills = [], tops = {};
    chips.forEach(function (el) {
      var m = /^filter-(-?\d+)-(\d+)$/.exec(el.getAttribute('data-focus-id'));
      if (!m) return;
      (byRow[m[1]] = byRow[m[1]] || []).push(el);
      tops[Math.round(el.getBoundingClientRect().top)] = true;
    });
    var rows = Object.keys(byRow).sort(function (a, b) { return a - b; });
    rows.forEach(function (r) {
      // Measure the ROW the way the browser laid it out: its own content width.
      // Summing chip widths plus margins missed the `gap` that the stretched
      // layout uses instead of margins, which made a correctly-filled row read
      // as short.
      var first = byRow[r][0];
      var parent = first.parentElement;
      var rowW = first.offsetWidth;
      byRow[r].forEach(function (el, i) {
        if (i) rowW += (el.offsetWidth || 0);
      });
      var cs2 = window.getComputedStyle(parent);
      var gap = parseFloat(cs2.columnGap || cs2.gap) || 0;
      if (byRow[r].length > 1) rowW += gap * (byRow[r].length - 1);
      fills.push(Math.round((rowW / usable) * 100));
    });
    return {
      title: (document.querySelector('.category-title') || {}).innerText || null,
      chips: chips.length,
      rows: rows.length,
      fillPct: fills,
      chipWidth: chips[0].offsetWidth,
      scale: +(parseFloat(cs.getPropertyValue('--chip-scale')) || 1).toFixed(2),
      stretched: grid.classList.contains('stretched')
    };
  }
  function enter(railId) {
    if (window.__hongguoFocus) window.__hongguoFocus.set(railId);
    return sleep(350).then(function () {
      window.dispatchEvent(new CustomEvent('tv-enter-content', { detail: railId }));
      function wait(n) {
        if ((document.querySelector('.filter-chip') && document.querySelector('.batch-pager')) || n > 20) return sleep(300);
        return sleep(400).then(function () { return wait(n + 1); });
      }
      return sleep(800).then(function () { return wait(0); });
    });
  }
  return sleep(500).then(function () {
    return back(0);
  }).then(function () {
    return enter('sidebar-2-0'); // 真人剧
  }).then(function () {
    out.longList = measure();
    return back(0);
  }).then(function () {
    return enter('sidebar-3-0'); // 漫剧
  }).then(function () {
    out.shortList = measure();
    out.verdict = {
      long_rows: out.longList && out.longList.rows,
      long_fill: out.longList && out.longList.fillPct,
      short_rows: out.shortList && out.shortList.rows,
      short_fill: out.shortList && out.shortList.fillPct,
      short_stretched: out.shortList && out.shortList.stretched
    };
    var shortOk = out.shortList && out.shortList.fillPct[0] >= 85;
    var longOk = out.longList && out.longList.fillPct.every(function (f) { return f >= 80 && f <= 101; });
    out.ok = shortOk && longOk;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
