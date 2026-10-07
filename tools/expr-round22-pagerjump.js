(function () {
  // Round 22b — self-contained verification of the batch pager jump.
  //
  // The previous probe left the app on another page between invocations, so a
  // second run could not find the buttons. Everything here happens in ONE
  // invocation: enter the category, read the pager, press a distant batch, and
  // confirm the page actually moved.
  //
  // The press goes through the REAL keyboard path (move focus with the D-pad,
  // then Enter). `el.click()` was tried first and changed nothing — it fires the
  // DOM handler but the app's pointer path calls `setFocus` and cancels content
  // focus, which is not how a remote drives it.
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  var RIGHT = 39, ENTER = 13, DOWN = 40;
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function pagerCurrent() {
    var el = document.querySelector('.batch-pager .page-chip.current');
    return el ? (el.innerText || '').trim() : null;
  }

  function backToHome(n) {
    if (n > 10) return sleep(300);
    if (document.querySelector('.hero') && !document.querySelector('.batch-pager')) return sleep(400);
    window.dispatchEvent(new CustomEvent('tv-back'));
    return sleep(850).then(function () { return backToHome(n + 1); });
  }

  function enterCategory() {
    var items = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'));
    var target = null;
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].innerText || '').trim();
      if (t.indexOf('真人剧') >= 0) { target = items[i]; break; }
    }
    if (!target) target = items[2];
    out.category = target ? (target.innerText || '').trim() : null;
    if (target) target.click();
    function wait(n) {
      if ((document.querySelector('.batch-pager') && document.querySelector('.filter-chip')) || n > 25) return sleep(400);
      return sleep(450).then(function () { return wait(n + 1); });
    }
    return sleep(1200).then(function () { return wait(0); });
  }

  return sleep(600).then(function () {
    return backToHome(0);
  }).then(function () {
    return enterCategory();
  }).then(function () {
    out.before = window.__hongguoBatches ? JSON.parse(JSON.stringify(window.__hongguoBatches)) : null;
    out.currentBefore = pagerCurrent();
    var els = [].slice.call(document.querySelectorAll('.batch-pager .page-chip'));
    out.labels = els.map(function (e) { return (e.innerText || '').trim(); });
    if (!out.before || !els.length) { out.error = 'no pager'; return null; }

    // Walk DOWN out of the grid onto the pager, then RIGHT onto the last
    // number. Driving it with real keys is the point: it proves the row is
    // reachable from the grid at all (which arithmetic alone could not do, as
    // the pager is its own focus group).
    if (window.__hongguoFocus) window.__hongguoFocus.set('content-0-0');
    return sleep(500).then(function () {
      out.focusStart = cur();
      // Find the grid's last row, then press Down once to land on the pager.
      var rows = {};
      [].slice.call(document.querySelectorAll('[data-focus-id^="content-"]')).forEach(function (e) {
        var m = /^content-(-?\d+)-\d+$/.exec(e.getAttribute('data-focus-id'));
        if (m) rows[m[1]] = true;
      });
      var keys = Object.keys(rows).map(Number).sort(function (a, b) { return a - b; });
      var last = keys[keys.length - 1];
      if (window.__hongguoFocus) window.__hongguoFocus.set('content-' + last + '-0');
      return sleep(500).then(function () {
        key('ArrowDown', DOWN);
        return sleep(600).then(function () {
          out.focusOnPager = cur();
          return null;
        });
      });
    });
  }).then(function () {
    // From wherever Down landed, walk Right to the LAST number button.
    var target = out.labels[out.labels.length - 1];
    out.target = target;
    var seen = [];
    function rightUntil(n) {
      var t = document.querySelector('.focused');
      var txt = t ? (t.innerText || '').trim() : null;
      seen.push(txt);
      if (txt === target || n > 12) return sleep(200);
      key('ArrowRight', RIGHT);
      return sleep(350).then(function () { return rightUntil(n + 1); });
    }
    if (!out.focusOnPager || String(out.focusOnPager).indexOf('page-') !== 0) {
      // Down did not land on the pager (it may have stopped in the grid).
      out.walkBlocked = true;
      return null;
    }
    return rightUntil(0).then(function () {
      out.rightWalk = seen;
      return null;
    });
  }).then(function () {
    if (out.walkBlocked || !out.target) return null;
    out.registryBefore = window.__hongguoFocus ? window.__hongguoFocus.list().filter(function (i) {
      return i.indexOf('page-0-') === 0;
    }) : null;
    out.focusAtEnter = cur();
    key('Enter', ENTER);
    // The press sends the page into `loading`, which REPLACES the whole page —
    // pager included — with the spinner while the service pulls three upstream
    // pages. So the marker to wait for is the pager COMING BACK, and only then
    // does reading `current` mean anything. (An earlier version polled for the
    // current marker and read `null`: it was querying a pager that had been
    // unmounted mid-flight.)
    function waitPagerBack(n) {
      var p = document.querySelector('.batch-pager');
      if (p && p.querySelector('.page-chip.current')) return sleep(300);
      if (n > 40) return sleep(200);
      return sleep(400).then(function () { return waitPagerBack(n + 1); });
    }
    return sleep(500).then(function () {
      out.sawLoading = !!document.querySelector('.page-state, .loading, [class*="loading"]');
      return waitPagerBack(0);
    });
  }).then(function () {
    out.after = window.__hongguoBatches ? JSON.parse(JSON.stringify(window.__hongguoBatches)) : null;
    out.currentAfter = pagerCurrent();
    out.jumpWorked = !!out.target && out.currentAfter === out.target;
    out.currentBatchMoved = !!(out.before && out.after && out.after.current !== out.before.current);
    out.ok = out.jumpWorked && out.currentBatchMoved;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
