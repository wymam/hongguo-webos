// Visual + DOM proof of the orientation tag.
//
// The tag only exists for series that have been played, so this harness seeds
// the aspect cache BEFORE the bundle boots (via the Luna stub), then asserts
// that cards carrying a known series id render the right label and colour.
//
// Usage: node tools/aspect-check.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8795;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml'
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
  server.listen(PORT, '127.0.0.1', () => console.log('listening ' + PORT));
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  return;
}

const { buildStub } = require('./luna-stub.js');

function findEdge() {
  const cands = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('Edge not found');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) return true; }
    catch (e) { /* not up */ }
    await sleep(120);
  }
  throw new Error('static server did not come up');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Seed the aspect cache for the first few fixture ids the stub emits
  // (769122861977490536x), so the rendered grid is guaranteed to contain both
  // a portrait and a landscape tag.
  const stub = buildStub();
  const seed = {
    '7691228619774905368': { aspect: 'portrait', w: 1080, h: 1920, at: Date.now() },
    '7691228619774905369': { aspect: 'landscape', w: 1920, h: 1080, at: Date.now() },
    '7691228619774905370': { aspect: 'portrait', w: 1080, h: 1920, at: Date.now() },
    '7691228619774905371': { aspect: 'landscape', w: 1920, h: 1080, at: Date.now() },
    '7691228619774905372': { aspect: 'portrait', w: 1080, h: 1920, at: Date.now() }
  };
  const seedScript =
    `<script>try{localStorage.setItem('hongguo_aspect',` +
    JSON.stringify(JSON.stringify(seed)) + `);}catch(e){}</script>`;

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const patched = html.replace('<head>', `<head>\n<script>${stub}</script>\n${seedScript}`);
  fs.writeFileSync(path.join(ROOT, '__aspect.html'), patched, 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  await waitForServer();

  const edge = findEdge();
  const shot = path.join(OUT, 'aspect-tag.png');
  const dom = path.join(OUT, 'aspect.dom.html');
  const url = `http://127.0.0.1:${PORT}/__aspect.html`;
  const profile = path.join(OUT, 'edge-profile-aspect');

  const baseArgs = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profile}`, '--virtual-time-budget=6000'
  ];

  execFileSync(edge, baseArgs.concat([
    '--hide-scrollbars', '--window-size=1920,1080',
    `--screenshot=${shot}`, url
  ]), { stdio: ['ignore', 'ignore', 'ignore'], timeout: 90000 });

  const domOut = execFileSync(edge, baseArgs.concat(['--dump-dom', url]), {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 90000
  }).toString();
  fs.writeFileSync(dom, domOut, 'utf8');

  const tagCount = (domOut.match(/class="video-card-aspect/g) || []).length;
  const portraitCount = (domOut.match(/video-card-aspect portrait/g) || []).length;
  const landscapeCount = (domOut.match(/video-card-aspect landscape/g) || []).length;

  const checks = [
    ['orientation tags rendered', tagCount > 0, `${tagCount} tags`],
    ['portrait tags present', portraitCount > 0, `${portraitCount} 竖`],
    ['landscape tags present', landscapeCount > 0, `${landscapeCount} 横屏`],
    ['portrait label is 竖', /video-card-aspect portrait[\s\S]{0,120}?竖/.test(domOut)],
    ['landscape label is 横屏', /video-card-aspect landscape[\s\S]{0,120}?横屏/.test(domOut)],
    ['no tag when unknown', !/video-card-aspect null/.test(domOut)],
    ['no react error output', !/Minified React error/.test(domOut)]
  ];

  console.log('\n--- orientation tag assertions ---');
  let failed = 0;
  for (const [name, ok, extra] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' (' + extra + ')' : ''}`);
    if (!ok) failed++;
  }
  console.log(`\nscreenshot: ${shot}`);
  console.log(`dom:        ${dom}`);

  try { srv.kill(); } catch (e) {}
  fs.unlinkSync(path.join(ROOT, '__aspect.html'));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
