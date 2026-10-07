(function () {
  // Issue #1 regression probe: walk the ENTIRE sidebar rail with the D-pad.
  //
  // The original bug let the user reach only 搜索 and 推荐: sidebar ids encoded
  // the array index while every item registered row 0, so navigateGrid's
  // row+1 arithmetic kept returning the same / non-existent id. This probe
  // asserts the whole rail is reachable, in order, and that it wraps.
  var labels = [];
  var ids = [];

  function railItems() {
    return Array.prototype.slice.call(document.querySelectorAll('.sidebar [data-focus-id]'));
  }

  function focusedEntry() {
    var f = document.querySelector('.focused');
    if (!f) return null;
    var id = f.getAttribute('data-focus-id');
    var labelEl = f.querySelector('.sidebar-label');
    return {
      id: id,
      label: labelEl ? labelEl.textContent.trim() : (f.textContent || '').trim().slice(0, 12),
      expanded: (document.querySelector('.sidebar') || {}).dataset
        ? document.querySelector('.sidebar').dataset.expanded : null
    };
  }

  function key(name) {
    var code = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13 }[name] || 0;
    // The focus system binds on window; dispatch to window (not document) so
    // this matches the real remote path exactly.
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: name, code: name, keyCode: code, bubbles: true, cancelable: true
    }));
  }

  // Park focus on the first rail item, whichever it is (the app boots on 推荐).
  var items = railItems();
  var firstId = items.length ? items[0].getAttribute('data-focus-id') : null;
  if (firstId) {
    var firstEl = document.querySelector('[data-focus-id="' + firstId + '"]');
    if (firstEl) firstEl.click();
  }

  var e0 = focusedEntry();
  labels.push(e0 ? e0.label : null);
  ids.push(e0 ? e0.id : null);

  // Walk down past the end of the rail to prove nothing is unreachable and that
  // the list wraps back to the top instead of dying.
  for (var i = 0; i < items.length + 2; i++) {
    key('ArrowDown');
    var e = focusedEntry();
    labels.push(e ? e.label : null);
    ids.push(e ? e.id : null);
  }

  // And one step back up from the top, which must land on the LAST item.
  key('ArrowUp');
  var up = focusedEntry();

  return JSON.stringify({
    railCount: items.length,
    railIds: items.map(function (el) { return el.getAttribute('data-focus-id'); }),
    walkLabels: labels,
    walkIds: ids,
    distinctLabels: labels.filter(function (v, i) { return v && labels.indexOf(v) === i; }),
    distinctCount: (function () {
      var s = {};
      labels.forEach(function (v) { if (v) s[v] = 1; });
      return Object.keys(s).length;
    })(),
    wrappedUpTo: up ? up.label : null,
    // The fix is only proven if every FOCUSABLE rail item is reachable. There
    // are 8 focusable entries (2 dividers are not focusable).
    allReachable: (function () {
      var s = {};
      labels.forEach(function (v) { if (v) s[v] = 1; });
      return Object.keys(s).length >= items.length;
    })()
  }, null, 2);
})()
