import React, { useCallback, useEffect, useState } from 'react';
import { setContentContext, resetContentMemory } from '../hooks/useFocus';
import ShelfGrid, { ShelfFooterButton } from '../components/ShelfGrid';
import { Loading, PageState } from '../components/Common';
import { getFavorites, toggleFavorite, getHistory, clearHistory, getSettings, clampCols } from '../utils/storage';

// Favorites and watch history.
//
// Red-berry has no account sync, so both lists are local to this TV. That is
// stated in the UI so a user moving between sets understands why the list is
// empty on a new device.
export default function LibraryPage({ mode, onOpenSeries, onLongPress, toast, refreshKey }) {
  const [state, setState] = useState({ status: 'loading', items: [] });
  const cols = clampCols(getSettings().gridCols);

  const load = useCallback(() => {
    setContentContext('library');
    const items = mode === 'favorites' ? getFavorites() : getHistory();
    setState({ status: items.length ? 'ready' : 'empty', items });
  }, [mode]);

  useEffect(() => {
    resetContentMemory();
    load();
  }, [load, refreshKey, mode]);

  const handleRemove = (item) => {
    if (mode === 'favorites') {
      toggleFavorite(item);
      if (toast) toast('已取消收藏');
      load();
    }
  };

  const handleClear = () => {
    clearHistory();
    if (toast) toast('观看记录已清空');
    load();
  };

  if (state.status === 'loading') return <Loading />;

  const isFavorites = mode === 'favorites';
  const title = isFavorites ? '我的收藏' : '观看记录';

  if (state.status === 'empty') {
    return (
      <PageState
        symbol="☆"
        title={isFavorites ? '还没有收藏' : '还没有观看记录'}
        message={
          isFavorites
            ? '在剧集详情页按「收藏」即可保存到这里。收藏保存在本机电视上。'
            : '播放过的剧集会自动出现在这里，方便继续观看。'
        }
        action={null}
      />
    );
  }

  return (
    <div className="scroll-area">
      <div className="page-heading">
        <div className="page-eyebrow">本机</div>
        <h1>
          {title}
          <span className="detail-fact" style={{ marginLeft: 14 }}>{state.items.length} 部</span>
        </h1>
        <p>数据保存在这台电视上（红果官方暂无账号同步）。</p>
      </div>
      <ShelfGrid
        shelves={[{ title: null, items: state.items }]}
        cols={cols}
        group="content"
        onSelect={onOpenSeries}
        onLongPress={isFavorites ? handleRemove : onLongPress}
        emptyText="暂无内容"
        footerId={isFavorites ? null : 'history-clear-0-0'}
        footer={
          !isFavorites ? (
            <ShelfFooterButton id="history-clear-0-0" onSelect={handleClear}>
              清空观看记录
            </ShelfFooterButton>
          ) : null
        }
      />
    </div>
  );
}
