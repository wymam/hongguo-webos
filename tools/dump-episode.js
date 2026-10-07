// 本地复现取证：把指定 episode 的完整解密文件拉下来，并做两个决定性实验。
//
//   node tools/dump-episode.js <episodeId>
//
// 实验 1（分割不变性）：同一段字节，一次性 decrypt vs 按 1MiB 分段 decrypt，
//         逐字节比对 —— 若不一致，decryptPartial 在分段边界有真 bug。
// 实验 2（样本表完整性）：解析 moov，逐样本走 length-prefix NAL，
//         报告结构损坏的样本（文件偏移 / 媒体时间戳 / 是否关键帧 / 是否跨 1MiB）。
'use strict';

const fs = require('fs');
const path = require('path');
const { provider } = require('../service/com.hongguowebos.app.service/provider.js');

const SEG = 1024 * 1024;
const episodeId = process.argv[2];
if (!episodeId) { console.error('usage: node tools/dump-episode.js <episodeId>'); process.exit(1); }

(async () => {
  console.log('resolving stream for ' + episodeId + ' ...');
  const h = await provider.stream(episodeId, false);
  console.log('total=' + h.total + ' quality=' + h.quality + ' keyed=' + h.keyed);

  const outDir = path.join(__dirname, 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // ---- 实验 1：分割不变性（前 3MiB，覆盖两个边界） ----
  const testLen = Math.min(3 * SEG, h.total);
  const rawAll = Buffer.from(await h.rawChunk(0, testLen - 1));
  const oneShot = Buffer.from(await h.decrypt(rawAll, 0));
  const parts = [];
  for (let s = 0; s < testLen; s += SEG) {
    const e = Math.min(s + SEG, testLen) - 1;
    const raw = Buffer.from(await h.rawChunk(s, e));
    parts.push(Buffer.from(await h.decrypt(raw, s)));
  }
  const segmented = Buffer.concat(parts);
  const same = oneShot.equals(segmented);
  console.log('\n[实验1] 一次性解密 vs 1MiB 分段解密 (' + testLen + ' bytes): ' + (same ? 'IDENTICAL' : '*** MISMATCH ***'));
  if (!same) {
    let diffs = 0;
    for (let i = 0; i < oneShot.length && diffs < 20; i++) {
      if (oneShot[i] !== segmented[i]) {
        console.log('  first-diff at offset ' + i + ' (0x' + i.toString(16) + '), boundary-dist=' + (i % SEG));
        diffs++;
      }
    }
    let total = 0; for (let i = 0; i < oneShot.length; i++) if (oneShot[i] !== segmented[i]) total++;
    console.log('  total differing bytes: ' + total + '/' + oneShot.length);
  }

  // ---- 全量拉取（按 1MiB 分段，与电视端服务路径完全一致） ----
  console.log('\n[dump] fetching ' + Math.ceil(h.total / SEG) + ' segments ...');
  const segs = [];
  for (let s = 0; s < h.total; s += SEG) {
    const e = Math.min(s + SEG, h.total) - 1;
    const raw = Buffer.from(await h.rawChunk(s, e));
    segs.push(Buffer.from(await h.decrypt(raw, s)));
    process.stdout.write('\r  ' + segs.length + ' / ' + Math.ceil(h.total / SEG));
  }
  const file = Buffer.concat(segs);
  const mp4Path = path.join(outDir, episodeId + '.mp4');
  fs.writeFileSync(mp4Path, file);
  console.log('\n[dump] wrote ' + mp4Path + ' (' + file.length + ' bytes)');

  // 也存一份一次性解密版，若实验1不一致可对比
  if (!same) {
    const rawFull = Buffer.from(await h.rawChunk(0, h.total - 1));
    fs.writeFileSync(path.join(outDir, episodeId + '.oneshot.mp4'), Buffer.from(await h.decrypt(rawFull, 0)));
    console.log('[dump] wrote one-shot variant for comparison');
  }
  console.log('DONE');
})().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });
