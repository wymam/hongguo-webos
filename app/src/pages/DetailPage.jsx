import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDetail } from '../api/client';
import { useFocusable, setContentContext, resetContentMemory, onFocusChange, isHoverDriven, focusContentTarget, hasFocusable } from '../hooks/useFocus';
import { Loading, PageState } from '../components/Common';
import { coverUrl } from '../utils/thumb';
import { splitTags } from '../utils/format';
import { getProgress, isFavorite, toggleFavorite, onProgressChange } from '../utils/storage';

// Series detail: metadata, a Play/Resume action, and the episode list.
//
// Episode buttons are laid out as a plain grid at 6 columns in their own focus
// group ('episode', numbered from row 1 so row 0 stays free as a scroll-anchor).
//
// The action row is a SEPARATE group ('action'), which is what let entry land
// on Play. The cost is that the two groups do not know about each other, so
// they are bridged explicitly below — see episodeTargetFor() / actionTargetFor().
export default function DetailPage({ seriesId, onPlay, onBack, toast, refreshKey }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [fav, setFav] = useState(false);
  const [progress, setProgress] = useState(null);

  const load = useCallback(() => {
    let alive = true;
    setState({ status: 'loading', data: null, error: '' });
    getDetail(seriesId)
      .then((res) => {
        if (!alive) return;
        if (!res || res.returnValue === false) {
          setState({ status: 'error', data: null, error: (res && res.errorText) || '加载失败' });
          return;
        }
        setState({ status: 'ready', data: res, error: '' });
        setFav(isFavorite(res.id));
        setProgress(getProgress(res.id));
      })
      .catch((e) => {
        if (!alive) return;
        setState({ status: 'error', data: null, error: e.message || '网络错误' });
      });
    return () => {
      alive = false;
    };
  }, [seriesId]);

  useEffect(() => {
    setContentContext('detail');
    resetContentMemory();
    return load();
  }, [load, refreshKey]);

  // Entry focus: land on the Play / Resume button.
  //
  // The owner asked for "选取剧集进入后，遥控应该停在播放或者重头播放按钮上，
  // 以便按确认进行播放" — arriving on this page should put the ring on the primary
  // action so one OK press starts playback, with no hunting.
  //
  // The page's own focus system can only reach group 'content' on entry, and
  // this page's action row is group 'action', so the target is named explicitly.
  // Guarded by `ready` because the button does not exist while loading.
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const timer = setTimeout(() => focusContentTarget('action-0-0', 4000), 80);
    return () => clearTimeout(timer);
  }, [state.status]);

  // Keep the resume label honest after returning from the player.
  useEffect(() => {
    return onProgressChange(() => setProgress(getProgress(seriesId)));
  }, [seriesId]);

  if (state.status === 'loading') return <Loading label="正在加载剧集…" />;
  if (state.status === 'error') {
    return (
      <PageState symbol="!" title="加载失败" message={state.error} action={null} />
    );
  }

  const data = state.data;
  const episodes = data.episodes || [];
  const tags = splitTags(data.tags);

  // Work out which episode "Play" should resume from.
  const resumeEp = progress ? episodes.find((e) => String(e.id) === String(progress.episodeId)) : null;
  const playTarget = resumeEp || episodes[0];
  const playLabel = resumeEp
    ? `继续播放 第 ${resumeEp.number} 集`
    : '从头播放';

  const handleToggleFav = () => {
    const next = toggleFavorite(data);
    setFav(next);
    if (toast) toast(next ? '已加入收藏' : '已取消收藏');
  };

  const handlePlay = () => {
    if (playTarget && onPlay) {
      onPlay(data, playTarget, resumeEp ? progress.position : 0);
    }
  };

  const handleEpisode = (ep) => {
    if (!onPlay) return;
    // Resume only the episode that actually has stored progress.
    const startAt =
      progress && String(progress.episodeId) === String(ep.id) ? progress.position : 0;
    onPlay(data, ep, startAt);
  };

  return (
    <div className="scroll-area" style={{ overflow: 'hidden' }}>
      <div className="detail-head">
        <div className="detail-cover">
          <img src={coverUrl(data.cover)} alt="" />
        </div>
        <div className="detail-info">
          <div className="detail-title">{data.title}</div>
          <div className="detail-facts">
            {data.rating ? <span className="detail-fact rating">{data.rating} 分</span> : null}
            <span className="detail-fact">共 {data.episodeCount} 集</span>
            {data.badge ? <span className="detail-fact">{data.badge}</span> : null}
            {tags.slice(0, 4).map((t) => (
              <span className="detail-fact" key={t}>
                {t}
              </span>
            ))}
          </div>
          {data.description ? <div className="detail-desc">{data.description}</div> : null}
          <div className="detail-actions">
            <ActionButton id="action-0-0" col={0} primary onSelect={handlePlay} disabled={!playTarget}>
              ▶ {playLabel}
            </ActionButton>
            <ActionButton id="action-0-1" col={1} onSelect={handleToggleFav}>
              {fav ? '♥ 已收藏' : '♡ 收藏'}
            </ActionButton>
          </div>
        </div>
      </div>

      <EpisodeGrid
        episodes={episodes}
        currentEpisodeId={progress ? progress.episodeId : ''}
        onSelect={handleEpisode}
      />
    </div>
  );
}

