import { formatDuration } from '../utils/format';

// Small helper components shared across pages.

export function Spinner() {
  return <div className="loading-spinner" />;
}

export function Loading({ label = '加载中…' }) {
  return (
    <div className="page-state">
      <Spinner />
      <p style={{ marginTop: 20 }}>{label}</p>
    </div>
  );
}

export function PageState({ symbol = '!', title, message, action = null }) {
  return (
    <div className="page-state">
      {symbol ? <div className="page-state-symbol">{symbol}</div> : null}
      <h2>{title}</h2>
      {message ? <p>{message}</p> : null}
      {action}
    </div>
  );
}

// Progress bar used on resume cards and the player timeline.
export function ProgressBar({ ratio }) {
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  return (
    <div className="video-card-progress">
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function formatTime(seconds) {
  return formatDuration(seconds);
}
