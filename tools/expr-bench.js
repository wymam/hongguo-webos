(function () {
  var out = {};
  function pickEpisode(items) {
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it && it.firstEpisode) return it.firstEpisode;
    }
    return '';
  }
  return Promise.resolve()
    .then(function () {
      if (!window.__hongguoApi || !window.__hongguoApi.benchMedia) { out.error = 'benchMedia 未暴露'; return null; }
      return window.__hongguoApi.getCategory('real-drama', 1, '', 50);
    })
    .then(function (cat) {
      if (out.error) return null;
      var items = (cat && cat.items) || [];
      out.categoryItems = items.length;
      var ep = pickEpisode(items);
      out.episodeId = ep;
      if (!ep) { out.error = '拿不到 firstEpisode'; return null; }
      return window.__hongguoApi.benchMedia(ep);
    })
    .then(function (r) {
      if (out.error) return JSON.stringify(out, null, 2);
      out.bench = r;
      return JSON.stringify(out, null, 2);
    })
    .catch(function (e) { out.error = String((e && e.message) || e); return JSON.stringify(out, null, 2); });
})()
