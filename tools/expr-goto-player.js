(function () {
  // Drive the app into the player through the REAL flow (home -> first card ->
  // detail -> first episode), so the shelf probe afterwards is meaningful.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }

  // If we are already on the player, we are done.
  if (document.querySelector('.player-root')) {
    return Promise.resolve(JSON.stringify({ already: 'player' }, null, 2));
  }

  // If on a detail page with episode cells, just start the first episode.
  var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
  if (cells.length) {
    cells[0].click();
    return sleep(3000).then(function () {
      return JSON.stringify({ started: 'episode', onPlayer: !!document.querySelector('.player-root') }, null, 2);
    });
  }

  // Otherwise we are on a feed page: enter the first content card.
  function waitForCards(n) {
    var cards = document.querySelectorAll('[data-focus-id^="content-"]');
    out.steps.push('cards-try' + n + ': ' + cards.length);
    if (cards.length || n > 10) return Promise.resolve(cards.length);
    return sleep(1500).then(function () { return waitForCards(n + 1); });
  }

  return waitForCards(1).then(function (n) {
    if (!n) return JSON.stringify({ error: 'no cards', out: out }, null, 2);
    click('content-1-0') || click('content-0-0');
    return sleep(3500);
  }).then(function () {
    var cells2 = document.querySelectorAll('[data-focus-id^="episode-"]');
    out.steps.push('episode-cells: ' + cells2.length);
    if (!cells2.length) return JSON.stringify({ error: 'no episode cells', out: out }, null, 2);
    cells2[0].click();
    return sleep(3500);
  }).then(function () {
    out.onPlayer = !!document.querySelector('.player-root');
    var v = document.querySelector('video');
    out.videoSrc = v ? (v.currentSrc || v.src || '').split('/').pop() : null;
    out.readyState = v ? v.readyState : null;
    out.err = v && v.error ? v.error.code : null;
    return JSON.stringify(out, null, 2);
  });
})()
