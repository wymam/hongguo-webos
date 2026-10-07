(function () {
  // Round 13, items 1-3 — verified on the real TV against the REAL DOM.
  //
  //   1. from a card, ArrowUp must reach the genre chips (爱情 / 年代 ...)
  //   2. the current-genre heading must be big (>= the chip font)
  //   3. one page of a category must hold >= 50 cards
  //
  // Item 1 is measured by WALKING (dispatching real keydowns) and recording the
  // focused id after each press — reading the registry would only prove the ids
  // exist, not that navigation reaches them.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const UP = 38, DOWN = 40, LEFT = 37, RIGHT = 39;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20) : null;
  }
  function snap(tag) { out.steps.push(tag + '=' + cur() + '[' + curText() + ']'); }

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function px(el, prop) {
    return el ? Math.round(parseFloat(window.getComputedStyle(el)[prop] || '0')) : null;
  }

  return ensureClean().then(function () {
    var nav = document.querySelector('[data-focus-id="sidebar-2-0"]');
    if (nav) nav.click();
    return sleep(3500);
  }).then(function () {
    // ---- item 2: heading typography vs the chips -------------------------
    var h = document.querySelector('.category-title');
    var chip = document.querySelector('.filter-chip');
    out.heading = {
      text: h ? (h.innerText || '').trim() : null,
      fontSize: px(h, 'fontSize'),
      fontWeight: h ? window.getComputedStyle(h).fontWeight : null
    };
    out.chipFontSize = px(chip, 'fontSize');
    out.headingBiggerThanChip = !!(out.heading.fontSize && out.chipFontSize &&
      out.heading.fontSize >= out.chipFontSize);

    // ---- chip grid shape (must be 2-D, not filter-0-N) -------------------
    var rows = {}, ids = [], texts = {};
    [].slice.call(document.querySelectorAll('[data-focus-id^="filter-"]')).forEach(function (el) {
      var id = el.getAttribute('data-focus-id');
      var m = /^filter-(-?\d+)-(\d+)$/.exec(id);
      if (!m) return;
      ids.push(id);
      rows[m[1]] = (rows[m[1]] || 0) + 1;
      texts[(el.innerText || '').trim()] = id;
    });
    out.chipCount = ids.length;
    out.chipRowKeys = Object.keys(rows).sort();
    out.chipRows = out.chipRowKeys.length;
    out.chipIs2D = out.chipRows > 1;
    out.loveId = texts['爱情'] || null;
    out.eraId = texts['年代'] || null;
    out.chipSample = Object.keys(texts).slice(0, 8);

    // ---- item 3: how many cards on this page ----------------------------
    var cards = document.querySelectorAll('[data-focus-id^="content-"]');
    out.cardCount = cards.length;
    var rowsC = {};
    [].slice.call(cards).forEach(function (el) {
      var m = /^content-(-?\d+)-(\d+)$/.exec(el.getAttribute('data-focus-id'));
      if (m) rowsC[m[1]] = true;
    });
    out.cardRowCount = Object.keys(rowsC).length;
    out.meets50 = out.cardCount >= 50;
    out.meets10Rows = out.cardRowCount >= 10;
    return null;
  }).then(function () {
    // ---- item 1: walk UP off the first card into the chip strip ----------
    if (window.__hongguoFocus) window.__hongguoFocus.set('content-0-0');
    return sleep(600);
  }).then(function () {
    snap('start');
    var seq = [];
    function upOnce(n) {
      key('ArrowUp', UP);
      return sleep(520).then(function () {
        seq.push(cur());
        if (n >= 4) return null;
        return upOnce(n + 1);
      });
    }
    return upOnce(0).then(function () { out.upSequence = seq; });
  }).then(function () {
    snap('afterUps');
    out.reachedChipStrip = !!cur() && String(cur()).indexOf('filter-') === 0;

    // Horizontal walk across the top chip row looking for 爱情 / 年代.
    function walkRight(n, seen) {
      var t = curText();
      if (t && seen.indexOf(t) < 0) seen.push(t);
      if (n >= 10) return seen;
      key('ArrowRight', RIGHT);
      return sleep(300).then(function () { return walkRight(n + 1, seen); });
    }
    return walkRight(0, []).then(function (seen) {
      out.rightWalkTexts = seen;
      out.rightSawLove = seen.indexOf('爱情') >= 0;
      out.rightSawEra = seen.indexOf('年代') >= 0;
      return null;
    });
  }).then(function () {
    // Down out of the strip: now that it is a real 4-row grid, each press
    // descends ONE row and only the BOTTOM row bridges into the cards. So walk
    // down until we land in `content` (or give up) — expecting 4 presses.
    var hops = [];
    function downOnce(n) {
      key('ArrowDown', DOWN);
      return sleep(520).then(function () {
        hops.push(cur());
        if (String(cur()).indexOf('content-') === 0) return hops;
        if (n >= 6) return hops;
        return downOnce(n + 1);
      });
    }
    return downOnce(0).then(function (h) { out.downHops = h; });
  }).then(function () {
    snap('afterDown');
    out.downReturnsToGrid = !!cur() && String(cur()).indexOf('content-') === 0;

    out.verdict = {
      item1_upReachesChips: out.reachedChipStrip,
      item1_loveReachable: out.rightSawLove,
      item1_eraReachable: out.rightSawEra,
      item1_downBackToGrid: out.downReturnsToGrid,
      item2_headingBiggerThanChip: out.headingBiggerThanChip,
      item3_atLeast50: out.meets50,
      item3_atLeast10Rows: out.meets10Rows
    };
    out.ok = out.reachedChipStrip && out.rightSawLove && out.rightSawEra &&
      out.downReturnsToGrid && out.headingBiggerThanChip && out.meets50 && out.meets10Rows;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
