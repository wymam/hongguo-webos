// Nails down the live website-search contract.
//
// Finding: the vendored code builds /search/<keyword>?page=N (path form), but
// the live site expects /search?query=<kw>&page=N (query form). The path form
// redirects to a shell whose loaderData has no searchList, which is why search
// silently came back empty.
//
// Usage: node tools/probe-search-web.js
'use strict';

const https = require('https');

function fetchText(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 16; zh_CN; 25053RT47C) AppleWebKit/537.36',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 4) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchText(next, depth + 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, url, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

function extractRouterData(html) {
  const at = html.indexOf('_ROUTER_DATA');
  if (at < 0) return null;
  const brace = html.indexOf('{', at);
  if (brace < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = brace; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(brace, i + 1)); } catch (e) { return { __parseError: e.message }; }
      }
    }
  }
  return null;
}

function findSearchLists(data) {
  const hits = [];
  const ld = (data && data.loaderData) || {};
  for (const [key, val] of Object.entries(ld)) {
    if (!val || typeof val !== 'object') continue;
    for (const [k, v] of Object.entries(val)) {
      if (Array.isArray(v) && /list/i.test(k)) {
        hits.push({ key: `${key}.${k}`, count: v.length, sampleKeys: v[0] ? Object.keys(v[0]) : [], sample: v[0] });
      }
    }
  }
  return hits;
}

(async () => {
  const kw = '总裁';
  const cases = [
    `https://hongguoduanju.com/search?query=${encodeURIComponent(kw)}`,
    `https://hongguoduanju.com/search?query=${encodeURIComponent(kw)}&page=2`,
    `https://hongguoduanju.com/search/${encodeURIComponent(kw)}?page=1`
  ];

  for (const url of cases) {
    console.log(`\n${'='.repeat(70)}\n${url}\n${'='.repeat(70)}`);
    let r;
    try { r = await fetchText(url); } catch (e) { console.log(`  FETCH FAILED ${e.message}`); continue; }
    console.log(`  HTTP ${r.status}  final: ${r.url}`);
    const data = extractRouterData(r.body);
    if (!data) { console.log('  no _ROUTER_DATA'); continue; }
    if (data.__parseError) { console.log(`  parse error: ${data.__parseError}`); continue; }
    console.log(`  loaderData keys: ${JSON.stringify(Object.keys(data.loaderData || {}))}`);
    const lists = findSearchLists(data);
    if (!lists.length) { console.log('  no list-shaped members found'); }
    for (const h of lists) {
      console.log(`  ${h.key}  n=${h.count}`);
      console.log(`    keys: ${h.sampleKeys.join(', ')}`);
      console.log(`    [0]: ${JSON.stringify(h.sample).slice(0, 340)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
