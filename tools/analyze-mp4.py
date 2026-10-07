#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MP4 样本完整性分析：逐视频样本走 length-prefix NAL，定位结构损坏样本。
用法: python tools/analyze-mp4.py <file.mp4>"""
import struct, sys

data = open(sys.argv[1], 'rb').read()
SEG = 1024 * 1024

def u32(b, o): return struct.unpack('>I', b[o:o+4])[0]
def u64(b, o): return struct.unpack('>Q', b[o:o+8])[0]

def boxes(buf, start, end):
    o = start
    while o + 8 <= end:
        size, typ = u32(buf, o), buf[o+4:o+8].decode('latin1')
        hdr = 8
        if size == 1:
            size = u64(buf, o+8); hdr = 16
        elif size == 0:
            size = end - o
        yield typ, o, size, hdr
        o += size

def find(buf, start, end, path):
    cur = [(start, end)]
    for want in path:
        nxt = []
        for (s, e) in cur:
            for typ, o, size, hdr in boxes(buf, s, e):
                if typ == want:
                    nxt.append((o + hdr, o + size))
        cur = nxt
        if not cur: return []
    return cur

# ---- 顶层结构 ----
top = [(t, o, s) for t, o, s, h in boxes(data, 0, len(data))]
print('top-level:', [(t, hex(o), s) for t, o, s in top])

moovs = find(data, 0, len(data), ['moov'])
if not moovs: print('NO moov!'); sys.exit(1)
moov_s, moov_e = moovs[0]
print('moov at [%d, %d) size=%d, mdat-after-moov=%s' % (
    moov_s, moov_e, moov_e - moov_s,
    any(t == 'mdat' and o >= moov_e for t, o, s in top)))

# ---- 逐 trak 解析 stbl ----
for trak_s, trak_e in find(data, moov_s, moov_e, ['trak']):
    hdlrs = find(data, trak_s, trak_e, ['mdia', 'hdlr'])
    htype = data[hdlrs[0][0]+8:hdlrs[0][0]+12].decode('latin1') if hdlrs else '?'
    stbls = find(data, trak_s, trak_e, ['mdia', 'minf', 'stbl'])
    if not stbls: continue
    stbl_s, stbl_e = stbls[0]
    tbl = {}
    for typ, o, size, hdr in boxes(data, stbl_s, stbl_e):
        tbl[typ] = (o + hdr, o + size)
    print('\ntrak type=%s boxes=%s' % (htype, sorted(tbl.keys())))

    # stts: entry_count, (count, delta)*
    stts = []
    if 'stts' in tbl:
        s, e = tbl['stts']
        n = u32(data, s + 4)
        o = s + 8
        for _ in range(n):
            stts.append((u32(data, o), u32(data, o + 4))); o += 8
    # timescale
    mdhds = find(data, trak_s, trak_e, ['mdia', 'mdhd'])
    timescale = u32(data, mdhds[0][0] + 12) if mdhds else 90000
    # stss
    keyframes = set()
    if 'stss' in tbl:
        s, e = tbl['stss']
        n = u32(data, s + 4); o = s + 8
        for _ in range(n):
            keyframes.add(u32(data, o)); o += 4
    # stsz
    sizes = []
    s, e = tbl['stsz']
    sample_size = u32(data, s + 4)
    n_samples = u32(data, s + 8)
    if sample_size == 0:
        o = s + 12
        for _ in range(n_samples):
            sizes.append(u32(data, o)); o += 4
    else:
        sizes = [sample_size] * n_samples
    # stsc
    stsc = []
    s, e = tbl['stsc']
    n = u32(data, s + 4); o = s + 8
    for _ in range(n):
        stsc.append((u32(data, o), u32(data, o + 4), u32(data, o + 8))); o += 12
    # stco / co64
    offsets = []
    if 'stco' in tbl:
        s, e = tbl['stco']
        n = u32(data, s + 4); o = s + 8
        for _ in range(n):
            offsets.append(u32(data, o)); o += 4
    elif 'co64' in tbl:
        s, e = tbl['co64']
        n = u32(data, s + 4); o = s + 8
        for _ in range(n):
            offsets.append(u64(data, o)); o += 8

    print('samples=%d timescale=%d keyframes=%d chunks=%d' % (len(sizes), timescale, len(keyframes), len(offsets)))

    # 展开 sample -> file offset
    sample_off = []
    sc = stsc
    chunk_idx = 0
    sample_idx = 0
    for ci, coff in enumerate(offsets):
        # 该 chunk 的 sample 数 = stsc 规则
        per = None
        for j, (first_chunk, spc, desc) in enumerate(sc):
            nxt = sc[j + 1][0] if j + 1 < len(sc) else len(offsets) + 1
            if first_chunk <= ci + 1 < nxt:
                per = spc
        pos = coff
        for _ in range(per):
            sample_off.append(pos)
            pos += sizes[sample_idx]
            sample_idx += 1

    # 时间戳
    ts = []
    t = 0
    for count, delta in stts:
        for _ in range(count):
            ts.append(t); t += delta

    # NAL 走查（视频轨）
    if htype != 'vide':
        print('(非视频轨，跳过 NAL 走查)')
        continue
    bad = []
    for i in range(len(sizes)):
        off, size = sample_off[i], sizes[i]
        if off + size > len(data):
            bad.append((i, off, size, 'overruns file'))
            continue
        p, end = off, off + size
        nals = 0
        ok = True
        while p + 4 <= end:
            nl = u32(data, p)
            if nl == 0 or p + 4 + nl > end:
                ok = False
                break
            p += 4 + nl
            nals += 1
        if not ok or p != end or nals == 0:
            t_sec = (ts[i] / timescale) if i < len(ts) else -1
            bad.append((i, off, size, 'nal-walk fails at +%d (end=%+d), t=%.2fs, key=%s, crosses-1MiB=%s' % (
                p - off, end - p, t_sec,
                (i + 1) in keyframes,
                (off // SEG) != ((off + size - 1) // SEG))))
    print('NAL-corrupt samples: %d / %d' % (len(bad), len(sizes)))
    for b in bad[:20]:
        print('  sample#%d off=%d (0x%x, seg#%d) size=%d %s' % (b[0] + 1, b[1], b[1], b[1] // SEG, b[2], b[3]))
