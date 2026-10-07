import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  initKeyboardNav,
  setFocus,
  getCurrentFocusId,
  focusFirstContent,
  focusContentTarget,
  setLastSidebarFocus,
  onFocusChange,
  isPointerFocus,
  useFocusable,
  hasFocusable
} from './hooks/useFocus';
import { probeService, isDevMode } from './api/client';
import { getUiScale, toggleFavorite, isFavorite } from './utils/storage';

import HomePage, { ActionButton } from './pages/HomePage';
import CategoryPage from './pages/CategoryPage';
import DetailPage from './pages/DetailPage';
import SearchPage from './pages/SearchPage';
import LibraryPage from './pages/LibraryPage';
import SettingsPage from './pages/SettingsPage';
import PlayerPage from './player/PlayerPage';

// Navigation model.
//
// Red-berry offers three browsable categories plus two local shelves. Search is
// present but the upstream currently gates it, so it is kept in the nav (the
// page explains the situation) rather than hidden — the minute the gate lifts,
// it works with no change.
const NAV_ITEMS = [
  { key: 'search', label: '搜索', icon: '⌕' },
  { key: 'home', label: '推荐', icon: '◉' },
  { key: 'divider-1', divider: true },
  { key: 'cat:real', label: '真人剧', icon: '▤' },
  { key: 'cat:comic', label: '漫剧', icon: '◈' },
  { key: 'cat:ai', label: 'AI剧', icon: '✦' },
  { key: 'divider-2', divider: true },
  { key: 'favorites', label: '收藏', icon: '♥' },
  { key: 'history', label: '观看记录', icon: '◷' },
  { key: 'settings', label: '设置', icon: '⚙' }
];

const CATEGORY_NAMES = { 'cat:real': '真人剧', 'cat:comic': '漫剧', 'cat:ai': 'AI剧' };
const CATEGORY_KEYS = { 'cat:real': 'real', 'cat:comic': 'comic', 'cat:ai': 'ai' };

// Sidebar focus ids are ROW-based, and the row must be the item's position among
// the FOCUSABLE items — dividers are skipped entirely (see below).
//
// This used to be the array index (`sidebar-${index}-0`) while useFocusable
// registered `row: 0` for every entry. navigateGrid works purely on `row ± 1`,
// so "down" computed row 0+1 = 0 → the same id back, or an id that never
// registered because it landed on a divider (index 2, 6). Result: the D-pad
// could move between 搜索 and 推荐 and then stopped dead — 真人剧 / 漫剧 / AI剧 /
// 收藏 / 观看记录 / 设置 were unreachable. Making the row the *focusable* index
// keeps 0,1,2,3,... contiguous, which is exactly what arithmetic navigation
// needs, and the mapping stays stable as items are added or removed.
const FOCUSABLE_ITEMS = NAV_ITEMS.filter((item) => !item.divider);
const SIDEBAR_ROWS = new Map(FOCUSABLE_ITEMS.map((item, i) => [item.key, i]));

function sidebarIdForPage(key) {
  const row = SIDEBAR_ROWS.has(key) ? SIDEBAR_ROWS.get(key) : 1;
  return `sidebar-${row}-0`;
}

// Inverse of sidebarIdForPage: which page a given rail focus id points at.
// The rail previews as it is browsed, so this mapping is what keeps "highlight
// on 真人剧" and "content pane shows 真人剧" the same thing.
function pageKeyForSidebarId(id) {
  const m = /^sidebar-(\d+)-0$/.exec(id || '');
  if (!m) return null;
  const row = Number(m[1]);
  for (const [key, r] of SIDEBAR_ROWS) {
    if (r === row) return key;
  }
  return null;
}

// Total number of focusable sidebar rows (for wrap-around bounds).
const SIDEBAR_ROW_COUNT = FOCUSABLE_ITEMS.length;

