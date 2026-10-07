'use strict';
/*
 * Round 23 — requirement 4, part 2: genuine cold-vs-warm on a FAR batch.
 *
 * The first script measured batch 1 cold (2190 ms) but that figure carries the
 * category page's own first-render cost. This one jumps to batch 16 — never
 * visited, and far enough that its pages cannot share with batches 1/2 — then
 * back to it, so the same batch is measured cold and warm with nothing else
 * changing. That isolates the network cost the cache removes.
 */

;(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function setFocus(id) { if (window.__hongguoFocus && window.__hongguoFocus.set) window.__hongguoFocus.set(id); }
  function pagerChips() { return Array.prototype.slice.call(document.querySelectorAll('.batch-list .page-chip')); }
  function cardCount() { return document.querySelectorAll('.video-grid .video-card').length; }
  function busy() { return !!document.querySelector('.category-busy'); }
  function labels() { return pagerChips().map(function (c) { return (c.textContent || '').trim(); }); }

  function clickChip(label) {
    var el = pagerChips().filter(function (c) { return (c.textContent || '').trim() === String(label); })[0];
    if (!el) return false;
    var id = el.getAttribute('data-focus-id');
    if (id) setFocus(id);
    el.click();
    return true;
  }

  function settle(timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    return new Promise(function (resolve) {
      var t0 = Date.now(), sawBusy = false;
      (function poll() {
        if (busy()) sawBusy = true;
        var n = cardCount();
        if ((n >= 50 && !busy()) || Date.now() - t0 > timeoutMs) {
          return resolve({ ms: Date.now() - t0, cards: n, sawBusy: sawBusy });
        }
        setTimeout(poll, 40);
      })();
    });
  }

  function go(label) {
    var t0 = Date.now();
    if (!clickChip(label)) return Promise.resolve({ label: label, error: 'chip-not-found', ms: -1 });
    return settle().then(function (r) { r.label = label; r.ms = Date.now() - t0; return r; });
  }

  // To reach batch 16 when the pager is windowed to [1,2,3,4,…,16] we may need
  // to click 16 directly; the window always keeps the last one visible.
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
      out.pagerBefore = labels();
      // Cold: batch 1 -> far batch 16.
      return go(1).then(function (r) { out.warmSeed = { label: 1, ms: r.ms, cards: r.cards }; return go(16); });
    })
    .then(function (r) {
      out.coldFar = r;
      out.steps.push({ step: 'cold-far-16', ms: r.ms, cards: r.cards, sawBusy: r.sawBusy });
      out.pagerAfterFar = labels();
      // Warm: back to batch 1, then out to 16 again (pages now cached).
      return go(1);
    })
    .then(function (r) {
      out.midBack = { label: 1, ms: r.ms, cards: r.cards };
      return go(16);
    })
    .then(function (r) {
      out.warmFar = r;
      out.steps.push({ step: 'warm-far-16-again', ms: r.ms, cards: r.cards, sawBusy: r.sawBusy });
      out.summary = {
        coldFarMs: out.coldFar.ms,
        warmFarMs: out.warmFar.ms,
        coldFarCards: out.coldFar.cards,
        warmFarCards: out.warmFar.cards
      };
      if (out.warmFar.ms > 0) {
        out.summary.speedup = Number((out.coldFar.ms / Math.max(1, out.warmFar.ms)).toFixed(2));
      }
      out.ok = out.coldFar.cards >= 50 && out.warmFar.cards >= 50;
      return out;
    })
    .catch(function (e) {
      out.error = String((e && e.stack) || e);
      out.ok = false;
      return out;
    });
})()
