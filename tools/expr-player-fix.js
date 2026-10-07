(function () {
  // Covers issue #2 (player not filling the screen) and issue #3 (switching to
  // another episode of the same season fails).
  //
  // Step 1 measures the geometry that the "only a sliver on the right" bug
  // corrupted: the player container and the <video> inside it must both be the
  // full 1920x1080, and the container must not be a squashed flex item.
  //
  // Step 2 switches to a different episode by clicking its cell, then waits for
  // the new stream to load. Before the fix the reused <video> kept stale media
  // state and fired error code 4.

  function geom(tag) {
    var root = document.querySelector('.player-root');
    var v = document.querySelector('video');
    var out = { t: tag };
    if (root) {
      var rr = root.getBoundingClientRect();
      var cs = getComputedStyle(root);
      out.root = {
        w: Math.round(rr.width), h: Math.round(rr.height),
        left: Math.round(rr.left), top: Math.round(rr.top),
        position: cs.position, flexShrink: cs.flexShrink, zIndex: cs.zIndex
      };
    } else out.root = null;
    if (v) {
      var vr = v.getBoundingClientRect();
      out.video = {
        w: Math.round(vr.width), h: Math.round(vr.height),
        left: Math.round(vr.left), top: Math.round(vr.top),
        objectFit: getComputedStyle(v).objectFit,
        intrinsicW: v.videoWidth, intrinsicH: v.videoHeight,
        readyState: v.readyState, paused: v.paused,
        err: v.error ? v.error.code : null,
        src: (v.currentSrc || v.src || '').split('/').pop()
      };
    } else out.video = null;
    return out;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitVideo(maxMs) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        var v = document.querySelector('video');
        if (v && (v.readyState >= 2 || v.error)) return resolve(v);
        if (Date.now() - t0 > maxMs) return resolve(v || null);
        setTimeout(tick, 400);
      })();
    });
  }

  var report = { steps: [] };

  // --- get to a player ---------------------------------------------------
  var video = document.querySelector('video');
  if (!video) {
    // On a detail page: click the first episode cell to start playback.
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    report.steps.push('episode-cells-visible: ' + cells.length);
    if (cells.length) {
      cells[0].click();
      report.steps.push('clicked-episode: ' + cells[0].getAttribute('data-focus-id'));
    }
  } else {
    report.steps.push('video-already-present');
  }

  return sleep(2500)
    .then(function () { return waitVideo(20000); })
    .then(function (v) {
      report.geometryPlaying = geom('after-start');
      report.verdictStart = v
        ? (v.error ? 'ERROR_' + v.error.code : (v.readyState >= 2 ? 'LOADED' : 'STILL_LOADING'))
        : 'NO_VIDEO';
      return sleep(1200);
    })
    .then(function () {
      // --- issue #3: switch to a DIFFERENT episode of the same season ------
      var v1 = document.querySelector('video');
      var firstSrc = v1 ? (v1.currentSrc || v1.src || '') : '';
      report.firstSrc = firstSrc.split('/').pop();

      // Go back to the detail page so the episode grid is reachable.
      var back = document.querySelector('[data-focus-id="player-back-0"]');
      if (back) { back.click(); report.steps.push('clicked-player-back'); }
      return sleep(1800).then(function () {
        var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
        report.steps.push('cells-after-back: ' + cells.length);
        // Pick episode #2 so the src definitely differs from what just played.
        var target = cells[1] || cells[0];
        if (!target) return { switched: false };
        var targetId = target.getAttribute('data-focus-id');
        target.click();
        report.switchedTo = targetId;
        return { switched: true, switchedToId: targetId };
      });
    })
    .then(function (info) {
      if (!info.switched) { report.verdictSwitch = 'NO_EPISODE_CELL'; return null; }
      return sleep(2500).then(function () { return waitVideo(20000); }).then(function (v) {
        report.geometryAfterSwitch = geom('after-switch');
        report.verdictSwitch = v
          ? (v.error ? 'ERROR_' + v.error.code : (v.readyState >= 2 ? 'LOADED' : 'STILL_LOADING'))
          : 'NO_VIDEO';
        return sleep(1500);
      });
    })
    .then(function () {
      var v2 = document.querySelector('video');
      report.secondSrc = v2 ? (v2.currentSrc || v2.src || '').split('/').pop() : null;
      report.srcChanged = !!(report.firstSrc && report.secondSrc && report.firstSrc !== report.secondSrc);
      // Geometry verdict for issue #2.
      var g = report.geometryPlaying && report.geometryPlaying.root;
      report.fullscreenOk = !!(g && g.w >= 1900 && g.h >= 1060);
      report.videoFullscreenOk = !!(report.geometryPlaying && report.geometryPlaying.video
        && report.geometryPlaying.video.w >= 1900 && report.geometryPlaying.video.h >= 1060);
      return JSON.stringify(report, null, 2);
    });
})()
