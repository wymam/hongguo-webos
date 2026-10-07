// Inspect the LIVE app on the TV through Chromium's remote debugging port.
//
// Why this instead of a screenshot: webOS exposes no capture service on this set,
// but every WebAppMgr renderer opens a CDP endpoint on the TV's localhost:9998.
// That gives us the real DOM, the real console, and the real JS errors of the
// running app - ground truth a screenshot could not improve on.
//
// No dependencies: the WebSocket framing is spoken by hand so the project stays
// install-free. Only the minimum needed for CDP is implemented (text frames,
// client masking, small payloads).
//
// Usage:  node tools/cdp-inspect.js <passphrase> [expression-file]
// The TV runs the probe itself, because 9998 is bound to its loopback.

const path = require('path');
const Module = require('module');
const fs = require('fs');

// The TV's LAN address is machine-specific and is never committed: set TV_HOST
// in your environment (defaults below are placeholders, not a real device).
const HOST = process.env.TV_HOST || '192.0.2.10';
const PORT = Number(process.env.TV_PORT || 9922);
const USER = process.env.TV_USER || 'prisoner';
const TV_KEY_PATH = process.env.TV_KEY_PATH ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'webos_tv_key');
const APP_ID = 'com.hongguowebos.app';

function loadSsh2() {
  const ws = path.join(process.env.HOME || process.env.USERPROFILE || '',
    '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'ssh2') return orig.call(this, path.join(ws, 'ssh2'), ...rest);
    return orig.call(this, request, ...rest);
  };
  return require('ssh2');
}

const { Client } = loadSsh2();

function connect(pass) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    try {
      conn.connect({
        host: HOST, port: PORT, username: USER,
        privateKey: fs.readFileSync(TV_KEY_PATH),
        passphrase: pass,
        readyTimeout: 15000,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
          kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group14-sha256',
                'diffie-hellman-group-exchange-sha256', 'ecdh-sha2-nistp256'],
          cipher: ['aes128-ctr', 'aes256-ctr', 'aes128-gcm@openssh.com']
        }
      });
    } catch (e) { reject(e); }
  });
}

function exec(conn, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('(timeout)'), timeoutMs || 60000);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(t); return resolve('ERR ' + err.message); }
      let out = '';
      stream.on('data', (d) => (out += d));
      stream.stderr.on('data', (d) => (out += d));
      stream.on('close', () => { clearTimeout(t); resolve(out.trim()); });
    });
  });
}

// This probe runs ON THE TV under its own node (v20). It discovers the page
// target, upgrades to WebSocket by hand, evaluates the expression, and prints
// console output plus the evaluation result.
const PROBE_SRC = String.raw`
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const expr = fs.readFileSync('/tmp/cdp_expr.js', 'utf8');
const APP_ID = 'com.hongguowebos.app';

http.get({ host: '127.0.0.1', port: 9998, path: '/json/list' }, (res) => {
  let b = '';
  res.on('data', (d) => (b += d));
  res.on('end', () => {
    let list = [];
    try { list = JSON.parse(b); } catch (e) {}
    const t = list.find((x) => x.url && x.url.indexOf(APP_ID) >= 0);
    if (!t) { console.log('NO_TARGET'); process.exit(0); }
    runWs(t.webSocketDebuggerUrl);
  });
}).on('error', (e) => { console.log('HTTP_ERR ' + e.message); process.exit(0); });

function runWs(url) {
  const m = /^ws:\/\/([^:]+):(\d+)(\/.*)$/.exec(url);
  if (!m) { console.log('BAD_WS_URL ' + url); return; }
  const host = m[1], port = Number(m[2]), pathPart = m[3];
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, host);
  let handshaken = false;
  let buf = Buffer.alloc(0);
  let id = 1;

  sock.on('connect', () => {
    sock.write('GET ' + pathPart + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n');
  });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshaken) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString();
      if (head.indexOf('101') < 0) { console.log('HANDSHAKE_FAIL'); sock.destroy(); return; }
      handshaken = true;
      buf = buf.slice(idx + 4);
      send({ id: 1, method: 'Runtime.enable' });
      send({ id: 2, method: 'Log.enable' });
      setTimeout(() => {
        send({ id: 3, method: 'Runtime.evaluate',
               params: { expression: expr, returnByValue: true, awaitPromise: true } });
      }, 300);
      // Long enough for expressions that await async work (opening a page and
      // letting the player negotiate a stream can take several seconds; the
      // multi-episode stress probe needs ~45s). Override with CDP_EVAL_MS.
      //
      // Keep this BELOW the host-side SSH budget (CDP_SSH_MS, below): the probe
      // running on the TV is killed by its own timer, and if that fires after
      // the SSH command already timed out we get "(timeout)" with no result.
      // 3 full episodes at 4x playback + 3s dwell + reload is comfortably
      // under 210s; raise both together if a future probe needs more.
      const budget = Number(process.env.CDP_EVAL_MS || 210000);
      setTimeout(() => { try { sock.destroy(); } catch (e) {} process.exit(0); }, budget);
    }
    while (buf.length >= 2) {
      const b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      handle(payload);
    }
  });

  function send(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    sock.write(Buffer.concat([header, mask, masked]));
  }

  function handle(payload) {
    let msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }
    if (msg.id === 3 && msg.result) {
      if (msg.result.exceptionDetails) {
        console.log('EVAL_EXCEPTION ' + JSON.stringify(msg.result.exceptionDetails.text));
      } else {
        const r = msg.result.result;
        const v = r && (r.value !== undefined ? r.value : r.description);
        console.log('=== RESULT ===');
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      }
      setTimeout(() => process.exit(0), 200);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
      console.log('CONSOLE[' + msg.params.type + '] ' + String(args).slice(0, 220));
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      console.log('LOG[' + e.level + '] ' + String(e.text).slice(0, 220));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const desc = (d.exception && d.exception.description) || d.text || '';
      console.log('EXCEPTION ' + String(desc).slice(0, 320));
    }
  }

  sock.on('error', (e) => { console.log('WS_ERR ' + e.message); process.exit(0); });
}
`;