export default function App() {
  const [page, setPage] = useState('home');
  const [seriesId, setSeriesId] = useState(null);
  const [player, setPlayer] = useState(null); // { series, episode, startAt }
  const [toast, setToast] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [menuVideo, setMenuVideo] = useState(null);
  const [serviceWarning, setServiceWarning] = useState('');

  const enterPageRef = useRef(null);
  const toastTimer = useRef(0);

  const showToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // Apply the persisted UI scale on boot.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(getUiScale()));
  }, []);

  // Verify the Luna service is reachable; without it no data call can succeed.
  useEffect(() => {
    let alive = true;
    probeService().then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setServiceWarning(
          isDevMode()
            ? '未检测到电视服务。在开发模式下需要先在电视上安装本应用，或运行本地开发桥。'
            : '无法连接应用服务，请重新启动应用。'
        );
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Boot the focus system.
  useEffect(() => {
    initKeyboardNav();
    const initial = sidebarIdForPage('home');
    setLastSidebarFocus(initial);
    setFocus(initial);
    const timer = setTimeout(() => focusFirstContent(), 900);
    return () => clearTimeout(timer);
  }, []);

  // Browsing the rail PREVIEWS the page it points at.
  //
  // The owner asked for exactly this: "在遥控器选中推荐、真人剧等菜单，应该右边
  // 同步切换到对应菜单上，而不要等需要确认才切换" — moving the highlight down the
  // rail must swap the content pane immediately, the way a TV sidebar behaves.
  // Confirm (OK) then only has to commit, i.e. hide the rail and hand the D-pad
  // to the page's own content.
  //
  // Preview is driven from the FOCUS listener rather than from onSelect because
  // the rail's highlight moves on focus, long before any Confirm.
  const previewPage = useCallback(
    (key) => {
      if (!key || key === page) return;
      if (key === 'detail') return; // detail is reached from a card, never the rail
      enterPageRef.current = null;  // a preview is not a "fresh entry"; do not re-anchor
      setSeriesId(null);
      // Leaving for another page ends playback. Pointer hover never reaches
      // here (the focus listener bails on isPointerFocus), so this only fires
      // for genuine D-pad rail navigation — where dropping the player is exactly
      // what the viewer means.
      setPlayer(null);
      setPage(key);
      setLastSidebarFocus(sidebarIdForPage(key));
    },
    [page]
  );

  // Which rail item the highlight is on, so repeated focus events don't re-render.
  const railPreviewRef = useRef(null);

  // Commit the rail: hide it and hand the D-pad to the page behind it.
  //
  // Shared by the OK path and the Right path, because the owner reported both
  // as broken in the same way: "按确定后…左边菜单栏不会隐藏，或者…按右键不会
  // 进入真人剧页面，并隐藏左边菜单栏".
  const commitRail = useCallback((key) => {
    const target = key || page;
    setRailExpanded(false);
    // Navigating away from anywhere must also drop the player.
    //
    // The player is an overlay rendered ON TOP of the page, so leaving it
    // mounted while the rail switches pages strands a full-screen <video> over
    // the new page — and because PlayerPage owns the D-pad via
    // setCustomKeyHandler, every arrow key on the page underneath is swallowed.
    // Back recovers from it, but pointer users (clicking a rail item with the
    // Magic Remote while a title plays) had no reason to think of Back.
    setPlayer(null);
    setMenuVideo(null);
    setLastSidebarFocus(sidebarIdForPage(target));
    // Broadcast the commit. A page that needs to know the difference between
    // "the user chose me" and "the rail merely previewed me on the way past"
    // has no other signal: preview and commit render the same component.
    window.dispatchEvent(new CustomEvent('hongguo-commit', { detail: target }));
    if (target && target !== page) previewPage(target);
    // Let the page mount, then move focus into its content.
    setTimeout(() => focusFirstContent(2000), 90);
    return true;
  }, [page, previewPage]);

  // After a page swap, move focus into the new content once it has rendered.
  //
  // The sidebar anchor here is a TRANSIENT placeholder: it gives focus somewhere
  // valid to be while the new page's cards register, and is immediately replaced
  // by focusFirstContent. It must NOT expand the rail — that is exactly the
  // "进去剧集后左边菜单栏会自动弹出" report.
  //
  // Suppression is keyed on the anchor's IDENTITY and a short expiry, not on a
  // one-shot boolean. A boolean was wrong: a real keypress arriving between the
  // anchor focus and focusFirstContent would consume the flag instead of the
  // anchor, so the user's own rail navigation stopped expanding the rail (measured
  // on device: Left reached the rail but it stayed collapsed).
  const anchorGuardRef = useRef({ id: null, until: 0 });

  useEffect(() => {
    if (!enterPageRef.current) return undefined;
    const target = enterPageRef.current;
    enterPageRef.current = null;
    const timer = setTimeout(() => {
      const anchorId = sidebarIdForPage(target);
      anchorGuardRef.current = { id: anchorId, until: Date.now() + 1200 };
      setFocus(anchorId);
      setTimeout(() => focusFirstContent(3000), 120);
    }, 60);
    return () => clearTimeout(timer);
  }, [page]);

  // The rail's expanded/collapsed state.
  //
  // It expands ONLY while the user is actually navigating it with the D-pad, and
  // collapses the moment focus leaves. Previously it keyed purely off the focus
  // id, which caused three reported problems:
  //
  //   * entering a series popped the rail open (the detail page briefly focused a
  //     sidebar id on its way in),
  //   * pressing Back while the rail was open left it open, because nothing
  //     collapsed it on the Back path,
  //   * pressing Right on 设置 left it open too, because nothing handled the
  //     "commit the rail" gesture at all.
  //
  // Driving it from a single explicit setter — instead of an ambient listener
  // that reacts to whatever focus happens to be — makes every path consistent:
  // expand when the rail takes focus, collapse on any exit (content, Back, the
  // Right-commit gesture).
  const [railExpanded, setRailExpanded] = useState(false);

  useEffect(() => {
    return onFocusChange((fid) => {
      if (isPointerFocus()) return;
      // Ignore ONLY the programmatic page-swap anchor, and only while it is
      // fresh. Anything else — including the user pressing Left onto the rail a
      // moment later — behaves normally and opens the rail.
      const guard = anchorGuardRef.current;
      if (guard.id && fid === guard.id && Date.now() < guard.until) {
        guard.id = null;
        return;
      }
      guard.id = null;
      const onRail = !!(fid && fid.startsWith('sidebar-'));
      setRailExpanded(onRail);
      // Sync the content pane to whatever the rail highlight is pointing at.
      if (onRail) {
        const key = pageKeyForSidebarId(fid);
        if (key && key !== railPreviewRef.current) {
          railPreviewRef.current = key;
          previewPage(key);
        }
      } else {
        railPreviewRef.current = null;
      }
    });
  }, [previewPage]);

  useEffect(() => {
    const rail = document.querySelector('.sidebar');
    if (rail) rail.dataset.expanded = railExpanded ? 'true' : 'false';
  }, [railExpanded]);

  const openSeries = useCallback(
    (video) => {
      if (!video || !video.id) return;
      setSeriesId(String(video.id));
      setPage('detail');
      enterPageRef.current = 'detail';
    },
    []
  );

  const openPlayer = useCallback((series, episode, startAt) => {
    setPlayer({ series, episode, startAt: startAt || 0 });
  }, []);

  const closePlayer = useCallback(() => {
    setPlayer(null);
  }, []);

  const switchEpisode = useCallback((episode) => {
    setPlayer((p) => (p ? { series: p.series, episode, startAt: 0 } : null));
  }, []);

  // Layered Back: player → detail → sidebar → previous page → exit.
  const handleBack = useCallback(() => {
    // The rail is the outermost layer of the UI, so Back closes it first — this
    // is the reported "按返回键，左边菜单栏不会自动隐藏回去". Doing it before the
    // player/detail checks would be wrong (those are *inside* content), but the
    // rail can only be open while it holds focus, which never happens during
    // playback or on a detail page, so testing it first is safe and predictable.
    if (railExpanded) {
      setRailExpanded(false);
      focusFirstContent(1500);
      return true;
    }
    if (player) {
      closePlayer();
      return true;
    }
    if (menuVideo) {
      setMenuVideo(null);
      return true;
    }
    const current = getCurrentFocusId();
    if (current && current.startsWith('content-')) {
      setFocus(sidebarIdForPage(page));
      return true;
    }
    if (page !== 'home') {
      if (page === 'detail') {
        setSeriesId(null);
      }
      setPage('home');
      setLastSidebarFocus(sidebarIdForPage('home'));
      enterPageRef.current = null;
      setTimeout(() => {
        setFocus(sidebarIdForPage('home'));
      }, 40);
      return true;
    }
    return false;
  }, [player, menuVideo, page, closePlayer, railExpanded]);

  // Route Back/Escape into handleBack; when nothing is left to close, exit.
  useEffect(() => {
    const onKey = (e) => {
      const isBack = e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === 461;
      if (!isBack) return;
      e.preventDefault();
      const handled = handleBack();
      if (!handled && window.webOS && window.webOS.platformBack) {
        window.webOS.platformBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleBack]);

  // The focus system dispatches tv-back for the physical Back button; reuse
  // the same handler so behaviour is identical.
  useEffect(() => {
    const onTvBack = () => {
      const handled = handleBack();
      if (!handled && window.webOS && window.webOS.platformBack) {
        window.webOS.platformBack();
      }
    };
    window.addEventListener('tv-back', onTvBack);
    return () => window.removeEventListener('tv-back', onTvBack);
  }, [handleBack]);

  // Right on the rail = "commit this section".
  //
  // The focus system emits this event when a sidebar item is at the right edge
  // and there is nowhere further to go. Commit means: hide the rail, make sure
  // the page the highlight points at is the one showing (it normally already is,
  // because browsing previews), then move focus into that page's own content so
  // the D-pad now drives it.
  //
  // Using the SAME commit path as OK is what fixes the reported asymmetry:
  // "选真人剧按确定后菜单栏不隐藏，或者选真人剧菜单栏按右键不会进入真人剧页面
  // 并隐藏" — both gestures now do the identical thing.
  useEffect(() => {
    const onEnterContent = () => {
      const fid = getCurrentFocusId();
      const key = pageKeyForSidebarId(fid);
      commitRail(key);
    };
    window.addEventListener('tv-enter-content', onEnterContent);
    return () => window.removeEventListener('tv-enter-content', onEnterContent);
  }, [commitRail]);

  // Long-press a card opens a small context menu.
  useEffect(() => {
    const onMenu = (e) => setMenuVideo(e.detail);
    window.addEventListener('card-menu', onMenu);
    return () => window.removeEventListener('card-menu', onMenu);
  }, []);

  // The context menu has no access to this component's setState, so it talks
  // back through events.
  useEffect(() => {
    const onToast = (e) => showToast(e.detail);
    const onOpenSeries = (e) => {
      setMenuVideo(null);
      openSeries(e.detail);
    };
    window.addEventListener('hongguo-toast', onToast);
    window.addEventListener('open-series', onOpenSeries);
    return () => {
      window.removeEventListener('hongguo-toast', onToast);
      window.removeEventListener('open-series', onOpenSeries);
    };
  }, [showToast, openSeries]);

  return (
    <div className="app-container">
      <Sidebar page={page} onCommit={commitRail} />

      <div className="main-content">
        {serviceWarning ? (
          <div className="page-state" style={{ flex: 'none', padding: '16px 56px 0', alignItems: 'flex-start' }}>
            <p style={{ color: '#ff9a8a' }}>{serviceWarning}</p>
          </div>
        ) : null}

        {page === 'home' ? (
          <HomePage onOpenSeries={openSeries} onLongPress={setMenuVideo} refreshKey={refreshKey} />
        ) : null}

        {page === 'search' ? (
          <SearchPage onOpenSeries={openSeries} onLongPress={setMenuVideo} toast={showToast} />
        ) : null}

        {page.startsWith('cat:') ? (
          <CategoryPage
            categoryKey={CATEGORY_KEYS[page]}
            categoryName={CATEGORY_NAMES[page]}
            onOpenSeries={openSeries}
            onLongPress={setMenuVideo}
            refreshKey={refreshKey}
          />
        ) : null}

        {page === 'detail' && seriesId ? (
          <DetailPage
            seriesId={seriesId}
            onPlay={openPlayer}
            onBack={() => handleBack()}
            toast={showToast}
            refreshKey={refreshKey}
          />
        ) : null}

        {page === 'favorites' ? (
          <LibraryPage mode="favorites" onOpenSeries={openSeries} onLongPress={setMenuVideo} toast={showToast} refreshKey={refreshKey} />
        ) : null}

        {page === 'history' ? (
          <LibraryPage mode="history" onOpenSeries={openSeries} onLongPress={setMenuVideo} toast={showToast} refreshKey={refreshKey} />
        ) : null}

        {page === 'settings' ? <SettingsPage toast={showToast} refreshKey={refreshKey} /> : null}
      </div>

      {player ? (
        <PlayerPage
          // Remount on episode change. The player owns a <video> plus its event
          // listeners and its own hold-to-seek key handler; letting React diff
          // it against a new episode means the element keeps stale media state
          // and the old listeners fire against the new source (manifested as
          // "切换其他集播放失败"). A key makes the switch deterministic: old
          // component unmounts, listeners detach, new one boots clean.
          key={player.episode ? String(player.episode.id) : 'player'}
          series={player.series}
          episode={player.episode}
          startAt={player.startAt}
          onBack={closePlayer}
          onEpisodeChange={switchEpisode}
          toast={showToast}
        />
      ) : null}

      {menuVideo ? <CardMenu video={menuVideo} onClose={() => setMenuVideo(null)} /> : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function Sidebar({ page, onCommit }) {
  return (
    <div className="sidebar" data-expanded="false">
      <div className="sidebar-logo">
        <span style={{ fontSize: 26, lineHeight: 1 }}>◕</span>
        <div className="sidebar-wordmark">
          红果短剧
          <span>HONGGUO TV</span>
        </div>
      </div>
      <div className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          if (item.divider) {
            return <div className="sidebar-divider" key={item.key} />;
          }
          const active = page === item.key;
          // Row = position among FOCUSABLE items, so the D-pad can walk the
          // whole rail with plain row±1 arithmetic (dividers are not rows).
          const row = SIDEBAR_ROWS.get(item.key);
          return (
            <SidebarItem
              key={item.key}
              id={`sidebar-${row}-0`}
              row={row}
              label={item.label}
              icon={item.icon}
              active={active}
              // Confirm commits the section: hide the rail, open the page (it
              // is normally already previewed) and focus its content.
              onSelect={() => onCommit(item.key)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SidebarItem({ id, row, label, icon, active, onSelect }) {
  // `row` MUST match the row encoded in `id` — navigateGrid navigates on the
  // registered row, not on the id string. Passing a constant here is what broke
  // the rail originally; keep the two in sync.
  const { props, isFocused } = useFocusable({ id, group: 'sidebar', row, col: 0, onSelect });
  return (
    <div
      className={`sidebar-item focusable${active ? ' active' : ''}${isFocused ? ' focused' : ''}`}
      {...props}
    >
      <span className="sidebar-icon">{icon}</span>
      <span className="sidebar-label">{label}</span>
    </div>
  );
}

function CardMenu({ video, onClose }) {
  const faved = isFavorite(video.id);

  // Put the ring ON the menu when it opens.
  //
  // The menu is a modal, but focus used to stay on the card behind the scrim,
  // so nothing on screen looked selected and Up/Down/Enter drove the grid
  // underneath. Naming the first row makes the menu operable immediately.
  //
  // Closing hands the ring back to the card it came from. Without that the
  // menu's own id unregisters with the focus still on it, `currentFocusId`
  // goes null, and the next arrow press falls back to the rail — the viewer
  // loses their place in the grid for having opened a menu.
  const returnToRef = useRef(null);
  useEffect(() => {
    returnToRef.current = getCurrentFocusId();
    const t = setTimeout(() => focusContentTarget('menu-0-0', 3000), 30);
    return () => {
      clearTimeout(t);
      const back = returnToRef.current;
      if (back && back.indexOf('menu-') !== 0 && hasFocusable(back)) setFocus(back);
    };
  }, []);

  return (
    <>
      <div className="cardmenu-scrim" />
      <div className="cardmenu">
        <div className="cardmenu-title">{video.title}</div>
        <MenuItem
          id="menu-0-0"
          row={0}
          onSelect={() => {
            const next = toggleFavorite(video);
            window.dispatchEvent(
              new CustomEvent('hongguo-toast', { detail: next ? '已加入收藏' : '已取消收藏' })
            );
            onClose();
          }}
        >
          {faved ? '取消收藏' : '加入收藏'}
        </MenuItem>
        <MenuItem
          id="menu-1-0"
          row={1}
          onSelect={() => {
            window.dispatchEvent(new CustomEvent('open-series', { detail: video }));
            onClose();
          }}
        >
          查看详情
        </MenuItem>
        <MenuItem id="menu-2-0" row={2} onSelect={onClose}>
          关闭
        </MenuItem>
      </div>
    </>
  );
}

function MenuItem({ id, row, onSelect, children }) {
  // Rows go DOWN, matching the stacked layout (each item is a full-width row
  // with margin-bottom). They were menu-0-0/1/2 — one row, three columns — so
  // ArrowDown looked for menu-1-0, found nothing, and the menu could only be
  // walked with Left/Right.
  const { props, isFocused } = useFocusable({ id, row, col: 0, group: 'menu', onSelect });
  return (
    <div className={`cardmenu-item focusable${isFocused ? ' focused' : ''}`} {...props}>
      <span>{children}</span>
    </div>
  );
}
