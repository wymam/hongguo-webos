import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCategory } from '../api/client';
import { useFocusable, setContentContext, resetContentMemory, hasFocusable, onFocusChange } from '../hooks/useFocus';
import ShelfGrid, { useShelfFooterUp } from '../components/ShelfGrid';
import { Loading, PageState } from '../components/Common';
import { getSettings, clampCols } from '../utils/storage';

// Category browsing with genre filters and batch paging.
//
// The API returns 24 items per page plus a `filters` group (genre slugs).
//
// TWO THINGS HERE ARE THE DIRECT RESULT OF A REPORTED BUG
//
// 1. The genre strip is a GRID, not a wrapped line.
//
//    The live payload ships 24 genres for 真人剧 (and 8 for the other two).
//    They used to be numbered `filter-0-0 … filter-0-23` — one row, twenty-four
//    columns — while the markup wrapped them onto three visual lines. Focus
//    moves by `row ± 1`, so ArrowDown looked for `filter-1-0`, found nothing,
//    and the key died: everything past the first wrapped line (古装, 都市,
//    玄幻 …) was visible but IMPOSSIBLE to select. This is what the owner hit
//    as "用向上按键无法选择到爱情、年代之类的过滤选项".
//
//    Numbering them by real row and column fixes it: the D-pad walks the strip
//    the way it reads.
//
// 2. A "page" is a BATCH, not 24 items.
//
//    Upstream paginates at 24 — barely three rows — so the viewer hit "next
//    page" almost immediately. The service now keeps pulling until the screen
//    holds >= 50 (see provider.category's minItems), and the UI pages by batch.
//
// 3. The genre strip stays within TWO rows (the owner asked "不要太多行，不超2行"),
//    but it must FILL each row before wrapping.
//
//    The previous version split the list into two EQUAL halves by index
//    (`perRow = ceil(n / 2)`), which made every row pay for the widest chip it
//    happened to contain. 真人剧's 24 genres + 全部 came out as 13+12 and each
//    row ended mid-screen with a lake of dead space — the owner's "右边关键字
//    筛选尽量铺满整行".
//
//    Chip width is not derivable from a character count (CJK labels, 2px
//    borders, 24px radius), so the row is packed from a MEASURED width: each
//    chip's own offsetWidth, read after the first paint. Until that measurement
//    exists the strip falls back to an even split, which is exactly the old
//    behaviour — the layout can never be worse than it was.
//
//    The packer is greedy: take chips while they fit the usable width, then
//    wrap. So a list that already fits stays on ONE row, which is the other
//    half of the request ("如果一行可以铺满，就不要分2行").

