// Upstream liveness probe. Reproduces the TV service's exact sandbox load of
// the vendored red-berry source and exercises each layer a playback depends
// on, so "is the API expired?" is answered by the upstream itself rather than
// by a device we cannot reach.
//
// Layers, cheapest first:
//   1. routerData(SITE)        site shell + _ROUTER_DATA still parses
//   2. appSearchPage           the app search endpoint answers & signs
//   3. fetchVideoInfo(vid)     the player video model endpoint answers
//   4. resolveStream(vid)      the SIGNED stream resolution actually returns
//
// Usage: node tools/probe-upstream.js [vid ...]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cryptoShim = require(path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'crypto-shim.js'));
const crypto = require('crypto');
const httpClient = require(path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'http-client.js'));

const VENDOR = path.join(__dirname, '..', 'service', 'com.hongguowebos.app.service', 'vendor', 'hongguo.cjs');

// VIDs observed in the field on the device (from getDiagnostics history).
const DEFAULT_VIDS = [
  '7692013554404166680',
  '7692013453707332632',
  '7680977186605517849'
];

async function main() {
  const vids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_VIDS;

  const source = fs.readFileSync(VENDOR, 'utf8');
  const context = vm.createContext({
    require: (name) => {
      if (name === 'node:crypto' || name === 'crypto') return crypto;
      throw new Error('Unsupported module: ' + name);
    },
    Buffer, URL, URLSearchParams, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
    process: { env: {} },
    axios: httpClient
  });

  const exportList = [
    'categoryPage', 'categoryData', 'itemToCard', 'appSearchPage', 'routerData',
    'resolveStream', 'fetchVideoInfo', 'prepareHeader', 'remoteRange', 'decryptPartial',
    'streamCache', 'videoInfoCache', 'pageCache', 'appSearchCache'
  ].join(', ');

  vm.runInContext(source + '\nthis.api = {' + exportList + '};', context, { timeout: 10000, filename: 'hongguo.cjs' });
  const a = context.api;
  const SITE = 'https://hongguoduanju.com';

  const results = [];
  const brief = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n || 90);

  // ---------- 1. site shell ----------
  try {
    const t0 = Date.now();
    const rd = await a.routerData(SITE);
    results.push({ layer: '1 routerData(site)', ok: true, ms: Date.now() - t0,
      detail: 'keys=' + Object.keys(rd || {}).slice(0, 6).join(',') });
  } catch (e) {
    results.push({ layer: '1 routerData(site)', ok: false, ms: 0, detail: e.message });
  }

  // ---------- 2. app search ----------
  try {
    const t0 = Date.now();
    const r = await a.appSearchPage('红果', 11, 1, 10);
    results.push({ layer: '2 appSearchPage', ok: !!(r && r.list && r.list.length), ms: Date.now() - t0,
      detail: 'list=' + ((r && r.list && r.list.length) || 0) });
  } catch (e) {
    results.push({ layer: '2 appSearchPage', ok: false, ms: 0, detail: e.message });
  }

  // ---------- 3/4. video model + signed stream ----------
  for (const vid of vids) {
    let infoOk = false, infoMs = 0, infoErr = '';
    try {
      const t0 = Date.now();
      const info = await a.fetchVideoInfo(vid);
      infoMs = Date.now() - t0;
      const n = info && info.video_resource ? info.video_resource.length : 0;
      infoOk = n > 0;
      infoErr = infoOk ? '' : brief(JSON.stringify(info).slice(0, 160));
      results.push({ layer: '3 fetchVideoInfo(' + vid + ')', ok: infoOk, ms: infoMs,
        detail: infoOk ? 'video_resource=' + n : 'EMPTY ' + infoErr });
    } catch (e) {
      results.push({ layer: '3 fetchVideoInfo(' + vid + ')', ok: false, ms: 0, detail: e.message });
    }

    try {
      const t0 = Date.now();
      const st = await a.resolveStream(vid, 'auto');
      const keys = st ? Object.keys(st) : [];
      const dur = st && st.duration != null ? st.duration : (st && st.total ? st.total : '?');
      results.push({ layer: '4 resolveStream(' + vid + ')', ok: !!(st && st.url || st && st.key || keys.length),
        ms: Date.now() - t0,
        detail: 'keys=' + keys.join(',') + ' dur/len=' + String(dur).slice(0, 24) });
    } catch (e) {
      results.push({ layer: '4 resolveStream(' + vid + ')', ok: false, ms: 0,
        detail: (e.code ? e.code + ' ' : '') + e.message });
    }
  }

  // ---------- report ----------
  console.log('\n===== UPSTREAM PROBE ' + new Date().toISOString() + ' =====');
  for (const r of results) {
    console.log((r.ok ? '  OK   ' : '  FAIL ') + r.layer.padEnd(34) + String(r.ms).padStart(6) + 'ms  ' + brief(r.detail, 110));
  }
  const failed = results.filter((r) => !r.ok);
  console.log('-----');
  console.log(failed.length === 0 ? 'ALL LAYERS OK — upstream is alive' : failed.length + '/' + results.length + ' LAYERS FAILED');
  process.exit(failed.length === 0 ? 0 : 2);
}

main().catch((e) => { console.error('PROBE CRASH: ' + (e && e.stack || e)); process.exit(1); });
