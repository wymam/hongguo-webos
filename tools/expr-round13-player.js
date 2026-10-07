(function () {
  // Round 13, item 5 — ArrowDown during full-screen playback must (a) reveal
  // the control shelf and (b) land the focus ON THE PLAY/PAUSE BUTTON, so the
  // viewer can decide instead of the UI deciding for them.
  //
  // Tested twice: once from a hidden shelf (the normal case, 5s auto-hide) and
  // once from a visible shelf, because the two paths are separate branches in
  // the key handler.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function key(k, code) {
    var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  const DOWN = 40;
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  // NOTE: scope every lookup to `.player-root`. The detail page stays mounted
  // underneath the player, and its episode cell keeps the global `.focused`
  // class, so an unscoped querySelector('.focused') reports `episode-1-0` and
  // looks like the player never took focus. The shelf highlight is its own
  // state (see PlayerButton: shelfIndex === index), not the generic registry.
  function cur() {
    var el = document.querySelector('.player-root .focused');
    return el ? el.getAttribute('data-focus-id') : null;
  }
  function curText() {
    var el = document.querySelector('.player-root .focused');
    return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20) : null;
  }
  function shelfVisible() { return !!document.querySelector('.player-overlay'); }
  function snap(tag) { out.steps.push(tag + '=' + cur() + '[' + curText() + ']'); }
  function vid() { return document.querySelector('.player-root video'); }

  function ensureClean() {
    function step(n) {
      if (!document.querySelector('.player-root') || n > 8) return sleep(900);
      window.dispatchEvent(new CustomEvent('tv-back'));
      return sleep(900).then(function () { return step(n + 1); });
    }
    return step(0);
  }
  function waitPlayer(n) {
    if (document.querySelector('.player-root') && vid() && vid().readyState >= 2) return sleep(1200);
    if (n > 20) return sleep(300);
    return sleep(800).then(function () { return waitPlayer(n + 1); });
  }

  return ensureClean().then(function () {
    // Real flow: home -> first card -> detail -> first episode.
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(3000);
  }).then(function () {
    click('content-1-0') || click('content-0-0');
    return sleep(3500);
  }).then(function () {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    out.episodeCells = cells.length;
    if (!cells.length) throw new Error('no episode cells');
    cells[0].click();
    return waitPlayer(0);
  }).then(function () {
    out.onPlayer = !!document.querySelector('.player-root');
    var v = vid();
    out.readyState = v ? v.readyState : null;
    out.duration = v ? Math.round((v.duration || 0) * 100) / 100 : null;

    // Let the 5s auto-hide fire, so the shelf is genuinely hidden.
    return sleep(6500);
  }).then(function () {
    out.shelfVisibleBefore = shelfVisible();
    snap('beforeDown');
    out.stepA_shelfHidden = !out.shelfVisibleBefore;

    // ---- A: down from a HIDDEN shelf ------------------------------------
    key('ArrowDown', DOWN);
    return sleep(600);
  }).then(function () {
    snap('A-afterDown');
    out.shelfVisibleAfterA = shelfVisible();
    out.A_focus = cur();
    out.A_text = curText();
    out.A_onPlayButton = cur() === 'player-play-0';

    // ---- B: down again while the shelf is already visible ---------------
    key('ArrowDown', DOWN);
    return sleep(600);
  }).then(function () {
    snap('B-afterDown');
    out.B_focus = cur();
    out.B_text = curText();
    out.B_onPlayButton = cur() === 'player-play-0';

    // ---- and the button must really be the pause control ----------------
    var btn = document.querySelector('[data-focus-id="player-play-0"]');
    out.playButtonText = btn ? (btn.innerText || '').replace(/\s+/g, ' ').trim() : null;

    out.verdict = {
      shelfAppearedOnDown: out.shelfVisibleAfterA,
      landedOnPlayButtonFromHidden: out.A_onPlayButton,
      stayedOnPlayButtonFromVisible: out.B_onPlayButton
    };
    out.ok = out.shelfVisibleAfterA && out.A_onPlayButton && out.B_onPlayButton;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String((e && e.message) || e);
    return JSON.stringify(out, null, 2);
  });
})()