export default function CategoryPage({ categoryKey, categoryName, onOpenSeries, onLongPress, refreshKey }) {
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [skip, setSkip] = useState(0);
  const [state, setState] = useState({ status: 'loading', items: [], filters: [], pagination: null, busy: false, error: '' });
  const cols = clampCols(getSettings().gridCols);

  // `keepItems` keeps the CURRENT screen mounted while the next one loads.
  //
  // This is not just cosmetic. Browsing a genre used to blank the whole page:
  // `selectGenre` called `load(1, next, false)`, which set status to 'loading',
  // which made this component `return <Loading/>` — unmounting the genre strip
  // and the grid. Every focusable unregistered, `currentFocusId` went null, and
  // the next D-pad press then hit the "nothing is focused" branch in the key
  // handler, which calls `focusSidebar()`. The owner saw that as "按方向向下键
  // 跳到了左边的菜单栏" — the focus had not moved down at all; it had been
  // destroyed and the fallback had taken over.
  //
  // Keeping the previous screen mounted also removes the white flash, which is
  // most of what "加载慢" feels like: the wait is the same, but the viewer is
  // no longer staring at a replacement page while it happens.
  const load = useCallback(
    (nextPage, nextGenre, keepItems, nextSkip) => {
      let alive = true;
      setState((s) => ({ ...s, status: s.items.length && keepItems ? 'ready' : 'loading', busy: !!keepItems, error: '' }));
      getCategory(categoryKey, nextPage, nextGenre, BATCH_MIN_ITEMS, nextSkip || 0)
        .then((res) => {
          if (!alive) return;
          if (!res || res.returnValue === false) {
            // A FAILED keepItems load must not blank the screen either: the
            // viewer would lose the grid, the strip, and the focus with them —
            // the exact failure this flag was introduced to fix. Keep what is
            // on screen and surface the error as a status line instead.
            setState((s) => (keepItems && s.items.length
              ? { ...s, status: 'ready', busy: false, error: (res && res.errorText) || '加载失败' }
              : { ...s, status: 'error', busy: false, error: (res && res.errorText) || '加载失败' }));
            return;
          }
          const items = Array.isArray(res.items) ? res.items : [];
          setState({
            status: items.length ? 'ready' : 'empty',
            items,
            filters: Array.isArray(res.filters) ? res.filters : [],
            pagination: res.pagination || null,
            busy: false,
            error: ''
          });
        })
        .catch((e) => {
          if (!alive) return;
          setState((s) => (keepItems && s.items.length
            ? { ...s, status: 'ready', busy: false, error: e.message || '网络错误' }
            : { ...s, status: 'error', busy: false, error: e.message || '网络错误' }));
        });
      return () => {
        alive = false;
      };
    },
    [categoryKey]
  );

  useEffect(() => {
    setContentContext('category');
    resetContentMemory();
    setGenre('');
    setPage(1);
    setSkip(0);
    return load(1, '', false, 0);
  }, [load, categoryKey, refreshKey]);

  const selectGenre = (id) => {
    const next = genre === id ? '' : id;
    setGenre(next);
    setSkip(0);
    setPage(1);
    // Keep the screen mounted: the strip must stay so the focused chip keeps
    // its identity, and the grid must stay so Down has a card to land on.
    load(1, next, true, 0);
  };

  // Same reasoning as `selectGenre`: a batch jump must not unmount the grid,
  // or the pager the viewer is standing on vanishes under them.
  const gotoBatch = (nextPage, nextSkip) => {
    setPage(nextPage);
    setSkip(nextSkip || 0);
    load(nextPage, genre, true, nextSkip || 0);
  };

  const pagination = state.pagination;
  const total = pagination ? pagination.total : 0;
  const hasMore = !!(pagination && pagination.hasMore);
  const hasPrev = !!(pagination && pagination.hasPrev);
  const pageSpan = useMemo(() => rangeLabel(pagination, state.items.length), [pagination, state.items.length]);

  // The batch index list, so the footer can offer "which screen of the category
  // am I in" as numbers instead of a two-state 上一批 / 下一批 pair.
  //
  // A batch is a SCREEN of exactly BATCH_MIN_ITEMS (50) items, so batch N
  // starts at ITEM offset (N-1) × 50. The batch count is therefore
  // `ceil(total / 50)` — derived from the item total, not from upstream page
  // counts.
  //
  // This used to be computed from `totalPages / stride`, where stride was
  // "pages per batch". That was wrong twice over: it keyed the numbers on the
  // UPSTREAM's page size (24) rather than on what the viewer actually sees,
  // and because 50 is not a multiple of 24 the page↔item mapping drifted, so
  // the last screen could hold anything from 1 to 50 items and the pager's
  // numbers did not match the screens behind them. Counting in ITEMS keeps the
  // pager honest for any upstream page size.
  //
  // The (page, skip) coordinate that starts a batch is derived from the same
  // item offset, and is what the service is asked for — see `batchCoord`.
  const batches = useMemo(() => {
    if (!pagination) return { current: 1, total: 1, size: 0, starts: [] };
    const size = BATCH_MIN_ITEMS;
    const itemTotal = pagination.total > 0 ? pagination.total : state.items.length;
    const count = Math.max(1, Math.ceil(itemTotal / size));
    // Which batch is on screen: derived from where THIS batch started, in
    // items. `pagination.page`/`skip` is the coordinate we asked for.
    const startOffset = ((pagination.page || 1) - 1) * (pagination.pageSize || 24) + (pagination.skip || 0);
    const current = Math.min(count, Math.max(1, Math.floor(startOffset / size) + 1));
    const starts = [];
    for (let i = 0; i < count; i++) starts.push(i * size);
    const b = { current, total: count, size, starts, startOffset, itemTotal };
    // Exposed for on-device probes: a TV has no devtools, and the batch maths is
    // the one piece of this page that cannot be read off the DOM.
    if (typeof window !== 'undefined') window.__hongguoBatches = b;
    return b;
  }, [pagination, state.items.length]);

  const gotoBatchIndex = (i) => {
    if (i < 1 || !batches.starts.length) return;
    const offset = batches.starts[i - 1];
    if (offset === undefined) return;
    const coord = batchCoord(offset, pagination);
    gotoBatch(coord.page, coord.skip);
  };

  // Every hook this component owns must be called BEFORE the early returns
  // below. `chips` used to be computed after them, so the loading render ran
  // fewer hooks than the ready render — React error #310 ("Rendered more hooks
  // than during the previous render"), which blanked the whole page.
  const genreItems = state.filters.length ? state.filters[0].items : [];

  // 全部 + every genre, packed by MEASURED width into at most TWO rows.
  //
  // Measurement protocol: the strip is rendered with a provisional even split,
  // then a layout effect reads each chip's offsetWidth and re-packs. The
  // measurement is keyed on the label list so it runs once per real content
  // change, not on every render.
  const list = useMemo(
    () => [{ id: '', name: '全部' }].concat(genreItems.map((g) => ({ id: g.id, name: g.name }))),
    [genreItems]
  );

  const gridRef = useRef(null);
  // Per-chip geometry as MEASURED by the probe effect below. Each entry keeps
  // the two parts of a chip's width separate, because only one of them scales
  // with the font:
  //
  //   text  = the label's rendered advance (grows with font-size)
  //   fixed = padding + borders (constant)
  //
  // Splitting them is what lets the layout ask "if the font were 20% bigger,
  // how wide would this chip be?" without re-measuring the DOM for every
  // candidate size — a re-measure per candidate would be a layout thrash.
  const [chipGeom, setChipGeom] = useState(null);
  const [stripWidth, setStripWidth] = useState(0);

  // ---- strip layout: font scale + row split --------------------------------
  //
  // The owner's two asks are one problem seen from two sides:
  //
  //   "真人剧的关键字筛选标题既然分成2行就做大点、格式平均一点尽量铺满2行"
  //   "其他页 一行的关键字标题页做的稍微大点，尽量不要这么空"
  //
  // Both say the same thing: the chips are too small for the room they have.
  // Measured on the TV, a 25-genre strip used 60% + 57% of the width — 40% of
  // every row stood empty. So the strip no longer just decides HOW TO SPLIT a
  // fixed-size row set; it first decides HOW BIG the chips should be, and only
  // then splits what is left.
  //
  // The search walks the font scale up and keeps the best layout it finds:
  //
  //   * one row always beats two ("一行可以铺满就不要分2行");
  //   * among layouts with the same row count, the one whose EMPTIEST row is
  //     fullest wins ("尽量铺满").
  //
  // It never returns more than two rows, and the scale is capped so a
  // three-label strip cannot inflate into a wall of enormous pills.
  const layout = useMemo(() => {
    const n = list.length;
    const perRow = Math.max(1, Math.ceil(n / 2));
    const evenSplit = () => {
      const rows = [];
      for (let i = 0; i < n; i += perRow) rows.push(list.slice(i, i + perRow));
      return { rows, scale: 1, stretch: false, fill: null };
    };
    // Nothing measured yet (first paint, or a layout-less render): fall back to
    // the historical even split at the CSS font size. Never worse than before.
    if (!chipGeom || chipGeom.length !== n || !stripWidth) return evenSplit();

    // The row split for a set of per-chip widths, as index ranges. Balanced,
    // with neither half allowed to overflow; greedy only as a rescue when no
    // balanced split exists (a chip or pair too wide to halve).
    const split = (widths) => {
      let total = 0;
      for (let i = 0; i < n; i++) total += widths[i] + CHIP_GAP;
      if (total <= stripWidth) return [[0, n]];

      let bestAt = 0;
      let bestGap = Infinity;
      let prefix = 0;
      for (let i = 0; i < n - 1; i++) {
        prefix += widths[i] + CHIP_GAP;
        const tail = total - prefix;
        if (prefix > stripWidth || tail > stripWidth) continue;
        const gap = Math.abs(prefix - tail);
        if (gap < bestGap) { bestGap = gap; bestAt = i + 1; }
      }
      if (bestAt) return [[0, bestAt], [bestAt, n]];

      const rows = [];
      let from = 0;
      let used = 0;
      for (let i = 0; i < n; i++) {
        const w = widths[i] + CHIP_GAP;
        if (i > from && used + w > stripWidth) {
          rows.push([from, i]);
          from = i;
          used = 0;
        }
        used += w;
      }
      rows.push([from, n]);
      return rows;
    };

    // How full the emptiest row is, as a fraction of the strip width. This is
    // the number to maximise: a two-row layout is only "filled" when its
    // *thinner* row is.
    const thinnestFill = (widths, ranges) => {
      let worst = Infinity;
      for (let k = 0; k < ranges.length; k++) {
        let sum = 0;
        for (let i = ranges[k][0]; i < ranges[k][1]; i++) sum += widths[i] + CHIP_GAP;
        const f = sum / stripWidth;
        if (f < worst) worst = f;
      }
      return worst;
    };

    const STEPS = 36; // ~3% font increments; runs once per label set, not per frame
    let best = null;
    for (let k = 0; k <= STEPS; k++) {
      const s = 1 + (CHIP_SCALE_MAX - 1) * (k / STEPS);
      // Prediction is not exact: glyph advance does not scale perfectly
      // linearly (hinting, sub-pixel rounding and font fallback all move the
      // number a little). Measured on the TV, a prediction that said "two rows"
      // at scale 1.6 rendered as three — the browser wrapped the overflow onto
      // a third line, which `overflow: hidden` then CUT OFF, hiding chips the
      // D-pad still believed in. `CHIP_SAFETY` keeps the predicted width on the
      // generous side so the rows we plan are the rows that appear.
      const widths = chipGeom.map((g) => (g.text * s + g.fixed) * CHIP_SAFETY);
      const ranges = split(widths);
      if (ranges.length > 2) break; // three rows: disqualified, and only worse ahead
      const fill = thinnestFill(widths, ranges);
      if (fill > 1.01) continue; // a row this full has already wrapped
      const better =
        !best ||
        ranges.length < best.ranges.length ||
        (ranges.length === best.ranges.length && fill > best.fill);
      if (better) best = { ranges, scale: s, fill };
      // A single, well-filled row is the ideal; growing further would only
      // push it back over into two. Stop.
      if (best.ranges.length === 1 && best.fill >= CHIP_FILL_TARGET) break;
    }
    if (!best) return evenSplit();
    // Stretching is for the ONE-ROW case only.
    //
    // With two rows the font has already been grown until the rows are full, so
    // there is no slack left to share — and enabling grow there did real damage:
    // `flex: 1 1 auto` cannot shrink a chip below its min-content width (the
    // labels are `nowrap`), so a full two-row strip kept its natural widths,
    // added 13 gaps on top, and overflowed by 184px (measured: scrollWidth 1916
    // against a 1732 client width), clipping the tail.
    //
    // A single row that is still short of the target is a different situation:
    // there IS space, and sharing it is exactly what the owner asked for
    // ("尽量不要这么空").
    const stretch = best.ranges.length === 1 && best.fill < CHIP_FILL_TARGET;
    const result = {
      rows: best.ranges.map((r) => list.slice(r[0], r[1])),
      scale: best.scale,
      stretch,
      fill: best.fill
    };
    // Exposed for on-device probes, alongside window.__hongguoBatches. The
    // decision above is the one thing a probe cannot reconstruct from the DOM:
    // it sees the ROWS the search chose, but not the scale it rejected or the
    // measured geom it decided from.
    if (typeof window !== 'undefined') {
      window.__hongguoLayout = {
        n,
        stripWidth,
        scale: best.scale,
        fill: best.fill,
        stretch,
        rows: best.ranges,
        geom: chipGeom.map((g) => ({ text: Math.round(g.text), fixed: Math.round(g.fixed) }))
      };
    }
    return result;
  }, [list, chipGeom, stripWidth]);

  const chips = layout.rows;
  const chipScale = layout.scale;

  // Measure the chips ONCE per label set, and the strip width alongside them.
  //
  // The measurement is taken at the UNSCALED font (the layout above only ever
  // writes `--chip-scale` after this runs), so `text` and `fixed` stay a clean
  // base to scale from. `offsetWidth` includes the padding and borders, so the
  // text advance is recovered by subtracting them — reading the computed style
  // rather than assuming keeps this correct if the CSS padding changes.
  //
  // A chip's geometry is a pure function of its label and the CSS, so this
  // never needs to run again for the same labels.
  useEffect(() => {
    const dom = gridRef.current;
    if (!dom) return;
    const nodes = dom.querySelectorAll('.filter-chip');
    if (!nodes.length || nodes.length !== list.length) return;
    const measured = [];
    let ok = true;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const cs = window.getComputedStyle(el);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const bordX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const fixed = padX + bordX;
      const w = el.offsetWidth || 0;
      // A zero width means the strip was laid out at zero size (display:none,
      // detached probe). Keep the fallback rather than scaling nonsense.
      if (!w) { ok = false; break; }
      measured.push({ text: Math.max(1, w - fixed), fixed });
    }
    if (!ok) return;
    const usable = usableStripWidth(dom);
    if (!usable) return;
    setChipGeom((prev) => (sameGeom(prev, measured) ? prev : measured));
    setStripWidth((prev) => (prev === usable ? prev : usable));
  }, [list]);

  const chipRows = chips.length;
  // The strip sits ABOVE the grid, so leaving the grid upwards should land on
  // the strip's BOTTOM row — the one physically closest to the cards.
  const stripEntryId = chipRows ? `filter-${chipRows - 1}-0` : null;

  // The genre strip auto-collapses once the viewer is deep enough into the
  // cards that it is no longer the thing being browsed.
  //
  // It used to collapse only on the FILTER -> CONTENT step, which meant it
  // stayed put for the whole page session — including while a season was being
  // browsed. The owner asked for it to slide away once focus reaches the THIRD
  // card row ("在选第三排的时候，关键字往上隐藏"): by then the viewer is reading
  // the grid, not the filters, and the two rows the strip occupies are better
  // spent on content.
  //
  // Rows are counted from the grid's own numbering, so "third row" is
  // startRow + 2 — not a hard-coded 2, which would drift the moment a page
  // renders the grid with a non-zero start.
  const [stripHidden, setStripHidden] = useState(false);
  const prevFidRef = useRef('');
  useEffect(() => {
    return onFocusChange((fid) => {
      const f = fid || '';
      const isFilter = f.indexOf('filter-') === 0;
      if (isFilter) setStripHidden(false);
      else if (f.indexOf('content-') === 0) {
        const row = contentRow(f);
        if (row !== null && row >= CONTENT_ROW_COLLAPSE) setStripHidden(true);
        else if (row !== null) setStripHidden(false);
      }
      prevFidRef.current = f;
    });
  }, []);

  if (state.status === 'loading') return <Loading label={`正在加载${categoryName}…`} />;
  if (state.status === 'error') {
    return (
      <PageState
        symbol="!"
        title="加载失败"
        message={state.error}
        action={<Chip id="filter-0-0" row={0} col={0} onSelect={() => load(page, genre, false, skip)}>按确认重试</Chip>}
      />
    );
  }

  return (
    <div className="scroll-area">
      <div className="category-head">
        {/* The CATEGORY NAME is the page title (the sidebar option the viewer
            chose), so it is the biggest thing — and always larger than the
            "全部" chip below it. The current genre is shown as a highlighted
            label next to the counts rather than masquerading as the title. */}
        <h1 className="category-title">{categoryName}</h1>
        <div className="category-meta">
          <span className="category-current">{genre ? genreLabel(genreItems, genre) : '全部'}</span>
          {total ? <span className="detail-fact">共 {total} 部</span> : null}
          {pageSpan ? <span className="detail-fact">{pageSpan}</span> : null}
          {/* Loading is shown as a small inline cue rather than by replacing the
              page: the screen stays put, the viewer keeps their place, and the
              wait reads as "updating" instead of "restarting". */}
          {state.busy ? <span className="category-busy" role="status" aria-live="polite">更新中…</span> : null}
          {!state.busy && state.error ? <span className="category-error" role="alert">{state.error}</span> : null}
        </div>
      </div>

      {chipRows ? (
        <div
          className={`filter-grid${stripHidden ? ' collapsed' : ''}${layout.stretch ? ' stretched' : ''}`}
          ref={gridRef}
          // The measured font scale, handed to CSS as a variable. Inline style
          // is safe here (unlike ShelfGrid's transform): nothing else writes to
          // this element's style, so a React re-render cannot clobber a value
          // some other code depends on.
          style={{ '--chip-scale': chipScale }}
        >
          {chips.map((row, r) => (
            <div className="filter-row" key={`frow-${r}`}>
              {row.map((g, c) => (
                <Chip
                  key={g.id || 'all'}
                  id={`filter-${r}-${c}`}
                  row={r}
                  col={c}
                  active={genre === g.id}
                  onSelect={() => selectGenre(g.id)}
                  // Down out of the last strip row reaches the cards; inside the
                  // strip the registry's own row arithmetic handles the rest.
                  downTo={r === chipRows - 1 ? 'content-0-0' : null}
                >
                  {g.name}
                </Chip>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <ShelfGrid
        shelves={[{ title: null, items: state.items }]}
        cols={cols}
        group="content"
        ranked={false}
        onSelect={onOpenSeries}
        onLongPress={onLongPress}
        emptyText="该分类暂时没有内容"
        headerId={stripEntryId}
        footerId={batches.total > 1 ? 'page-0-0' : null}
        footer={
          batches.total > 1 ? (
            <BatchPager
              current={batches.current}
              total={batches.total}
              pageSpan={pageSpan}
              onPick={gotoBatchIndex}
            />
          ) : null
        }
      />
    </div>
  );
}

// The card row, counted from the grid's own numbering, at which the genre
// strip slides away. 0 = first row of cards, so 2 = the third.
const CONTENT_ROW_COLLAPSE = 2;

// How many items a batch (a screen) holds. Upstream paginates at 24, so the
// service collects consecutive pages and returns exactly this many — at the
// default 5-column grid that is a full 10 rows ("每页剧集每行5个，一共10行 50个").
const BATCH_MIN_ITEMS = 50;

// The upstream coordinate that starts the batch at global ITEM `offset`:
// item `skip` of upstream page `page`.
//
// Batches are addressed in ITEMS (each is exactly BATCH_MIN_ITEMS) while the
// upstream serves PAGES of its own size, and 50 is not a multiple of 24 — so
// the mapping has to be computed rather than assumed. Deriving it here (and on
// the service, which walks the same arithmetic) is what lets batches tile the
// catalogue: screen N ends mid-page and screen N+1 begins at that same offset,
// with nothing repeated and nothing dropped.
//
// `pagination` supplies the upstream page size once the first response is in;
// before that the caller is asking for offset 0, which is page 1 / skip 0
// regardless.
function batchCoord(offset, pagination) {
  const size = pagination && pagination.pageSize > 0 ? pagination.pageSize : 24;
  const page = Math.floor(offset / size) + 1;
  const skip = offset % size;
  return { page: page, skip: skip };
}

// The gap a chip carries on its trailing edge (`.filter-chip`'s right margin).
// Packing must count it: the chip's offsetWidth does NOT include its margin,
// and ignoring the gap is what let 23 chips claim to fit where only 21 did.
const CHIP_GAP = 8;

// How far the strip is allowed to grow its chips, as a multiple of the base
// font.
//
// 1.6 was too timid for a SHORT strip (漫剧's 9 genres reached only 62% fill at
// the cap, still visibly half-empty — the "尽量不要这么空" complaint), but 2.0
// was too greedy: it pushed 真人剧's two rows to 105% and wrapped 漫剧's single
// row onto a second line. 1.75 is the largest value measured to fill a short
// strip without pushing a long one over. The residual slack on a single row is
// taken by stretching (see `.filter-grid.stretched`), which is far more precise
// than hunting for a font size that lands exactly on the edge.
const CHIP_SCALE_MAX = 1.75;

// A single row this full counts as "done" — stop growing. 0.94 leaves a hair of
// slack so sub-pixel rounding cannot tip the row into a wrap.
const CHIP_FILL_TARGET = 0.94;

// Prediction slack for the scaled width. Glyph advance does not scale perfectly
// linearly with font-size (hinting, sub-pixel rounding, font fallback), and the
// error grows with the scale: measured on the TV, the linear model under-counted
// a 2.0× strip by about 15% — enough that a layout predicted as two rows
// rendered as three (the overflow wrapped, and `overflow: hidden` then cut the
// tail off, hiding chips the D-pad still believed in). 1.10 keeps the plan on
// the safe side; the stretch pass takes back any slack it leaves.
const CHIP_SAFETY = 1.10;

// "content-2-0" -> 2. Returns null for anything that is not a content cell,
// so callers can tell "not the grid" from "row zero".
function contentRow(fid) {
  const m = /^content-(-?\d+)-\d+$/.exec(fid);
  return m ? parseInt(m[1], 10) : null;
}

// How much horizontal room a strip row actually has for chips.
//
// The strip is a padded block (`.filter-grid`), each chip carries a right
// margin (`.filter-chip`), so the usable figure is the content box, not
// clientWidth. Reading the computed padding keeps this honest if the CSS
// padding changes — the alternative, a constant here, is a number that goes
// stale silently.
function usableStripWidth(dom) {
  if (!dom) return 0;
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(dom) : null;
  const padL = style ? parseFloat(style.paddingLeft) || 0 : 0;
  const padR = style ? parseFloat(style.paddingRight) || 0 : 0;
  return Math.max(0, dom.clientWidth - padL - padR);
}

// Compare two measurement sets so the state update can be skipped when the
// numbers land on the same values, which is the common case for a re-render
// that did not change the filters.
function sameGeom(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].fixed !== b[i].fixed) return false;
  }
  return true;
}

function rangeLabel(pagination, shown) {
  if (!pagination) return '';
  // The batch's first item, from the coordinate we ASKED for (page + skip), so
  // the label stays correct even when the upstream page size differs from what
  // the batch assumes.
  const size = pagination.pageSize || 24;
  const first = ((pagination.page || 1) - 1) * size + (pagination.skip || 0) + 1;
  return `第 ${first}-${first + Math.max(0, shown - 1)} 部`;
}

// The pager under the grid: a row of batch NUMBERS, not just "上一批 / 下一批".
//
// The owner asked to be able to jump straight to a later block ("带上页面序号，
// 可以直接点选进行后续剧集展现，不要只是显示 下一批"). Walking there one batch
// at a time costs a service round trip each, so the numbers are the point.
//
// When a category has more batches than fit comfortably on one line, the row is
// WINDOWED: the first and last are always shown, with the current batch's
// neighbours around it and an ellipsis marking the gap. That keeps the control
// one line wide no matter how deep the category goes, which matters because the
// grid's own row arithmetic addresses these buttons by column.
function BatchPager({ current, total, pageSpan, onPick }) {
  const items = useMemo(() => windowBatches(current, total), [current, total]);
  return (
    <div className="batch-pager">
      <span className="batch-span">{pageSpan || ''}</span>
      <div className="batch-list">
        {items.map((it, i) =>
          it === null ? (
            <span className="batch-gap" key={`gap-${i}`}>…</span>
          ) : (
            <PageChip
              // The column is the position in the WINDOWED list, not the batch
              // number: focus walks the line as rendered, and the ids must match
              // what is on screen. Gap marks are spans, not chips, so they do
              // not consume a column — the chips stay tightly numbered even
              // though an ellipsis sits between them visually.
              id={`page-0-${it.slot}`}
              key={`b-${it.n}`}
              col={it.slot}
              active={it.n === current}
              onSelect={() => onPick(it.n)}
            >
              {it.n}
            </PageChip>
          )
        )}
      </div>
    </div>
  );
}

// Which batch numbers to show: always the first and last, plus a window around
// the current one. `null` marks a gap (rendered as an ellipsis).
//
// FIRST/LAST always visible is deliberate — it is what makes the control read
// as "there are N blocks" rather than "there are a few blocks near me".
//
// The ceiling is 16, not 7. The owner's call: "16页序号完全可以全部展现出来，
// 超过16页再在前面有缩略" — sixteen numbers DO fit the row at a fixed size, so
// showing every one of them beats hiding neighbours behind an ellipsis. Only
// past 16 does the list get windowed, and the head is what collapses, so the
// numbers near the viewer and the whole tail stay intact.
//
// Three zones, merged: {1}, {the viewer's neighbourhood}, {the tail run}.
//
//   total<=16        -> every number, no ellipsis
//   current in tail  -> 1 … <tail>                       (one ellipsis)
//   current below 3  -> 1 2..3 … <tail>                  (one ellipsis)
//   current between  -> 1 … <around current> … <tail>    (two ellipses)
//
// The entry count is bounded at 1 + (2*NEI+1) + TAIL + 2 gaps = 17, so the row
// is one line no matter how deep the category goes. Two ellipses in the middle
// case is honest: there really are three separate zones on screen, and pretending
// otherwise (by stretching the run leftwards to merge them) is what made an
// earlier attempt grow to 55 chips at batch 50 of 100.
//
// Each entry carries a `slot`: the chip's COLUMN on the line. Gaps are plain
// spans and do not take a column, so the chips stay densely numbered
// 0..k-1 and Right/Left walk them without stepping over an ellipsis. That
// matters because `useFocusable` addresses by (row, col) and the default is
// (0, 0) — a chip whose col was left implicit would collide with the first one.
const PAGER_FULL_MAX = 16;
const PAGER_WINDOW_TAIL = 9;
const PAGER_WINDOW_NEI = 2;

function windowBatches(current, total) {
  const nums = [];
  if (total <= PAGER_FULL_MAX) {
    // Everything fits — show every batch number, no ellipsis at all.
    for (let n = 1; n <= total; n++) nums.push(n);
  } else {
    const tailFrom = Math.max(2, total - PAGER_WINDOW_TAIL + 1);
    const keep = new Set([1]);
    for (let n = tailFrom; n <= total; n++) keep.add(n);

    // The viewer's neighbourhood. When it reaches or overlaps the tail the two
    // merge into one run (no second ellipsis); otherwise it stays its own zone.
    const nFrom = Math.max(2, current - PAGER_WINDOW_NEI);
    const nTo = Math.min(total, current + PAGER_WINDOW_NEI);
    for (let n = nFrom; n <= Math.min(nTo, tailFrom - 1); n++) keep.add(n);

    const sorted = Array.from(keep).sort((a, b) => a - b);
    sorted.forEach((n, i, arr) => {
      if (i && n - arr[i - 1] > 1) nums.push(null);
      nums.push(n);
    });
  }
  let slot = 0;
  return nums.map((n) => (n === null ? null : { n, slot: slot++ }));
}

function genreLabel(items, id) {
  const found = items.find((g) => g.id === id);
  return found ? found.name : id;
}

// A genre chip, addressed by (row, col) so ArrowUp/Down can walk a wrapped
// strip. Only the bottom row bridges down into the card grid — the rows in
// between are handled by the registry's own arithmetic.
function Chip({ id, row, col, children, onSelect, active = false, downTo = null }) {
  const { props, isFocused } = useFocusable({
    id,
    row,
    col,
    group: 'filter',
    onSelect,
    onNavigate: (dir) => (dir === 'down' && downTo && hasFocusable(downTo) ? downTo : undefined)
  });
  return (
    <span
      className={`filter-chip focusable${active ? ' active' : ''}${isFocused ? ' focused' : ''}`}
      {...props}
    >
      {children}
    </span>
  );
}

// Paging chips are their own group. They used to share group 'filter' while
// carrying ids `page-0-*` — so navigateGrid composed `filter-0-1`, which is a
// GENRE chip: Right from 上一页 jumped into the genre strip and Left from it
// fell out to the sidebar.
//
// `active` marks the batch the viewer is ON. It uses a distinct class rather
// than the genre strip's `.active` because the two mean different things: a
// genre chip that is active is a FILTER currently applied, a page chip that is
// active is a LOCATION. Sharing the style made the current page look like a
// selected filter.
function PageChip({ id, col = 0, children, onSelect, active = false }) {
  const upTarget = useShelfFooterUp();
  const { props, isFocused } = useFocusable({
    id,
    row: 0,
    col,
    onSelect,
    group: 'page',
    onNavigate: (dir) => (dir === 'up' && upTarget ? upTarget : undefined)
  });
  return (
    <span
      className={`filter-chip page-chip focusable${active ? ' current' : ''}${isFocused ? ' focused' : ''}`}
      {...props}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </span>
  );
}
