// Dump the focus registry as the app actually built it.
//
// navigateGrid works purely on `group-row-col` ids present in the registry, so
// when ArrowDown stops moving there are only two possibilities:
//   (a) the next row id is not in the registry at all, or
//   (b) it is, but something rejects the move.
// This prints the registry sorted by row so both are decidable at a glance.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { buildStub } = require('./luna-stub.js');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8796;

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

const probe = `
<script>
(function () {
  var tries = 0;
  function tick() {
    tries++;
    if (document.querySelectorAll('.video-card').length < 2 && tries < 120) return setTimeout(tick, 100);

    // Walk every element that carries data-focus-id, in DOM order.
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-focus-id]'));
    var ids = nodes.map(function (n) {
      var r = n.getBoundingClientRect();
      return { id: n.getAttribute('data-focus-id'), top: Math.round(r.top), h: Math.round(r.height), cls: n.className };
    });

    var body = document.querySelector('.video-grid');
    var rows = [];
    if (body) {
      Array.prototype.slice.call(body.children).forEach(function (c, i) {
        rows.push({ i: i, top: c.offsetTop, h: c.offsetHeight, cls: c.className, cards: c.querySelectorAll('.video-card').length });
      });
    }

    // Is the 3rd card row inside the viewport's subtree at all?
    var vp = document.querySelector('.video-grid-viewport');
    var inVp = 0;
    if (vp) inVp = vp.querySelectorAll('.video-card').length;

    var el = document.createElement('div');
    el.id = '__reg';
    el.setAttribute('data-payload', JSON.stringify({
      ids: ids,
      rows: rows,
      totalCards: document.querySelectorAll('.video-card').length,
      cardsInsideViewportSubtree: inVp,
      gridHeight: body ? body.offsetHeight : null
    }));
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  tick();
})();
</script>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, '__reg.html'),
    html.replace('<head>', '<head>\n<script>' + buildStub() + '</script>\n' + probe), 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) break; } catch (e) {}
    await sleep(120);
  }

  const dom = execFileSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--window-size=1920,1080',
    `--user-data-dir=${path.join(OUT, 'edge-profile-reg')}`,
    '--virtual-time-budget=25000', '--dump-dom',
    `http://127.0.0.1:${PORT}/__reg.html`
  ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6, timeout: 120000 }).toString();

  const m = dom.match(/id="__reg"\s+data-payload="(.*?)"/s);
  if (!m) { console.log('no data'); console.log(dom.slice(0, 600)); try { srv.kill(); } catch (e) {} process.exit(1); }
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const d = JSON.parse(unesc(m[1]));

  console.log('total cards in DOM        :', d.totalCards);
  console.log('cards inside viewport tree:', d.cardsInsideViewportSubtree);
  console.log('grid offsetHeight         :', d.gridHeight);

  console.log('\n--- grid children (row wrappers) ---');
  for (const r of d.rows) {
    console.log(`  #${String(r.i).padStart(2)}  top=${String(r.top).padStart(5)}  h=${String(r.h).padStart(4)}  cards=${r.cards}  ${r.cls}`);
  }

  console.log('\n--- every [data-focus-id] in DOM order (content only) ---');
  const content = d.ids.filter((x) => x.id.startsWith('content-'));
  for (const x of content) {
    console.log(`  ${x.id.padEnd(16)} top=${String(x.top).padStart(5)} h=${String(x.h).padStart(4)}`);
  }
  console.log(`\n(content nodes: ${content.length}, non-content: ${d.ids.length - content.length})`);

  try { srv.kill(); } catch (e) {}
  fs.unlinkSync(path.join(ROOT, '__reg.html'));
})();
