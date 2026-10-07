(function () {
  // We are on a detail page (or will be). Click the first episode to start
  // playback, then watch the <video> element for up to ~20s and report the
  // furthest state it reached. Slower and more patient than expr-play.js,
  // because the player must first resolve the stream through the service.
  var log = [];
  function report(tag) {
    var v = document.querySelector('video');
    if (!v) { log.push(tag + ': no-video'); return null; }
    var st = {
      t: tag,
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      dur: isFinite(v.duration) ? Math.round(v.duration) : null,
      w: v.videoWidth,
      h: v.videoHeight,
      cur: Math.round(v.currentTime * 100) / 100,
      err: v.error ? v.error.code : null,
      src: (v.currentSrc || v.src || '').split('/').pop()
    };
    log.push(JSON.stringify(st));
    return st;
  }

  var video = document.querySelector('video');
  if (!video) {
    // Open the first episode. Prefer a dedicated episode button, else any
    // element whose handler starts playback.
    var ep = document.querySelector('[class*=episode-item], [class*=episode-btn], [class*=ep-item]');
    if (ep) { ep.click(); log.push('clicked-episode-button'); }
    else {
      var play = document.querySelector('[class*=play], button');
      if (play) { play.click(); log.push('clicked-play'); }
    }
  } else {
    // Already on the player; nudge it to load.
    log.push('video-already-present');
    video.load();
  }

  return new Promise(function (resolve) {
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var st = report('t' + n);
      var v = document.querySelector('video');
      // Stop early once we have a definite verdict.
      var settled = st && (
        (st.readyState >= 2 && st.paused === false) ||
        (st.err && st.err > 0)
      );
      if (settled || n >= 10) {
        clearInterval(iv);
        var vv = document.querySelector('video');
        resolve(JSON.stringify({
          verdict: st && st.err ? ('ERROR_' + st.err)
                 : (st && st.readyState >= 2 ? 'LOADED'
                 : 'STILL_LOADING'),
          log: log,
          final: vv ? {
            readyState: vv.readyState, networkState: vv.networkState,
            paused: vv.paused, duration: isFinite(vv.duration) ? vv.duration : null,
            w: vv.videoWidth, h: vv.videoHeight, cur: vv.currentTime,
            error: vv.error ? { code: vv.error.code, msg: vv.error.message } : null
          } : null
        }, null, 2));
      }
    }, 2000);
  });
})()
