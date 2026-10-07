(function () {
  // The Enter key did not open the detail page when dispatched on `document`.
  // The handler is registered on `window`, and React's onSelect lives on the
  // card. Try the most direct route that mirrors a real OK press: dispatch on
  // window with a proper keyCode, and if the DOM has not changed, fall back to
  // a real click on the focused card.
  var before = document.querySelector('.video-grid') ? 'home' : 'other';
  var card = document.querySelector('.video-card.focused') || document.querySelector('.video-card');

  function dispatch(target, type, keyCode, key) {
    var ev = new KeyboardEvent(type, {
      key: key, code: key, keyCode: keyCode, which: keyCode,
      bubbles: true, cancelable: true, composed: true
    });
    // keyCode/which are read-only on the constructed event in some engines;
    // define them explicitly so the handler's keyCode checks see the value.
    try { Object.defineProperty(ev, 'keyCode', { get: function () { return keyCode; } }); } catch (e) {}
    try { Object.defineProperty(ev, 'which', { get: function () { return keyCode; } }); } catch (e) {}
    target.dispatchEvent(ev);
  }

  var trace = [];
  trace.push('before=' + before + ' card=' + (card ? card.getAttribute('data-focus-id') : 'none'));

  // Route 1: Enter on window.
  dispatch(window, 'keydown', 13, 'Enter');
  trace.push('after-window-enter hash=' + location.hash);

  return new Promise(function (resolve) {
    setTimeout(function () {
      var v1 = document.querySelector('video');
      if (v1) return done('window-enter');
      // Route 2: real click on the card.
      if (card) { card.click(); trace.push('clicked-card'); }
      setTimeout(function () {
        var v2 = document.querySelector('video');
        if (v2) return done('card-click');
        // Route 3: click the card's inner link/button if any.
        var btn = card && (card.querySelector('a,button') || card);
        if (btn && btn !== card) { btn.click(); trace.push('clicked-inner'); }
        setTimeout(function () { done('fallback'); }, 3500);
      }, 3500);
    }, 3500);

    function done(via) {
      var video = document.querySelector('video');
      resolve(JSON.stringify({
        via: via,
        trace: trace,
        hash: location.hash,
        hasVideo: !!video,
        videoSrc: video ? (video.currentSrc || video.src || '').slice(0, 120) : null,
        readyState: video ? video.readyState : null,
        networkState: video ? video.networkState : null,
        duration: video && isFinite(video.duration) ? Math.round(video.duration) : null,
        videoW: video ? video.videoWidth : null,
        videoH: video ? video.videoHeight : null,
        currentTime: video ? Math.round(video.currentTime * 100) / 100 : null,
        paused: video ? video.paused : null,
        error: video && video.error ? { code: video.error.code, msg: video.error.message } : null,
        bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220)
      }, null, 2));
    }
  });
})()
