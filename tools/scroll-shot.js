// Visual proof that the grid actually scrolls.
//
// The nav-check asserts on geometry, which is the right thing to assert on.
// This produces the companion artefact a human can eyeball: the same page
// screenshotted before and after four ArrowDown presses. If the transform were
// being swallowed again, both frames would look identical.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { buildStub } = require('./luna-stub.js');

const ROOT = path.join(__dirname, '..', 'app', 'dist');
const OUT = path.join(__dirname, 'out');
const PORT = 8790;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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

// Page A: press down 4 times, then a plain screenshot is taken by Edge.
const driveProbe = (presses) => `
<script>
window.__hongguoGridDebug = true;
(function () {
  function wait() {
    if (document.querySelectorAll('.video-card').length < 5) return setTimeout(wait, 100);
    setTimeout(function () {
      var n = ${presses};
      var i = 0;
      (function step() {
        if (i >= n) return;
        i++;
        var init = { key: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
        window.dispatchEvent(new KeyboardEvent('keydown', init));
        window.dispatchEvent(new KeyboardEvent('keyup', init));
        setTimeout(step, 400);
      })();
    }, 400);
  }
  wait();
})();
</script>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const page = (presses) => html.replace('<head>', '<head>\n<script>' + buildStub() + '</script>\n' + driveProbe(presses));

  fs.writeFileSync(path.join(ROOT, '__shot-top.html'), page(0), 'utf8');
  fs.writeFileSync(path.join(ROOT, '__shot-scrolled.html'), page(6), 'utf8');

  const srv = spawn(process.execPath, [__filename, '--serve'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/index.html`); if (r.ok) break; } catch (e) {}
    await sleep(120);
  }

  const shoot = (file, outName) => {
    const out = path.join(OUT, outName);
    execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--window-size=1920,1080',
      `--user-data-dir=${path.join(OUT, 'edge-profile-shot')}`,
      '--virtual-time-budget=20000',
      `--screenshot=${out}`,
      `http://127.0.0.1:${PORT}/${file}`
    ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6, timeout: 120000 });
    return out;
  };

  const a = shoot('__shot-top.html', 'scroll-top.png');
  console.log('top      :', a);
  const b = shoot('__shot-scrolled.html', 'scroll-down.png');
  console.log('scrolled :', b);

  const sa = fs.statSync(a).size, sb = fs.statSync(b).size;
  console.log(`\nsizes: ${sa} / ${sb}`);
  console.log(sa && sb ? 'both screenshots written' : 'MISSING screenshot');

  try { srv.kill(); } catch (e) {}
  fs.unlinkSync(path.join(ROOT, '__shot-top.html'));
  fs.unlinkSync(path.join(ROOT, '__shot-scrolled.html'));
})();
