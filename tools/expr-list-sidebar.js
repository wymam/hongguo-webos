(function () {
  // List every registered sidebar item with its label and focus id, so probes
  // can address them by NAME instead of guessing an index.
  var rows = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]')).map(function (el) {
    return { id: el.getAttribute('data-focus-id'), text: (el.innerText || '').replace(/\s+/g, ' ').trim() };
  });
  var reg = (window.__hongguoFocus && window.__hongguoFocus.list) ? window.__hongguoFocus.list() : [];
  return JSON.stringify({
    sidebarItems: rows,
    sidebarRegistered: reg.filter(function (i) { return i.indexOf('sidebar-') === 0; }),
    current: window.__focusState ? window.__focusState().current : null
  }, null, 2);
})()
