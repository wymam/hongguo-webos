(function () {
  // Round-2 verification: #1 (OK/Right on a rail item hides the rail and opens
  // the page), #4 (browsing the rail previews the page), #5 (rail width).
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  var RAIL_LABELS = {};
  document.querySelectorAll('.sidebar [data-focus-id]').forEach(function (el) {
    RAIL_LABELS[el.getAttribute('data-focus-id')] = (el.querySelector('.sidebar-label') || {}).textContent;
  });

  function rail() {
    var r = document.querySelector('.sidebar');
    return r ? (r.dataset.expanded || 'false') : 'missing';
  }
  function railWidth() {
    var r = document.querySelector('.sidebar');
    return r ? getComputedStyle(r).width : null;
  }
  function focusId() {
    var f = document.querySelector('.focused');
    var id = f ? f.getAttribute('data-focus-id') : null;
    out._focusLabel = id && RAIL_LABELS[id] ? RAIL_LABELS[id] : null;
    return id;
  }
  // Which section the CONTENT pane is showing. The category name lives in
  // .page-eyebrow (the h1 shows the genre filter), so read that.
  function pane() {
    var eyebrow = document.querySelector('.page-eyebrow');
    if (eyebrow) return 'CAT:' + eyebrow.textContent.trim();
    if (document.querySelector('.config-intro')) return 'SETTINGS';
    if (document.querySelector('.detail-title')) return 'DETAIL';
    var h = document.querySelector('.page-heading h1');
    if (h) return 'H1:' + h.textContent.trim().slice(0, 16);
    if (document.querySelector('.search-input')) return 'SEARCH';
    return 'UNKNOWN';
  }
  function snap(tag) {
    var s = { t: tag, expanded: rail(), focus: focusId(), railLabel: out._focusLabel, pane: pane(), railWidth: railWidth() };
    out.steps.push(s);
    return s;
  }

  function goHome() {
    if (window.__hongguoFocus) window.__hongguoFocus.set('sidebar-1-0');
    return sleep(300).then(function () { key('Enter'); return sleep(3500); });
  }

  return Promise.resolve()
    .then(goHome)
    .then(function () {
      out.issue5_collapsedWidth = railWidth();
      snap('start');

      // ---- #4: browsing previews the page -----------------------------
      key('ArrowLeft');
      return sleep(600);
    })
    .then(function () {
      snap('on-rail');
      var trail = [];
      var chain = Promise.resolve();
      // Walk down: 推荐(1) -> 真人剧(2) -> 漫剧(3) -> AI剧(4)
      for (var i = 0; i < 3; i++) {
        chain = chain.then(function () {
          key('ArrowDown');
          return sleep(800).then(function () {
            var s = snap('preview-' + out.steps.length);
            trail.push({ focus: s.focus, railLabel: s.railLabel, pane: s.pane });
          });
        });
      }
      return chain.then(function () {
        out.issue4_previewTrail = trail;
        var panes = {};
        trail.forEach(function (x) { panes[x.pane] = 1; });
        out.issue4_distinctPanes = Object.keys(panes);
        out.issue4_pageChangedWithoutEnter = Object.keys(panes).length > 1;
      });
    })
    .then(function () {
      // ---- #1a: OK on 真人剧 ---------------------------------------------
      if (window.__hongguoFocus) window.__hongguoFocus.set('sidebar-2-0');
      return sleep(500);
    })
    .then(function () {
      snap('before-enter');
      key('Enter');
      return sleep(1600);
    })
    .then(function () {
      var s = snap('after-enter');
      out.issue1_enter_hidesRail = s.expanded === 'false';
      out.issue1_enter_pane = s.pane;
      out.issue1_enter_focusInContent = !!(s.focus && s.focus.indexOf('sidebar-') !== 0);
      out.issue1_enter_focus = s.focus;
      // ---- #1b: Right on 真人剧 ------------------------------------------
      key('ArrowLeft');
      return sleep(700);
    })
    .then(function () {
      if (window.__hongguoFocus) window.__hongguoFocus.set('sidebar-2-0');
      return sleep(500);
    })
    .then(function () {
      snap('before-right');
      key('ArrowRight');
      return sleep(1600);
    })
    .then(function () {
      var s = snap('after-right');
      out.issue1_right_hidesRail = s.expanded === 'false';
      out.issue1_right_pane = s.pane;
      out.issue1_right_focusInContent = !!(s.focus && s.focus.indexOf('sidebar-') !== 0);
      out.issue1_right_focus = s.focus;
      return JSON.stringify(out, null, 2);
    })
    .catch(function (e) {
      out.error = String(e && e.message || e);
      return JSON.stringify(out, null, 2);
    });
})()
