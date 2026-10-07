(function () {
  // Round 23 — the four category-page requests, measured on the TV.
  //
  //   1. one screen = exactly 50 items, on a 5-column grid = 10 full rows;
  //   2. Down from the genre strip lands on a CARD, not the sidebar — the bug
  //      this round fixed, so it is asserted by the focused id prefix;
  //   3. the batch pager fills its row;
  //   4. a genre change does not destroy the screen (focus survives), which is
  //      also what makes the wait feel shorter.
  //
  // Every check is against the live DOM. The batch coordinates come from
  // window.__hongguoBatches, which the page exposes because a TV has no
  // devtools and the arithmetic cannot be read off the DOM.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  var DOWN = 40, RIGHT = 39;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function px(el, prop) {
    return el ? parseFloat(window.getComputedStyle(el)[prop] || '0') : null;
  }

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    function backOut(n) {
      if (document.querySelector('.hero') || n > 6) return sleep(400);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(800).then(function () { return backOut(n + 1); });
    }
    return step(0).then(function () { return backOut(0); });
  }

  function enterCategory(name) {
    var items = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'));
    var target = null;
    for (var i = 0; i < items.length; i++) {
      if ((items[i].innerText || '').indexOf(name) >= 0) { target = items[i]; break; }
    }
    if (!target) target = items[2] || items[1];
    out['entered'] = target ? (target.innerText || '').replace(/\s+/g, ' ').trim() : null;
    if (target) target.click();
    function wait(n) {
      if (document.querySelector('.filter-chip') || n > 25) return sleep(600);
      return sleep(500).then(function () { return wait(n + 1); });
    }
    return sleep(1500).then(function () { return wait(0); });
  }

  return ensureClean().then(function () {
    return enterCategory('真人剧');
  }).then(function () {
    // ---- item 1: one screen is 50 items on 10 full rows ------------------
    var cards = [].slice.call(document.querySelectorAll('[data-focus-id^="content-"]'));
    out.cardCount = cards.length;
    var rows = {};
    cards.forEach(function (el) {
      var m = /^content-(\d+)-(\d+)$/.exec(el.getAttribute('data-focus-id'));
      if (m) rows[m[1]] = (rows[m[1]] || 0) + 1;
    });
    var rowKeys = Object.keys(rows);
    out.rowCount = rowKeys.length;
    out.perRow = rowKeys.length ? rowKeys.map(function (k) { return rows[k]; }) : [];
    out.rowSizesUniform = out.perRow.length
      ? Math.max.apply(null, out.perRow) - Math.min.apply(null, out.perRow) === 0
      : false;
    out.colsPerRow = out.perRow.length ? out.perRow[0] : 0;

    // The span label the page renders: 第 a-b 部.
    var facts = [].slice.call(document.querySelectorAll('.category-meta .detail-fact'))
      .map(function (e) { return (e.innerText || '').trim(); });
    out.metaFacts = facts;
    var span = facts.filter(function (t) { return /^第 .* 部$/.test(t); })[0] || null;
    out.rangeLabel = span;
    var m2 = span ? /^第 (\d+)-(\d+) 部$/.exec(span) : null;
    out.rangeFrom = m2 ? +m2[1] : null;
    out.rangeTo = m2 ? +m2[2] : null;
    out.rangeSize = m2 ? (+m2[2] - +m2[1] + 1) : null;

    // ---- item 3: the pager fills the row ---------------------------------
    var pager = document.querySelector('.batch-pager');
    out.pagerPresent = !!pager;
    if (pager) {
      var list = pager.querySelector('.batch-list');
      var chips = [].slice.call(pager.querySelectorAll('.page-chip'));
      var avail = pager.clientWidth;
      var lw = list ? list.getBoundingClientRect().width : 0;
      var w = chips.map(function (c) { return Math.round(c.getBoundingClientRect().width); });
      var last = chips.length ? chips[chips.length - 1].getBoundingClientRect() : null;
      out.pager = {
        buttons: chips.length,
        labels: chips.map(function (c) { return (c.innerText || '').trim(); }),
        current: (function () {
          var c = pager.querySelector('.page-chip.current');
          return c ? (c.innerText || '').trim() : null;
        })(),
        listFillPct: avail ? Math.round((lw / avail) * 100) : 0,
        chipMin: w.length ? Math.min.apply(null, w) : 0,
        chipMax: w.length ? Math.max.apply(null, w) : 0,
        rightGap: last ? Math.round(pager.getBoundingClientRect().right - last.right) : null
      };
      out.pagerUniform = out.pager.chipMax - out.pager.chipMin <= 2;
      out.batches = window.__hongguoBatches || null;
    }
    return null;
  }).then(function () {
    // ---- item 2: Down from the strip's BOTTOM row reaches a CARD --------
    //
    // The strip can be one row or two, so the row to press Down from is the
    // LAST one — pressing from the top row correctly lands on the row beneath
    // it, which is not the behaviour under test. The failure being fixed put
    // focus in the SIDEBAR, so the assertion is explicit about the group.
    var chips = [].slice.call(document.querySelectorAll('[data-focus-id^="filter-"]'));
    out.filterIds = chips.map(function (c) { return c.getAttribute('data-focus-id'); });
    var maxRow = 0;
    chips.forEach(function (c) {
      var m = /^filter-(\d+)-\d+$/.exec(c.getAttribute('data-focus-id'));
      if (m && +m[1] > maxRow) maxRow = +m[1];
    });
    out.stripRows = maxRow + 1;
    out.stripBottomId = 'filter-' + maxRow + '-0';
    if (window.__hongguoFocus) window.__hongguoFocus.set(out.stripBottomId);
    return sleep(500).then(function () {
      out.stripStart = cur();
      key('ArrowDown', DOWN);
      return sleep(500);
    }).then(function () {
      out.afterDownFromStrip = cur();
      return null;
    });
  }).then(function () {
    // ---- item 4: changing a genre keeps the screen and the focus ---------
    // The regression this round fixed: selecting a genre used to unmount the
    // strip (status -> loading -> <Loading/>), which cleared the focus and
    // made the NEXT key press jump to the sidebar.
    var chips = [].slice.call(document.querySelectorAll('[data-focus-id^="filter-"]'));
    if (!chips.length) { out.genreChangeError = 'no chips'; return null; }
    var target = chips.length > 1 ? chips[1] : chips[0];
    out.genreTarget = target.getAttribute('data-focus-id');
    var label = (target.innerText || '').trim();
    out.genreName = label;
    // Focus the chip the way the D-pad would before pressing OK: a bare
    // `.click()` fires the handler but leaves focus wherever it was, which is
    // not what a remote does and not the state under test.
    if (window.__hongguoFocus) window.__hongguoFocus.set(out.genreTarget);
    out.genreFocusBefore = cur();
    target.click();
    return sleep(300).then(function () {
      out.duringGenreLoad = {
        stripMounted: !!document.querySelector('.filter-grid'),
        gridMounted: !!document.querySelector('[data-focus-id^="content-"]'),
        focused: cur()
      };
      // Wait for the load to settle (the busy cue disappears).
      function wait(n) {
        if (!document.querySelector('.category-busy') || n > 30) return sleep(400);
        return sleep(400).then(function () { return wait(n + 1); });
      }
      return wait(0);
    }).then(function () {
      out.afterGenreLoad = {
        stripMounted: !!document.querySelector('.filter-grid'),
        focused: cur(),
        // The newly-selected genre should now be the active chip.
        activeGenre: (function () {
          var a = document.querySelector('.filter-chip.active');
          return a ? (a.innerText || '').trim() : null;
        })()
      };
      // The point of item 4: having changed genre, the strip is still there and
      // the focus is still ON THE CHIP that was pressed — so the next D-pad
      // press navigates from the strip instead of hitting the "nothing is
      // focused" fallback (which jumped to the sidebar).
      key('ArrowDown', DOWN);
      return sleep(500).then(function () {
        out.afterDownPostGenre = cur();
        return null;
      });
    });
  }).then(function () {
    var v = out;
    var item1 = v.rangeSize === 50 && v.cardCount === 50 && v.rowCount === 10 && v.colsPerRow === 5;
    var item2 = /^content-/.test(v.afterDownFromStrip || '');
    var item3 = !!v.pagerPresent && v.pager.listFillPct >= 88 && v.pagerUniform;
    var item4 = !!(v.duringGenreLoad && v.duringGenreLoad.stripMounted && v.duringGenreLoad.gridMounted) &&
      !!v.afterGenreLoad && v.afterGenreLoad.focused === v.genreTarget &&
      v.afterGenreLoad.activeGenre === v.genreName &&
      // The crucial one: the next D-pad press stays in the page (the strip or
      // the grid). It must NOT be the sidebar, which is what the destroyed
      // focus used to cause.
      !/^sidebar-/.test(v.afterDownPostGenre || '');
    v.verdict = {
      item1_screen_is_50: item1,
      item1_cardCount: v.cardCount,
      item1_rows: v.rowCount,
      item1_colsPerRow: v.colsPerRow,
      item1_rangeSize: v.rangeSize,
      item1_rangeLabel: v.rangeLabel,
      item2_downReachesCard: item2,
      item2_stripRows: v.stripRows,
      item2_from: v.stripStart,
      item2_landedOn: v.afterDownFromStrip,
      item3_pagerFillsRow: item3,
      item3_fillPct: v.pager ? v.pager.listFillPct : null,
      item3_uniform: v.pagerUniform,
      item4_screenSurvivesGenreChange: item4,
      item4_activeGenre: v.afterGenreLoad ? v.afterGenreLoad.activeGenre : null,
      item4_downAfterGenre: v.afterDownPostGenre
    };
    v.ok = item1 && item2 && item3 && item4;
    return JSON.stringify(v, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
