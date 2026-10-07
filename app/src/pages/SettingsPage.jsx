import React, { useCallback, useEffect, useState } from 'react';
import { useFocusable, setContentContext, resetContentMemory } from '../hooks/useFocus';
import { Loading } from '../components/Common';
import { getSettings, setSettings, nextCols, GRID_COLUMN_CHOICES } from '../utils/storage';
import { getDiagnostics, isDevMode, hasLunaService } from '../api/client';

// Settings and on-device diagnostics.
//
// The diagnostics block is deliberately included: a TV app has no dev console,
// so when something breaks the user needs a way to see it. This surfaces Node
// version, media proxy port, upstream load status and the last few service
// errors — everything needed to diagnose without a debugger.
export default function SettingsPage({ toast, refreshKey }) {
  const [settings, setLocal] = useState(() => getSettings());
  const [diag, setDiag] = useState(null);
  const [diagError, setDiagError] = useState('');

  useEffect(() => {
    // The second argument MATTERS: this page's controls are group 'settings',
    // not 'content'. Without it the entry-focus resolver only looked for
    // group 'content' cards, found none, and left the ring parked on the rail
    // after Right — "左边菜单栏选择设置，按右方向键进不去".
    setContentContext('settings', 'settings');
    resetContentMemory();
  }, []);

  const refreshDiag = useCallback(() => {
    setDiagError('');
    getDiagnostics()
      .then((res) => setDiag(res))
      .catch((e) => setDiagError(e.message || '无法获取诊断信息'));
  }, []);

  useEffect(() => {
    refreshDiag();
  }, [refreshDiag, refreshKey]);

  const update = (patch) => {
    const next = setSettings(patch);
    setLocal(next);
  };

  const applyUiScale = (scale) => {
    update({ uiScale: scale });
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    if (toast) toast(`字号已调整为 ${Math.round(scale * 100)}%`);
  };

  return (
    <div className="config-page">
      <div className="config-intro">
        <div className="page-eyebrow">设置</div>
        <h1>偏好与诊断</h1>
        <p>调整浏览体验，并查看服务运行状态。所有设置立即生效并保存在本机。</p>
      </div>

      <div className="config-options">
        <div className="config-section-title">浏览</div>

        {/* Rows are numbered DOWN the column, not across it.
            They used to be settings-0-0..settings-0-3 — one row, four columns —
            while the markup stacks them VERTICALLY. navigateGrid walks
            `${group}-${row+1}-${col}` for ArrowDown, so it looked for
            settings-1-0, found nothing, and the key was dead: the ring could
            never reach 刷新诊断信息 at all. Row-per-option is what the layout
            actually is, and it makes Up/Down work the way the screen reads. */}
        <OptionRow
          id="settings-0-0"
          row={0}
          label="每行卡片数"
          value={`${settings.gridCols} 列`}
          hint={GRID_COLUMN_CHOICES.join(' / ')}
          onSelect={() => {
            const next = nextCols(settings.gridCols);
            update({ gridCols: next });
            if (toast) toast(`每行 ${next} 张`);
          }}
        />

        <OptionRow
          id="settings-1-0"
          row={1}
          label="界面字号"
          value={`${Math.round(settings.uiScale * 100)}%`}
          onSelect={() => {
            const ladder = [1, 1.15, 1.3];
            const idx = ladder.findIndex((v) => Math.abs(v - settings.uiScale) < 0.01);
            applyUiScale(ladder[(idx + 1) % ladder.length]);
          }}
        />

        <div className="config-section-title" style={{ marginTop: 40 }}>
          播放
        </div>

        <OptionRow
          id="settings-2-0"
          row={2}
          label="自动播放下一集"
          value={settings.autoplayNext ? '开启' : '关闭'}
          onSelect={() => {
            update({ autoplayNext: !settings.autoplayNext });
            if (toast) toast(settings.autoplayNext ? '已关闭自动播放' : '已开启自动播放');
          }}
        />

        <div className="config-section-title" style={{ marginTop: 40 }}>
          运行状态
        </div>

        {diagError ? (
          <div className="settings-row" style={{ cursor: 'default' }}>
            <span>诊断信息</span>
            <span className="settings-row-value">{diagError}</span>
          </div>
        ) : null}

        {diag ? (
          <div className="diagnostic-report" style={{ color: 'var(--tv-secondary)', fontSize: 18, lineHeight: 1.9 }}>
            <div>服务：{diag.service}</div>
            <div>运行环境：{diag.node}</div>
            <div>媒体代理端口：{diag.mediaPort}</div>
            <div>
              上游签名层：
              {diag.upstream && diag.upstream.upstream === 'ok' ? '正常' : `异常 — ${(diag.upstream && diag.upstream.error) || '未知'}`}
            </div>
            <div>哈希实现：{diag.upstream && diag.upstream.crypto}</div>
            {diag.media ? (
              <div>
                媒体：已服务 {diag.media.served} 段 / {Math.round((diag.media.bytes || 0) / 1048576)} MB，错误 {diag.media.errors}
              </div>
            ) : null}
            {diag.recentErrors && diag.recentErrors.length ? (
              <div style={{ marginTop: 10, color: '#ff9a8a' }}>
                最近错误：
                {diag.recentErrors.slice(-3).map((e, i) => (
                  <div key={i}>
                    · [{e.tag}] {String(e.detail).slice(0, 120)}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ marginTop: 10 }}>最近没有错误。</div>
            )}
          </div>
        ) : null}

        <div style={{ marginTop: 24 }}>
          <ActionButton id="settings-3-0" row={3} onSelect={refreshDiag}>
            刷新诊断信息
          </ActionButton>
        </div>

        <div className="config-section-title" style={{ marginTop: 40 }}>
          关于
        </div>
        <div style={{ color: 'var(--tv-secondary)', fontSize: 18, lineHeight: 1.9 }}>
          <div>红果短剧 webOS 客户端 v1.0.0</div>
          <div>
            运行模式：{hasLunaService() ? '电视（Luna 服务已连接）' : isDevMode() ? '浏览器（开发模式）' : '未知'}
          </div>
          <div style={{ marginTop: 8, color: 'var(--tv-muted)' }}>
            内容来自红果短剧公开接口，本应用仅作播放客户端，不存储任何影视内容。
          </div>
        </div>
      </div>
    </div>
  );
}

function OptionRow({ id, row, label, value, hint, onSelect }) {
  const { props, isFocused } = useFocusable({ id, row, col: 0, onSelect, group: 'settings' });
  return (
    <div
      className={`settings-row focusable${isFocused ? ' focused' : ''}`}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      {...props}
    >
      <span>
        {label}
        {hint ? <span className="settings-row-hint">{hint}</span> : null}
      </span>
      <span className="settings-row-value">{value}</span>
    </div>
  );
}

function ActionButton({ id, row, onSelect, children }) {
  const { props, isFocused } = useFocusable({ id, row, col: 0, onSelect, group: 'settings' });
  return (
    <span className={`tv-action focusable${isFocused ? ' focused' : ''}`} {...props}>
      {children}
    </span>
  );
}
