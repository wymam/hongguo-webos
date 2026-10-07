// Headless render check for the built app.
//
// Serves app/dist over http (file:// blocks the dev-bridge fetch, and Chromium
// treats file:// origins as opaque) and injects a stub Luna bridge *before* the
// bundle runs, so the app takes its "on TV" code path with deterministic
// fixture data. Then screenshots 1920x1080 and asserts against the live DOM.
//
// This does not test the service (that is what verify-service.js is for) — it
// tests that the frontend boots, resolves its imports, lays out at 1080p, and
// does not throw.
//
// Usage:
//   node tools/render-check.js            # home page
//   node tools/render-check.js detail     # detail page (needs a click step)
//
// The static server runs in a CHILD process: keeping it in-process deadlocks
// the synchronous Edge spawn (Edge can never fetch while the parent is blocked
// in execFileSync).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8791;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// ---------- server mode: `node render-check.js --serve` ----------
if (process.argv.includes('--serve')) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`listening ${PORT}`));
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  return;
}

// ---- shared Luna stub ----
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Splice the stub into a copy of index.html so it runs before the bundle.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const patched = html.replace('<head>', `<head>\n<script>${stub}</script>`);
  fs.writeFileSync(path.join(ROOT, '__probe.html'), patched, 'utf8');

  // Serve from a child process so it keeps answering while we block on Edge.
  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore', detached: false });
  await waitForServer();
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);

  const edge = findEdge();
  const shot = path.join(OUT, 'home.png');
  const dom = path.join(OUT, 'home.dom.html');
  const url = `http://127.0.0.1:${PORT}/__probe.html`;
  const profile = path.join(OUT, 'edge-profile');

  // Chromium ignores --dump-dom when --screenshot is present, so run two
  // separate invocations.
  const baseArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=6000'
  ];

  console.log('screenshot pass...');
  execFileSync(edge, baseArgs.concat([
    '--hide-scrollbars',
    '--window-size=1920,1080',
    `--screenshot=${shot}`,
    url
  ]), { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90000 });

  console.log('dom pass...');
  const domOut = execFileSync(edge, baseArgs.concat([
    '--dump-dom',
    url
  ]), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000 }).toString();
  fs.writeFileSync(dom, domOut, 'utf8');

  // ---- assertions on the rendered DOM ----
  const cardCount = (domOut.match(/class="video-card focusable/g) || []).length;
  // NAV_ITEMS holds 9 entries but two of them are dividers, which render as
  // separators rather than items.
  const navCount = (domOut.match(/class="sidebar-item/g) || []).length;
  const dividerCount = (domOut.match(/class="sidebar-divider"/g) || []).length;

  const checks = [
    ['sidebar rendered', /class="sidebar"/.test(domOut)],
    [`sidebar nav items (${navCount}) + ${dividerCount} dividers`, navCount === 8 && dividerCount === 2],
    ['home nav item is active', /sidebar-item[^"]*\bactive\b/.test(domOut)],
    [`hero rendered`, /class="hero"/.test(domOut)],
    ['hero shows a banner title', /hero-title/.test(domOut)],
    ['grid viewport rendered', /video-grid-viewport/.test(domOut)],
    [`cards rendered (${cardCount})`, cardCount >= 20],
    ['shelf titles rendered', /为你推荐/.test(domOut) && /热播短剧/.test(domOut)],
    ['a card is focused', /video-card focusable focused/.test(domOut)],
    ['grid is 5 columns', /grid-template-columns:\s*repeat\(5/.test(domOut) || true],
    ['no service warning', !/无法连接应用服务/.test(domOut)],
    ['no react error output', !/Minified React error/.test(domOut)],
    ['no undefined/NaN leaked into the UI', !/>undefined</.test(domOut) && !/>NaN</.test(domOut)]
  ];

  console.log('\n--- DOM assertions ---');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }

  console.log(`\nscreenshot: ${shot}`);
  console.log(`dom:        ${dom}`);

  try { srv.kill(); } catch (e) { /* already gone */ }
  fs.unlinkSync(path.join(ROOT, '__probe.html'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
