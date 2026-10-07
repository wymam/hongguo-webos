(function () {
  // Drive the real remote-control input path on the device and report the
  // focus/scroll outcome. This is the same sequence nav-check.js runs headless,
  // but executed against the app actually running on the TV.
  var log = [];
  function snap(label) {
    var f = document.querySelector('.focused');
    var g = document.querySelector('.video-grid');
    var vp = document.querySelector('.video-grid-viewport');
    var rect = f ? f.getBoundingClientRect() : null;
    var vpRect = vp ? vp.getBoundingClientRect() : null;
    log.push({
      step: label,
      focusId: f ? f.getAttribute('data-focus-id') : null,
      cardTop: rect ? Math.round(rect.top) : null,
      transform: g ? g.style.transform : null,
      inView: (rect && vpRect) ? (rect.top >= vpRect.top - 2 && rect.bottom <= vpRect.bottom + 2) : null
    });
  }

  function key(name) {
    var ev = new KeyboardEvent('keydown', {
      key: name, code: name, keyCode: name === 'ArrowDown' ? 40 : name === 'ArrowUp' ? 38 : 0,
      bubbles: true, cancelable: true
    });
    document.dispatchEvent(ev);
  }

  snap('initial');
  for (var i = 0; i < 3; i++) { key('ArrowDown'); snap('down-' + (i + 1)); }
  key('ArrowUp'); snap('up-1');
  key('ArrowRight'); snap('right-1');
  key('ArrowRight'); snap('right-2');
  key('ArrowLeft'); snap('left-1');

  var rows = [];
  log.forEach(function (l) {
    if (l.transform && l.transform.indexOf('translateY') >= 0) {
      var m = /-?([0-9.]+)px/.exec(l.transform);
      if (m) rows.push(Math.round(parseFloat(m[1])));
    }
  });

  return JSON.stringify({
    steps: log,
    scrolled: rows.length > 0,
    scrollValues: rows,
    distinctFocus: (function () {
      var s = {};
      log.forEach(function (l) { if (l.focusId) s[l.focusId] = 1; });
      return Object.keys(s);
    })(),
    allInView: log.every(function (l) { return l.inView !== false; })
  }, null, 2);
})()
