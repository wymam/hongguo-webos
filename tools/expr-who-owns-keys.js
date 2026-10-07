(function () {
  // Pure observation, no driving: where is the app right now, and WHO owns the
  // D-pad? `custom: true` on a non-player page means a stale handler is eating
  // every arrow key.
  var st = window.__focusState ? window.__focusState() : null;
  var focused = document.querySelector('.focused');
  return JSON.stringify({
    focusState: st,
    playerRootPresent: !!document.querySelector('.player-root'),
    playerOverlayPresent: !!document.querySelector('.player-overlay'),
    videoPresent: !!document.querySelector('video'),
    detailPresent: !!document.querySelector('[data-focus-id="action-0-0"]'),
    episodeCells: document.querySelectorAll('[data-focus-id^="episode-"]').length,
    contentCards: document.querySelectorAll('[data-focus-id^="content-"]').length,
    currentFocusId: focused ? focused.getAttribute('data-focus-id') : null,
    currentFocusText: focused ? (focused.innerText || '').trim().slice(0, 30) : null,
    bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)
  }, null, 2);
})()
