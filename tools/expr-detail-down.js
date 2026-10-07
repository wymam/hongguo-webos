(function () {
  // Reproduce the report: "进入剧集后焦点在播放按钮上，但按下键无法到集数上".
  //
  // Drives the REAL key path (synthetic ArrowDown keydown, same as the remote)
  // from the detail page's Play button and asserts the ring lands on an episode
  // cell — and that Up comes back.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  function key(k) {
    var init = { key: k, keyCode: k === 'ArrowDown' ? 40 : k === 'ArrowUp' ? 38 : 37, which: k === 'ArrowDown' ? 40 : k === 'ArrowUp' ? 38 : 37, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.focused');
    return el ? (el.innerText || '').trim().slice(0, 20) : null;
  }

  // Make sure we start from a feed, with NO player mounted.
  //
  // Clicking player-back-0 is NOT enough: once the 5s auto-hide has fired the
  // overlay (and therefore the button) is gone from the DOM, so the click is a
  // no-op and the app stays stuck in the player — whose custom key handler then
  // eats every arrow key on the page behind it. The real remote uses Back,
  // which the app handles as the `tv-back` event, so that is what we dispatch.
  function back() {
    window.dispatchEvent(new CustomEvent('tv-back'));
  }
  function ensureFeed() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) {
        var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
        if (nav) nav.click();
        return sleep(1800);
      }
      var v = document.querySelector('video');
      if (v) { try { v.pause(); } catch (e) {} }
      back();
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  return ensureFeed().then(function () {
    out.prePlayerRoot = !!document.querySelector('.player-root');
    out.preCustom = window.__focusState ? window.__focusState().custom : null;
    // Enter the first card -> detail page.
    click('content-1-0') || click('content-0-0');
    return sleep(3000);
  }).then(function () {
    out.onDetail = !!document.querySelector('[data-focus-id="action-0-0"]');
    out.entryFocus = cur();          // expect action-0-0 (the Play button)
    out.entryFocusText = curText();
    out.steps.push('entry=' + out.entryFocus);
    return sleep(400);
  }).then(function () {
    key('ArrowDown');                 // THE reported failing key
    return sleep(600);
  }).then(function () {
    out.afterDown = cur();
    out.afterDownText = curText();
    out.downReachedEpisodes = !!out.afterDown && out.afterDown.indexOf('episode-') === 0;
    out.steps.push('afterDown=' + out.afterDown);
    if (!out.downReachedEpisodes) {
      out.diag = {
        focusedClass: (document.querySelector('.focused') || {}).className || null,
        customHandler: window.__focusState ? window.__focusState().custom : null,
        registered: window.__focusState ? window.__focusState().registered : null
      };
    }
    return sleep(300);
  }).then(function () {
    // Keep going down: should walk to the next episode row.
    key('ArrowDown');
    return sleep(600);
  }).then(function () {
    out.afterDown2 = cur();
    out.steps.push('afterDown2=' + out.afterDown2);
    return sleep(300);
  }).then(function () {
    // And back up twice: episode -> episode -> action row.
    key('ArrowUp');
    return sleep(500);
  }).then(function () {
    out.afterUp1 = cur();
    return sleep(200);
  }).then(function () {
    key('ArrowUp');
    return sleep(600);
  }).then(function () {
    out.afterUp2 = cur();             // expect action-0-0 again
    out.upReturnedToAction = out.afterUp2 === 'action-0-0' || out.afterUp2 === 'action-0-1';
    out.steps.push('afterUp2=' + out.afterUp2);
    out.episodeCells = document.querySelectorAll('[data-focus-id^="episode-"]').length;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    return JSON.stringify(out, null, 2);
  });
})()
