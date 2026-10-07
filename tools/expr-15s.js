(function () {
  // Definitive test for issue #5 ("每集只播 15 秒就跳下一集").
  //
  // Hypothesis: the ceiling is a BYTE budget, not a clock. The proxy clamps
  // every response to SEG_SIZE (1 MiB) but reports the Content-Range as if the
  // client's much larger request had been honoured, so the media element
  // believes it has far more data than it actually received. Once the decoder
  // has consumed the bytes that ARE present, it hits the end of what it can
  // read and the <video> fires `ended` — which the player then treats as a
  // real end-of-episode and auto-advances.
  //
  // This probe plays the episode and records the exact currentTime at which
  // `ended` arrives, plus how the byte counter tracks it.
  var out = { samples: [] };
  var v = document.querySelector('video');
  if (!v) return Promise.resolve(JSON.stringify({ error: 'no video element' }, null, 2));

  out.duration = isFinite(v.duration) ? v.duration : null;
  out.startTime = v.currentTime;

  var t0 = Date.now();
  var endedAt = null;
  var endedWall = null;

  function onEnded() {
    endedAt = v.currentTime;
    endedWall = Math.round((Date.now() - t0) / 1000);
  }
  function onError() { out.errorCode = v.error ? v.error.code : null; }
  v.addEventListener('ended', onEnded);
  v.addEventListener('error', onError);

  try { if (v.paused) v.play(); } catch (e) {}

  return new Promise(function (resolve) {
    var iv = setInterval(function () {
      var vv = document.querySelector('video');
      if (!vv) { clearInterval(iv); return resolve(); }
      var buf = vv.buffered.length ? vv.buffered.end(vv.buffered.length - 1) : null;
      out.samples.push({
        wall: Math.round((Date.now() - t0) / 1000),
        cur: Math.round(vv.currentTime * 100) / 100,
        buf: buf === null ? null : Math.round(buf * 100) / 100,
        rs: vv.readyState,
        ns: vv.networkState
      });
      // Stop when the episode ends (the reported bug) or after 45s.
      if (endedWall !== null || out.samples.length >= 45) {
        clearInterval(iv);
        var last = out.samples[out.samples.length - 1];
        var maxBuf = 0;
        out.samples.forEach(function (s) { if (s.buf && s.buf > maxBuf) maxBuf = s.buf; });
        out.endedAtSeconds = endedAt === null ? null : Math.round(endedAt * 100) / 100;
        out.endedAfterWallSeconds = endedWall;
        out.maxBufferedEnd = Math.round(maxBuf * 100) / 100;
        out.verdict = endedAt !== null
          ? 'ENDED_EARLY_AT_' + Math.round(endedAt) + 's'
          : 'STILL_PLAYING';
        out.durationVsStop = (out.duration && endedAt !== null)
          ? Math.round((out.duration - endedAt) * 100) / 100 + 's left unwatched'
          : null;
        resolve(JSON.stringify(out, null, 2));
      }
    }, 1000);
  });
})()
