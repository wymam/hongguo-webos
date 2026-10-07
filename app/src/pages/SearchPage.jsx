import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getSearch } from '../api/client';
import { useFocusable, setContentContext, resetContentMemory, focusContentTarget } from '../hooks/useFocus';
import ShelfGrid from '../components/ShelfGrid';
import { Loading, PageState } from '../components/Common';
import { getSettings, get, set, clampCols } from '../utils/storage';

// Search.
//
// NOTE ON A KNOWN UPSTREAM LIMIT: the red-berry search APIs are gated as of
// 2026-10; both the app endpoint and the website SSR return nothing to
// non-app traffic. The service reports this as errorCode SEARCH_UNAVAILABLE
// rather than an empty list, and this page surfaces that plainly instead of
// pretending the user typed something wrong. If the gate is ever lifted, no
// change is needed here — results simply start arriving.
export default function SearchPage({ onOpenSeries, onLongPress, toast }) {
  const [keyword, setKeyword] = useState('');
  const [state, setState] = useState({ status: 'idle', items: [], error: '', code: '' });
  const [recent, setRecent] = useState(() => get('search_recent', []) || []);
  const inputRef = useRef(null);
  const cols = clampCols(getSettings().gridCols);

  useEffect(() => {
    setContentContext('search');
    resetContentMemory();
  }, []);

  // Open the keyboard when the user actually ENTERS search.
  //
  // A native <input> is not a node in the focus system, so with a D-pad-only
  // remote there was no way to reach it at all: the page rendered, nothing was
  // focusable, and every arrow key moved the rail behind it. Search was
  // unusable without a Magic Remote pointer.
  //
  // It must wait for a real commit, not for the page to mount: browsing down
  // the rail PREVIEWS every page it passes, and popping the virtual keyboard
  // because the highlight drifted over 搜索 would be hostile.
  useEffect(() => {
    const onCommit = (e) => {
      if (e.detail !== 'search') return;
      setTimeout(() => {
        const el = inputRef.current;
        if (el && typeof el.focus === 'function') el.focus();
      }, 150);
    };
    window.addEventListener('hongguo-commit', onCommit);
    return () => window.removeEventListener('hongguo-commit', onCommit);
  }, []);

  // Hand the D-pad back once the input has done its job.
  //
  // While the input owns DOM focus the global key handler ignores arrows
  // (they belong to the caret / the virtual keyboard), so leaving it focused
  // after results arrive would freeze the result grid: the ring would move but
  // the caret would eat every key.
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'loading') return;
    const el = inputRef.current;
    if (el && typeof el.blur === 'function') el.blur();
    if (state.status === 'ready') focusContentTarget('content-0-0', 3000);
  }, [state.status]);

  const runSearch = useCallback(
    (kw) => {
      const query = String(kw || '').trim();
      if (!query) return;
      let alive = true;
      setState({ status: 'loading', items: [], error: '', code: '' });

      // Remember the term as soon as it is submitted, so the history is user
      // intent rather than "whatever produced results".
      const next = [query].concat(recent.filter((r) => r !== query)).slice(0, 12);
      setRecent(next);
      set('search_recent', next);

      getSearch(query, 1)
        .then((res) => {
          if (!alive) return;
          if (!res || res.returnValue === false) {
            setState({
              status: 'unavailable',
              items: [],
              error: (res && res.errorText) || '搜索暂不可用',
              code: (res && res.errorCode) || ''
            });
            return;
          }
          const items = Array.isArray(res.items) ? res.items : [];
          setState({ status: items.length ? 'ready' : 'empty', items, error: '', code: '' });
        })
        .catch((e) => {
          if (!alive) return;
          setState({
            status: e.code === 'SEARCH_UNAVAILABLE' ? 'unavailable' : 'error',
            items: [],
            error: e.message || '搜索失败',
            code: e.code || ''
          });
        });

      return () => {
        alive = false;
      };
    },
    [recent]
  );

  const focusInput = () => {
    const el = inputRef.current;
    if (el && typeof el.focus === 'function') el.focus();
  };

  return (
    <div className="search-container">
      <div className="page-heading" style={{ padding: '26px 0 16px' }}>
        <div className="page-eyebrow">搜索</div>
        <h1>找剧</h1>
      </div>

      <SearchInput
        inputRef={inputRef}
        value={keyword}
        onChange={setKeyword}
        onSubmit={() => runSearch(keyword)}
      />

      <div className="search-help">
        输入剧名后按遥控器确认键搜索，或按返回键关闭键盘
      </div>

      {state.status === 'idle' ? (
        <RecentSearch recent={recent} onPick={(kw) => { setKeyword(kw); runSearch(kw); }} />
      ) : null}

      {state.status === 'loading' ? <Loading label="正在搜索…" /> : null}

      {state.status === 'unavailable' ? (
        <PageState
          symbol="!"
          title="搜索暂时不可用"
          message="上游已限制搜索接口（红果官方当前仅对 App 开放），推荐改用「真人剧 / 漫剧 / AI剧」分类或首页推荐浏览。"
          action={null}
        />
      ) : null}

      {state.status === 'error' ? (
        <PageState symbol="!" title="搜索失败" message={state.error} action={null} />
      ) : null}

      {state.status === 'empty' ? (
        <PageState
          symbol="?"
          title="没有找到相关剧集"
          message={`没有与「${keyword}」匹配的结果，换个关键词试试。`}
          action={null}
        />
      ) : null}

      {state.status === 'ready' ? (
        <div className="scroll-area">
          <ShelfGrid
            shelves={[{ title: null, items: state.items }]}
            cols={cols}
            group="content"
            onSelect={onOpenSeries}
            onLongPress={onLongPress}
          />
        </div>
      ) : null}
    </div>
  );
}

// A native text input is the only way to get the on-screen keyboard. Focus is
// handled by the browser, not the focus system, so Up/Down hand control to the
// grid or the recent list around it.
function SearchInput({ inputRef, value, onChange, onSubmit }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      ref={inputRef}
      className={`search-input${focused ? ' focused' : ''}`}
      type="text"
      placeholder="输入剧名，例如：总裁"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSubmit();
        }
      }}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

function RecentSearch({ recent, onPick }) {
  if (!recent.length) {
    return <div className="search-empty">还没有搜索记录。</div>;
  }
  return (
    <>
      <div className="search-recs" style={{ marginBottom: 12 }}>
        <div className="search-rec-section">最近搜索</div>
      </div>
      <div className="search-recent">
        {recent.map((kw, i) => (
          <RecentChip key={kw} id={`recent-0-${i}`} onSelect={() => onPick(kw)}>
            {kw}
          </RecentChip>
        ))}
      </div>
    </>
  );
}

function RecentChip({ id, children, onSelect }) {
  const { props, isFocused } = useFocusable({ id, onSelect, group: 'recent' });
  return (
    <span className={`search-recent-chip focusable${isFocused ? ' focused' : ''}`} {...props}>
      {children}
    </span>
  );
}
