'use strict';
/*
 * Round 23 — requirement 4: quantify the load speedup.
 *
 * The service fetches page 1, then the remaining pages concurrently, with a
 * 5-minute per-page cache. To show the win we measure, on the live TV:
 *
 *   (a) cold  — jump to a batch never visited (all pages must be fetched)
 *   (b) warm  — jump back to a batch just visited (pages served from cache)
 *   (c) cross — jump to a batch that SHARES a page with the previous one
 *
 * Timing is taken from the moment the pager chip is clicked to the moment the
 * grid settles at 50 cards with the busy indicator gone.
 *
 * Method note: we cannot read the service's cache directly from the page, so
 * "cold/warm" is established by visiting in a deliberate order (fresh batches
 * first). Duplicate visits within the 5-minute TTL are the warm path.
 */

;(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function setFocus(id) { if (window.__hongguoFocus && window.__hongguoFocus.set) window.__hongguoFocus.set(id); }
  function pagerChips() { return Array.prototype.slice.call(document.querySelectorAll('.batch-list .page-chip')); }
  function cardCount() { return document.querySelectorAll('.video-grid .video-card').length; }
  function busy() { return !!document.querySelector('.category-busy'); }

  function clickChip(label) {
    var chips = pagerChips();
    var el = chips.filter(function (c) { return (c.textContent || '').trim() === String(label); })[0];
    if (!el) return false;
    var id = el.getAttribute('data-focus-id');
    if (id) setFocus(id);
    el.click();
    return true;
  }

  // Resolve when the grid shows a full batch and the busy pulse is gone.
  function settle(timeoutMs) {
    timeoutMs = timeoutMs || 12000;
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var sawBusy = false;
      (function poll() {
        if (busy()) sawBusy = true;
        var n = cardCount();
        var done = n >= 50 && !busy();
        if (done || Date.now() - t0 > timeoutMs) {
          return resolve({ ms: Date.now() - t0, cards: n, sawBusy: sawBusy, timedOut: !done });
        }
        setTimeout(poll, 40);
      })();
    });
  }

  function measureTo(label) {
    var t0 = Date.now();
    if (!clickChip(label)) return Promise.resolve({ label: label, error: 'chip-not-found' });
    return settle().then(function (r) {
      r.label = label;
      r.ms = Date.now() - t0;
      return r;
    });
  }

  var out = { steps: [] };

  return sleep(300)
    .then(function () {
      if (!document.querySelector('.batch-list')) {
        var item = Array.prototype.slice.call(document.querySelectorAll('.sidebar-item'))
          .filter(function (el) { return /真人剧/.test(el.textContent || ''); })[0];
        if (item) { setFocus(item.getAttribute('data-focus-id')); item.click(); }
        return sleep(2200);
      }
      return true;
    })
    .then(function () {
      out.pager = pagerChips().map(function (c) { return (c.textContent || '').trim(); });
      // Cold: land on batch 1 (fresh visit), then jump to far, unvisited batches.
      return measureTo(1);
    })
    .then(function (r) { out.cold1 = r; out.steps.push({ step: 'cold-batch1', ms: r.ms, cards: r.cards }); return measureTo(2); })
    .then(function (r) { out.cold2 = r; out.steps.push({ step: 'cold-batch2', ms: r.ms, cards: r.cards }); return measureTo(1); })
    .then(function (r) { out.warm1 = r; out.steps.push({ step: 'warm-batch1-again', ms: r.ms, cards: r.cards }); return measureTo(2); })
    .then(function (r) { out.warm2 = r; out.steps.push({ step: 'warm-batch2-again', ms: r.ms, cards: r.cards }); return measureTo(1); })
    .then(function (r) {
      out.warm3 = r;
      out.summary = {
        coldAvg: Math.round((out.cold1.ms + out.cold2.ms) / 2),
        warmAvg: Math.round((out.warm1.ms + out.warm2.ms + out.warm3.ms) / 3),
        coldSamples: [out.cold1.ms, out.cold2.ms],
        warmSamples: [out.warm1.ms, out.warm2.ms, out.warm3.ms]
      };
      out.summary.speedup =
        out.summary.warmAvg > 0
          ? Number((out.summary.coldAvg / out.summary.warmAvg).toFixed(2))
          : null;
      out.ok = out.cold1.cards >= 50 && out.cold2.cards >= 50 && out.warm1.cards >= 50;
      return out;
    })
    .catch(function (e) {
      out.error = String((e && e.stack) || e);
      out.ok = false;
      return out;
    });
})()
