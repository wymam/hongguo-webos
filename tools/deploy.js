// Deploy the .ipk to a real LG webOS TV over SSH.
//
// Why not `ares-install`: the ares CLI on this host cannot complete its own
// postinstall (it invokes a blacklisted program), and its device profiles
// assume a `prisoner`/key-pair setup. The TV's Developer Mode SSH endpoint
// speaks plain OpenSSH, so we talk to it directly and use the TV's own
// `luna-send-pub` to install and launch. That is exactly what ares does under
// the hood, minus the parts that break here.
//
// HOW AUTH WORKS (webOS 6+, verified on webOS 11.2):
//   * prisoner@<tv>:9922 is KEY-ONLY. There is no password login.
//   * The 6-char code in the Developer Mode app is NOT an SSH password. It is
//     the passphrase that unlocks the private key the device serves over HTTP.
//   * The key comes from GET http://<tv>:9991/webos_rsa, which only answers
//     while the "Key Server" switch is ON in Developer Mode.
//   * ssh2 unwraps the encrypted PEM natively when given `privateKey` +
//     `passphrase`. Do not hand-roll EVP_BytesToKey; it is easy to get wrong.
//
// Usage:
//   node tools/deploy.js <passphrase>
//   TV_SSH_PASSPHRASE=xxxx node tools/deploy.js
//
// The passphrase changes every time Developer Mode is restarted, so it is never
// stored in the repo.

const fs = require('fs');
const path = require('path');

const HOST = process.env.TV_HOST || '192.0.2.10';
const PORT = Number(process.env.TV_PORT || 9922);
const USER = process.env.TV_USER || 'prisoner';
const APP_ID = 'com.hongguowebos.app';
const REMOTE_DIR = '/media/developer/temp/';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function findIpk() {
  if (!fs.existsSync(DIST)) return null;
  const files = fs.readdirSync(DIST).filter((f) => f.endsWith('.ipk'));
  if (!files.length) return null;
  // Newest first.
  files.sort((a, b) => fs.statSync(path.join(DIST, b)).mtimeMs - fs.statSync(path.join(DIST, a)).mtimeMs);
  return path.join(DIST, files[0]);
}

function passphrase() {
  // Only real user arguments — i.e. from index 2 onward. Do NOT scan the whole
  // argv: argv[0] is the interpreter (e.g. `...\node.exe`) and argv[1] is this
  // script, and BOTH satisfy "does not start with -". A `find()` over the full
  // argv therefore returns the interpreter path as the "passphrase", which then
  // surfaces from ssh2 as `Cannot parse privateKey: Malformed OpenSSH private
  // key. Bad passphrase?` — a message that blames the key and hides the real
  // cause. That exact misdiagnosis cost a long detour; keep this scoped to [2:].
  const arg = process.argv.slice(2).find((a) => a && !a.startsWith('-'));
  if (arg) return arg;
  if (process.env.TV_SSH_PASSPHRASE) return process.env.TV_SSH_PASSPHRASE;
  const file = path.join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'webos_tv.pass');
  if (fs.existsSync(file)) {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  return null;
}

// Node resolution: ssh2 lives in the managed workspace, not in this project
// (the project itself stays dependency-free so the .ipk is pure source).
function loadSsh2() {
  try { return require('ssh2'); } catch (e) {}
  const ws = path.join(process.env.HOME || process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'ssh2') return orig.call(this, path.join(ws, 'ssh2'), ...rest);
    return orig.call(this, request, ...rest);
  };
  return require('ssh2');
}

const { Client } = loadSsh2();

function connect(cfg) {
  return new Promise((resolve, reject) => {
    // `Client.connect()` can THROW SYNCHRONOUSLY when it cannot parse the input
    // (notably: a malformed private key). A bare `new Promise` executor would
    // reject correctly, but this function also gets called from paths where the
    // throw would escape the promise entirely and kill the process before any
    // message is printed. Keeping the call inside the executor plus an explicit
    // try/catch makes the failure readable either way.
    let conn;
    try {
      conn = new Client();
      conn.on('ready', () => resolve(conn));
      conn.on('error', reject);
      conn.connect(cfg);
    } catch (e) {
      reject(e);
    }
  });
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', (d) => (stdout += d));
      stream.stderr.on('data', (d) => (stderr += d));
      stream.on('close', (code) => resolve({ stdout, stderr, code }));
    });
  });
}

function getSftp(conn) {
  return new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
}

