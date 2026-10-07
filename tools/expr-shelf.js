(function () {
  // Verify the player fixes for the D-pad shelf (#3), the 5s auto-hide, and the
  // reachability of the settings list from the rail (#4).
  //
  // We drive the REAL keyboard path (window keydown/keyup, which is what the
  // focus system binds), not synthetic clicks, so the custom key handler is
  // genuinely exercised.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13 }[name] || 0;
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

  var v = document.querySelector('video');
  if (!v) return Promise.resolve(JSON.stringify({ error: 'not on player — run from the player page' }, null, 2));

  out.startSrc = (v.currentSrc || v.src || '').split('/').pop();

  // 1) Shelf starts visible (it does on mount), then Down should keep it open
  //    and put focus on a button.
  out.steps.push(['initial-shelf', shelf()]);

  return sleep(600)
    .then(function () { key('ArrowDown'); return sleep(250); })
    .then(function () {
      out.steps.push(['after-down-1', shelf()]);
      key('ArrowDown'); return sleep(250);
    })
    .then(function () {
      out.steps.push(['after-down-2', shelf()]);
      // 2) Right should walk the shelf buttons.
      key('ArrowRight'); return sleep(250);
    })
    .then(function () {
      out.steps.push(['after-right', shelf()]);
      key('ArrowRight'); return sleep(250);
    })
    .then(function () {
      out.steps.push(['after-right-2', shelf()]);
      // 3) Up returns to playback and hides the shelf.
      key('ArrowUp'); return sleep(300);
    })
    .then(function () {
      out.steps.push(['after-up', shelf()]);
      // 4) With the shelf hidden, Down must bring it back.
      key('ArrowDown'); return sleep(300);
    })
    .then(function () {
      out.steps.push(['after-down-reopen', shelf()]);
      // 5) Auto-hide: leave it alone for 6s while playing, expect it gone.
      return sleep(6200).then(function () {
        out.steps.push(['after-6s-idle', shelf()]);
        return JSON.stringify(out, null, 2);
      });
    });
})()
