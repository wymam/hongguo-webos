// Render the HOME page at 1920x1080 with LIVE data — for the README.
//
// Why not screenshot the TV itself: capture is dead on this set. Over CDP the
// composited surface reads blank (Wayland + in-process GPU, verified both
// fromSurface:true and false — two byte-identical white 1920x1080 PNGs), there
// is no Luna capture service (probed: tv.capture / screen.capture / tv.screen
// all "does not exist"), /dev/fb* exists but EINVALs on read, and GStreamer
// ships exactly one display element and it is a sink.
//
// What the TV CAN hand over is its DATA: getHome's payload, artwork URLs and
// all. Rendering that payload against the real built bundle in headless Edge
// gives a screenshot faithful in layout, copy and artwork; only font
// rasterisation differs from the set (and the grid is flex, so the layout
// absorbs the width difference).
//
// Usage: node tools/readme-shot.js <home.json> [out.png]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8791;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROXY = process.env.README_SHOT_PROXY || 'http://127.0.0.1:10092';

const inputJson = process.argv[2];
const outPng = process.argv[3] || path.join(OUT, 'readme-home.png');
if (!inputJson) {
  console.error('usage: node tools/readme-shot.js <home.json> [out.png]');
  process.exit(2);
}

if (process.argv.includes('--serve')) {
  const http = require('http');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain' };
  http.createServer((q, r) => {
    let rel = q.url.split('?')[0];
    if (rel === '/') rel = '/index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(PORT, '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
  return;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const home = JSON.parse(fs.readFileSync(inputJson, 'utf8'));

  const stub = `
(function () {
  var PORT = 7655;
  var HOME = ${JSON.stringify(home)};
  var HANDLERS = {
    ping: function () {
      return { returnValue: true, service: 'com.hongguowebos.app.service', node: 'v20.12.2',
               mediaPort: PORT, upstream: { upstream: 'ok' } };
    },
    getHome: function () { return HOME; },
    getSearch: function () {
      return { returnValue: false, errorCode: 'SEARCH_UNAVAILABLE',
               errorText: '搜索暂不可用（上游已限制该接口）' };
    }
  };
  window.PalmServiceBridge = function () {
    var self = this;
    this.onservicecallback = null;
    this.call = function (uri, payload) {
      var method = String(uri).split('/').pop();
      setTimeout(function () {
        var fn = HANDLERS[method];
        var out = fn ? fn() : { returnValue: false, errorCode: 'NO_METHOD', errorText: 'no such method: ' + method };
        if (self.onservicecallback) self.onservicecallback(JSON.stringify(out));
      }, 20);
    };
    this.cancel = function () {};
  };
  window.PalmSystem = window.PalmSystem || {
    deviceInfo: JSON.stringify({ modelName: 'OLED55C1', platformVersion: '6.4.0', screenWidth: 1920, screenHeight: 1080 }),
    identifier: 'com.hongguowebos.app 1.0.2'
  };
  window.Mojo = window.Mojo || { relaunch: function () {} };
})();
`;

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const page = html.replace('<head>', '<head>\n<script>' + stub + '</script>\n');
  const pagePath = path.join(ROOT, '__readme-home.html');
  fs.writeFileSync(pagePath, page, 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve', inputJson], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) { ready = true; break; } } catch (e) {}
    await sleep(120);
  }
  if (!ready) console.error('warning: local server did not answer the readiness probe');

  // The headless run writes its output and its profile through Chromium's own
  // path handling, which on this host has proven flaky outside pure-ASCII
  // locations — run it entirely in the system temp dir and copy the result in.
  const TMP = process.env.TEMP || process.env.TMP || 'C:/Users/wymam/AppData/Local/Temp';
  const shotTmp = path.join(TMP, 'readme-shot-out.png').replace(/\\/g, '/');
  const profileDir = path.join(TMP, 'edge-profile-readme').replace(/\\/g, '/');
  try { fs.unlinkSync(shotTmp); } catch (e) {}

  let edgeOut = '';
  try {
    edgeOut = String(execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--window-size=1920,1080',
      // The artwork lives on a public CDN; without an explicit proxy the
      // headless instance would resolve it directly and the grid would come
      // back cover-less. 127.0.0.1 must bypass the proxy or the local server
      // itself becomes unreachable.
      `--proxy-server=${PROXY}`,
      '--proxy-bypass-list=127.0.0.1;localhost',
      `--user-data-dir=${profileDir}`,
      '--virtual-time-budget=30000',
      `--screenshot=${shotTmp}`,
      `http://127.0.0.1:${PORT}/__readme-home.html`
    ], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, timeout: 150000 }) || '');
  } catch (e) {
    console.error('edge run failed:', e.message);
    if (e.stderr) console.error('edge stderr (tail):', String(e.stderr).slice(-600));
    srv.kill();
    try { fs.unlinkSync(pagePath); } catch (e2) {}
    process.exit(1);
  }

  srv.kill();
  try { fs.unlinkSync(pagePath); } catch (e) {}

  console.log('edge output (tail):', edgeOut.slice(-200).trim());
  if (!fs.existsSync(shotTmp)) {
    console.error('edge exited without writing: ' + shotTmp);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.copyFileSync(shotTmp, outPng);
  console.log(`saved: ${outPng} (${fs.statSync(outPng).size} bytes)`);
  process.exit(0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
