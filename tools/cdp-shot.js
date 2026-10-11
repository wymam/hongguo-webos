// Capture a REAL screenshot of the running app on the TV, over CDP.
//
// Why not a headless browser at home: font rendering there differs wildly from
// the TV (measured: identical chips are 3-4x wider in headless), so a local
// render is a lie about what the app looks like. Why not the TV's own capture
// service: this set does not expose one (established earlier — every probe in
// this repo exists because of that). What DOES exist is the renderer's CDP
// endpoint on the TV's loopback (9998), and Chromium's Page.captureScreenshot
// reads the renderer's own framebuffer — the one honest source.
//
// Mechanism: the probe runs ON THE TV (9998 is loopback-only), handshakes a
// WebSocket (no deps), sends Page.captureScreenshot, and streams the base64
// back in 8KB lines so no single line is megabytes long.
//
// WebSocket note: a ~2MB screenshot arrives as FRAGMENTED frames (fin=0 then
// continuations), which the small-message probes never had to handle. The
// reader below reassembles them; without that, JSON.parse sees a truncated
// string and dies.
//
// Usage:
//   TV_HOST=<tv-ip> node tools/cdp-shot.js <passphrase> [out.png]
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const HOST = process.env.TV_HOST || '192.0.2.10';
const PORT = Number(process.env.TV_PORT || 9922);
const USER = process.env.TV_USER || 'prisoner';
const TV_KEY_PATH = process.env.TV_KEY_PATH ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'webos_tv_key');
const APP_ID = 'com.hongguowebos.app';

function loadSsh2() {
  try { return require('ssh2'); } catch (e) { /* fall through */ }
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
      stream.on('close', () => { clearTimeout(t); resolve(out); });
    });
  });
}

// Runs ON THE TV under its own node (v20). Discovers the app target, upgrades
// to WebSocket by hand, asks for a PNG, streams it back.
const PROBE_SRC = String.raw`
const http = require('http');
const crypto = require('crypto');
const net = require('net');
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
  if (!m) { console.log('BAD_WS_URL'); return; }
  const host = m[1], port = Number(m[2]), pathPart = m[3];
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, host);
  let handshaken = false;
  let buf = Buffer.alloc(0);
  let frag = null;

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
      send({ id: 1, method: 'Page.captureScreenshot', params: (function () {
        var p = { format: 'png' };
        // fromSurface:true (default) reads the COMPOSITED surface, which on
        // this Wayland + in-process-GPU set comes back blank. false reads the
        // renderer's own main frame, which sometimes still has the DOM paint.
        if (process.env.SHOT_FROM_SURFACE === '0') p.fromSurface = false;
        return p;
      })() });
      setTimeout(() => { console.log('TIMEOUT_WAITING_SHOT'); try { sock.destroy(); } catch (e) {} process.exit(0); }, 25000);
    }
    while (buf.length >= 2) {
      // Byte 0 carries FIN + opcode; byte 1 carries MASK + length. Reading
      // fin/opcode off byte 1 (as an earlier version of this probe did) makes
      // every frame look like a continuation fragment, so the screenshot
      // response — which arrives fragmented — was never reassembled and the
      // probe just timed out. The small-message probes never hit this because
      // they never had to look at byte 0 at all.
      const b0 = buf[0];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);

      if (opcode === 0x0) {                          // continuation
        frag = frag ? Buffer.concat([frag, payload]) : payload;
        if (fin) { handle(frag.toString('utf8')); frag = null; }
      } else if (opcode === 0x1 || opcode === 0x2) { // text / binary
        if (fin) handle(payload.toString('utf8'));
        else frag = payload;
      }
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
    if (msg.id !== 1) return;
    if (msg.error) { console.log('CDP_ERROR ' + JSON.stringify(msg.error)); process.exit(0); }
    const data = msg.result && msg.result.data;
    if (!data) { console.log('NO_DATA ' + JSON.stringify(msg.result || {}).slice(0, 200)); process.exit(0); }
    console.log('=== SHOT_BEGIN ===');
    for (let i = 0; i < data.length; i += 8192) console.log(data.slice(i, i + 8192));
    console.log('=== SHOT_END ===');
    console.log('B64_CHARS ' + data.length);
    setTimeout(() => process.exit(0), 200);
  }

  sock.on('error', (e) => { console.log('WS_ERR ' + e.message); process.exit(0); });
}
`;

(async () => {
  const pass = process.argv[2] || process.env.TV_SSH_PASSPHRASE || '';
  const outPath = process.argv[3] || path.join(__dirname, 'out', 'tv-shot.png');
  if (!pass) {
    console.error('usage: TV_HOST=<tv-ip> node tools/cdp-shot.js <passphrase> [out.png]');
    process.exit(2);
  }

  const conn = await connect(pass);
  const probeB64 = Buffer.from(PROBE_SRC, 'utf8').toString('base64');
  const envPrefix = process.env.SHOT_FROM_SURFACE === '0' ? 'SHOT_FROM_SURFACE=0 ' : '';
  const cmd = `echo ${probeB64} | base64 -d > /tmp/cdp_shot.js && ${envPrefix}node /tmp/cdp_shot.js 2>&1`;
  const out = await exec(conn, cmd, 90000);
  conn.end();

  const m = /=== SHOT_BEGIN ===\r?\n([\s\S]*?)\r?\n=== SHOT_END ===/.exec(out);
  if (!m) {
    console.error('no screenshot in probe output. Raw head:');
    console.error(out.slice(0, 600));
    process.exit(1);
  }
  const b64 = m[1].replace(/\s+/g, '');
  const png = Buffer.from(b64, 'base64');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  const sigOk = png.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  console.log(`saved: ${outPath}`);
  console.log(`bytes: ${png.length} | b64 chars: ${b64.length} | PNG signature: ${sigOk ? 'ok' : 'BAD'}`);
  process.exit(sigOk ? 0 : 1);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