// Episodes are numbered in their own focus group as `episode-<row>-<col>`,
// starting at row 1 so row 0 can act as the "scroll to top" anchor.
//
// Scrolling: the grid is a REAL overflow:auto box and the focused cell is kept
// in view explicitly.
//
// Two things had to be true for the list to "翻" at all:
//
//   1. The box must actually be scrollable — it used to be `overflow:hidden`
//      with no mechanism, so cells past the visible rows were simply clipped.
//      (Fixed earlier; `scrollHeight > clientHeight` is now true on device.)
//
//   2. The focused cell must be brought INTO the box. The focus system calls
//      `scrollIntoView` for non-hover moves, but on this Chromium the options
//      object is only partially honoured and, more importantly, the app's own
//      per-page scrolling can fight it. Doing the arithmetic here — directly
//      against the scroll box — is deterministic and cannot be raced.
//
// The mounted window also grows as the user descends, so a long season (76
// episodes for the series tested on device) never runs out of rows to reach
// before the "加载更多" button appears.
function EpisodeGrid({ episodes, currentEpisodeId, onSelect }) {
  const PER_ROW = 6;
  const [mounted, setMounted] = useState(60);
  const scrollRef = useRef(null);
  const visible = episodes.slice(0, mounted);

  const rows = [];
  for (let i = 0; i < visible.length; i += PER_ROW) {
    rows.push(visible.slice(i, i + PER_ROW));
  }

  // Keep the focused episode cell inside the scroll box.
  //
  // Runs on every focus change in the episode group, and is written as a plain
  // scrollTop computation (not `scrollIntoView`) so the behaviour is identical
  // on every Chromium build and cannot be cancelled by another scroller.
  useEffect(() => {
    return onFocusChange((fid) => {
      if (!fid || fid.indexOf('episode-') !== 0) return;
      if (isHoverDriven()) return; // pointer hover must never scroll (edge loop)
      const box = scrollRef.current;
      const cell = document.querySelector(`[data-focus-id="${fid}"]`);
      if (!box || !cell) return;

      const boxTop = box.scrollTop;
      const boxBottom = boxTop + box.clientHeight;
      const cellTop = cell.offsetTop;
      const cellBottom = cellTop + cell.offsetHeight;
      // A little breathing room so the ring is never flush against the edge.
      const margin = 16;
      if (cellBottom + margin > boxBottom) {
        box.scrollTop = cellBottom + margin - box.clientHeight;
      } else if (cellTop - margin < boxTop) {
        box.scrollTop = Math.max(0, cellTop - margin);
      }

      // Descend gracefully: if the user is near the end of what is mounted,
      // mount more so the list keeps going.
      const rowIndex = Number(String(fid).split('-')[1]) - 1;
      if (rowIndex >= 0 && (rowIndex + 2) * PER_ROW > mounted) {
        setMounted((m) => Math.min(episodes.length, m + 120));
      }
    });
  }, [mounted, episodes.length]);

  return (
    <div className="scroll-area" style={{ overflow: 'hidden' }}>
      <div className="page-heading" style={{ paddingTop: 14, paddingBottom: 6 }}>
        <h1 style={{ fontSize: 24 }}>
          选集
          <span className="detail-fact" style={{ marginLeft: 12 }}>{episodes.length} 集</span>
        </h1>
      </div>
      {/* A REAL scroll container. This was `overflow:hidden` with no scrolling
          mechanism at all, so moving down past the visible rows left the focused
          cell painted outside the viewport — the reported "集号不会向下翻".
          `auto` lets the focus system's scrollIntoView actually work. The
          padding lives on the inner wrapper so the scroll box measures the full
          episode list. */}
      <div
        ref={scrollRef}
        style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', scrollbarWidth: 'none' }}
      >
        <div style={{ padding: '4px 56px 60px' }}>
          {rows.map((row, rowIndex) => (
            <div
              key={`eprow-${rowIndex}`}
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${PER_ROW}, 1fr)`,
                gridGap: 14,
                marginBottom: 14
              }}
            >
              {row.map((ep, colIndex) => (
                <EpisodeCell
                  key={ep.id}
                  ep={ep}
                  row={rowIndex + 1}
                  col={colIndex}
                  watched={isWatched(ep, currentEpisodeId)}
                  current={String(ep.id) === String(currentEpisodeId)}
                  onSelect={() => onSelect(ep)}
                />
              ))}
            </div>
          ))}
          {mounted < episodes.length ? (
            // Row = one past the last rendered episode row, so Down from any
            // column of that row reaches it (navigateGrid scans columns right
            // to left when the exact cell is missing). At row 0 it was below
            // the grid visually but above it arithmetically — unreachable.
            <LoadMoreEpisodes
              id={`episode-${rows.length + 1}-0`}
              row={rows.length + 1}
              onClick={() => setMounted(mounted + 120)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function isWatched(ep, currentEpisodeId) {
  return false; // reserved: progress tracking is per-series, not per-episode
}

// ---- crossing between the action row and the episode grid -------------------
//
// "选中剧集进入后是在播放按钮上了，但是按下键无法到集数上。"
//
// navigateGrid composes `${group}-${row}-${col}`, so Down from `action-0-0`
// looked for `action-1-0`, which does not exist, and the key was swallowed —
// the ring simply never moved. The two groups are laid out vertically on the
// page but are invisible to each other in the registry, so the page has to name
// the neighbour itself.
//
// Both directions are wired, because landing in the episode grid with no way
// back up would be just as stuck.
function episodeTargetFor(col) {
  // Prefer the column the user was on (Down from 收藏 lands on the 2nd cell of
  // the first episode row), then fall back to the row's first cell.
  for (let r = 1; r <= 2; r++) {
    const candidates = [col, 0];
    for (const c of candidates) {
      const id = `episode-${r}-${c}`;
      if (hasFocusable(id)) return id;
    }
  }
  return null;
}

function actionTargetFor(col) {
  const id = `action-0-${col}`;
  if (hasFocusable(id)) return id;
  return hasFocusable('action-0-0') ? 'action-0-0' : null;
}

function EpisodeCell({ ep, row, col, current, watched, onSelect }) {
  const { props, isFocused } = useFocusable({
    id: `episode-${row}-${col}`,
    row,
    col,
    group: 'episode',
    onSelect,
    // Up out of the top episode row returns to the action row.
    onNavigate: (dir) => (dir === 'up' && row === 1 ? actionTargetFor(col) : undefined)
  });
  return (
    <div
      className={`episode-cell focusable${isFocused ? ' focused' : ''}${current ? ' current' : ''}${watched ? ' watched' : ''}`}
      {...props}
    >
      {ep.number}
    </div>
  );
}

function LoadMoreEpisodes({ id, row, onClick }) {
  const { props, isFocused } = useFocusable({ id, row, col: 0, group: 'episode', onSelect: onClick });
  return (
    <span className={`tv-action focusable${isFocused ? ' focused' : ''}`} {...props}>
      加载更多剧集
    </span>
  );
}

function ActionButton({ id, col = 0, onSelect, children, primary = false, disabled = false }) {
  const { props, isFocused } = useFocusable({
    id,
    col,
    group: 'action',
    // A disabled action must not be selectable, so simply omit the handler.
    onSelect: disabled ? undefined : onSelect,
    // Down from the action row must reach the episode grid; without this the
    // key did nothing (see episodeTargetFor).
    onNavigate: (dir) => (dir === 'down' ? episodeTargetFor(col) : undefined)
  });
  return (
    <span
      className={`tv-action focusable${primary ? ' primary' : ''}${isFocused ? ' focused' : ''}`}
      style={disabled ? { opacity: 0.5 } : undefined}
      {...props}
    >
      {children}
    </span>
  );
}
