(function () {
  return window.__hongguoApi.getDiagnostics().then(function (d) {
    var log = (d && d.mediaLog) || [];
    return JSON.stringify({
      count: log.length,
      tail: log.slice(-40).map(function (e) {
        return { at: e.at, req: e.req, start: e.start, end: e.end, len: e.len, fetchMs: e.fetchMs, serveMs: e.serveMs };
      })
    }, null, 1);
  });
})()
