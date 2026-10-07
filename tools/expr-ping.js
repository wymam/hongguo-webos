(function () {
  return window.__hongguoApi.getDiagnostics().then(function (d) {
    return JSON.stringify({ service: d && d.service, node: d && d.node, mediaPort: d && d.mediaPort, media: d && d.media, upstream: d && d.upstream && d.upstream.upstream }, null, 2);
  }).catch(function (e) { return JSON.stringify({ error: String((e && e.message) || e) }); });
})()
