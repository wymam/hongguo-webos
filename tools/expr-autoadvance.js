(function () {
  // Reproduce issue #5 through the REAL flow and instrument every candidate
  // cause at once, so we stop guessing.
  //
  // Candidates for "每集只播 15 秒就跳到下一集":
  //   a) `ended` firing early (media thinks it finished)
  //   b) the <video> erroring, and the player's autoplayNext path advancing
  //   c) the focus system's HOLD_MS (800ms) swallowing an Enter and firing
  //      onSelect on the next-episode button
  //   d) the player remounting because `switchEpisode` changed identity
  //   e) magic-remote wheel/pointer synthesising input
  //
  // The probe listens on the video for EVERY media event, and observers on the
  // document record any focus change, so whichever fires first is visible.

  var events = [];
  var focusLog = [];
  var t0 = Date.now();

  function stamp() { return Math.round((Date.now() - t0) / 100) / 10; }

  var v = document.querySelector('video');
  if (!v) return Promise.resolve(JSON.stringify({ error: 'not on player', hint: 'run from player or detail page' }, null, 2));

  var MEDIA_EVENTS = [
    'loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'stalled',
    'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing',
    'waiting', 'seeking', 'seeked', 'ended', 'durationchange', 'timeupdate', 'pause', 'play'
  ];
  var seen = {};
  MEDIA_EVENTS.forEach(function (name) {
    v.addEventListener(name, function () {
      // timeupdate is noisy; record it at most once per second of media time.
      if (name === 'timeupdate') {
        var bucket = Math.floor(v.currentTime);
        if (seen['tu' + bucket]) return;
        seen['tu' + bucket] = 1;
      }
      events.push({
        t: stamp(),
        ev: name,
        cur: Math.round(v.currentTime * 100) / 100,
        dur: isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        rs: v.readyState,
        err: v.error ? v.error.code : null,
        src: (v.currentSrc || v.src || '').split('/').pop()
      });
    });
  });

  // Any focus move tells us if D-pad/magic-remote input is happening.
  window.addEventListener('keydown', function (e) {
    focusLog.push({ t: stamp(), key: e.key, keyCode: e.keyCode });
  });

  var startSrc = (v.currentSrc || v.src || '').split('/').pop();
  events.push({ t: 0, ev: 'PROBE_ATTACHED', cur: v.currentTime, dur: v.duration, src: startSrc });
  try { if (v.paused) v.play(); } catch (e) {}

  return new Promise(function (resolve) {
    var iv = setInterval(function () {
      var vv = document.querySelector('video');
      var srcNow = vv ? (vv.currentSrc || vv.src || '').split('/').pop() : null;
      // Stop if the source changed (= auto-advanced to another episode) or 40s pass.
      var changed = srcNow && srcNow !== startSrc;
      if (changed || stamp() > 40) {
        clearInterval(iv);
        var ended = events.filter(function (e) { return e.ev === 'ended'; });
        var errs = events.filter(function (e) { return e.ev === 'error'; });
        resolve(JSON.stringify({
          startSrc: startSrc,
          endSrc: srcNow,
          sourceChanged: !!changed,
          verdict: changed ? 'AUTO_ADVANCED' : 'NO_ADVANCE_IN_40S',
          endedEvents: ended,
          errorEvents: errs,
          // The event history right before the switch is what identifies the cause.
          lastEvents: events.slice(-25),
          keydowns: focusLog.slice(-15)
        }, null, 2));
      }
    }, 500);
  });
})()
