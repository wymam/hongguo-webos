(function () {
  // Round 22 — the strip auto-size and the batch pager, measured on the TV.
  //
  //   1. The genre strip grows its chips to FILL its rows. Measured as the
  //      thinnest row's fill fraction, which is the number that matters: a
  //      two-row strip is only "filled" when the thinner row is.
  //
  //   2. The pager offers batch NUMBERS, not just 上一批 / 下一批. Verified by
  //      reading which numbers are rendered, walking the row with real Right
  //      presses, and actually pressing one that is not the current or adjacent
  //      batch to prove it jumps (the point of the feature).
  //
  // Both are asserted against the live DOM. The scale is read from the chip's
  // computed font-size against the page's own base (--ui-scale × 18px), so the
  // assertion does not hard-code a pixel size the CSS is free to change.
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
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null;
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

  function enterCategory() {
    var items = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'));
    var target = null;
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].innerText || '').trim();
      if (t.indexOf('真人剧') >= 0 || t.indexOf('短剧') >= 0) { target = items[i]; break; }
    }
    if (!target) target = items[2] || items[1];
    out.categoryLabel = target ? (target.innerText || '').trim() : null;
    if (target) target.click();
    function waitStrip(n) {
      if (document.querySelector('.filter-chip') || n > 20) return sleep(400);
      return sleep(400).then(function () { return waitStrip(n + 1); });
    }
    return sleep(1200).then(function () { return waitStrip(0); });
  }

  return ensureClean().then(function () {
    return enterCategory();
  }).then(function () {
    // ---- item 1: strip auto-size ---------------------------------------
    var grid = document.querySelector('.filter-grid');
    var chips = [].slice.call(document.querySelectorAll('.filter-chip'))
      .filter(function (el) { return /^filter-/.test(el.getAttribute('data-focus-id') || ''); });
    out.chipCount = chips.length;
    if (!grid || !chips.length) { out.error = 'no strip'; return null; }

    var cs = window.getComputedStyle(grid);
    var usable = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    out.usableWidth = Math.round(usable);

    // The scale the page applied, read from the CSS variable it wrote.
    out.chipScale = parseFloat(cs.getPropertyValue('--chip-scale')) || 1;
    // The chip's effective font size vs the page base (18px × ui-scale).
    var rootScale = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    out.fontSize = px(chips[0], 'fontSize');
    out.fontSizeBase = Math.round(18 * rootScale);
    out.fontSizeRatio = out.fontSizeBase ? +(out.fontSize / out.fontSizeBase).toFixed(3) : null;

    var byRow = {};
    chips.forEach(function (el) {
      var m = /^filter-(-?\d+)-(\d+)$/.exec(el.getAttribute('data-focus-id'));
      if (!m) return;
      (byRow[m[1]] = byRow[m[1]] || []).push({ col: +m[2], el: el });
    });
    var rowKeys = Object.keys(byRow).sort(function (a, b) { return a - b; });
    out.rows = rowKeys.length;

    var fills = [];
    out.rowFill = rowKeys.map(function (r) {
      var list = byRow[r].sort(function (a, b) { return a.col - b.col; });
      var sum = 0, tops = {};
      var detail = [];
      list.forEach(function (c) {
        sum += (c.el.offsetWidth || 0);
        var bb = c.el.getBoundingClientRect();
        tops[Math.round(bb.top)] = true;
        detail.push({
          text: (c.el.innerText || '').trim(),
          w: c.el.offsetWidth,
          top: Math.round(bb.top),
          cls: (c.el.className || '').replace('filter-chip focusable', '').trim()
        });
      });
      // Add the inter-chip spacing, whichever mechanism the CSS used: a right
      // margin in the normal layout, or a `gap` in the stretched one.
      if (list.length > 1) {
        var par = list[0].el.parentElement;
        var pcs = window.getComputedStyle(par);
        var g = parseFloat(pcs.columnGap || pcs.gap) || 0;
        var mr = parseFloat(window.getComputedStyle(list[0].el).marginRight) || 0;
        var per = g || mr;
        sum += per * (list.length - 1);
      }
      var f = usable ? Math.round((sum / usable) * 100) : 0;
      fills.push(f);
      return { row: r, chips: list.length, fillPct: f, visualLines: Object.keys(tops).length, detail: detail };
    });
    out.thinnestFill = fills.length ? Math.min.apply(null, fills) : null;
    out.withinTwoRows = out.rows <= 2;
    out.noRowOverflows = fills.every(function (f) { return f <= 101; });
    out.rowsBalanced = fills.length > 1 ? Math.abs(fills[0] - fills[1]) <= 15 : true;
    out.visualLinesMatchFocusRows = out.rowFill.every(function (r) {
      // The focused chip carries `transform: scale(1.08)`, which moves its
      // rect's top by a pixel or two. Counting that as a separate "visual line"
      // would flag a perfectly flat row as wrapped, so group by top with a
      // tolerance rather than by exact pixel.
      var tops = {};
      var seen = [];
      r.detail.forEach(function (d) {
        var matched = false;
        for (var i = 0; i < seen.length; i++) {
          if (Math.abs(seen[i] - d.top) <= 6) { matched = true; break; }
        }
        if (!matched) seen.push(d.top);
      });
      return seen.length === 1;
    });

    // ---- item 2: batch pager -------------------------------------------
    var pager = document.querySelector('.batch-pager');
    out.pagerPresent = !!pager;
    if (!pager) return null;
    var nums = [].slice.call(pager.querySelectorAll('.page-chip'));
    out.batchButtons = nums.length;
    out.batchLabels = nums.map(function (el) { return (el.innerText || '').trim(); });
    var currentEl = pager.querySelector('.page-chip.current');
    out.currentBatch = currentEl ? (currentEl.innerText || '').trim() : null;
    out.gapMarks = pager.querySelectorAll('.batch-gap').length;
    return null;
  }).then(function () {
    // Walk the pager: Down out of the grid lands on the pager, Right walks the
    // numbers, and Enter on a number that is NOT the current or the next one
    // proves the jump — which is the whole point of the feature.
    if (window.__hongguoFocus) window.__hongguoFocus.set('page-0-0');
    return sleep(600);
  }).then(function () {
    var seen = [];
    function rightOnce(n, max) {
      seen.push({ fid: cur(), text: curText() });
      if (n >= max) return null;
      key('ArrowRight', RIGHT);
      return sleep(320).then(function () { return rightOnce(n + 1, max); });
    }
    return rightOnce(0, 6).then(function () {
      out.pagerWalk = seen;
      return null;
    });
  }).then(function () {
    // Press a batch that is neither the first nor the second, to show the jump
    // is real. Prefer the LAST visible number, which is the farthest jump the
    // control offers — the most convincing case.
    var labels = out.batchLabels.filter(function (t) { return /^\d+$/.test(t); });
    var target = labels.length > 2 ? labels[labels.length - 1] : labels.filter(function (t) {
      return t !== out.currentBatch;
    })[0];
    out.jumpTo = target || null;
    out.batchesBefore = window.__hongguoBatches || null;
    if (!target) return null;
    var els = [].slice.call(document.querySelectorAll('.batch-pager .page-chip'));
    var hit = null;
    for (var i = 0; i < els.length; i++) {
      if ((els[i].innerText || '').trim() === target) { hit = els[i]; break; }
    }
    if (!hit) return null;
    var slotId = hit.getAttribute('data-focus-id');
    out.jumpTargetId = slotId;
    // Drive it the way a remote does: move focus there, then press OK. A bare
    // .click() on the span proved unreliable through CDP (it fired no handler),
    // whereas the focus API's own Enter path is exactly what the TV runs.
    if (window.__hongguoFocus && slotId) window.__hongguoFocus.set(slotId);
    return sleep(400).then(function () {
      key('Enter', 13);
      function waitCurrent(n) {
        var now = document.querySelector('.batch-pager .page-chip.current');
        var txt = now ? (now.innerText || '').trim() : null;
        if (txt === target || n > 30) return sleep(200);
        return sleep(400).then(function () { return waitCurrent(n + 1); });
      }
      return sleep(600).then(function () { return waitCurrent(0); });
    });
  }).then(function () {
    var pager = document.querySelector('.batch-pager');
    out.batchesAfter = window.__hongguoBatches || null;
    if (pager && out.jumpTo) {
      var now = pager.querySelector('.page-chip.current');
      out.afterJumpCurrent = now ? (now.innerText || '').trim() : null;
      out.jumpWorked = out.afterJumpCurrent === out.jumpTo;
    }
    out.verdict = {
      item1_rows: out.rows,
      item1_withinTwoRows: out.withinTwoRows,
      item1_noRowOverflows: out.noRowOverflows,
      item1_rowsBalanced: out.rowsBalanced,
      item1_rowFillPct: out.rowFill ? out.rowFill.map(function (r) { return r.fillPct; }) : null,
      item1_thinnestFill: out.thinnestFill,
      item1_chipScale: out.chipScale,
      item1_grew: out.item1_grew,
      item1_fillPacked: out.item1_fillPacked,
      item1_visualLinesMatchFocusRows: out.visualLinesMatchFocusRows,
      item2_pagerPresent: out.pagerPresent,
      item2_batchButtons: out.batchButtons,
      item2_currentHighlighted: !!out.currentBatch,
      item2_jumpWorked: !!out.jumpWorked
    };
    // Item 1's pass condition is NOT a fixed fill percentage. With a fixed
    // number of chips the row count and the fill trade off against each other:
    // a 25-chip strip that fits two rows is at its best when the two rows are
    // EVEN, and "even" for 13+12 IS ~90-98% — but a 9-chip strip on one row
    // cannot be measured against the same bar. What must hold is:
    //   - it never spills past two rows,
    //   - no row overflows its container,
    //   - the rows it does use are balanced,
    //   - the chips visibly grew (scale > 1: the strip is not sitting at its
    //     un-sized default), and
    //   - the fill is high enough to read as "packed", which for a two-row
    //     balanced layout means >= 80% on the THINNER row.
    // The scale assertion is what proves the strip actually responded to the
    // request to make the titles bigger; without it a 60%-fill default layout
    // would pass.
    out.item1_grew = out.chipScale > 1.2;
    out.item1_fillPacked = out.rows === 2 ? out.thinnestFill >= 80 : out.thinnestFill >= 70;
    var item1 = out.withinTwoRows && out.noRowOverflows && out.rowsBalanced &&
      out.visualLinesMatchFocusRows && out.item1_grew && out.item1_fillPacked;
    var item2 = out.pagerPresent && out.batchButtons >= 2 && !!out.currentBatch && !!out.jumpWorked;
    out.ok = item1 && item2;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
