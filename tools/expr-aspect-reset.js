(function () {
  // Wipe the aspect cache and restart the app, so the next probe measures a
  // COLD first visit. Without this the accumulated localStorage entries make
  // any coverage number meaningless — a card can be tagged from a previous run
  // rather than from the probe under test.
  //
  // The reload is also what clears the in-memory attempt counter, which no
  // localStorage clear can reach.
  var before = 0;
  try {
    var m = JSON.parse(localStorage.getItem('hongguo_aspect') || '{}') || {};
    before = Object.keys(m).length;
    localStorage.removeItem('hongguo_aspect');
  } catch (e) { /* ignore */ }
  setTimeout(function () {
    try { location.reload(); } catch (e) { /* ignore */ }
  }, 400);
  return JSON.stringify({ clearedEntries: before, reloading: true }, null, 2);
})()
