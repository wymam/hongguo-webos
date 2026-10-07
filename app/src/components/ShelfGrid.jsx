import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { onFocusChange, isHoverDriven, useFocusable } from '../hooks/useFocus';
import VideoCard from './VideoCard';
import { probeAspects, aspectReport } from '../utils/aspectProbe';

// Every grid shares one orientation prober, so no page can end up with "some
// cards badged, some not" — the inconsistency the owner reported. Wiring it
// once here (rather than in HomePage/CategoryPage/LibraryPage/SearchPage
// separately) is what makes the coverage uniform by construction.
if (typeof window !== 'undefined') {
  window.__hongguoAspectReport = () => aspectReport(
    (window.__hongguoGridItems && window.__hongguoGridItems()) || []
  );
}

// Tells a footer control which grid cell ArrowUp should return to. The grid
// knows its own last row; the page rendering the footer does not, and passing
// row numbers around by hand would re-introduce exactly the arithmetic drift
// this component exists to prevent.
const FooterUpContext = createContext(null);

// A footer control for a ShelfGrid (paging, 清空观看记录, 刷新推荐…).
//
// Rendered inside the grid's footer slot it gains both directions: ArrowDown
// from the last card row lands on it (the grid bridges down), and ArrowUp
// returns to the grid. Without the up bridge a footer was a one-way trip —
// focus went down and could never come back.
// The same target, for a footer control that is not a ShelfFooterButton
// (CategoryPage's paging chips keep their own chip styling).
export function useShelfFooterUp() { return useContext(FooterUpContext); }

export function ShelfFooterButton({ id, onSelect, children, primary = false }) {
  const upTarget = useContext(FooterUpContext);
  const { props, isFocused } = useFocusable({
    id,
    group: 'button',
    onSelect,
    onNavigate: (dir) => (dir === 'up' && upTarget ? upTarget : undefined)
  });
  return (
    <span
      className={`tv-action focusable${primary ? ' primary' : ''}${isFocused ? ' focused' : ''}`}
      {...props}
    >
      {children}
    </span>
  );
}

// Smoothing factor for the scroll animation, per ~16ms frame. Applied
// exponentially, so the travel converges and always lands exactly on target.
const SCROLL_EASE = 0.25;
// Snap when within this many pixels: without it the exponential approach only
// tends to the target and the last fraction of a pixel would keep the loop
// alive forever.
const SCROLL_SNAP = 0.5;
// Stop the loop if frames stop arriving, so a suspended renderer cannot leave
// a rAF chain pinning the service.
const SCROLL_TIMEOUT_MS = 1200;

// Set window.__hongguoGridDebug = true from the console (or the settings
// diagnostics page) to record why each scroll decision was taken. A TV has no
// devtools, so this is the only way to see the grid's arithmetic on-device.
function debugEnabled() {
  return typeof window !== 'undefined' && !!window.__hongguoGridDebug;
}

function debugLog(line) {
  if (!debugEnabled()) return;
  if (!window.__hongguoGridLog) window.__hongguoGridLog = [];
  window.__hongguoGridLog.push(line);
  if (window.__hongguoGridLog.length > 200) window.__hongguoGridLog.shift();
}

// Distance from `el`'s content box top to `ancestor`'s content box top.
//
// offsetTop alone is relative to offsetParent, which is whichever ancestor is
// positioned or transformed first — not necessarily the element we measure
// against. Summing offsetTop up the chain makes the value independent of where
// the transform happens to sit.
function offsetWithin(el, ancestor) {
  let top = 0;
  let node = el;
  while (node && node !== ancestor) {
    top += node.offsetTop || 0;
    node = node.offsetParent;
    // Guard against a detached node walking to null.
    if (!node) return el.offsetTop || 0;
  }
  return top;
}

