// Definitive navigation correctness check.
//
// HISTORY / WHY THIS TOOL LOOKS THE WAY IT DOES
// ---------------------------------------------
// Two earlier versions of this suite reported a false failure, and both wrong
// conclusions are worth keeping written down:
//
//   1. "Reading back getComputedStyle(el).transform returns the identity
//      matrix in headless, so ignore it and trust the rect instead."
//      The identity readback is real, but the DIAGNOSIS was wrong: it is not a
//      headless compositing quirk. It is the app's own `transition: transform`
//      holding the property at its start value because no compositor frames
//      are produced. The transform genuinely had not applied. Trusting the
//      rect papered over a real, shippable bug — the grid froze with the
//      focused card off-screen and ArrowDown died permanently two rows in.
//
//   2. Asserting on the rect taken immediately after a keypress.
//      The scroll is animated by a rAF loop, so the rect is sampled mid-travel
//      and the assertion is a race. Sample AFTER the travel settles.
//
// So this tool drives real key presses, waits for the scroll to settle, and
// then measures where the focused card physically ended up. It reads the rect
// only, never the computed transform.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { buildStub } = require('./luna-stub.js');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8794;

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

// The key sequence walks DOWN through every shelf (past the title rows) and
// then back up and across, so a hole in the row numbering cannot hide.
const SEQ = [
  'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown',
  'ArrowDown', 'ArrowDown', 'ArrowDown',
  'ArrowUp', 'ArrowUp',
  'ArrowRight', 'ArrowRight',
  'ArrowLeft',
  'ArrowDown', 'ArrowDown', 'ArrowUp'
];

const probe = `
<script>
window.__hongguoGridDebug = true;
(function () {
  var KEY = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
  var log = [];
  var seq = ${JSON.stringify(SEQ)};

  function press(k) {
    var init = { key: k, keyCode: KEY[k], which: KEY[k], bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function snap(step, key) {
    var focused = document.querySelector('.video-card.focused');
    var vp = document.querySelector('.video-grid-viewport');
    var out = { step: step, key: key || '(initial)' };
    if (vp) {
      var v = vp.getBoundingClientRect();
      out.vpTop = Math.round(v.top); out.vpBottom = Math.round(v.bottom);
    }
    if (focused) {
      var r = focused.getBoundingClientRect();
      out.id = focused.getAttribute('data-focus-id');
      out.top = Math.round(r.top); out.bottom = Math.round(r.bottom);
      // A card counts as visible only when it is FULLY inside the viewport
      // (plus a 2px slack for sub-pixel rounding).
      out.visible = (out.top >= out.vpTop - 2) && (out.bottom <= out.vpBottom + 2);
    }
    log.push(out);
  }

  // Drive one key, then poll until the scroll offset stops changing, then
  // sample. Polling the rect rather than the inline style keeps this honest:
  // it measures what a viewer would see.
  function settle(cb) {
    var last = null, stable = 0, n = 0;
    (function poll() {
      var f = document.querySelector('.video-card.focused');
      var t = f ? Math.round(f.getBoundingClientRect().top) : null;
      if (t === last) stable++; else stable = 0;
      last = t;
      if (stable >= 4 || n++ > 60) return cb();
      setTimeout(poll, 40);
    })();
  }

  (function boot() {
    if (document.querySelectorAll('.video-card').length < 5) return setTimeout(boot, 100);
    setTimeout(run, 300);
  })();

  function run() {
    var i = 0;
    snap(0, null);
    (function step() {
      if (i >= seq.length) return finish();
      var k = seq[i]; i++;
      press(k);
      settle(function () { snap(i, k); setTimeout(step, 60); });
    })();
  }

  function finish() {
    var el = document.createElement('div');
    el.id = '__nav';
    el.setAttribute('data-json', JSON.stringify(log));
    el.setAttribute('data-glog', JSON.stringify(window.__hongguoGridLog || []));
    el.style.display = 'none';
    document.body.appendChild(el);
  }
})();
</script>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(ROOT, '__nav.html'),
    html.replace('<head>', '<head>\n<script>' + buildStub() + '</script>\n' + probe), 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) break; } catch (e) {}
    await sleep(120);
  }

  const dom = execFileSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--window-size=1920,1080',
    `--user-data-dir=${path.join(OUT, 'edge-profile-nav3')}`,
    '--virtual-time-budget=90000', '--dump-dom',
    `http://127.0.0.1:${PORT}/__nav.html`
  ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6, timeout: 180000 }).toString();

  const m = dom.match(/id="__nav"\s+data-json="(.*?)"\s+data-glog="(.*?)"/s);
  if (!m) {
    console.log('FAIL  no navigation data captured');
    try { srv.kill(); } catch (e) {}
    process.exit(1);
  }
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const log = JSON.parse(unesc(m[1]));
  const glog = JSON.parse(unesc(m[2]));

  console.log('step  key          focus-id        card[top,bottom]   viewport[top,bottom]  visible');
  console.log('----  -----------  --------------  -----------------  --------------------  -------');
  let outOfView = 0;
  for (const s of log) {
    const vis = s.visible === true || s.visible === undefined;
    if (!vis) outOfView++;
    console.log(
      `${String(s.step).padStart(4)}  ${String(s.key).padEnd(11)}  ${String(s.id || '-').padEnd(14)}  ` +
      `${String(`[${s.top},${s.bottom}]`).padEnd(17)}  ${String(`[${s.vpTop},${s.vpBottom}]`).padEnd(20)}  ${s.visible === undefined ? 'n/a' : (vis ? 'yes' : 'NO')}`
    );
  }

  console.log('\n--- grid scroll decisions ---');
  console.log(glog.length ? glog.join('\n') : '(none)');

  const rows = [...new Set(glog.map((l) => Number(l.match(/row=(-?\d+)/)?.[1])))].sort((a, b) => a - b);
  const distinctIds = new Set(log.map((s) => s.id).filter(Boolean)).size;

  // The specific regression that killed navigation: a title row consuming a
  // navigable row number leaves a hole, so the strict `row + 1` lookup misses
  // and focus freezes. Contiguity is therefore an assertion, not a nicety.
  let contiguous = true;
  for (let i = 1; i < rows.length; i++) if (rows[i] !== rows[i - 1] + 1) contiguous = false;

  console.log('');
  const checks = [
    ['focus moved across the grid', distinctIds >= 5],
    ['grid took a scroll decision on each row', rows.length >= 4],
    ['scroll decisions cover contiguous rows', contiguous && rows.length >= 4],
    ['focused card stayed fully visible in every step', outOfView === 0]
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`\nrows with scroll decisions: [${rows.join(', ')}]`);
  console.log(`${failed === 0 ? 'NAV CHECK GREEN' : `NAV CHECK FAILED (${failed})`}`);

  try { srv.kill(); } catch (e) {}
  fs.unlinkSync(path.join(ROOT, '__nav.html'));
  process.exit(failed ? 1 : 0);
})();