const DEFAULT_EXPR = `(function () {
  var q = function (s) { return document.querySelectorAll(s).length; };
  var cards = [].slice.call(document.querySelectorAll('.video-card')).slice(0, 6)
    .map(function (c) { return (c.innerText || '').replace(/\\s+/g, ' ').slice(0, 40); });
  var heads = [].slice.call(document.querySelectorAll('.feed-heading')).slice(0, 8)
    .map(function (h) { return (h.innerText || '').trim().slice(0, 30); });
  var grid = document.querySelector('.video-grid');
  return JSON.stringify({
    title: document.title,
    readyState: document.readyState,
    heroPresent: !!document.querySelector('.hero, .hero-banner'),
    sidebarItems: q('.nav-item, .sidebar-item'),
    gridCards: q('.video-card'),
    shelfHeadings: heads,
    focusedClass: (document.querySelector('.focused') || {}).className || null,
    gridTransform: grid ? grid.style.transform : '(no grid)',
    sampleCards: cards,
    bodyHead: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300)
  }, null, 2);
})()`;

(async () => {
  const pass = process.argv[2] || process.env.TV_SSH_PASSPHRASE || '';
  let expression = DEFAULT_EXPR;
  const exprArg = process.argv[3];
  if (exprArg && fs.existsSync(exprArg)) expression = fs.readFileSync(exprArg, 'utf8');
  else if (exprArg) expression = exprArg;

  const hostDir = '/media/developer/apps/usr/palm/applications/' + APP_ID;

  const conn = await connect(pass);
  const probeB64 = Buffer.from(PROBE_SRC, 'utf8').toString('base64');
  const exprB64 = Buffer.from(expression, 'utf8').toString('base64');

  // Round-trip the files through base64 so no quoting survives the shell.
  // The budget is read by the probe process ON THE TV, so it has to be exported
  // into that command — setting it here on the host would do nothing.
  const evalMs = Number(process.env.CDP_EVAL_MS || 210000);
  const cmd =
    `echo ${probeB64} | base64 -d > /tmp/cdp_probe.js && ` +
    `echo ${exprB64} | base64 -d > /tmp/cdp_expr.js && ` +
    `cd ${hostDir} && CDP_EVAL_MS=${evalMs} node /tmp/cdp_probe.js 2>&1 | head -${Number(process.env.CDP_HEAD_LINES || 400)}`;

  // Host-side budget. Must exceed the probe's own CDP_EVAL_MS budget, or the
  // SSH channel is torn down before the TV finishes and we only see "(timeout)".
  const out = await exec(conn, cmd, Number(process.env.CDP_SSH_MS || 240000));
  console.log(out);
  conn.end();
  process.exit(0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