// The single grid primitive the whole app uses: a vertical scroll surface with
// one or more titled shelves of cards.
//
// Why one primitive, and why the row model matters:
//   The focus system navigates by parsing `group-row-col` and doing row
//   arithmetic. That only stays predictable when a surface has one continuous
//   row numbering and a fixed column count. So every card here is assigned
//   (row, col) by a single sequential packer, and shelf titles consume a row
//   of their own. Down from the last row of shelf A therefore lands on the
//   first row of shelf B with no special casing.
//
// Scrolling is one `translateY` on the content body, driven straight from the
// focus system (never React state) so a keypress costs no re-render.
export default function ShelfGrid({
  shelves = [],
  group = 'content',
  cols = 3,
  startRow = 0,
  ranked = false,
  onSelect,
  onLongPress,
  emptyText = '这里暂时没有内容',
  footer = null,
  // The focus id of the control rendered in `footer` (e.g. 清空观看记录).
  // It lives in its own focus group, and `navigateGrid` only composes
  // `${group}-${row}-${col}`, so it can never be reached from the grid by
  // arithmetic alone. Naming it lets the last card row hand focus down to it.
  footerId = null,
  // Mirror of `footerId`: a control rendered ABOVE the grid (a genre filter
  // strip, say) that the first card row should hand focus up to. Same reason
  // — its focus group differs, so arithmetic alone can never reach it.
  headerId = null,
  className = ''
}) {
  const viewportRef = useRef(null);
  const bodyRef = useRef(null);
  const scrollRef = useRef(0);
  const rowRef = useRef(startRow);

  // ---- sequential packer -------------------------------------------------
  // Produces rows in visual order. A row is either a title row or a card row.
  //
  // ROW NUMBERS MUST BE CONTIGUOUS ACROSS CARD ROWS.
  // `navigateGrid` resolves a move by pure arithmetic (`row +/- 1` on the same
  // group and column), so it can only ever reach a row number that exists in
  // the focus registry. A title row is NOT navigable, therefore it must NOT
  // consume a number: doing so punches a hole in the sequence and the strict
  // `tr + 1` lookup misses, the same-row fallback (`c--`) misses too, and
  // ArrowDown dies permanently at that row.
  //
  // This bug was live and reproducible: with a title row counted as a row, the
  // registry held rows 1, 2, 4, 5, 7, 8 and navigation froze on content-2-0
  // because content-3-0 did not exist. Titles now carry a `null` row and are
  // skipped by the card numbering entirely.
  const layout = useMemo(() => {
    const rows = [];
    let row = startRow;
    let col = 0;
    let rank = 0;

    const flushPartialRow = () => {
      if (col !== 0) {
        row += 1;
        col = 0;
      }
    };

    shelves.forEach((shelf) => {
      const items = (shelf && shelf.items) || [];
      if (!items.length) return;

      flushPartialRow();

      if (shelf.title) {
        // `row: null` — rendered, given a stable key, but not addressable by
        // the D-pad and not counted in the row arithmetic.
        rows.push({ type: 'title', row: null, title: shelf.title });
      }

      let current = null;
      items.forEach((item) => {
        if (col === 0 || !current) {
          current = { type: 'cards', row, cards: [] };
          rows.push(current);
        }
        current.cards.push({ item, col, rank: ranked ? rank + 1 : 0 });
        rank += 1;
        col += 1;
        if (col === cols) {
          col = 0;
          row += 1;
        }
      });
      flushPartialRow();
    });

    const totalRows = rows.length ? rows[rows.length - 1].row + 1 : startRow;

    // Highest-numbered row that actually holds cards. Title rows carry
    // `row: null`, so the last entry is not necessarily the last card row.
    let lastRow = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type === 'cards') { lastRow = rows[i].row; break; }
    }

    return { rows, totalRows, lastRow };
  }, [shelves, cols, startRow, ranked]);

  // Where the footer's own focusable should send ArrowUp: back into the grid.
  // Column 0 always exists in a card row.
  const footerUpTarget = layout.lastRow === null ? null : `${group}-${layout.lastRow}-0`;

  // ---- scrolling ---------------------------------------------------------
  //
  // The offset is animated by a rAF loop that we own, NOT by a CSS transition.
  //
  // A CSS `transition: transform` looks like the obvious choice and is wrong
  // here: the property is written imperatively, so the transition holds it at
  // the old value until it advances, and any write landing mid-transition is
  // swallowed. Worse, an environment that produces no compositor frames (GPU
  // disabled, background/occluded surface — and this was reproduced by
  // measurement on the built app) never advances the transition at all, so the
  // grid silently freezes at a stale offset with the focused card off-screen.
  // Driving it ourselves makes the final position a plain assignment that
  // cannot be deferred by anything.
  const scrollRaf = useRef(0);
  const scrollDeadline = useRef(0);

  const applyOffset = useCallback((px) => {
    const el = bodyRef.current;
    if (el) el.style.transform = `translateY(-${px}px)`;
  }, []);

  const animateTo = useCallback(
    (next) => {
      // CORRECTNESS FIRST: the target offset is committed SYNCHRONOUSLY and is
      // never rolled back.
      //
      // The animation is pure decoration and must never be the thing that makes
      // the scroll correct, because a rAF chain only advances when the renderer
      // actually delivers frames — an occluded, throttled or GPU-less surface
      // may deliver none at all. Measured on the built app: a rAF-only driver
      // left the grid at its old offset with the focused card off-screen, and a
      // CSS transition behaved the same way.
      //
      // An earlier version of this function wrote the target and then
      // immediately re-applied the OLD value to give the animation a starting
      // point. That undid the correct write on the same tick, so the settled
      // position depended on frames arriving after all. The target is now
      // written once; the loop below only ever moves TOWARDS it.
      const from = scrollRef.current;
      scrollRef.current = next;
      applyOffset(next);

      if (Math.abs(from - next) <= SCROLL_SNAP) return;

      const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      scrollDeadline.current = now + SCROLL_TIMEOUT_MS;
      if (scrollRaf.current) return; // a loop is already running; it re-reads scrollRef

      const step = () => {
        const t = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        const remaining = next - scrollRef.current;
        // Converged, or frames stopped arriving: land exactly on the target
        // (already written above, so this only ever re-asserts it).
        if (Math.abs(remaining) <= SCROLL_SNAP || t > scrollDeadline.current) {
          scrollRef.current = next;
          applyOffset(next);
          scrollRaf.current = 0;
          return;
        }
        scrollRef.current += remaining * SCROLL_EASE;
        applyOffset(scrollRef.current);
        scrollRaf.current = requestAnimationFrame(step);
      };
      scrollRaf.current = requestAnimationFrame(step);
    },
    [applyOffset]
  );

  useEffect(() => {
    return () => {
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = 0;
    };
  }, []);

  //
  // Coordinate-space note: the cards are NOT direct children of `.video-grid`
  // (each visual row is its own grid wrapper), so `offsetTop` must be read
  // relative to `.video-grid` rather than assumed to be already relative to it.
  // `offsetWithin` walks the offsetParent chain, so the maths survives a change
  // in nesting depth. (It does not depend on `.video-grid` being the
  // offsetParent — measured, it reports `BODY` while the grid is static.)
  const scrollToRow = useCallback(
    (gridRow) => {
      const el = bodyRef.current;
      const viewport = viewportRef.current;
      if (!el || !viewport) return;
      const viewportHeight = viewport.clientHeight;
      if (!viewportHeight) return;

      const target =
        gridRow < 0
          ? el.firstElementChild
          : el.querySelector(`[data-focus-id="${group}-${gridRow}-0"]`);
      if (!target) return;

      // offsetTop is relative to offsetParent, which is not guaranteed to be
      // `.video-grid`. Convert to a grid-relative offset by walking up.
      const top = offsetWithin(target, el);

      // Show a sliver of the row above unless we are at the surface's top.
      const PEEK = gridRow > startRow ? 46 : 0;
      const want =
        gridRow <= startRow
          ? Math.max(0, top + target.offsetHeight + 16 - viewportHeight)
          : Math.max(0, top - PEEK);

      const maxScroll = Math.max(0, el.offsetHeight - viewportHeight);
      const next = Math.min(want, maxScroll);
      if (Math.abs(scrollRef.current - next) <= 1) return;
      debugLog(`row=${gridRow} top=${top} want=${want} next=${next}`);
      animateTo(next);
    },
    [group, startRow, animateTo]
  );

  // The footer sits INSIDE the transformed body, so it scrolls with the grid
  // and `applyFocus` deliberately refuses to scrollIntoView anything in a
  // `.video-grid-viewport`. Without this the footer could take the focus ring
  // while sitting below the fold — focused but invisible.
  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    const viewport = viewportRef.current;
    if (!el || !viewport) return;
    const maxScroll = Math.max(0, el.offsetHeight - viewport.clientHeight);
    if (Math.abs(scrollRef.current - maxScroll) <= 1) return;
    debugLog(`footer-scroll next=${maxScroll}`);
    animateTo(maxScroll);
  }, [animateTo]);

  useEffect(() => {
    return onFocusChange((fid) => {
      if (!fid || isHoverDriven()) return;
      if (footerId && fid === footerId) { scrollToBottom(); return; }
      const m = fid.match(/^(.+?)-(-?\d+)-(\d+)$/);
      if (!m || m[1] !== group) return;
      const gridRow = parseInt(m[2], 10);
      rowRef.current = gridRow;
      scrollToRow(gridRow);
    });
  }, [group, scrollToRow, scrollToBottom, footerId]);

  useEffect(() => {
    const update = () => scrollToRow(rowRef.current);
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (observer && viewportRef.current) observer.observe(viewportRef.current);
    return () => {
      window.removeEventListener('resize', update);
      if (observer) observer.disconnect();
    };
  }, [scrollToRow]);

  // Re-apply the current row after content changes (paging, tab switch).
  useEffect(() => {
    scrollToRow(rowRef.current);
  }, [shelves, cols, scrollToRow]);

  // Orientation badges for everything on this grid.
  //
  // Runs AFTER the cards are on screen, never instead of them: the probe costs
  // one upstream resolve per unknown series, so it must never be on the
  // critical path to a painted grid.
  const flatItems = useMemo(
    () => shelves.reduce((acc, s) => acc.concat((s && s.items) || []), []),
    [shelves]
  );
  useEffect(() => {
    if (typeof window !== 'undefined') window.__hongguoGridItems = () => flatItems;
  }, [flatItems]);
  useEffect(() => {
    const t = setTimeout(() => probeAspects(flatItems), 250);
    return () => clearTimeout(t);
  }, [flatItems]);

  return (
    <div className={`video-grid-viewport ${className}`} ref={viewportRef}>
      {/*
        No `style` prop here on purpose.

        The scroll is driven imperatively by writing `el.style.transform`, but
        React re-applies a `style` prop on EVERY render and resets inline
        properties it does not own — so having any style here silently erased
        the transform each time the grid re-rendered, leaving the focused card
        stranded off-screen. All grid styling lives in `.video-grid` in CSS.
      */}
      <div className="video-grid" ref={bodyRef}>
        {layout.rows.map((entry, idx) =>
          entry.type === 'title' ? (
            // Key by index+title: title rows carry `row: null` (they must not
            // consume a navigable row number), so `entry.row` cannot key them.
            <div className="feed-heading" style={{ padding: 0, margin: '22px 0 12px' }} key={`t-${idx}-${entry.title}`}>
              <h2>{entry.title}</h2>
            </div>
          ) : (
            <div
              key={`r-${entry.row}`}
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gridGap: 24,
                marginBottom: 24
              }}
            >
              {entry.cards.map(({ item, col, rank }) => (
                <VideoCard
                  key={item.id || `${group}-${entry.row}-${col}`}
                  video={item}
                  focusId={`${group}-${entry.row}-${col}`}
                  row={entry.row}
                  col={col}
                  group={group}
                  rank={rank}
                  onSelect={(v) => onSelect && onSelect(v)}
                  onLongPress={onLongPress}
                  // Bridge to a footer control (e.g. 清空观看记录) from the last
                  // grid row. The footer lives in its own focus group, and
                  // navigateGrid cannot cross groups, so without this the button
                  // was unreachable by D-pad — you could see it but never select it.
                  onNavigate={(dir) => {
                    if (dir === 'down' && footerId && entry.row === layout.lastRow) return footerId;
                    if (dir === 'up' && headerId && entry.row === startRow) return headerId;
                    return undefined;
                  }}
                />
              ))}
            </div>
          )
        )}

        {!layout.rows.length ? (
          <div className="page-state">
            <p>{emptyText}</p>
          </div>
        ) : null}

        {footer ? (
          <FooterUpContext.Provider value={footerUpTarget}>
            <div style={{ marginTop: 20 }}>{footer}</div>
          </FooterUpContext.Provider>
        ) : null}
      </div>
    </div>
  );
}
