// Send a second launch request to the TV.
//
// Needed because the first `launch` from deploy.js races the install: while the
// old instance is still running, applicationManager replies
// `errorCode: -102 "app is locked"`. By the time this runs the previous process
// has exited, so the launch takes.
//
//   node tools/relaunch.js <passphrase>
//   TV_SSH_PASSPHRASE=xxxx node tools/relaunch.js
const fs = require('fs');
const path = require('path');

// Node resolution: ssh2 lives in the managed workspace, not in this project
// (the project itself stays dependency-free so the .ipk is pure source).
function loadSsh2() {
  try { return require('ssh2'); } catch (e) { /* fall through to the workspace */ }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const ws = path.join(home, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules');
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'ssh2') return orig.call(this, path.join(ws, 'ssh2'), ...rest);
    return orig.call(this, request, ...rest);
  };
  return require('ssh2');
}

const { Client } = loadSsh2();

// The TV's LAN address is machine-specific and is never committed: set TV_HOST
// in your environment (the default below is a placeholder, not a real device).
const HOST = process.env.TV_HOST || '192.0.2.10';
const PORT = Number(process.env.TV_SSH_PORT || 9922);
const USER = process.env.TV_SSH_USER || 'prisoner';
const APP_ID = process.env.TV_APP_ID || 'com.hongguowebos.app';

// The passphrase changes every time Developer Mode is restarted.
function resolvePass() {
  const arg = process.argv.slice(2).find((a) => a && !a.startsWith('-'));
  if (arg) return arg;
  if (process.env.TV_SSH_PASSPHRASE) return process.env.TV_SSH_PASSPHRASE;
  return null;
}

const home = process.env.HOME || process.env.USERPROFILE || '';
const keyPath = process.env.TV_KEY_PATH || path.join(home, '.ssh', 'webos_tv_key');

const conn = new Client();
conn.on('ready', () => {
  const payload = JSON.stringify({ id: APP_ID });
  const cmd = `luna-send-pub -n 1 -f luna://com.webos.applicationManager/launch '${payload}'`;
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err.message); conn.end(); return; }
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', () => conn.end());
  });
});
conn.on('error', (e) => { console.error('ssh error:', e.message); process.exit(1); });

conn.connect({
  host: HOST,
  port: PORT,
  username: USER,
  privateKey: fs.readFileSync(keyPath),
  passphrase: resolvePass(),
  readyTimeout: 15000,
  // webOS 6 ships OpenSSH 6.1, which offers only legacy algorithms. These names
  // must be the ones ssh2 knows (`rsa-sha2-256`, not `ssh-rsa-sha256`).
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
