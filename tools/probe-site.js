// Structural probe for the red-berry site's SSR payloads.
//
// The upstream vendor file was pinned in 2026-09; since then the site moved
// its category routes from query form (?tab=1&sort_type=1) to path form
// (/category/real-drama) and relocated rank pages from /category/hot-* to
// /rank/hot-*. This script discovers the CURRENT shape so the provider layer
// can be built against reality rather than a stale assumption.
//
// Usage: node tools/probe-site.js
'use strict';

const https = require('https');

function fetchText(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 16; zh_CN; 25053RT47C) AppleWebKit/537.36',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }, headers || {})
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location, headers).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('timeout')); });
  });
}

// Extract the JSON object assigned to window._ROUTER_DATA by brace matching.
function extractRouterData(html) {
  const marker = '_ROUTER_DATA';
  const at = html.indexOf(marker);
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
        const raw = html.slice(brace, i + 1);
        try { return JSON.parse(raw); } catch (e) { return { __parseError: e.message, __len: raw.length }; }
      }
    }
  }
  return null;
}

function summarizeLoaderData(data) {
  if (!data || !data.loaderData) return '(no loaderData)';
  const out = [];
  for (const [key, val] of Object.entries(data.loaderData)) {
    const shape = val && typeof val === 'object' ? Object.keys(val) : typeof val;
    out.push(`      ${key} -> ${JSON.stringify(shape)}`);
  }
  return out.join('\n');
}

// Walk loaderData looking for any array whose elements look like content rows
// (objects carrying both a title-ish and an image-ish field).
function findContentArrays(data, limit = 6) {
  const hits = [];
  const seen = new Set();
  function walk(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object') {
        const keys = Object.keys(node[0]);
        const hasTitle = keys.some((k) => /title|name|book_name|series_name/i.test(k));
        const hasImg = keys.some((k) => /img|cover|url|thumb|poster/i.test(k));
        const sig = keys.sort().join(',');
        if (hasTitle && hasImg && !seen.has(sig)) {
          seen.add(sig);
          hits.push({ path, count: node.length, keys, sample: pick(node[0]) });
        }
      }
      for (let i = 0; i < Math.min(node.length, 3); i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  }
  walk(data.loaderData || data, '', 0);
  return hits.slice(0, limit);
}

function pick(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (typeof v === 'object') { out[k] = Array.isArray(v) ? `[${v.length}]` : '{obj}'; continue; }
    const s = String(v);
    out[k] = s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  return out;
}

const TARGETS = [
  ['home /', 'https://hongguoduanju.com/'],
  ['category real-drama', 'https://hongguoduanju.com/category/real-drama'],
  ['category comic-drama', 'https://hongguoduanju.com/category/comic-drama'],
  ['rank hot-drama', 'https://hongguoduanju.com/rank/hot-drama']
];

(async () => {
  for (const [label, url] of TARGETS) {
    console.log(`\n${'='.repeat(70)}\n${label}\n  ${url}\n${'='.repeat(70)}`);
    let r;
    try {
      r = await fetchText(url);
    } catch (e) {
      console.log(`  FETCH FAILED: ${e.message}`);
      continue;
    }
    console.log(`  HTTP ${r.status}, ${r.body.length} bytes`);
    const data = extractRouterData(r.body);
    if (!data) { console.log('  no _ROUTER_DATA found'); continue; }
    if (data.__parseError) { console.log(`  _ROUTER_DATA JSON parse failed: ${data.__parseError} (len ${data.__len})`); continue; }
    console.log('  loaderData keys:');
    console.log(summarizeLoaderData(data));
    const arrays = findContentArrays(data);
    console.log(`  content-like arrays (${arrays.length}):`);
    for (const a of arrays) {
      console.log(`    ${a.path}  n=${a.count}`);
      console.log(`      keys: ${a.keys.join(', ')}`);
      console.log(`      [0]:  ${JSON.stringify(a.sample)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
