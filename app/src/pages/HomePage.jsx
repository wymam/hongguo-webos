import React, { useCallback, useEffect, useState } from 'react';
import { getHome } from '../api/client';
import {
  useFocusable,
  onFocusChange,
  setContentContext,
  resetContentMemory
} from '../hooks/useFocus';
import ShelfGrid, { ShelfFooterButton } from '../components/ShelfGrid';
import { Loading, PageState } from '../components/Common';
import { splitTags } from '../utils/format';
import { coverUrl } from '../utils/thumb';
import { getSettings, clampCols } from '../utils/storage';

// Home: a rotating hero plus the recommended shelves.
export default function HomePage({ onOpenSeries, onLongPress, refreshKey }) {
  const [state, setState] = useState({ status: 'loading', banners: [], shelves: [], error: '' });
  const cols = clampCols(getSettings().gridCols);

  const load = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, status: s.shelves.length ? 'ready' : 'loading', error: '' }));
    getHome()
      .then((res) => {
        if (!alive) return;
        if (!res || res.returnValue === false) {
          setState({ status: 'error', banners: [], shelves: [], error: (res && res.errorText) || '加载失败' });
          return;
        }
        const shelves = Array.isArray(res.sections) ? res.sections : [];
        setState({
          status: shelves.length ? 'ready' : 'empty',
          banners: Array.isArray(res.banners) ? res.banners : [],
          shelves,
          error: ''
        });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ status: 'error', banners: [], shelves: [], error: e.message || '网络错误' });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setContentContext('home');
    resetContentMemory();
    return load();
  }, [load, refreshKey]);

  if (state.status === 'loading') return <Loading label="正在加载推荐…" />;

  if (state.status === 'error') {
    return (
      <PageState
        symbol="!"
        title="内容加载失败"
        message={state.error}
        action={<ActionButton id="retry-0-0" onSelect={load}>按确认重试</ActionButton>}
      />
    );
  }

  return (
    <div className="scroll-area">
      {state.banners.length ? <Hero banners={state.banners} onOpenSeries={onOpenSeries} /> : null}
      <ShelfGrid
        shelves={state.shelves}
        cols={cols}
        group="content"
        onSelect={onOpenSeries}
        onLongPress={onLongPress}
        footerId="refresh-0-0"
        footer={
          <ShelfFooterButton id="refresh-0-0" onSelect={load}>
            刷新推荐
          </ShelfFooterButton>
        }
      />
    </div>
  );
}

// The hero rotates only while nothing is focused: a moving target under the
// D-pad is frustrating, so any focus pauses the rotation.
function Hero({ banners, onOpenSeries }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => onFocusChange((fid) => setPaused(!!fid)), []);

  useEffect(() => {
    if (paused || banners.length < 2) return undefined;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % banners.length), 7000);
    return () => clearTimeout(timer);
  }, [index, paused, banners.length]);

  const current = banners[Math.min(index, banners.length - 1)];
  if (!current) return null;
  const tags = splitTags(current.tags).slice(0, 3);

  return (
    <div className="hero" onClick={() => onOpenSeries && onOpenSeries(current)}>
      <img key={current.id} className="hero-bg hero-fade-in" src={coverUrl(current.cover)} alt="" />
      <div className="hero-scrim" />
      <div className="hero-body">
        <div className="hero-title">{current.title}</div>
        {current.description ? <div className="hero-desc">{current.description}</div> : null}
        <div className="hero-tags">
          {tags.map((t) => (
            <span className="hero-tag" key={t}>
              {t}
            </span>
          ))}
          {current.badge ? <span className="hero-tag">{current.badge}</span> : null}
        </div>
      </div>
    </div>
  );
}

// A focusable pill button, usable anywhere.
export function ActionButton({ id, onSelect, children, primary = false, group = 'button' }) {
  const { props, isFocused } = useFocusable({ id, onSelect, group });
  return (
    <span
      className={`tv-action focusable${primary ? ' primary' : ''}${isFocused ? ' focused' : ''}`}
      {...props}
    >
      {children}
    </span>
  );
}
