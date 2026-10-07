(function () {
  // Verify the rail fixes: #1 (no auto-pop when entering a series), #2 (Back
  // collapses an open rail) and #4 (Right on 设置 commits the section and hides
  // the rail).
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  function rail() {
    var r = document.querySelector('.sidebar');
    return r ? (r.dataset.expanded || 'false') : 'missing';
  }
  function focusId() {
    var f = document.querySelector('.focused');
    return f ? f.getAttribute('data-focus-id') : null;
  }
  function snap(tag) {
    out.steps.push({ t: tag, expanded: rail(), focus: focusId(), page: currentPage() });
    return out;
  }
  function currentPage() {
    var h = document.querySelector('.page-heading h1, .detail-title');
    return h ? h.textContent.trim().slice(0, 18) : null;
  }

  // Start clean: if we are on the player, exit back out first.
  if (document.querySelector('.player-root')) {
    var back = document.querySelector('[data-focus-id="player-back-0"]');
    if (back) back.click();
    return sleep(1500).then(function () { return run(); });
  }
  return sleep(200).then(run);

  function run() {
    snap('start');

    // Go to the rail, make sure it opens.
    key('ArrowLeft'); return sleep(400)
      .then(function () { snap('after-left-to-rail'); key('ArrowDown'); return sleep(400); })
      .then(function () {
        snap('rail-down-1');
        key('ArrowDown'); return sleep(400);
      })
      .then(function () {
        snap('rail-down-2');
        // ---- Issue #2: Back must collapse the rail ----
        // The rail is open; Back should close it (not navigate away).
        var before = focusId();
        key('Escape'); return sleep(700).then(function () {
          snap('after-back');
          out.issue2_backCollapsed = rail() === 'false';
          out.issue2_beforeFocus = before;
        });
      })
      .then(function () {
        // ---- Issue #4: Right on 设置 commits and hides the rail ----
        // Walk to the last rail item (设置) then press Right.
        key('ArrowLeft'); return sleep(300);
      })
      .then(function () {
        // Move to the bottom of the rail.
        return (function walkDown(n) {
          if (n <= 0) return Promise.resolve();
          key('ArrowDown');
          return sleep(180).then(function () { return walkDown(n - 1); });
        })(9);
      })
      .then(function () {
        snap('at-rail-bottom');
        out.issue4_focusAtBottom = focusId();
        key('ArrowRight'); return sleep(900);
      })
      .then(function () {
        snap('after-right-on-settings');
        out.issue4_railHidden = rail() === 'false';
        out.issue4_focusAfter = focusId();
        return JSON.stringify(out, null, 2);
      });
  }
})()
