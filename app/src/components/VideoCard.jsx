import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocus';
import { coverUrl, PLACEHOLDER } from '../utils/thumb';
import { splitTags } from '../utils/format';
import { getProgress, getAspect, onProgressChange, isFavorite } from '../utils/storage';

// A single series tile.
//
// Focus is handled entirely by the focus system (classList mutation, no React
// state), so this component renders only when its data changes — not on every
// arrow key. The only local state is the image load phase.
export default React.memo(function VideoCard({
  video,
  focusId,
  row,
  col,
  group,
  onSelect,
  onLongPress,
  onNavigate,
  rank = 0
}) {
  const [imageState, setImageState] = useState('idle');
  const [faved, setFaved] = useState(false);
  const [progress, setProgressState] = useState(null);
  // 'portrait' | 'landscape' | null. Only known for series that have been
  // played at least once — see the note in utils/storage.js.
  const [aspect, setAspectState] = useState(null);
  const cardRef = useRef(null);

  const loadProgress = useCallback(() => {
    if (!video || !video.id) {
      setProgressState(null);
      setAspectState(null);
      return;
    }
    setProgressState(getProgress(video.id));
    setFaved(isFavorite(video.id));
    setAspectState(getAspect(video.id));
  }, [video && video.id]);

  useEffect(() => {
    loadProgress();
    // Refresh when the player exits so the resume bar is current.
    const off = onProgressChange(loadProgress);
    return off;
  }, [loadProgress]);

  const handleSelect = useCallback(() => {
    if (onSelect) onSelect(video);
  }, [onSelect, video]);

  const handleLongPress = useCallback(() => {
    if (onLongPress) {
      onLongPress(video);
      return;
    }
    // Default long-press behaviour: open the context menu.
    window.dispatchEvent(new CustomEvent('card-menu', { detail: video }));
  }, [onLongPress, video]);

  const { props, isFocused } = useFocusable({
    id: focusId,
    row,
    col,
    group,
    onSelect: handleSelect,
    onLongPress: handleLongPress,
    onNavigate
  });

  const src = coverUrl(video && video.cover);

  // Only apply the resume bar when there is meaningful progress (past 5s and
  // not essentially finished).
  const ratio =
    progress && progress.duration > 0
      ? Math.max(0, Math.min(1, progress.position / progress.duration))
      : 0;
  const showProgress = ratio > 0.01 && ratio < 0.98;

  // Bottom-left corner tag: which orientation the footage was shot in.
  // Bottom-right is already taken by the episode-count badge, so they never
  // collide; the label uses an arrow glyph (portrait = taller than wide) plus a
  // single character, which stays legible at TV viewing distance.
  const aspectTag = aspect ? (aspect.aspect === 'portrait' ? '竖' : '横屏') : '';

  return (
    <div
      ref={cardRef}
      className={`video-card focusable${isFocused ? ' focused' : ''}`}
      {...props}
    >
      <div className="video-card-thumb">
        {src ? (
          <img
            src={imageState === 'failed' ? PLACEHOLDER : src}
            alt=""
            loading="lazy"
            className={imageState === 'ready' ? 'image-ready' : ''}
            onLoad={() => setImageState('ready')}
            onError={() => setImageState('failed')}
          />
        ) : null}
        {rank > 0 ? <span className="video-card-rank">{rank}</span> : null}
        {video && video.badge ? <span className="video-card-badge">{video.badge}</span> : null}
        {faved ? <span className="video-card-fav">♥</span> : null}
        {aspectTag ? (
          <span
            className={`video-card-aspect ${aspect.aspect}${showProgress ? ' has-progress' : ''}`}
            title={aspect.aspect === 'portrait' ? '竖屏拍摄' : '横屏拍摄'}
          >
            {/* The orientation mark is drawn in CSS, not typed as a glyph.
                Box-drawing/geometric codepoints (▯ ▭ ▮) render as tofu on this
                Chromium build's font set — visible on the TV as an empty box,
                which is worse than no icon. A plain bordered span is exact on
                every build: tall+narrow when portrait, wide+short when
                landscape. */}
            <i className="video-card-aspect-mark" aria-hidden="true" />
            {aspectTag}
          </span>
        ) : null}
        {showProgress ? (
          <div className="video-card-progress">
            <i style={{ width: `${ratio * 100}%` }} />
          </div>
        ) : null}
      </div>
      <div className="video-card-info">
        <div className="video-card-title">{video ? video.title : ''}</div>
        <div className="video-card-meta">{metaLine(video)}</div>
      </div>
    </div>
  );
});

// Prefer tags, then the episode count badge, then a description snippet — so
// the line is never empty for cards whose metadata differs by source.
function metaLine(video) {
  if (!video) return '';
  const tags = splitTags(video.tags);
  if (tags.length) return tags.slice(0, 3).join(' · ');
  if (video.badge) return video.badge;
  if (video.description) return video.description.slice(0, 20);
  return '';
}
