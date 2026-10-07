// Second-stage probe: digs into the shapes the provider layer must map.
// Specifically the rank page's `content` field and the detail page's
// series/episode structure, which were not covered by probe-site.js.
//
// Usage: node tools/probe-detail.js
'use strict';

const https = require('https');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 16; zh_CN; 25053RT47C) AppleWebKit/537.36',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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

function shape(v, depth = 0) {
  if (v == null) return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[${v.length} x ${depth < 3 ? shape(v[0], depth + 1) : '...'}]`;
  }
  if (typeof v === 'object') {
    if (depth > 3) return '{...}';
    return '{ ' + Object.entries(v).map(([k, x]) => `${k}:${shape(x, depth + 1)}`).join(', ') + ' }';
  }
  if (typeof v === 'string') return v.length > 30 ? `"${v.slice(0, 30)}…"` : `"${v}"`;
  return String(v);
}

(async () => {
  console.log('===== RANK page content shape =====');
  const rank = await fetchText('https://hongguoduanju.com/rank/hot-drama');
  const rd = extractRouterData(rank.body);
  const rankPage = rd && rd.loaderData && rd.loaderData['rank_hot-drama/page'];
  if (rankPage) {
    console.log(JSON.stringify({
      rankKey: rankPage.rankKey,
      updatedText: rankPage.updatedText,
      pageNum: rankPage.pageNum
    }, null, 2));
    console.log('\ncontent shape:');
    console.log(shape(rankPage.content));
    const content = rankPage.content;
    // try to locate the list of ranked series
    for (const [k, v] of Object.entries(content || {})) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        console.log(`\n  array ${k}: n=${v.length}`);
        console.log(`    keys: ${Object.keys(v[0]).join(', ')}`);
        console.log(`    [0] sample: ${JSON.stringify(v[0]).slice(0, 700)}`);
      }
    }
  } else {
    console.log('rank page shape not found; loaderData keys:', rd && rd.loaderData ? Object.keys(rd.loaderData) : 'none');
  }

  console.log('\n\n===== DETAIL page shape =====');
  // Use a real series id discovered from the category listing.
  const cat = await fetchText('https://hongguoduanju.com/category/real-drama');
  const cd = extractRouterData(cat.body);
  const rec = cd && cd.loaderData && cd.loaderData['category_$'] && cd.loaderData['category_$'].recommendList;
  const seriesId = rec && rec[0] && rec[0].series_id;
  console.log(`using series_id = ${seriesId}`);

  for (const url of [
    `https://hongguoduanju.com/detail?series_id=${seriesId}`,
    `https://hongguoduanju.com/series/${seriesId}`,
    `https://hongguoduanju.com/detail/${seriesId}`
  ]) {
    const r = await fetchText(url);
    console.log(`\n  ${url}\n    HTTP ${r.status}, ${r.body.length} bytes`);
    const d = extractRouterData(r.body);
    if (!d) { console.log('    no _ROUTER_DATA'); continue; }
    const keys = d.loaderData ? Object.keys(d.loaderData) : [];
    console.log(`    loaderData keys: ${JSON.stringify(keys)}`);
    for (const k of keys) {
      const v = d.loaderData[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        console.log(`      ${k}: ${shape(v)}`.slice(0, 1200));
      }
    }
    break;
  }
})().catch((e) => { console.error(e); process.exit(1); });
