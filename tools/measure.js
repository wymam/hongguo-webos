// Measure real layout boxes in the built app.
//
// The screenshot alone cannot tell you whether a card is "too big" or whether
// a wrapper is mis-sized — this dumps the actual border-box geometry of the
// elements that participate in the grid scroll math.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = 8792;
const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');

if (process.argv.includes('--serve')) {
  const http = require('http');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain' };
  http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT, '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
  return;
}

const { spawn } = require('child_process');
const { buildStub } = require('./luna-stub.js');
const stub = buildStub();

const probe = `
<script>
(function () {
  var tries = 0;
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
      display: cs.display, gridCols: cs.gridTemplateColumns,
      scrollH: el.scrollHeight, clientH: el.clientHeight
    };
  }
  function tick() {
    tries++;
    // Wait until the grid actually has cards in it.
    if (!document.querySelector('.video-card') && tries < 100) return setTimeout(tick, 100);
    var out = {};
    out.viewport = { w: window.innerWidth, h: window.innerHeight };
    out.gridViewport = box('.video-grid-viewport');
    out.grid = box('.video-grid');
    out.row1 = box('.video-grid > div:nth-of-type(2)');
    out.row2 = box('.video-grid > div:nth-of-type(3)');
    out.firstCard = box('.video-card');
    out.firstThumb = box('.video-card-thumb');
    out.hero = box('.hero');
    out.heading = box('.feed-heading');
    out.scrollArea = box('.scroll-area');
    out.cardCount = document.querySelectorAll('.video-card').length;
    out.rowCount = document.querySelectorAll('.video-grid > div').length;
    document.title = 'MEASURED:' + JSON.stringify(out);
  }
  tick();
})();
</script>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, '__measure.html'),
    html.replace('<head>', `<head>\n<script>${stub}</script>\n${probe}`), 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) break; } catch (e) {}
    await sleep(120);
  }

  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const dom = execFileSync(edge, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    `--user-data-dir=${path.join(OUT, 'edge-profile-measure')}`,
    '--virtual-time-budget=15000', '--dump-dom',
    `http://127.0.0.1:${PORT}/__measure.html`
  ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString();

  const m = dom.match(/<title>MEASURED:(.*?)<\/title>/s);
  if (!m) {
    console.log('no measurement captured');
    console.log(dom.slice(0, 500));
  } else {
    const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    console.log(JSON.stringify(data, null, 2));
  }

  try { srv.kill(); } catch (e) {}
  fs.unlinkSync(path.join(ROOT, '__measure.html'));
}

main().catch((e) => { console.error(e); process.exit(1); });
