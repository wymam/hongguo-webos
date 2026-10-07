'use strict';
/*
 * Round 23 — cross-batch dedup verification.
 *
 * Text comparison produced false positives (different shows share episode
 * counts; vertical titles render as a single glyph). The only stable identity
 * on a card is the artwork hash inside <img src=".../novel-pic/<hash>~tplv...">.
 * Use that as the key.
 *
 * Navigate to 真人剧 first (the app may be sitting on a detail page after the
 * previous probe), then: batch 1 -> harvest 50 keys -> batch 2 -> harvest 50
 * keys -> intersect. Expect zero overlap and all-distinct keys.
 */

;(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function keyOf(card) {
    var img = card && card.querySelector ? card.querySelector('img') : null;
    var src = img ? img.getAttribute('src') || '' : '';
    var m = src.match(/novel-pic\/([0-9a-f]{16,})/i);
    if (m) return m[1].toLowerCase();
    if (src) return 'src:' + src;
    var t = card && card.textContent ? card.textContent.trim() : '';
    return 'txt:' + t;
  }

  function gridCards() {
    return Array.prototype.slice.call(document.querySelectorAll('.video-grid .video-card'));
  }

  function pagerChips() {
    return Array.prototype.slice.call(document.querySelectorAll('.batch-list .page-chip'));
  }

  function rangeText() {
    var el = document.querySelector('.category-current');
    return el ? (el.textContent || '').trim() : '';
  }

  function headerText() {
    var h = document.querySelector('.grid-header');
    return h ? (h.textContent || '').trim().replace(/\s+/g, ' ') : '';
  }

  function harvest() {
    var cards = gridCards();
    var keys = [];
    var missing = 0;
    for (var i = 0; i < cards.length; i++) {
      var k = keyOf(cards[i]);
      if (k.indexOf('src:') === 0) missing++;
      keys.push(k);
    }
    return { count: cards.length, missingImg: missing, keys: keys };
  }

  function setFocus(id) {
    if (window.__hongguoFocus && window.__hongguoFocus.set) window.__hongguoFocus.set(id);
  }

  function clickEl(el) {
    if (!el) return false;
    var id = el.getAttribute('data-focus-id');
    if (id) setFocus(id);
    el.click();
    return true;
  }

  var out = { steps: [] };

  function waitForGrid(tries) {
    tries = tries || 40;
    return new Promise(function (resolve) {
      var n = 0;
      (function poll() {
        if (document.querySelector('.video-grid .video-card')) return resolve(true);
        if (++n >= tries) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }

  return sleep(300)
    .then(function () {
      // Already on a category page?
      if (document.querySelector('.filter-grid') && document.querySelector('.batch-list')) {
        out.steps.push('already-on-category');
        return true;
      }
      // Otherwise hop to 真人剧 through the sidebar.
      var item = Array.prototype.slice.call(document.querySelectorAll('.sidebar-item'))
        .filter(function (el) { return /真人剧/.test(el.textContent || ''); })[0];
      out.steps.push({ step: 'nav-to-real', found: !!item });
      if (!item) return false;
      clickEl(item);
      return sleep(1800).then(function () { return true; });
    })
    .then(function (okNav) {
      if (!okNav) return false;
      return waitForGrid().then(function (ok) {
        out.steps.push({ step: 'grid-ready', ok: ok });
        return ok;
      });
    })
    .then(function (ok) {
      if (!ok) { out.error = 'no category grid'; return out; }
      var chips = pagerChips();
      out.pagerCount = chips.length;
      out.pagerLabels = chips.map(function (c) { return (c.textContent || '').trim(); });
      // Go to batch 1 (the "1" chip).
      var one = chips.filter(function (c) { return (c.textContent || '').trim() === '1'; })[0] || chips[0];
      clickEl(one);
      return sleep(1800);
    })
    .then(function () {
      out.batch1 = harvest();
      out.batch1Header = headerText();
      out.steps.push({ step: 'harvest-batch1', count: out.batch1.count, missingImg: out.batch1.missingImg });
      var chips = pagerChips();
      out.pagerAfter1 = chips.map(function (c) { return (c.textContent || '').trim(); });
      var two = chips.filter(function (c) { return (c.textContent || '').trim() === '2'; })[1] ||
                chips[1];
      out.steps.push({ step: 'goto-batch2', label: two ? (two.textContent || '').trim() : null });
      clickEl(two);
      return sleep(2000);
    })
    .then(function () {
      out.batch2 = harvest();
      out.batch2Header = headerText();

      var a = out.batch1.keys || [];
      var b = out.batch2.keys || [];
      var setA = {}; a.forEach(function (k) { setA[k] = 1; });
      var setB = {}; b.forEach(function (k) { setB[k] = 1; });
      var overlap = b.filter(function (k) { return setA[k]; });

      out.dedup = {
        batch1Count: a.length,
        batch2Count: b.length,
        batch1Unique: Object.keys(setA).length,
        batch2Unique: Object.keys(setB).length,
        overlapCount: overlap.length,
        overlapSample: overlap.slice(0, 8),
        ok: overlap.length === 0 &&
            Object.keys(setA).length === a.length &&
            Object.keys(setB).length === b.length &&
            a.length > 0 && b.length > 0 &&
            out.batch1.missingImg === 0 && out.batch2.missingImg === 0
      };
      out.batch1Head = a.slice(0, 5);
      out.batch2Head = b.slice(0, 5);
      out.ok = out.dedup.ok;
      return out;
    })
    .catch(function (e) {
      out.error = String((e && e.stack) || e);
      out.ok = false;
      return out;
    });
})()
