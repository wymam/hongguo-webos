// Local (headless) check that the batch pager FILLS its row.
//
// The owner asked for the page numbers to use the whole line ("最下面的选页
// 序号，尽量填满整行，利用好整行空间"). The pager is built from the live DOM,
// so the assertion is geometric: the number row must consume essentially all
// the width available to the grid, and the buttons must be uniform — an equal
// share each, not a fixed small pill with slack to the right.
//
// Usage: node tools/local-pager-fill.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8796;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

if (process.argv.includes('--serve')) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`listening ${PORT}`));
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  return;
}

const { buildStub } = require('./luna-stub.js');
const stub = buildStub();

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Edge not found');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      if (res.ok) return true;
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('static server did not come up');
}

// The probe: walk into a category, wait for a pager, measure it.
function probeScript() {
  return `(${function () {
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function measure() {
      var pager = document.querySelector('.batch-pager');
      if (!pager) return { pagerPresent: false };
      var list = pager.querySelector('.batch-list');
      var chips = [].slice.call(pager.querySelectorAll('.page-chip'));
      if (!list || !chips.length) return { pagerPresent: true, error: 'no chips' };

      // What the grid can use: the pager sits inside the same scroll area, so
      // its own client width IS the usable width.
      var avail = pager.clientWidth;
      var span = pager.querySelector('.batch-span');
      var listRect = list.getBoundingClientRect();
      var pagerRect = pager.getBoundingClientRect();

      var widths = chips.map(function (c) { return Math.round(c.getBoundingClientRect().width); });
      var min = Math.min.apply(null, widths);
      var max = Math.max.apply(null, widths);

      return {
        pagerPresent: true,
        pagerWidth: Math.round(pagerRect.width),
        listWidth: Math.round(listRect.width),
        spanWidth: span ? Math.round(span.getBoundingClientRect().width) : 0,
        availableForList: avail - (span ? Math.round(span.getBoundingClientRect().width) : 0),
        chipCount: chips.length,
        chipMin: min,
        chipMax: max,
        // How much of the row the numbers actually use. The list is the
        // flexible part; if it fills, the row has no dead space on the right.
        listFillPct: avail ? Math.round((listRect.width / avail) * 100) : 0,
        uniform: max - min <= 2,
        // Right edge of the last button vs the pager's right edge.
        rightGap: Math.round(pagerRect.right - chips[chips.length - 1].getBoundingClientRect().right)
      };
    }

    var link = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'))
      .filter(function (el) { return (el.innerText || '').indexOf('真人剧') >= 0; })[0];
    if (!link) link = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'))[2];
    if (link) link.click();

    return sleep(5000).then(function () {
      function wait(n) {
        if (document.querySelector('.batch-pager') || n > 20) return sleep(500);
        return sleep(500).then(function () { return wait(n + 1); });
      }
      return wait(0);
    }).then(measure);
  }})()`;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const probe = `
<script>${stub}</script>
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    Promise.resolve(${probeScript()})
      .then(function (r) { document.title = 'PROBE:' + JSON.stringify(r); })
      .catch(function (e) { document.title = 'PROBE:{"error":"' + String((e && e.message) || e) + '"}'; });
  }, 1500);
});
</script>`;
  const injected = html.replace('</head>', probe + '\n</head>');
  const tmp = path.join(ROOT, '__pagerfill.html');
  fs.writeFileSync(tmp, injected);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'pager.png');
  const server = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  try {
    await waitForServer();
    const edge = findEdge();
    const profile = path.join(OUT, 'edge-pager-profile');
    const base = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      '--virtual-time-budget=45000'
    ];
    const url = `http://127.0.0.1:${PORT}/__pagerfill.html`;

    execFileSync(edge, base.concat(['--hide-scrollbars', '--window-size=1920,1080', `--screenshot=${shot}`, url]),
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120000 });

    const domOut = execFileSync(edge, base.concat(['--dump-dom', url]),
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120000 }).toString();

    const m = /<title>PROBE:([\s\S]*?)<\/title>/.exec(domOut);
    if (!m) { console.log('NO PROBE RESULT'); process.exitCode = 1; return; }
    const result = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    console.log('\n--- probe result ---');
    console.log(JSON.stringify(result, null, 2));

    const checks = [
      ['pager rendered', !!result.pagerPresent],
      ['numbers fill the row (>= 90%)', result.listFillPct >= 90],
      ['buttons are uniform', !!result.uniform],
      ['no dead space at the right edge (<= 24px)', result.rightGap !== undefined && result.rightGap <= 24],
      ['more than one number', (result.chipCount || 0) >= 2]
    ];
    console.log('\n--- assertions ---');
    let failed = 0;
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failed++;
    }
    console.log(`\nscreenshot: ${shot}`);
    if (failed) process.exitCode = 1;
  } finally {
    server.kill();
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
