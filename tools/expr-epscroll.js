(function () {
  // Issue #6 driver. Navigate to 推荐, open the first card, then walk the
  // episode grid downward and measure whether the list scrolls.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  function findScrollBox() {
    var cell = document.querySelector('[data-focus-id^="episode-"]');
    if (!cell) return null;
    var p = cell.parentElement;
    while (p && p !== document.body) {
      var cs = getComputedStyle(p);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    // Fall back to the first auto/scroll ancestor even if not yet overflowing.
    p = cell.parentElement;
    while (p && p !== document.body) {
      var cs2 = getComputedStyle(p);
      if (cs2.overflowY === 'auto' || cs2.overflowY === 'scroll') return p;
      p = p.parentElement;
    }
    return null;
  }

  function snap(tag) {
    var box = findScrollBox();
    var f = document.querySelector('.focused');
    var fid = f ? f.getAttribute('data-focus-id') : null;
    var cell = (fid && /^episode-/.test(fid)) ? f : document.querySelector('[data-focus-id^="episode-"]');
    var rec = cell ? cell.getBoundingClientRect() : null;
    var boxRec = box ? box.getBoundingClientRect() : null;
    out.steps.push({
      t: tag,
      focus: fid,
      epText: cell ? (cell.textContent || '').trim() : null,
      scrollTop: box ? Math.round(box.scrollTop) : null,
      scrollHeight: box ? Math.round(box.scrollHeight) : null,
      clientHeight: box ? Math.round(box.clientHeight) : null,
      overflowY: box ? getComputedStyle(box).overflowY : null,
      cellTop: rec ? Math.round(rec.top) : null,
      cellBottom: rec ? Math.round(rec.bottom) : null,
      boxTop: boxRec ? Math.round(boxRec.top) : null,
      boxBottom: boxRec ? Math.round(boxRec.bottom) : null,
      inViewport: rec && boxRec ? (rec.bottom > boxRec.top + 2 && rec.top < boxRec.bottom - 2) : null
    });
  }

  function clickRail(label) {
    var items = document.querySelectorAll('.sidebar [data-focus-id]');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].textContent || '').indexOf(label) >= 0) { items[i].click(); return true; }
    }
    return false;
  }

  // Step 0: if a player is open (an earlier probe clicked a cell and started
  // playback), leave it first — the player owns the D-pad while mounted.
  if (document.querySelector('.player-root')) {
    var back = document.querySelector('[data-focus-id="player-back-0"]');
    if (back) back.click();
    return sleep(1800).then(function () {
      out.steps.push({ t: 'left-player', ok: !document.querySelector('.player-root') });
      return restart();
    });
  }
  return restart();

  function restart() {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    if (cells.length) return sleep(300).then(walkEpisodes);
    if (!document.querySelector('.video-card')) {
      out.steps.push({ t: 'clicked-rail', ok: clickRail('推荐') });
      return sleep(4000).then(function () {
        out.cardCount = document.querySelectorAll('.video-card').length;
        return openFirstCard();
      });
    }
    return sleep(200).then(openFirstCard);
  }

  function openFirstCard() {
    var cards = document.querySelectorAll('.video-card');
    out.cardCount = cards.length;
    if (!cards.length) return JSON.stringify({ error: 'still no cards', out: out }, null, 2);
    cards[0].click();
    return sleep(4000).then(function () {
      var c = document.querySelectorAll('[data-focus-id^="episode-"]');
      out.episodeCells = c.length;
      out.detailTitle = (document.querySelector('.detail-title') || {}).textContent || null;
      if (!c.length) return JSON.stringify({ error: 'no episode cells after opening', out: out }, null, 2);
      return walkEpisodes();
    });
  }

  function walkEpisodes() {
    // Park focus on the first episode cell WITHOUT playing it.
    //
    // Clicking a cell starts playback and an open player owns the D-pad, so the
    // probe uses the app's own focus entry point (window.__hongguoFocus.set),
    // which is the same setFocus the app calls internally. That observes real
    // focus state without pretending to be a thumb.
    var firstId = 'episode-1-0';
    var firstEl = document.querySelector('[data-focus-id="' + firstId + '"]');
    if (!firstEl) {
      // Fall back to whatever episode row 1 offers.
      var any = document.querySelector('[data-focus-id^="episode-1-"]');
      if (any) firstId = any.getAttribute('data-focus-id');
    }
    if (window.__hongguoFocus) window.__hongguoFocus.set(firstId);

    return sleep(600).then(function () {
      out.parkedFocus = (document.querySelector('.focused') || {}).getAttribute
        ? document.querySelector('.focused').getAttribute('data-focus-id') : null;
      if (document.querySelector('.player-root')) out.steps.push({ t: 'unexpected-player-open' });
      snap('at-row-1');
      var chain = Promise.resolve();
      for (var i = 0; i < 6; i++) {
        (function (n) {
          chain = chain.then(function () {
            key('ArrowDown');
            return sleep(320).then(function () { snap('down-' + (n + 1)); });
          });
        })(i);
      }
      return chain.then(function () {
        var first = null, last = null;
        for (var i = 0; i < out.steps.length; i++) {
          if (out.steps[i].t === 'at-row-1') first = out.steps[i];
          if (out.steps[i].t.indexOf('down-') === 0) last = out.steps[i];
        }
        out.scrolled = !!(first && last && last.scrollTop > first.scrollTop);
        out.scrollDelta = (first && last) ? (last.scrollTop - first.scrollTop) : null;
        out.stayedVisible = !!(last && last.inViewport);
        out.finalEpisode = last ? last.epText : null;
        out.customHandlerActive = window.__focusState ? window.__focusState().custom : null;
        return JSON.stringify(out, null, 2);
      });
    });
  }
})()
