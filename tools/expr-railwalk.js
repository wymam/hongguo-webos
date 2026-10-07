(function () {
  // Diagnostic: why does the rail walk stall? Walk down one step at a time and
  // record the focus id + registry state after each press, so a stall shows up
  // as the exact row where repetition begins.
  var out = { walk: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[name] || 0;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: name, code: name, keyCode: code, bubbles: true, cancelable: true }));
  }

  // Full registry dump: id -> {row,col,group}
  function registry() {
    var ids = [];
    document.querySelectorAll('[data-focus-id^="sidebar-"]').forEach(function (el) {
      ids.push(el.getAttribute('data-focus-id'));
    });
    return ids;
  }
  function focusId() {
    var f = document.querySelector('.focused');
    return f ? f.getAttribute('data-focus-id') : null;
  }
  function rail() {
    var r = document.querySelector('.sidebar');
    return r ? (r.dataset.expanded || 'false') : 'missing';
  }

  // Park focus on the first rail item.
  var items = registry();
  out.railIds = items;
  if (items.length) {
    var el = document.querySelector('[data-focus-id="' + items[0] + '"]');
    if (el) el.click();
  }
  out.start = { focus: focusId(), expanded: rail() };

  var chain = Promise.resolve();
  for (var i = 0; i < items.length + 3; i++) {
    (function (n) {
      chain = chain.then(function () {
        key('ArrowDown');
        return sleep(220).then(function () {
          out.walk.push({
            n: n + 1,
            focus: focusId(),
            expanded: rail(),
            pending: window.__focusState ? window.__focusState().pending : null,
            custom: window.__focusState ? window.__focusState().custom : null,
            registered: window.__focusState ? window.__focusState().registered : null
          });
        });
      });
    })(i);
  }

  return chain.then(function () { return JSON.stringify(out, null, 2); });
})()
