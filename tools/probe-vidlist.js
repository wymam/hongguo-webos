// Does the category row carry a usable first-episode id?
//
// Needed for #4 (detect portrait/landscape for EVERY card at load time): the
// list rows have no width/height field, so the only way to know the footage's
// orientation is to look at the video itself — which needs an episode id.
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(brace, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

(async () => {
  const html = await fetchText('https://hongguoduanju.com/category/real-drama');
  const data = extractRouterData(html);
  const page = data && data.loaderData && data.loaderData['category_$'];
  const list = (page && page.recommendList) || [];
  console.log('recommendList n =', list.length);
  console.log('pagination =', JSON.stringify(page && page.pagination));
  for (let i = 0; i < 3; i++) {
    const r = list[i] || {};
    const vl = r.vid_list || [];
    console.log(`\n[${i}] ${r.series_name}  series_id=${r.series_id}`);
    console.log('   vid_list len =', vl.length, ' typeof[0] =', typeof vl[0]);
    console.log('   vid_list[0] =', JSON.stringify(vl[0]));
    console.log('   vid_list[1] =', JSON.stringify(vl[1]));
    console.log('   series_episode_info =', JSON.stringify(r.series_episode_info));
  }
  // Any dimension-ish field anywhere in the row?
  const keys = new Set();
  list.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  console.log('\nall row keys:', Array.from(keys).join(', '));
  console.log('dimension-ish keys:', Array.from(keys).filter((k) => /width|height|ratio|vertical|horizontal|orient|size/i.test(k)).join(', ') || '(none)');
})().catch((e) => { console.error(e); process.exit(1); });
