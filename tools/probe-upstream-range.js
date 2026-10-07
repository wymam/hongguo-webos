// Determine the largest Range size the red-berry CDN will actually honour.
//
// The service reports "媒体 Range 长度异常: 0/262144" — the CDN returns an EMPTY
// body for a 256KiB request, remoteRange() treats that as fatal, prepareHeader()
// fails, the proxy 502s, and playback dies mid-episode.
//
// This runs INSIDE the installed service directory and goes through the
// service's OWN provider.js, so the URL resolution / CENC path is identical to
// production. It then asks for progressively larger windows and reports which
// ones succeed.
const WS = process.env.USERPROFILE + '/.workbuddy/binaries/node/workspace/node_modules/ssh2';
const { Client } = require(WS);
const fs = require('fs');
const KEY = process.env.USERPROFILE + '/.ssh/webos_tv_key';

const PROBE = String.raw`
const dir = '/media/developer/apps/usr/palm/services/com.hongguowebos.app.service';
const provider = require(dir + '/provider.js').provider;
const vid = process.argv[2];

provider.stream(vid, true).then(function (handle) {
  const sizes = [220*1024, 230*1024, 240*1024, 245*1024, 248*1024, 250*1024, 252*1024, 254*1024, 255*1024, 256*1024];
  let i = 0;
  (function next() {
    if (i >= sizes.length) return;
    const size = sizes[i++];
    handle.chunk(0, size - 1).then(function (buf) {
      console.log('OK   ' + size + ' -> ' + Buffer.from(buf).length + ' bytes');
      next();
    }).catch(function (e) {
      console.log('FAIL ' + size + ' -> ' + e.message);
      next();
    });
  })();
}).catch(function (e) { console.log('STREAM_FAIL ' + e.message); });
`;

const c = new Client();
function run(conn, cmd, ms) {
  return new Promise((res) => {
    let out = '';
    conn.exec(cmd, (err, stream) => {
      if (err) return res('ERR ' + err.message);
      const t = setTimeout(() => { try { stream.close(); } catch (e) {} res(out.trim() + '\n[TIMEOUT]'); }, ms || 90000);
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { out += d.toString(); });
      stream.on('close', () => { clearTimeout(t); res(out.trim()); });
    });
  });
}

c.on('ready', async () => {
  const remote = '/media/developer/temp/range-probe2.js';
  await new Promise((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remote);
      ws.on('close', resolve);
      ws.on('error', reject);
      ws.end(Buffer.from(PROBE, 'utf8'));
    });
  });
  const vid = process.argv[3] || '7688396246087650366';
  const out = await run(c, 'cd ' + '/media/developer/apps/usr/palm/services/com.hongguowebos.app.service' + ' && /usr/bin/node ' + remote + ' ' + vid, 120000);
  console.log(out);
  c.end();
}).on('error', (e) => { console.log('SSH ERR ' + e.message); process.exit(1); })
  .connect({ host: '192.0.2.10', port: 9922, username: 'prisoner', privateKey: fs.readFileSync(KEY), passphrase: process.argv[2], readyTimeout: 20000 });
