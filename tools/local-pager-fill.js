// Local (headless) check that the batch pager uses a FIXED, comfortable size.
//
// History: this file used to assert the opposite. The owner first asked for the
// numbers to fill the line ("尽量填满整行，利用好整行空间"), so the chips were made
// to stretch. On the TV that read badly — a handful of numbers became enormous
// slabs. The owner then clarified: "不是这样无限拉大，位置是有的，16页序号完全可以
// 全部展现出来" — there IS room, sixteen numbers fit at a normal size, so stop
// stretching and just show them.
//
// The assertions below therefore check for a fixed size, NOT full-fill:
//   * every chip is the same width (a button, not a bar chart)
//   * that width is in a sane band (not a sliver, not a slab)
//   * sixteen chips fit inside the row without wrapping or overflowing
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

      var avail = pager.clientWidth;
      var listRect = list.getBoundingClientRect();
      var pagerRect = pager.getBoundingClientRect();
      var grid = document.querySelector('.video-grid');
      var gridWidth = grid ? Math.round(grid.getBoundingClientRect().width) : 0;

      var widths = chips.map(function (c) { return Math.round(c.getBoundingClientRect().width); });
      var min = Math.min.apply(null, widths);
      var max = Math.max.apply(null, widths);
      var span = pager.querySelector('.batch-span');
      var spanWidth = span ? Math.round(span.getBoundingClientRect().width) : 0;

      // Simulate a 16-batch row: the width sixteen fixed chips + their gaps
      // would need, and whether that still fits beside the label.
      var gap = 8;
      var sixteen = 16 * max + 15 * gap;

      return {
        pagerPresent: true,
        pagerWidth: Math.round(pagerRect.width),
        gridWidth: gridWidth,
        listWidth: Math.round(listRect.width),
        spanWidth: spanWidth,
        roomForChips: Math.round(avail - spanWidth - 20),
        chipCount: chips.length,
        chipMin: min,
        chipMax: max,
        uniform: max - min <= 2,
        // How much of the row the numbers use. With a FIXED size this is
        // naturally well under 100% — that is the point, not a defect.
        listFillPct: avail ? Math.round((listRect.width / avail) * 100) : 0,
        rightGap: Math.round(pagerRect.right - chips[chips.length - 1].getBoundingClientRect().right),
        sixteenNeeds: Math.round(sixteen),
        sixteenFits: sixteen <= (avail - spanWidth - 20)
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
      ['more than one number', (result.chipCount || 0) >= 2],
      ['chips are a FIXED size (not stretched)', !!result.uniform],
      // ~58px logical at 1920 wide is the target; allow a wide band so local
      // font metrics (which differ from the TV's) cannot make this flaky.
      ['chip width in a sane band (40-200px)', result.chipMax >= 40 && result.chipMax <= 200],
      ['row is NOT stretched to the edges (fill < 80%)', result.listFillPct < 80],
      ['sixteen numbers fit the row', !!result.sixteenFits]
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
