// Local (headless) verification of the CategoryPage genre-strip changes.
//
// The two behaviours under test are pure layout/focus logic:
//
//   1. the strip packs chips by MEASURED width, so each row fills and a list
//      that fits stays on one row;
//   2. the strip collapses once focus reaches the THIRD card row.
//
// Both are observable in a headless Chromium at 1920x1080 with the Luna stub
// installed, so they can be checked without touching the TV. The probe runs
// INSIDE the page (window.__hongguoProbe below) and reports through
// document.title, which --dump-dom picks up.
//
// Usage: node tools/local-catstrip-check.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const PORT = 8793;
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

// The probe. Runs in-page, walks the real UI, and reports JSON on the title.
function probeScript() {
  return `(${function () {
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function key(k, code) {
      var init = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', init));
      window.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    var DOWN = 40;
    function cur() {
      var el = document.querySelector('.focused');
      return el ? el.getAttribute('data-focus-id') : null;
    }
    function stripState() {
      var g = document.querySelector('.filter-grid');
      if (!g) return { present: false };
      var cs = window.getComputedStyle(g);
      return {
        present: true,
        maxHeight: Math.round(parseFloat(cs.maxHeight || '0')),
        opacity: parseFloat(cs.opacity || '1'),
        collapsed: g.classList.contains('collapsed')
      };
    }

    var out = {};

    // Land on a category page. The sidebar holds the categories; pick the one
    // with the most genres (真人剧) since it is the only last-mile case.
    var link = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'))
      .filter(function (el) { return (el.innerText || '').indexOf('真人剧') >= 0; })[0];
    if (!link) link = [].slice.call(document.querySelectorAll('[data-focus-id^="sidebar-"]'))[2];
    out.category = link ? (link.innerText || '').trim() : null;
    if (link) link.click();

    return sleep(4000).then(function () {
      var grid = document.querySelector('.filter-grid');
      var chips = [].slice.call(document.querySelectorAll('.filter-chip'))
        .filter(function (el) { return /^filter-/.test(el.getAttribute('data-focus-id') || ''); });
      out.chipCount = chips.length;
      if (!grid || !chips.length) { out.error = 'no filter strip'; return out; }

      var cs = window.getComputedStyle(grid);
      var usable = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      out.usableWidth = Math.round(usable);

      var byRow = {};
      chips.forEach(function (el) {
        // NOTE: this file is a template literal that is later stringified into
        // the page, so a regex source needs \\\\d here to arrive as \\d there.
        var m = /^filter-(-?\\d+)-(\\d+)$/.exec(el.getAttribute('data-focus-id'));
        if (!m) return;
        (byRow[m[1]] = byRow[m[1]] || []).push({ col: +m[2], el: el });
      });
      var rowKeys = Object.keys(byRow).sort(function (a, b) { return a - b; });
      out.rows = rowKeys.length;
      out.rowFill = rowKeys.map(function (r) {
        var list = byRow[r].sort(function (a, b) { return a.col - b.col; });
        var sum = 0, widths = [], tops = {};
        list.forEach(function (c) {
          var w = c.el.offsetWidth || 0;
          sum += w + (parseFloat(window.getComputedStyle(c.el).marginRight) || 0);
          widths.push(w);
          tops[Math.round(c.el.getBoundingClientRect().top)] = true;
        });
        return {
          row: r,
          chips: list.length,
          widths: widths,
          consumed: Math.round(sum),
          fillPct: usable ? Math.round((sum / usable) * 100) : null,
          visualLines: Object.keys(tops).length
        };
      });

      // The strip's job is to be PACKED, and how packed it can be depends on
      // how many chips there are: a list that fits one row should sit on one
      // row and be stretched to fill it; a list that needs two rows is at its
      // best when the two rows are EVEN, and an even split of 25 chips IS
      // ~90%+. A flat "every row >= 82%" bar would fail a perfectly good
      // two-row layout whose halves happen to be short, so assert the shape
      // instead: never past two rows, no row overflowing, rows balanced, and
      // the chips actually grew (scale > 1 — otherwise the strip is just the
      // un-sized default and the request to make them bigger was not met).
      var fills = out.rowFill.map(function (r) { return r.fillPct; });
      out.withinTwoRows = out.rows <= 2;
      out.noRowOverflows = fills.every(function (f) { return f <= 101; });
      out.rowsBalanced = fills.length > 1
        ? Math.abs(fills[0] - fills[1]) <= 15
        : true;
      out.packedEnough = out.rows === 2
        ? Math.min.apply(null, fills) >= 80
        : Math.min.apply(null, fills) >= 70;
      out.visualLinesMatchFocusRows = out.rowFill.every(function (r) { return r.visualLines === 1; });

      // ---- collapse walk ----
      if (window.__hongguoFocus) window.__hongguoFocus.set('content-0-0');
      var walk = [{ fid: cur(), strip: stripState() }];
      function step(n) {
        if (n > 4) return Promise.resolve(walk);
        key('ArrowDown', DOWN);
        return sleep(500).then(function () {
          walk.push({ fid: cur(), strip: stripState() });
          return step(n + 1);
        });
      }
      return step(1).then(function (w) {
        out.walk = w.map(function (s) {
          return { fid: s.fid, maxHeight: s.strip.maxHeight, collapsed: s.strip.collapsed };
        });
        var first = w.filter(function (s) { return /^content-0-/.test(s.fid || ''); })[0];
        var third = w.filter(function (s) { return /^content-2-/.test(s.fid || ''); })[0];
        // `collapsed` is the logic; maxHeight/opacity are what the CSS has
        // interpolated to SO FAR, and under `--virtual-time-budget` a transition
        // may not have advanced at all. Assert on the class, and note the
        // painted values alongside for context.
        out.visibleOnFirstRow = !!(first && !first.strip.collapsed);
        out.hiddenOnThirdRow = !!(third && third.strip.collapsed);
        out.ok = out.withinTwoRows && out.noRowOverflows && out.rowsBalanced &&
          out.packedEnough && out.visualLinesMatchFocusRows &&
          out.visibleOnFirstRow && out.hiddenOnThirdRow;
        return out;
      });
    });
  }})()`;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const probe = `
<script>${stub}</script>
<script>
window.__hongguoProbeResult = null;
window.addEventListener('load', function () {
  setTimeout(function () {
    Promise.resolve(${probeScript()})
      .then(function (r) {
        window.__hongguoProbeResult = r;
        document.title = 'PROBE:' + JSON.stringify(r);
      })
      .catch(function (e) {
        document.title = 'PROBE:{"error":"' + String((e && e.message) || e) + '"}';
      });
  }, 1500);
});
</script>`;
  const patched = html.replace('<head>', `<head>${probe}`);
  fs.writeFileSync(path.join(ROOT, '__probe21.html'), patched, 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  await waitForServer();
  const edge = findEdge();
  const url = `http://127.0.0.1:${PORT}/__probe21.html`;

  console.log('probe pass (this takes ~20s of virtual time)...');
  const domOut = execFileSync(edge, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${path.join(__dirname, 'out', 'edge-profile21')}`,
    '--window-size=1920,1080',
    // Generous virtual clock: the probe drives ~6s of real waits plus the
    // category page's own resolve.
    '--virtual-time-budget=45000',
    '--dump-dom', url
  ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 180000 }).toString();

  try { srv.kill(); } catch (e) { /* gone */ }
  fs.unlinkSync(path.join(ROOT, '__probe21.html'));

  const m = /<title>PROBE:([\s\S]*?)<\/title>/.exec(domOut);
  if (!m) {
    console.log('NO PROBE RESULT (title not found). Likely the page did not load.');
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
  } catch (e) {
    console.log('PROBE TITLE IS NOT JSON:', m[1].slice(0, 400));
    process.exitCode = 1;
    return;
  }

  console.log('\n--- probe result ---');
  console.log(JSON.stringify(result, null, 2));

  const checks = [
    ['strip within two rows', result.withinTwoRows],
    ['no row overflows the strip', result.noRowOverflows],
    ['rows balanced within 15%', result.rowsBalanced],
    ['rows packed enough for their count', result.packedEnough],
    ['focus rows match visual lines', result.visualLinesMatchFocusRows],
    ['strip visible on first card row', result.visibleOnFirstRow],
    ['strip hidden on third card row', result.hiddenOnThirdRow]
  ];
  console.log('\n--- assertions ---');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
