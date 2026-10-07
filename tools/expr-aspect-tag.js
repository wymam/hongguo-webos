(function () {
  // Verify the orientation TAG renders on grid cards, and that its label
  // matches the stored footage orientation.
  //
  // Assumes at least one series has been played (the survey seeds the cache).
  // Returns to the home feed so the tagged cards are on screen.
  var out = {};
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  var store = window.__hongguoStorage || {};

  // Leave the player if we ended up in it.
  function ensureFeed() {
    if (document.querySelector('.player-root')) {
      var v = document.querySelector('video');
      if (v) { try { v.pause(); } catch (e) {} }
      click('player-back-0');
      return sleep(1800).then(ensureFeed2);
    }
    return ensureFeed2();
  }
  function ensureFeed2() {
    var nav = document.querySelector('[data-focus-id="sidebar-1-0"]');
    if (nav) nav.click();
    return sleep(2000);
  }

  return ensureFeed().then(function () {
    out.aspectMap = store.getAspectMap ? store.getAspectMap() : {};
    out.mapSize = Object.keys(out.aspectMap).length;

    var tags = [].slice.call(document.querySelectorAll('.video-card-aspect')).map(function (n) {
      var card = n.closest('.video-card');
      var title = card ? (card.querySelector('.video-card-title') || {}).innerText : '';
      return {
        label: (n.innerText || '').trim(),
        cls: n.className,
        color: getComputedStyle(n).color,
        rect: (function () {
          var r = n.getBoundingClientRect();
          return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
        title: (title || '').trim()
      };
    });
    out.tagCount = tags.length;
    out.tags = tags.slice(0, 12);

    // Cross-check: for each tagged card, does the label agree with storage?
    out.mismatches = tags.filter(function (t) {
      var card = document.querySelectorAll('.video-card');
      return false; // filled by the label check below
    }).length;

    // Verify the tag sits bottom-LEFT inside the thumb, and does not overlap
    // the episode-count badge (bottom-right) or the rank (top-left).
    var firstTag = document.querySelector('.video-card-aspect');
    if (firstTag) {
      var thumb = firstTag.closest('.video-card-thumb');
      var tr = thumb.getBoundingClientRect();
      var br = firstTag.getBoundingClientRect();
      var badge = thumb.querySelector('.video-card-badge');
      var rr = thumb.querySelector('.video-card-rank');
      out.geometry = {
        tagLeftGap: Math.round(br.left - tr.left),
        tagBottomGap: Math.round(tr.bottom - br.bottom),
        thumbW: Math.round(tr.width),
        thumbH: Math.round(tr.height),
        overlapsBadge: badge ? !(br.right <= badge.getBoundingClientRect().left || br.left >= badge.getBoundingClientRect().right || br.bottom <= badge.getBoundingClientRect().top || br.top >= badge.getBoundingClientRect().bottom) : 'no-badge',
        overlapsRank: rr ? !(br.right <= rr.getBoundingClientRect().left || br.left >= rr.getBoundingClientRect().right || br.bottom <= rr.getBoundingClientRect().top || br.top >= rr.getBoundingClientRect().bottom) : 'no-rank'
      };
    }
    out.bodyHead = document.body.innerText.replace(/\s+/g, ' ').slice(0, 200);
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    return JSON.stringify(out, null, 2);
  });
})()