// The Developer Mode app serves the SSH private key over plain HTTP on :9991.
// This is the documented mechanism `ares-novacom --getkey` uses; we implement it
// directly so the deploy does not depend on the ares CLI being usable.
function fetchDeviceKey(host) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: 9991, path: '/webos_rsa', method: 'GET', timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`key server returned HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', (e) => reject(new Error(`${e.code || e.message} (port 9991)`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout on port 9991')); });
    req.end();
  });
}

function put(sftp, local, remote) {
  return new Promise((resolve, reject) => sftp.fastPut(local, remote, (e) => (e ? reject(e) : resolve())));
}

// Sanity-check a fetched PEM before it reaches ssh2.
//
// This exists because of a real, hours-losing failure: this host runs an HTTP
// proxy, and a key that was pulled THROUGH it came back with the header line
// corrupted (the letters were substituted, e.g. `-----PBQOC AQX MHATMYD TIP-----`)
// and the body inflated from 1766 to 6241 bytes. ssh2's only comment on that was
// "Cannot parse privateKey: Malformed OpenSSH private key. Bad passphrase?" —
// which points the reader at the passphrase and away from the real cause.
//
// A correct webOS key is ~1.7K and starts with exactly `-----BEGIN RSA PRIVATE
// KEY-----`. Anything else means the bytes were rewritten in transit.
function assertLooksLikeKey(buf) {
  const head = buf.slice(0, 64).toString('utf8');
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(head)) {
    throw new Error(
      'the fetched bytes are not a PEM private key (header is ' +
        JSON.stringify(head.split('\n')[0]) + '). ' +
        'The response was most likely rewritten by an HTTP proxy on this host — ' +
        'check http_proxy/HTTPS_PROXY and make sure requests to the TV bypass it.'
    );
  }
  if (buf.length > 8192) {
    throw new Error(
      `the fetched key is ${buf.length} bytes; a webOS key is ~1.7K. ` +
        'This is the signature of a proxy re-encoding the response (1766 -> 6241).'
    );
  }
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pass = passphrase();
  if (!pass) {
    console.error('Missing TV passphrase.\n' +
      '  node tools/deploy.js <passphrase>        # or\n' +
      '  TV_SSH_PASSPHRASE=xxxx node tools/deploy.js\n' +
      'The passphrase is shown in the TV\'s Developer Mode app.');
    process.exit(2);
  }

  const ipk = findIpk();
  if (!ipk) {
    console.error('No .ipk in dist/. Run ./build.sh first.');
    process.exit(2);
  }
  const ipkName = path.basename(ipk);

  console.log(`TV          : ${USER}@${HOST}:${PORT}`);
  console.log(`artifact    : ${ipkName} (${(fs.statSync(ipk).size / 1024).toFixed(0)}K)`);
  console.log(`install dir : ${REMOTE_DIR}${ipkName}\n`);

  console.log('[1/5] SSH connect');

  // webOS 6 Developer Mode is KEY-ONLY. The passphrase is not an SSH password —
  // it is the passphrase that unlocks the private key served by the device's
  // key server on :9991/webos_rsa. So: fetch the key, then authenticate with
  // it and hand ssh2 the passphrase to unwrap it.
  //
  // ssh2 unwraps an "Proc-Type: 4,ENCRYPTED" PEM natively when given
  // `privateKey` + `passphrase`; there is no need to decrypt it ourselves (and
  // doing so by hand is easy to get wrong — the legacy EVP_BytesToKey path).
  const keyPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.ssh', 'webos_tv_key');
  let privateKey;

  // Prefer a key we already hold, if it passes the same sanity check. Re-fetching
  // every run is what let a proxy-corrupted copy get written over a good one.
  if (fs.existsSync(keyPath)) {
    const cached = fs.readFileSync(keyPath);
    try {
      assertLooksLikeKey(cached);
      privateKey = cached;
      console.log(`  key cached  : ${cached.length} bytes -> ${keyPath}`);
    } catch (e) {
      console.log(`  cached key rejected: ${e.message}`);
    }
  }

  if (!privateKey) {
    try {
      privateKey = assertLooksLikeKey(await fetchDeviceKey(HOST));
      fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
      console.log(`  key fetched : ${privateKey.length} bytes -> ${keyPath}`);
    } catch (e) {
      console.error(`  FAILED to obtain a usable device key`);
      console.error(`  ${e.message}`);
      console.error('  Port 9991 must be open — turn ON the "Key Server" switch in the');
      console.error('  TV\'s Developer Mode app (or restart Developer Mode).');
      process.exit(1);
    }
  }

  let conn;
  try {
    conn = await connect({
      host: HOST, port: PORT, username: USER,
      privateKey,
      // ssh2 unwraps the encrypted PEM with this. Verified working.
      passphrase: pass,
      readyTimeout: 15000,
      // webOS 6 ships OpenSSH 6.1, which offers only legacy algorithms. These
      // names must be the ones ssh2 knows: `ssh-rsa-sha256` is NOT valid (the
      // RSA/SHA-2 host key variants are `rsa-sha2-256` / `rsa-sha2-512`).
      algorithms: {
        serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
        kex: [
          'diffie-hellman-group14-sha1',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group-exchange-sha256',
          'ecdh-sha2-nistp256'
        ],
        cipher: ['aes128-ctr', 'aes256-ctr', 'aes128-gcm@openssh.com']
      }
    });
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    if (/Malformed|Unsupported key format/i.test(e.message)) {
      // ssh2 emits this same message for BOTH a corrupt key and a wrong
      // passphrase, because a bad passphrase yields garbage plaintext. So check
      // the cheap, decisive thing first: the passphrase we actually used.
      console.error(`  passphrase used: ${JSON.stringify(pass)}`);
      console.error('  Either the passphrase is wrong, or the key bytes are corrupt');
      console.error('  (a proxy rewriting :9991/webos_rsa). Verify the key starts with');
      console.error('  "-----BEGIN RSA PRIVATE KEY-----" and is ~1.7K, then re-run.');
    } else if (/authentication/i.test(e.message) || /All configured authentication/i.test(e.message)) {
      console.error('  The passphrase is wrong or Developer Mode was restarted.');
      console.error('  Re-read the passphrase from the TV\'s Developer Mode app.');
    }
    process.exit(1);
  }
  console.log('  connected');

  // Confirm we landed on a webOS device before touching anything.
  const id = await exec(conn, 'cat /etc/version 2>/dev/null || cat /var/run/nyx/os_info.json 2>/dev/null | head -c 200');
  console.log(`  device      : ${(id.stdout || '').trim().slice(0, 120) || '(no version string)'}`);

  console.log('\n[2/5] Upload package');
  await exec(conn, `mkdir -p ${REMOTE_DIR}`).catch(() => {});
  const sftp = await getSftp(conn);
  await put(sftp, ipk, REMOTE_DIR + ipkName);
  sftp.end();
  const ls = await exec(conn, `ls -l ${REMOTE_DIR}${ipkName}`);
  console.log(`  ${(ls.stdout || '').trim() || 'uploaded'}`);

  console.log('\n[3/5] Install via luna-send');
  // `-n N` is the MAXIMUM number of responses to print before exiting. Use a
  // small N: the install service emits an ack when the request is accepted and
  // another when it completes, and waiting for the full count blocks the whole
  // deploy for the subscription window even though the install is long done.
  // 5 is enough to catch accept + progress + installed; if fewer arrive,
  // luna-send still returns as soon as the call settles.
  const installCmd =
    `luna-send-pub -n 5 -f luna://com.webos.appInstallService/dev/install ` +
    `'{"id":"${APP_ID}","ipkUrl":"${REMOTE_DIR}${ipkName}","subscribe":true}'`;
  const inst = await exec(conn, installCmd);
  const instOut = (inst.stdout || '').trim();
  console.log(instOut ? instOut.split('\n').map((l) => '  ' + l).join('\n') : '  (no output)');
  if (inst.stderr && inst.stderr.trim()) console.log('  stderr: ' + inst.stderr.trim().slice(0, 400));

  const okInstall = /"statusValue":\s*30|"state":"installed"|statusValue":\s*30/.test(instOut) ||
                    /installed/i.test(instOut);
  if (!okInstall) {
    // Fall back to a synchronous list to see whether it actually landed.
    const listed = await exec(conn, `ls /media/developer/apps/usr/palm/applications/${APP_ID} 2>/dev/null && echo FOUND || echo MISSING`);
    console.log(`  verify dir: ${(listed.stdout || '').trim()}`);
  }

  console.log('\n[4/5] Confirm installed');
  const list = await exec(conn,
    `luna-send-pub -n 1 -f luna://com.webos.applicationManager/listApps '{}' 2>/dev/null | tr ',' '\\n' | grep -i ${APP_ID} | head -3`);
  console.log(list.stdout && list.stdout.trim() ? '  ' + list.stdout.trim().split('\n').join('\n  ') : '  (listApps showed no match — see journal below if launch fails)');

  console.log('\n[5/5] Launch');
  const launch = await exec(conn,
    `luna-send-pub -n 1 -f luna://com.webos.service.applicationmanager/launch '{"id":"${APP_ID}"}'`);
  console.log('  ' + ((launch.stdout || launch.stderr || '').trim() || '(no output)'));

  console.log('\n--- recent app/service log ---');
  const journal = await exec(conn,
    `tail -n 40 /var/log/messages 2>/dev/null | grep -iE "${APP_ID}|hongguo" | tail -n 15`);
  console.log(journal.stdout && journal.stdout.trim() ? journal.stdout.trim() : '  (nothing yet)');

  conn.end();
  console.log('\nDone. If the app did not appear, check the TV screen for a notification.');
})().catch((e) => {
  console.error('\nDeploy error:', e.message);
  process.exit(1);
});
