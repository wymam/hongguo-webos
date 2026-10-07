'use strict';
/*
 * Round 23b — the pager still NAVIGATES after the fixed-width change.
 *
 * Two measurement traps this probe exists to avoid, both found the hard way:
 *
 *  1. Focus is NOT `document.activeElement`. The app keeps its own registry and
 *     marks the current item with a `.focused` class; real DOM focus stays on
 *     BODY. Asserting on `document.activeElement` reports null forever.
 *  2. The row count must ignore the FOCUSED chip. `.page-chip.current.focused`
 *     applies `transform: scale(1.08)`, which changes its measured top and
 *     width by a couple of pixels — enough to look like a second row when it is
 *     not. So the geometry check measures the UNFOCUSED chips only.
 *
 * Checks:
 *   1. focus a pager chip, press Right -> focus moves to the next chip
 *   2. select the far chip -> the grid reloads and aria-current follows
 *   3. the chips are still a single row at full width
 */

;(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function setFocus(id) { if (window.__hongguoFocus && window.__hongguoFocus.set) window.__hongguoFocus.set(id); }
  function focusedId() {
    var el = document.querySelector('.focused');
    return el ? (el.getAttribute('data-focus-id') || el.id || null) : null;
  }
  function chips() { return Array.prototype.slice.call(document.querySelectorAll('.batch-list .page-chip')); }
  function label(el) { return el ? (el.textContent || '').trim() : null; }
  function cardCount() { return document.querySelectorAll('.video-grid .video-card').length; }
  function activeChipLabel() {
    var el = document.querySelector('.batch-list .page-chip[aria-current="page"]');
    return label(el);
  }
  // Rows among the chips that do NOT carry the focus ring.
  function rowCount() {
    var plain = chips().filter(function (c) { return c.className.indexOf('focused') < 0; });
    var tops = plain.map(function (c) { return Math.round(c.getBoundingClientRect().top); });
    return tops.filter(function (t, i) { return tops.indexOf(t) === i; }).length;
  }
  function sendKey(key) {
    return new Promise(function (resolve) {
      var map = { Right: 39, Left: 37, Up: 38, Down: 40, Enter: 13 };
      var code = map[key] || 0;
      var init = { key: key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
      window.dispatchEvent(new KeyboardEvent('keyup', init));
      setTimeout(resolve, 320);
    });
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
      var cs = chips();
      var one = cs.filter(function (c) { return label(c) === '1'; })[0] || cs[0];
      setFocus(one.getAttribute('data-focus-id'));
      one.click();
      return sleep(1800);
    })
    .then(function () {
      out.before = { focused: focusedId(), active: activeChipLabel(), cards: cardCount(), rows: rowCount() };
      return sendKey('Right');
    })
    .then(function () {
      out.afterRight = { focused: focusedId(), active: activeChipLabel() };
      return sendKey('Right');
    })
    .then(function () {
      out.afterRight2 = { focused: focusedId(), active: activeChipLabel() };
      var cs = chips();
      var last = cs[cs.length - 1];
      out.lastLabel = label(last);
      setFocus(last.getAttribute('data-focus-id'));
      last.click();
      return sleep(2400);
    })
    .then(function () {
      var hdr = document.querySelector('.grid-header');
      out.afterFar = {
        focused: focusedId(),
        active: activeChipLabel(),
        cards: cardCount(),
        rows: rowCount(),
        header: hdr ? (hdr.textContent || '').trim().replace(/\s+/g, ' ') : ''
      };
      out.checks = {
        rightWalkedFrom1: out.afterRight.focused === 'page-0-1',
        rightWalkedAgain: out.afterRight2.focused === 'page-0-2',
        farSelected: String(out.afterFar.active) === String(out.lastLabel),
        farLoaded: out.afterFar.cards >= 50,
        stillOneRow: out.afterFar.rows === 1
      };
      out.ok = Object.keys(out.checks).every(function (k) { return out.checks[k]; });
      return out;
    })
    .catch(function (e) {
      out.error = String((e && e.stack) || e);
      out.ok = false;
      return out;
    });
})()
