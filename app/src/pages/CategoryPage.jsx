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
// 3. The genre strip stays within TWO rows (the owner asked "不要太多行，不超2行").
//    The per-row count is derived from the total so 真人剧's 24 genres + 全部
//    land as 13+12 instead of the old 4 rows of 8.

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

  // 全部 + every genre, laid out as a real grid, at most TWO rows.
  const chips = useMemo(() => {
    const list = [{ id: '', name: '全部' }].concat(
      genreItems.map((g) => ({ id: g.id, name: g.name }))
    );
    // Split into exactly two rows (fewer if the list is tiny), evenly.
    const perRow = Math.max(1, Math.ceil(list.length / 2));
    const rows = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    return rows;
  }, [genreItems]);

  const chipRows = chips.length;
  // The strip sits ABOVE the grid, so leaving the grid upwards should land on
  // the strip's BOTTOM row — the one physically closest to the cards.
  const stripEntryId = chipRows ? `filter-${chipRows - 1}-0` : null;

  // The genre strip auto-collapses when the viewer leaves it for the cards, so
  // browsing a season does not keep 2 rows of filters eating the screen. It
  // only collapses on the FILTER -> CONTENT move: entering the page lands on the
  // cards without having "left" the strip, so the strip stays visible until the
  // viewer actually steps through it.
  const [stripHidden, setStripHidden] = useState(false);
  const prevFidRef = useRef('');
  useEffect(() => {
    return onFocusChange((fid) => {
      const f = fid || '';
      const wasFilter = prevFidRef.current.indexOf('filter-') === 0;
      const isFilter = f.indexOf('filter-') === 0;
      const isContent = f.indexOf('content-') === 0;
      if (isFilter) setStripHidden(false);
      else if (isContent && wasFilter) setStripHidden(true);
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
        <div className={`filter-grid${stripHidden ? ' collapsed' : ''}`}>
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

// Where the previous batch started. The batch covers `pagesFetched` upstream
// pages, so stepping back means going back by that many — not by one, which
// would re-show 24 items the viewer has already seen.
function prevBatchStart(pagination) {
  const pages = (pagination && pagination.pagesFetched) || [];
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
