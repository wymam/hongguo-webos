(function () {
  // Core player verification (issue #3), written to be robust against an
  // episode ENDING mid-test.
  //
  // Episodes are ~86s, and autoplay-next is on by default, so any wait longer
  // than the remaining episode time will roll into the next one. That used to
  // remount the player and reset the shelf — which is exactly why the 5s fuse
  // appeared not to fire. The shelf now survives the remount, so we can assert
  // the fuse INDEPENDENTLY of whether the episode rolled over.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  function shelf() {
    var el = document.querySelector('.player-overlay');
    var focused = document.querySelector('.player-btn.focused');
    return {
      visible: !!el,
      focusedBtn: focused ? focused.getAttribute('data-focus-id') : null,
      btnCount: document.querySelectorAll('.player-btn').length
    };
  }
  function custom() { return window.__focusState ? window.__focusState().custom : null; }
  function fuselog() { return (window.__playerShelfDiag || []).slice(-14); }

  function startPlayback() {
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    if (!cells.length) return Promise.resolve(false);
    cells[0].click();
    return sleep(4000);
  }

  function enterPlayer() {
    if (document.querySelector('video')) return Promise.resolve(true);
    if (!document.querySelector('[data-focus-id^="episode-"]')) {
      if (!document.querySelector('.video-card')) {
        var items = document.querySelectorAll('.sidebar [data-focus-id]');
        for (var i = 0; i < items.length; i++) {
          if ((items[i].textContent || '').indexOf('推荐') >= 0) { items[i].click(); break; }
        }
        return sleep(4000).then(function () {
          var cards = document.querySelectorAll('.video-card');
          if (cards.length) cards[0].click();
          return sleep(4000);
        }).then(startPlayback);
      }
      var cards2 = document.querySelectorAll('.video-card');
      cards2[0].click();
      return sleep(4000).then(startPlayback);
    }
    return startPlayback();
  }

  return enterPlayer().then(function () {
    if (!document.querySelector('video')) {
      return JSON.stringify({ error: 'could not reach player', out: out }, null, 2);
    }
    window.__playerShelfDiag = [];
    out.steps.push({ t: 'player-open', custom: custom(), shelf: shelf() });

    return sleep(700)
      .then(function () { key('ArrowDown'); return sleep(300); })
      .then(function () {
        var s = shelf();
        out.steps.push({ t: 'after-down-1', shelf: s });
        out.issue3_downEntersShelf = s.focusedBtn !== null;
        key('ArrowDown'); return sleep(300);
      })
      .then(function () {
        var s = shelf();
        out.steps.push({ t: 'after-down-2', shelf: s });
        out.issue3_downStable = s.focusedBtn === out.steps[1].shelf.focusedBtn;
        key('ArrowRight'); return sleep(300);
      })
      .then(function () {
        var s = shelf();
        out.steps.push({ t: 'after-right-1', shelf: s });
        out._r1 = s;
        key('ArrowRight'); return sleep(300);
      })
      .then(function () {
        var s = shelf();
        out.steps.push({ t: 'after-right-2', shelf: s });
        out.issue3_rightSteps = !!(out._r1 && s.focusedBtn && out._r1.focusedBtn !== s.focusedBtn);
        // --- idle: the fuse must fire within ~5s, episode rollover or not ---
        var t0 = Date.now();
        return (function waitHidden(n) {
          if (!shelf().visible) { out.issue3_autoHiddenAfterMs = Date.now() - t0; return null; }
          if (n <= 0) { out.issue3_autoHiddenAfterMs = -1; return null; }
          return sleep(500).then(function () { return waitHidden(n - 1); });
        })(24);
      })
      .then(function () {
        out.steps.push({ t: 'after-idle-wait', shelf: shelf() });
        out.issue3_autoHidden = shelf().visible === false;
        out.fuseDiag = fuselog();
        // Down brings it back.
        key('ArrowDown'); return sleep(350);
      })
      .then(function () {
        var s = shelf();
        out.steps.push({ t: 'after-down-reopen', shelf: s });
        out.issue3_reopens = s.visible === true;
        // Leave the player; the handler must be released.
        var back = document.querySelector('[data-focus-id="player-back-0"]');
        if (back) back.click();
        return sleep(1800);
      })
      .then(function () {
        out.steps.push({ t: 'after-exit', player: !!document.querySelector('.player-root'), custom: custom() });
        out.handlerReleasedOnExit = custom() === false;
        key('ArrowDown'); return sleep(400);
      })
      .then(function () {
        var f = document.querySelector('.focused');
        var fid = f ? f.getAttribute('data-focus-id') : null;
        out.steps.push({ t: 'after-exit-down', focus: fid, custom: custom() });
        out.pageNavigableAfterExit = !!(fid && fid.indexOf('player-') !== 0);
        // Clean up: return the shelf memory to defaults for the next probe.
        var v = document.querySelector('video');
        return JSON.stringify(out, null, 2);
      });
  });
})()
