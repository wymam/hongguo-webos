import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { coverUrl } from '../utils/thumb';
import { perfFlag, canPrefetch } from '../utils/perfFlags';
import { onFocusChange, isHoverDriven } from '../hooks/useFocus';
import VideoCard from './VideoCard';

// Scrolling is done with transform: translateY rather than overflow: scroll.
// That keeps scrolling on the GPU compositor and avoids a layout pass per
// keypress, which matters on TV-class hardware.
//
// Two lessons carried over from the reference implementation:
//
//   1. Never compute the scroll offset from a row-pitch formula. Card heights
//      vary with title wrapping, so any formula drifts and eventually clips
//      the focused row. Read the target row's real offsetTop instead.
//   2. Do not route the scroll offset through React state. The focus system is
//      already zero-render, and putting scroll back into state would re-render
//      every card on each keypress.
export default React.memo(function VideoGrid({
  videos = [],
  group = 'content',
  startRow = 0,
  cols = 3,
  onSelect,
  onLongPress,
  rankFrom = 0,
  header = null,
  footer = null,
  emptyText = '这里暂时没有内容'
}) {
  const gridRef = useRef(null);
  const viewportRef = useRef(null);
  const scrollRef = useRef(0);
  const lastRowRef = useRef(0);

  const scrollToRow = useCallback(
    (gridRow) => {
      const el = gridRef.current;
      const viewportHeight = viewportRef.current && viewportRef.current.clientHeight;
      if (!el || !el.children.length || !viewportHeight) return;
      const first = el.querySelector('.video-card');
      const target =
        gridRow < 0
          ? el.firstElementChild
          : el.querySelector(`[data-focus-id="${group}-${startRow + gridRow}-0"]`) ||
            el.lastElementChild;
      if (!target) return;

      // Show a sliver of the previous row when we are not at the very top, so
      // "there is more above" is visible rather than implied.
      const PEEK = gridRow > 0 ? 46 : 0;
      let want;
      if (gridRow < 0) {
        want = 0;
      } else if (gridRow === 0) {
        want = Math.max(0, target.offsetTop + target.offsetHeight + 16 - viewportHeight);
      } else {
        want = Math.max(0, target.offsetTop - (header ? 24 : first.offsetTop) - PEEK);
      }
      const maxScroll = Math.max(0, el.scrollHeight - viewportHeight);
      const next = Math.min(want, maxScroll);
      if (Math.abs(scrollRef.current - next) <= 1) return;
      scrollRef.current = next;
      el.style.transform = `translateY(-${next}px)`;
    },
    [group, startRow, !!header]
  );

  // Drive scrolling straight from the focus system.
  useEffect(() => {
    if (!perfFlag('scrollDirect')) return undefined;
    return onFocusChange((fid) => {
      if (!fid || isHoverDriven()) return;
      const m = fid.match(/^(.+?)-(-?\d+)-(\d+)$/);
      if (!m || m[1] !== group) return;
      const gridRow = parseInt(m[2], 10) - startRow;
      if (gridRow < 0 && !(header && gridRow === -1)) return;
      lastRowRef.current = gridRow;
      scrollToRow(gridRow);
    });
  }, [group, startRow, scrollToRow, !!header]);

  // Re-apply the current row after the list changes (paging, tab switch).
  useLayoutEffect(() => {
    scrollToRow(lastRowRef.current);
  }, [videos.length, cols, scrollToRow]);

  useEffect(() => {
    const update = () => scrollToRow(lastRowRef.current);
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (observer && viewportRef.current) observer.observe(viewportRef.current);
    return () => {
      window.removeEventListener('resize', update);
      if (observer) observer.disconnect();
    };
  }, [scrollToRow]);

  // Warm the next row's covers once the user settles. Debounced so a burst of
  // keypresses never competes with the render path, and bounded so a long
  // session cannot accumulate references.
  const prefetched = useRef(new Set());
  useEffect(() => {
    if (typeof Image === 'undefined' || !perfFlag('prefetchThumbs')) return undefined;
    if (!canPrefetch()) return undefined;
    const from = (lastRowRef.current + 1) * cols;
    const to = Math.min(videos.length, from + cols);
    const idle =
      typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 300 })
        : (fn) => setTimeout(fn, 0);
    let cancelled = false;
    const settle = setTimeout(() => {
      idle(() => {
        if (cancelled || !canPrefetch()) return;
        for (let i = from; i < to; i++) {
          const v = videos[i];
          const src = v && coverUrl(v.cover);
          if (!src || prefetched.current.has(src)) continue;
          prefetched.current.add(src);
          const im = new Image();
          im.decoding = 'async';
          im.src = src;
        }
        if (prefetched.current.size > 400) prefetched.current.clear();
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(settle);
    };
  }, [cols, videos]);

  return (
    <div
      ref={viewportRef}
      className="video-grid-viewport"
    >
      <div ref={gridRef} className={`video-grid cols-${cols}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {header ? (
          <header className="grid-header" style={{ gridColumn: '1 / -1' }}>
            {header}
          </header>
        ) : null}
        {videos.map((video, idx) => {
          const row = startRow + Math.floor(idx / cols);
          const col = idx % cols;
          return (
            <VideoCard
              key={video.id || `v-${row}-${col}`}
              video={video}
              focusId={`${group}-${row}-${col}`}
              row={row}
              col={col}
              group={group}
              rank={rankFrom ? rankFrom + idx : 0}
              onSelect={onSelect}
              onLongPress={onLongPress}
            />
          );
        })}
        {footer ? (
          <footer className="grid-footer" style={{ gridColumn: '1 / -1' }}>
            {footer}
          </footer>
        ) : null}
        {!videos.length ? (
          <div className="page-state" style={{ gridColumn: '1 / -1' }}>
            <p>{emptyText}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});
