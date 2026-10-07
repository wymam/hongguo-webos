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
  const [state, setState] = useState({ status: 'loading', items: [], filters: [], pagination: null, error: '' });
  const cols = clampCols(getSettings().gridCols);

  const load = useCallback(
    (nextPage, nextGenre, keepItems) => {
      let alive = true;
      setState((s) => ({ ...s, status: s.items.length && keepItems ? 'ready' : 'loading', error: '' }));
      getCategory(categoryKey, nextPage, nextGenre, 50)
        .then((res) => {
          if (!alive) return;
          if (!res || res.returnValue === false) {
            setState((s) => ({ ...s, status: 'error', error: (res && res.errorText) || '加载失败' }));
            return;
          }
          const items = Array.isArray(res.items) ? res.items : [];
          setState({
            status: items.length ? 'ready' : 'empty',
            items,
            filters: Array.isArray(res.filters) ? res.filters : [],
            pagination: res.pagination || null,
            error: ''
          });
        })
        .catch((e) => {
          if (!alive) return;
          setState((s) => ({ ...s, status: 'error', error: e.message || '网络错误' }));
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
    return load(1, '', false);
  }, [load, categoryKey, refreshKey]);

  const selectGenre = (id) => {
    const next = genre === id ? '' : id;
    setGenre(next);
    setPage(1);
    load(1, next, false);
  };

  const gotoBatch = (nextPage) => {
    setPage(nextPage);
    load(nextPage, genre, true);
  };

  const pagination = state.pagination;
  const total = pagination ? pagination.total : 0;
  const hasMore = !!(pagination && pagination.hasMore);
  const hasPrev = !!(pagination && pagination.hasPrev);
  const pageSpan = useMemo(() => rangeLabel(pagination, state.items.length), [pagination, state.items.length]);

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
  // null = "not measured yet"; the packer then uses the even split.
  const [chipWidths, setChipWidths] = useState(null);
  // The strip's usable width, kept in state so it participates in the packer's
  // dependency list. A TV viewport does not resize during a session, but the
  // strip is laid out once and the packer runs on the render AFTER that, so
  // reading clientWidth inside the memo alone would freeze whichever value
  // happened to exist then.
  const [stripWidth, setStripWidth] = useState(0);

  const chips = useMemo(() => {
    const perRow = Math.max(1, Math.ceil(list.length / 2));
    const evenSplit = () => {
      const rows = [];
      for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
      return rows;
    };
    // No measurement (first paint, or a headless render with no layout):
    // even split, i.e. the historical behaviour. Never worse than before.
    if (!chipWidths || chipWidths.length !== list.length) return evenSplit();
    // Width known to be unusable, or not yet read: nothing to pack against.
    if (!stripWidth) return evenSplit();

    // Two passes, because "fill the row" and "do not strand the tail" pull in
    // opposite directions.
    //
    // Pure greedy packing fills row 0 to the brim and leaves whatever is left
    // on row 1 — measured on the TV that produced 23 chips + 2 chips, i.e. a
    // 108%-full first row above a 9%-full second one. That is *worse* than the
    // even split it replaced. So:
    //
    //   1. If the whole list fits on ONE row, stop — that is the request
    //      ("一行可以铺满就不要分2行") in its cleanest form.
    //   2. Otherwise pick the split point whose two rows are most BALANCED,
    //      subject to neither row overflowing. That keeps the tail off the
    //      floor while still letting each row run to the edge: with balanced
    //      packing a 25-chip row set lands near 50/50, not 92/8.
    const total = list.reduce((acc, g, i) => acc + chipWidths[i] + CHIP_GAP, 0);
    if (total <= stripWidth) return [list];

    // The split point that minimises the difference between the two rows'
    // widths. Scanning every prefix is O(n) and n is a few dozen genres.
    let bestSplit = 0;
    let bestGap = Infinity;
    let prefix = 0;
    for (let i = 0; i < list.length - 1; i++) {
      prefix += chipWidths[i] + CHIP_GAP;
      const tail = total - prefix;
      // Neither half may exceed the strip: a half that overflows is a half
      // that has wrapped into a third row, which the owner ruled out.
      if (prefix > stripWidth || tail > stripWidth) continue;
      const gap = Math.abs(prefix - tail);
      if (gap < bestGap) { bestGap = gap; bestSplit = i + 1; }
    }
    // No legal split exists (one chip wider than the strip, or a two-chip list
    // whose halves both overflow). Fall back to greedy, which at least keeps
    // the row numbering consistent with the rendered lines.
    if (!bestSplit) {
      const rows = [];
      let row = [];
      let used = 0;
      list.forEach((g, i) => {
        const w = chipWidths[i] + CHIP_GAP;
        if (row.length && used + w > stripWidth) { rows.push(row); row = []; used = 0; }
        row.push(g);
        used += w;
      });
      if (row.length) rows.push(row);
      return rows;
    }

    return [list.slice(0, bestSplit), list.slice(bestSplit)];
  }, [list, chipWidths, stripWidth]);

  // Measure the chips ONCE per label set, and the strip width alongside them.
  // offsetWidth is read after paint, so the first frame still shows the
  // fallback split; the re-pack lands on the next one and the strip settles.
  // A chip's width is a pure function of its label and the CSS, so this never
  // needs to run again for the same labels.
  useEffect(() => {
    const dom = gridRef.current;
    if (!dom) return;
    const measured = [];
    const nodes = dom.querySelectorAll('.filter-chip');
    if (!nodes.length || nodes.length !== list.length) return;
    for (let i = 0; i < nodes.length; i++) measured.push(nodes[i].offsetWidth || 0);
    // A zero width means the strip was laid out at zero size (display:none,
    // detached probe). Keep the fallback rather than packing into nonsense.
    if (measured.some((w) => !w)) return;
    const usable = usableStripWidth(dom);
    if (!usable) return;
    setChipWidths((prev) => (sameWidths(prev, measured) ? prev : measured));
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
        action={<Chip id="filter-0-0" row={0} col={0} onSelect={() => load(page, genre, false)}>按确认重试</Chip>}
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
        </div>
      </div>

      {chipRows ? (
        <div className={`filter-grid${stripHidden ? ' collapsed' : ''}`} ref={gridRef}>
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
        footerId={hasPrev ? 'page-0-0' : hasMore ? 'page-0-1' : null}
        footer={
          hasPrev || hasMore ? (
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {hasPrev ? (
                <PageChip id="page-0-0" onSelect={() => gotoBatch(Math.max(1, prevBatchStart(pagination)))}>
                  ← 上一批
                </PageChip>
              ) : null}
              <span style={{ margin: '0 16px', color: 'var(--tv-secondary)', fontSize: 19 }}>
                {pageSpan || ''}
              </span>
              {hasMore ? (
                <PageChip id="page-0-1" onSelect={() => gotoBatch(pagination.nextPage)}>
                  下一批 →
                </PageChip>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}

// The card row, counted from the grid's own numbering, at which the genre
// strip slides away. 0 = first row of cards, so 2 = the third.
const CONTENT_ROW_COLLAPSE = 2;

// The gap a chip carries on its trailing edge (`.filter-chip`'s right margin).
// Packing must count it: the chip's offsetWidth does NOT include its margin,
// and ignoring the gap is what let 23 chips claim to fit where only 21 did.
const CHIP_GAP = 8;

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

// Width lists are re-measured on every label change; comparing them lets the
// state update be skipped when the measurement lands on the same numbers, which
// is the common case for a re-render that did not change the filters.
function sameWidths(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Where the previous batch started. The batch covers `pagesFetched` upstream
// pages, so stepping back means going back by that many — not by one, which
// would re-show 24 items the viewer has already seen.
function prevBatchStart(pagination) {  const pages = (pagination && pagination.pagesFetched) || [];
  const size = pages.length || 1;
  const first = pages.length ? pages[0] : (pagination && pagination.page) || 1;
  return Math.max(1, first - size);
}

function rangeLabel(pagination, shown) {
  if (!pagination) return '';
  const pages = pagination.pagesFetched || [];
  const size = pagination.pageSize || 24;
  const first = pages.length ? (pages[0] - 1) * size + 1 : 1;
  return `第 ${first}-${first + Math.max(0, shown - 1)} 部`;
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
function PageChip({ id, children, onSelect }) {
  const upTarget = useShelfFooterUp();
  const { props, isFocused } = useFocusable({
    id,
    onSelect,
    group: 'page',
    onNavigate: (dir) => (dir === 'up' && upTarget ? upTarget : undefined)
  });
  return (
    <span className={`filter-chip focusable${isFocused ? ' focused' : ''}`} {...props}>
      {children}
    </span>
  );
}
