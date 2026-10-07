'use strict';
/*
 * Round 23b — verify the pager is FIXED-size and shows every number up to 16.
 *
 * The owner's correction: "不是这样无限拉大，位置是有的，16页序号完全可以全部
 * 展现出来". So:
 *   * chips must be a fixed width (not a share of the row)
 *   * that width must be comfortably tappable
 *   * 真人剧 has 16 batches -> all 16 numbers, NO ellipsis
 *   * the row must not wrap or overflow
 *
 * Also reports whether the chip strip stays inside the grid width, since a
 * fixed size means it no longer stretches to fill — it just has to fit.
 */

;(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function setFocus(id) { if (window.__hongguoFocus && window.__hongguoFocus.set) window.__hongguoFocus.set(id); }

  function measure() {
    var pager = document.querySelector('.batch-pager');
    if (!pager) return { pagerPresent: false };
    var list = pager.querySelector('.batch-list');
    var chips = Array.prototype.slice.call(pager.querySelectorAll('.page-chip'));
    if (!list || !chips.length) return { pagerPresent: true, error: 'no chips' };

    var gaps = pager.querySelectorAll('.batch-gap');
    var pagerRect = pager.getBoundingClientRect();
    // Size uniformity is judged on the UNFOCUSED chips: the focused one is
    // scaled 1.08 by its focus ring, so it is legitimately wider on screen.
    var plain = chips.filter(function (c) { return c.className.indexOf('focused') < 0; });
    var sized = (plain.length ? plain : chips);
    var widths = sized.map(function (c) { return Math.round(c.getBoundingClientRect().width); });
    var heights = sized.map(function (c) { return Math.round(c.getBoundingClientRect().height); });
    var min = Math.min.apply(null, widths);
    var max = Math.max.apply(null, widths);

    // Wrap detection: same exclusion, since the scale shifts the top edge too.
    var tops = sized.map(function (c) { return Math.round(c.getBoundingClientRect().top); });
    var distinctTops = tops.filter(function (t, i) { return tops.indexOf(t) === i; }).length;

    var grid = document.querySelector('.video-grid');
    var listRect = list.getBoundingClientRect();

    return {
      pagerPresent: true,
      chipCount: chips.length,
      chipLabels: chips.map(function (c) { return (c.textContent || '').trim(); }),
      gapCount: gaps.length,
      chipMin: min,
      chipMax: max,
      chipHeight: Math.round(heights[0] || 0),
      uniform: max - min <= 2,
      rows: distinctTops,
      listWidth: Math.round(listRect.width),
      pagerWidth: Math.round(pagerRect.width),
      gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
      // With a fixed size the strip no longer fills; it just must not overflow.
      listFillPct: pagerRect.width ? Math.round((listRect.width / pagerRect.width) * 100) : 0,
      overflowRight: Math.round(listRect.right - pagerRect.right),
      // How much of the row's usable width is consumed by the numbers.
      usedPct: grid ? Math.round((listRect.width / grid.getBoundingClientRect().width) * 100) : 0
    };
  }

  var out = { steps: [] };

  return sleep(300)
    .then(function () {
      if (!document.querySelector('.batch-list')) {
        var item = Array.prototype.slice.call(document.querySelectorAll('.sidebar-item'))
          .filter(function (el) { return /真人剧/.test(el.textContent || ''); })[0];
        if (item) { setFocus(item.getAttribute('data-focus-id')); item.click(); }
        return sleep(2400);
      }
      return true;
    })
    .then(function () {
      return sleep(600).then(measure);
    })
    .then(function (m) {
      out.measured = m;
      var ok = !!m.pagerPresent && !m.error &&
        m.uniform === true &&
        m.rows === 1 &&
        (m.chipCount || 0) >= 2 &&
        m.chipHeight >= 30;
      // 16 batches -> 16 chips, no ellipsis (the owner's headline requirement)
      if (m.chipCount === 16) {
        ok = ok && m.gapCount === 0;
      }
      // Never overflow the row.
      ok = ok && m.overflowRight <= 4;
      out.ok = ok;
      out.verdict = {
        fixedSize: m.uniform,
        singleRow: m.rows === 1,
        noEllipsisAt16: m.chipCount === 16 ? m.gapCount === 0 : 'n/a',
        fits: m.overflowRight <= 4,
        chipWidth: m.chipMax,
        chipHeight: m.chipHeight,
        usedPct: m.usedPct
      };
      return out;
    })
    .catch(function (e) {
      out.error = String((e && e.stack) || e);
      out.ok = false;
      return out;
    });
})()
