(function () {
  return window.__hongguoApi.getDiagnostics().then(function (d) {
    var log = (d && d.mediaLog) || [];
    return JSON.stringify({
      count: log.length,
      served: d.media && d.media.served,
      bytes: d.media && d.media.bytes,
      errors: d.errors,
      tail: log.slice(-30).map(function (e) {
        return { at: e.at, start: e.start, end: e.end, len: e.len, fetchMs: e.fetchMs, serveMs: e.serveMs, active: e.active };
      })
    }, null, 1);
  });
})()
