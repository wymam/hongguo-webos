// Does the HOME feed's video_list carry a usable first-episode id?
//
// The category rows do (`vid_list[0]`), which is what lets a grid probe every
// card's orientation on load. The home feed renders through a different
// adapter (sectionsFromHome) and produced `firstEpisode: ""` for all 36 cards,
// so those cards can never earn a 竖/横 badge. This discovers the real field
// name on the home payload instead of guessing.
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
  const html = await fetchText('https://hongguoduanju.com/');
  const data = extractRouterData(html);
  const ld = (data && data.loaderData) || {};
  console.log('loaderData keys:', Object.keys(ld).join(', '));
  const page = ld.page || ld['home_$'] || ld.home_page || ld.home || null;
  if (!page) { console.log('no page payload'); return; }
  const secs = page.homeSections || page.home_sections || [];
  console.log('sections n =', secs.length);
  const all = new Set();
  let sample = null;
  secs.forEach((s) => {
    const vl = s.video_list || s.videoList || [];
    vl.forEach((r) => { if (!sample) sample = r; Object.keys(r).forEach((k) => all.add(k)); });
  });
  console.log('video_list row keys:', Array.from(all).join(', '));
  if (sample) console.log('sample row:', JSON.stringify(sample).slice(0, 900));
  console.log('vid-ish keys:', Array.from(all).filter((k) => /vid|episode|album|play/i.test(k)).join(', ') || '(none)');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
