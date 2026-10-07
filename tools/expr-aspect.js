(function () {
  // End-to-end check of the orientation feature.
  //
  //   1. Drive home -> first card -> first episode -> player (real flow).
  //   2. Wait for loadedmetadata, read videoWidth/videoHeight.
  //   3. Assert the storage entry landed under the series id.
  //   4. Go back to the grid and assert the .video-card-aspect tag renders,
  //      with the expected label.
  //
  // Every step is recorded so a failure says WHICH link broke.
  var out = { steps: [] };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function click(id) {
    var el = document.querySelector('[data-focus-id="' + id + '"]');
    if (el) { el.click(); return true; }
    return false;
  }
  function aspectTags() {
    return [].slice.call(document.querySelectorAll('.video-card-aspect')).map(function (n) {
      return { text: (n.innerText || '').trim(), cls: n.className };
    });
  }
  function tagCount() { return document.querySelectorAll('.video-card-aspect').length; }

  var store = window.__hongguoStorage || {};
  out.storageApi = {
    hasAspectApi: typeof store.setAspect === 'function',
    hasGetAspect: typeof store.getAspect === 'function'
  };

  // Record what the grid looked like BEFORE, so we can prove the tag is new.
  out.tagsBefore = tagCount();

  var vid;

  function waitMetadata(n) {
    vid = document.querySelector('video');
    if (!vid) {
      if (n > 12) return Promise.resolve('no-video');
      return sleep(700).then(function () { return waitMetadata(n + 1); });
    }
    if (vid.videoWidth > 0 && vid.videoHeight > 0) return Promise.resolve('ok');
    if (n > 20) return Promise.resolve('timeout');
    return sleep(700).then(function () { return waitMetadata(n + 1); });
  }

  function enterPlayer() {
    if (document.querySelector('.player-root')) return Promise.resolve();
    var cells = document.querySelectorAll('[data-focus-id^="episode-"]');
    if (cells.length) {
      cells[0].click();
      return sleep(2500);
    }
    function waitCards(n) {
      var cards = document.querySelectorAll('[data-focus-id^="content-"]');
      if (cards.length || n > 10) return Promise.resolve(cards.length);
      return sleep(1500).then(function () { return waitCards(n + 1); });
    }
    return waitCards(1).then(function (c) {
      if (!c) return Promise.reject(new Error('no content cards'));
      click('content-1-0') || click('content-0-0');
      return sleep(3000);
    }).then(function () {
      var cells2 = document.querySelectorAll('[data-focus-id^="episode-"]');
      out.steps.push('episode-cells:' + cells2.length);
      if (!cells2.length) return Promise.reject(new Error('no episode cells'));
      cells2[0].click();
      return sleep(2500);
    });
  }

  var seriesId = null;

  return enterPlayer().then(function () {
    out.onPlayer = !!document.querySelector('.player-root');
    out.steps.push('onPlayer:' + out.onPlayer);
    // Learn the series id from the history the player just wrote.
    var hist = store.getHistory ? store.getHistory() : [];
    if (hist && hist.length) seriesId = String(hist[0].id);
    out.seriesId = seriesId;
    return waitMetadata(0);
  }).then(function (metaState) {
    out.steps.push('metadata:' + metaState);
    out.videoWidth = vid ? vid.videoWidth : null;
    out.videoHeight = vid ? vid.videoHeight : null;
    out.readyState = vid ? vid.readyState : null;
    out.videoErr = vid && vid.error ? vid.error.code : null;
    out.expectedAspect = (vid && vid.videoWidth > 0)
      ? (vid.videoWidth >= vid.videoHeight ? 'landscape' : 'portrait')
      : null;
    out.stored = seriesId && store.getAspect ? store.getAspect(seriesId) : null;
    out.aspectMapSize = store.getAspectMap ? Object.keys(store.getAspectMap()).length : null;
    return null;
  }).then(function () {
    // Now leave the player and come back to a grid that shows this series.
    var v = document.querySelector('video');
    if (v) { try { v.pause(); } catch (e) {} }
    // Back to the detail page, then to the feed.
    click('player-back-0');
    return sleep(1600);
  }).then(function () {
    out.afterBack = document.querySelector('.player-root') ? 'still-player' : 'left-player';
    return sleep(1200);
  }).then(function () {
    out.tagsAfter = tagCount();
    out.tagsSample = aspectTags().slice(0, 8);
    out.storedFinal = seriesId && store.getAspect ? store.getAspect(seriesId) : null;
    out.stepDump = out.steps;
    return JSON.stringify(out, null, 2);
  }).catch(function (e) {
    out.error = String(e && e.message || e);
    out.stepDump = out.steps;
    return JSON.stringify(out, null, 2);
  });
})()
