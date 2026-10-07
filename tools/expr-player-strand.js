(function () {
  // Regression: the player must not survive a rail navigation.
  //
  // PlayerPage is an overlay that owns the D-pad via setCustomKeyHandler, so a
  // player left mounted over another page swallows every arrow key there. This
  // drives: play -> click a rail item -> assert the player is gone and the D-pad
  // belongs to the page again.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  function key(k) {
    var code = k === 'ArrowDown' ? 40 : 38;
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  function cur() {
    var el = document.querySelector('.focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function custom() { return window.__focusState ? window.__focusState().custom : null; }

  // Start from a clean feed.
  function ensureFeed() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) {
        var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
        if (nav) nav.click();
        return sleep(1800);
      }
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }

  return ensureFeed().then(function () {
    out.prePlayer = !!document.querySelector('.player-root');
    out.preCustom = custom();
    // Open a series and start episode 1.
    click('content-1-0') || click('content-0-0');
    return sleep(2800);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    out.episodeCells = cells.length;
    if (!cells.length) throw new Error('no episodes');
    cells[0].click();
    return sleep(3500);
  }).then(function () {
    out.inPlayer = !!document.querySelector('.player-root');
    out.customInPlayer = custom();
    out.steps.push('inPlayer=' + out.inPlayer + ' custom=' + out.customInPlayer);
    // Now click a DIFFERENT rail item while the player is up (pointer users).
    var nav = document.querySelector('[data-focus-id="sidebar-3-0"]'); // 真人剧
    out.clicked = nav ? (nav.click(), true) : false;
    return sleep(2200);
  }).then(function () {
    out.playerAfterNav = !!document.querySelector('.player-root');
    out.customAfterNav = custom();
    out.steps.push('afterNav player=' + out.playerAfterNav + ' custom=' + out.customAfterNav);
    // And prove the D-pad works again: focus should be movable.
    var before = cur();
    key('ArrowDown');
    return sleep(600).then(function () {
      out.focusBefore = before;
      out.focusAfter = cur();
      out.dpadAlive = before !== cur();
      out.steps.push('dpad ' + before + ' -> ' + cur());
    });
  }).then(function () {
    out.ok = !out.playerAfterNav && !out.customAfterNav && out.dpadAlive;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    return JSON.stringify(out, null, 2);
  });
})()
