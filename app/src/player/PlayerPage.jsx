import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable, setCustomKeyHandler } from '../hooks/useFocus';
import { mediaUrl, getMediaPort, probeService } from '../api/client';
import { setProgress, notifyProgressChange, addHistory, getSettings, setAspect } from '../utils/storage';
import { formatDuration } from '../utils/format';
import { beginHeavyWork, endHeavyWork } from '../utils/perfFlags';

// The player.
//
// Playback is deliberately simple: the red-berry pipeline yields a single
// progressive MP4 stream, so the TV's native <video> can play it directly.
// There is no DASH/HLS manifest and therefore no player library — the
// reference (Bilibili) project needed Shaka for DASH, but that does not apply
// here, and skipping it removes ~770KB from the bundle.
//
// The <video> src points at the service's loopback media proxy, which performs
// the SPADE/CENC decryption and speaks HTTP Range. Seeking comes for free
// because the proxy honours Range requests.
//
// Shelf state that must survive an episode change.
//
// `App` gives this component `key={episode.id}`, so switching episodes (or
// reaching the end and auto-advancing) UNMOUNTS and REMOUNTS it — deliberately,
// because reusing one <video> across a new source is what produced
// "切换其他集播放失败". The cost of that remount is that every piece of React
// state resets, including the shelf's visibility and its 5s auto-hide fuse.
//
// Measured on device: pressing Down to open the shelf, then letting the episode
// finish, reset `shelfTick` to 0 and re-armed the fuse from scratch — so the
// shelf could sit on screen indefinitely if episodes kept rolling over. The
// module-level store below carries the shelf across the remount so the fuse
// keeps its deadline and the ring is not yanked away mid-interaction.
let shelfMemory = { showControls: true, shelfIndex: -1, shelfTick: 0 };
function resetShelfMemory() {
  shelfMemory = { showControls: true, shelfIndex: -1, shelfTick: 0 };
}

export default function PlayerPage({ series, episode, startAt = 0, onBack, onEpisodeChange, toast }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | playing | paused | error
  const [error, setError] = useState('');
  const [position, setPosition] = useState(startAt);
  const [duration, setDuration] = useState(0);
  // Seeded from the module store so a remount (episode change) resumes the
  // shelf exactly where it was instead of resetting the auto-hide countdown.
  const [showControls, _setShowControls] = useState(shelfMemory.showControls);
  // Which shelf button is highlighted, as an index into the VISIBLE buttons
  // (-1 = the shelf is open but nothing is selected, i.e. play is still the
  // focus of the screen). Held as state so React owns the highlight.
  const [shelfIndex, _setShelfIndex] = useState(shelfMemory.shelfIndex);
  // Bumped on every key; makes the auto-hide effect restart its countdown.
  const [shelfTick, _setShelfTick] = useState(shelfMemory.shelfTick);

  // Mirror every shelf write into the module store so the next mount inherits it.
  const setShowControls = useCallback((v) => {
    _setShowControls((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      shelfMemory.showControls = next;
      return next;
    });
  }, []);
  const setShelfIndex = useCallback((v) => {
    _setShelfIndex((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      shelfMemory.shelfIndex = next;
      return next;
    });
  }, []);
  const setShelfTick = useCallback((v) => {
    _setShelfTick((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      shelfMemory.shelfTick = next;
      return next;
    });
  }, []);

  const currentEpisodeRef = useRef(episode);
  const seriesRef = useRef(series);
  const saveTimer = useRef(0);
  const lastSavedSecond = useRef(-1);
  // Counts transient media-error retries for the CURRENT episode, so a flaky
  // stretch cannot loop forever. Reset whenever the source changes.
  const retriesRef = useRef(0);
  // Separate budget for "ended fired but we had not reached the real end" —
  // picking the stream back up at the same position.
  const resumeAttemptsRef = useRef(0);
  // The position seen at the last timeupdate. Used to catch a SILENT jump:
  // measured on device, playback can leap from ~9s straight to the end with no
  // `seeking` event (the media pipeline does it internally, not our code), which
  // fires `ended` and auto-advances — the reported "只播放开头几秒然后跳到结尾".
  const lastCtRef = useRef(0);
  // How many times we have recovered from such a jump; caps the retry loop.
  const jumpRecoveryRef = useRef(0);
  // Autoplay-next is no longer instant: the episode finishes, then a short
  // countdown runs so the viewer can cancel instead of being teleported into
  // the next title ("每集播放完毕后停留3S再自动播放下一集").
  const AUTO_ADVANCE_SECONDS = 3;
  const [nextUp, setNextUp] = useState(null);   // { episode, remaining }
  const countdownRef = useRef(0);
  // Kept in a ref so the countdown's interval callback always calls the CURRENT
  // handler, and so `startNextCountdown` stays a stable identity.
  const onEpisodeChangeRef = useRef(onEpisodeChange);
  onEpisodeChangeRef.current = onEpisodeChange;

  // ---- auto-advance hand-off ---------------------------------------------
  //
  // Cancel a pending auto-advance. Every key and leaving the player call this:
  // if the viewer touches the remote, the next episode is their decision.
  const cancelNextCountdown = useCallback((revealShelf) => {
    clearInterval(countdownRef.current);
    countdownRef.current = 0;
    setNextUp((cur) => {
      if (cur && revealShelf) setShowControls(true);
      return null;
    });
  }, [setShowControls]);

  // Start the 3s hand-off to the next episode.
  const startNextCountdown = useCallback((target) => {
    clearInterval(countdownRef.current);
    setNextUp({ episode: target, remaining: AUTO_ADVANCE_SECONDS });
    setShowControls(true);
    setShelfTick((t) => t + 1);
    countdownRef.current = setInterval(() => {
      setNextUp((cur) => {
        if (!cur) return null;
        if (cur.remaining <= 1) {
          clearInterval(countdownRef.current);
          countdownRef.current = 0;
          const to = cur.episode;
          // Defer the hand-over out of the state updater: switching episodes
          // remounts this component, and doing it mid-reducer would be a
          // setState-during-render on a tree that is about to be replaced.
          setTimeout(() => {
            if (onEpisodeChangeRef.current) onEpisodeChangeRef.current(to);
          }, 0);
          return null;
        }
        return { episode: cur.episode, remaining: cur.remaining - 1 };
      });
    }, 1000);
  }, [setShowControls, setShelfTick]);

  // A pending countdown must never outlive the player (Back, or an episode
  // switch), or a stale interval fires into an unmounted component.
  useEffect(() => () => clearInterval(countdownRef.current), []);

  // Make sure the media port is the one the service actually bound (it walks
  // upward if 7655 is taken), before handing a URL to the video element.
  useEffect(() => {
    probeService();
  }, []);

  // Hold off thumbnail prefetching for the duration of playback.
  useEffect(() => {
    beginHeavyWork();
    return endHeavyWork;
  }, []);

  // ---- persistence -------------------------------------------------------
  const persistProgress = useCallback(
    (pos, total, force) => {
      const s = seriesRef.current;
      const ep = currentEpisodeRef.current;
      if (!s || !ep) return;
      // Throttle: at most one write per second unless forced (pause/unmount).
      const second = Math.floor(pos);
      if (!force && second === lastSavedSecond.current) return;
      lastSavedSecond.current = second;
      setProgress(s.id, {
        episodeId: String(ep.id),
        episodeNumber: ep.number,
        position: pos,
        duration: total || 0
      });
    },
    []
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const onLoadedMetadata = () => {
      setDuration(video.duration || 0);
      setStatus('playing');
      // Intrinsic video dimensions are readable exactly here and nowhere
      // earlier. Persist portrait/landscape for this series so the browse grid
      // can tag the card; `notifyProgressChange` reuses the existing subscriber
      // channel so any mounted VideoCard picks the tag up without a reload.
      // Wrapped because a storage failure must never block playback startup.
      try {
        const s = seriesRef.current;
        if (s && s.id && setAspect(s.id, video.videoWidth, video.videoHeight)) {
          notifyProgressChange();
        }
      } catch (e) { /* aspect is a nicety; playback continues regardless */ }
      // Resume: only seek when we have a meaningful offset and it is inside
      // the media, otherwise start from 0.
      if (startAt > 1 && (!video.duration || startAt < video.duration - 3)) {
        try {
          video.currentTime = startAt;
          lastCtRef.current = startAt;   // a resume is a real seek, not a jump
        } catch (e) {
          // Some TV players reject a seek before enough data is buffered;
          // seeking again once data arrives is handled below.
          video.addEventListener(
            'canplay',
            () => {
              try {
                video.currentTime = startAt;
                lastCtRef.current = startAt;
              } catch (e2) { /* give up; playback continues from 0 */ }
            },
            { once: true }
          );
        }
      }
    };

    const onTimeUpdate = () => {
      const ct = video.currentTime || 0;
      const prev = lastCtRef.current;
      // Catch the silent forward jump. It has no `seeking` event (it is not a
      // seek we or the user issued), so the only signal is currentTime leaping
      // forward by more than a few seconds between two timeupdates. Restore the
      // position immediately so playback continues instead of reaching `ended`
      // and auto-advancing.
      if (prev > 0 && ct - prev > 5 && jumpRecoveryRef.current < 6) {
        jumpRecoveryRef.current += 1;
        const target = Math.max(0, prev + 0.5);
        try { video.currentTime = target; } catch (e) { /* keep going */ }
        lastCtRef.current = target;
        return;
      }
      lastCtRef.current = ct;
      setPosition(ct);
      // Throttled write; the storage layer bound is enforced there.
      if (Date.now() - saveTimer.current > 5000) {
        saveTimer.current = Date.now();
        persistProgress(ct, video.duration || 0, false);
      }
    };

    const onEnded = () => {
      const total = video.duration;
      const at = video.currentTime || 0;
      // Guard against a PREMATURE `ended` — and FAIL CLOSED.
      //
      // Episodes run ~80-90s, so stopping after a few seconds is not a real
      // ending: when the proxy briefly stalls, the element can reach the end of
      // the bytes it managed to buffer and fire `ended` as if the title were
      // over. The old guard was `!total || at >= total - 2`, and `!total` was
      // the hole: `video.duration || 0` turns NaN/undefined into 0, `!0` is
      // true, so ANY `ended` with an unknown duration was accepted as a genuine
      // finish and auto-advanced — exactly the reported "播放几秒钟后就自动跳到
      // 下一集". A missing duration is now proof that we do NOT know where the
      // end is, so it must never authorise a jump forward.
      const knownTotal = Number.isFinite(total) && total > 0;
      const reachedRealEnd = knownTotal && at >= total - 2;
      // Belt for the suspenders above: if `ended` arrives at the real end but
      // the last sampled position was nowhere near it, the timeline was
      // teleported and this is NOT a genuine finish. Do not advance.
      const lastSampled = lastCtRef.current;
      const wasSilentJump = reachedRealEnd && Number.isFinite(lastSampled) &&
        lastSampled > 0 && total - lastSampled > 5;
      if (typeof window !== 'undefined') {
        (window.__playerEndDiag = window.__playerEndDiag || []).push({
          t: Date.now() % 1000000, at: Math.round(at * 100) / 100,
          total: knownTotal ? Math.round(total * 100) / 100 : String(total),
          knownTotal, reachedRealEnd, lastSampled: Math.round(lastSampled * 100) / 100,
          wasSilentJump
        });
      }
      if (wasSilentJump) {
        if (jumpRecoveryRef.current < 6) {
          jumpRecoveryRef.current += 1;
          setStatus('loading');
          setTimeout(() => {
            const v = videoRef.current;
            if (!v) return;
            try {
              v.currentTime = Math.max(0, lastSampled - 1);
              lastCtRef.current = Math.max(0, lastSampled - 1);
              v.play().catch(() => {});
            } catch (e) { /* fall through to the error UI */ }
          }, 300);
          return;
        }
        try { video.pause(); } catch (e) { /* ignore */ }
        setStatus('error');
        setError('播放异常中断（时间轴跳变）。请重试，或选择其他剧集。');
        setShowControls(true);
        setShelfTick((t) => t + 1);
        return;
      }
      if (!reachedRealEnd) {
        // Recover rather than give up: a stalled buffer usually resumes if we
        // pick the stream back up at the same position. The cap is generous —
        // a few transient premature `ended` events (a brief upstream stall
        // under preload) are each recovered silently, and only a genuinely
        // broken stream reaches the error UI.
        if (knownTotal && resumeAttemptsRef.current < 4) {
          resumeAttemptsRef.current += 1;
          setStatus('loading');
          setTimeout(() => {
            const v = videoRef.current;
            if (!v) return;
            try {
              v.currentTime = Math.max(0, at - 1);
              lastCtRef.current = Math.max(0, at - 1);
              v.play().catch(() => {});
            } catch (e) { /* fall through to the error UI */ }
          }, 400);
          return;
        }
        try { video.pause(); } catch (e) { /* ignore */ }
        setStatus('error');
        setError('播放中断（网络或内容源暂时不可用）。请重试，或选择其他剧集。');
        setShowControls(true);
        setShelfTick((t) => t + 1);
        return;
      }
      persistProgress(total, total, true);
      notifyProgressChange();
      // The element stopped: the button must offer 播放, not 暂停.
      setStatus('paused');
      if (getSettings().autoplayNext) {
        const next = nextEpisode(seriesRef.current, currentEpisodeRef.current);
        if (next) {
          // Do NOT teleport: hand the viewer a 3s window to bail out first.
          startNextCountdown(next);
          return;
        }
      }
      setShowControls(true);
      setShelfTick((t) => t + 1);
    };

    const onError = () => {
      const err = video.error;
      // A NETWORK_* error is usually the media proxy having a transient upstream
      // hiccup (the red-berry CDN throttles short Range reads intermittently).
      // Retrying a couple of times with a backoff recovers most of these
      // without bothering the viewer; MEDIA_* errors are decode problems and
      // retrying would just fail identically, so those go straight to the UI.
      const transient = err && (err.code === 2 || err.code === 3);
      if (transient && retriesRef.current < 3) {
        retriesRef.current += 1;
        setStatus('loading');
        setTimeout(() => {
          const v = videoRef.current;
          if (!v) return;
          try {
            v.load();
            v.play().catch(() => {});
          } catch (e) { /* fall through to the error UI on the next event */ }
        }, 600 * retriesRef.current);
        return;
      }
      setStatus('error');
      setError(describeMediaError(err));
      // Reveal the shelf so the failure is not a dead end: with the shelf
      // hidden the key handler ignores Enter, which fell through to the global
      // focus system and re-triggered whatever card sat behind the player.
      setShowControls(true);
      setShelfTick((t) => t + 1);
    };

    const onWaiting = () => setStatus((s) => (s === 'error' ? s : 'loading'));
    const onPlaying = () => setStatus('playing');
    const onPause = () => setStatus('paused');

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
    };
  }, [startAt, persistProgress, onEpisodeChange]);

  // Record the episode in history as soon as playback starts, and keep the
  // current episode ref in sync when the episode changes.
  useEffect(() => {
    currentEpisodeRef.current = episode;
    seriesRef.current = series;
    lastSavedSecond.current = -1;
    if (series && episode) {
      addHistory(
        {
          id: series.id,
          title: series.title,
          cover: series.cover,
          badge: series.episodeCount ? `全 ${series.episodeCount} 集` : '',
          tags: series.tags
        },
        episode
      );
    }
  }, [series, episode]);

  // Flush progress when leaving the player.
  useEffect(() => {
    return () => {
      // Leaving cancels any pending auto-advance: Back during the countdown
      // must mean "stop", not "go to the next episode anyway".
      clearInterval(countdownRef.current);
      countdownRef.current = 0;
      const video = videoRef.current;
      if (video && seriesRef.current && currentEpisodeRef.current) {
        persistProgress(video.currentTime || 0, video.duration || 0, true);
        notifyProgressChange();
      }
    };
  }, [persistProgress]);

  // Clear the cross-remount shelf memory only when playback REALLY ends.
  //
  // The component is remounted by App on every episode change (see the key on
  // <PlayerPage>), which is how the shelf carries over. But when the user
  // leaves the player for good, that stale state must not leak into the next
  // series they open. A page-level marker does the job: if the document no
  // longer contains the player when this cleanup runs, we are truly leaving.
  useEffect(() => {
    return () => {
      setTimeout(() => {
        if (!document.querySelector('.player-root')) resetShelfMemory();
      }, 120);
    };
  }, []);

  // Auto-hide the control shelf.
  //
  // The countdown runs from the LATER of "the shelf became visible" and "the
  // last input", which is why shelfTick is a dependency.
  //
  // The status gate that used to be here is gone on purpose. Gating the fuse on
  // `status === 'playing'` meant that whenever the element reported 'paused' or
  // was still 'loading' the shelf never hid at all. A visible shelf is now
  // ALWAYS on a 5s fuse — matching what the user asked for ("播放菜单如5秒无操作
  // 应该自动隐藏") and independent of the media element's mood.
  //
  // Anything that re-renders this component without a key press must not reset
  // the fuse; that is why the tick is a monotonic counter bumped only from the
  // key handler, the play/seek helpers and the media events — never from a
  // plain render.
  useEffect(() => {
    if (!showControls) return undefined;
    if (typeof window !== 'undefined') {
      (window.__playerShelfDiag = window.__playerShelfDiag || []).push({ t: Date.now() % 1000000, e: 'fuse-armed', tick: shelfTick });
    }
    const timer = setTimeout(() => {
      if (typeof window !== 'undefined') {
        (window.__playerShelfDiag = window.__playerShelfDiag || []).push({ t: Date.now() % 1000000, e: 'fuse-fired' });
      }
      setShowControls(false);
    }, 5000);
    return () => {
      if (typeof window !== 'undefined') {
        (window.__playerShelfDiag = window.__playerShelfDiag || []).push({ t: Date.now() % 1000000, e: 'fuse-cancelled', tick: shelfTick });
      }
      clearTimeout(timer);
    };
  }, [showControls, shelfTick]);

  // The player owns the D-pad while it is mounted.
  //
  // Without this the global focus system swallowed every key: the shelf buttons
  // are focus-group 'player' and the generic navigation looks for grid
  // neighbours that do not exist, so Down did nothing and the shelf was
  // unreachable by remote — the reported issue.
  //
  // The highlight is held in React state (`shelfIndex`) rather than toggled as a
  // DOM class. Mixing the two made the ring disappear: a direct class removal
  // was immediately undone by the next render, which re-applied `isFocused` from
  // the registry. One owner, one source of truth.
  useEffect(() => {
    // `setCustomKeyHandler` returns a token-scoped release. Calling it (rather
    // than passing null) is what keeps a stale player from uninstalling a
    // newer owner's handler, or vice versa — see the note in useFocus.js.
    const release = setCustomKeyHandler((e) => {
      const key = e.key;

      // Every key is activity: restart the auto-hide fuse.
      setShelfTick((t) => t + 1);

      // Any input during the auto-advance countdown cancels it — the viewer is
      // still there and has not asked for the next episode.
      if (countdownRef.current) {
        cancelNextCountdown(true);
        if (key === 'Enter' || key === 'ArrowUp' || key === 'ArrowDown' ||
            key === 'ArrowLeft' || key === 'ArrowRight') {
          e.preventDefault();
          return true;   // this keypress was the cancel; do not also act on it
        }
      }

      // The failure screen replaces the shelf, so the generic paths below
      // (all gated on `showControls`) cannot operate it: Enter would fall
      // through to the global focus system and re-select whatever card sits
      // BEHIND the player. Own Enter here and swallow the arrows, leaving
      // Back as the other way out.
      if (status === 'error') {
        if (key === 'Enter') {
          e.preventDefault();
          const el = document.querySelector('[data-focus-id="player-retry-0"]');
          if (el) el.click();
          return true;
        }
        if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
          e.preventDefault();
          return true;
        }
        return false;
      }

      if (key === 'ArrowDown') {
        e.preventDefault();
        // Land ON THE PAUSE BUTTON, not on the leftmost control.
        //
        // The shelf's first slot is 上一集 whenever a previous episode exists,
        // so Down used to drop the ring there — the viewer reached for pause
        // and got a jump backwards instead. Pause is what someone opening the
        // shelf mid-episode is almost always after.
        if (!showControls) {
          setShowControls(true);
          setShelfIndex(playButtonIndex());
        } else {
          // Already open: step into the shelf (or keep the current button).
          setShelfIndex((i) => (i < 0 ? playButtonIndex() : i));
        }
        return true;
      }

      if (key === 'ArrowUp') {
        e.preventDefault();
        if (showControls && shelfIndex >= 0) {
          // Leaving the shelf back to full-screen playback.
          setShelfIndex(-1);
        } else {
          setShowControls(false);
        }
        return true;
      }

      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        if (!showControls) return false; // let the shelf stay out of the way
        e.preventDefault();
        const delta = key === 'ArrowRight' ? 1 : -1;
        setShelfIndex((i) => {
          const count = shelfButtonIds().length;
          if (!count) return -1;
          const from = i < 0 ? 0 : i;
          return Math.max(0, Math.min(count - 1, from + delta));
        });
        return true;
      }

      if (key === 'Enter') {
        if (!showControls) return false;
        e.preventDefault();
        const ids = shelfButtonIds();
        const target = ids[shelfIndex >= 0 ? shelfIndex : 0];
        if (target) {
          const el = document.querySelector(`[data-focus-id="${target}"]`);
          if (el) el.click();
        }
        return true;
      }

      return false;
    });
    return () => release();
  }, [showControls, shelfIndex, cancelNextCountdown, status]);

  const src = episode ? mediaUrl(episode.id) : '';
  const episodeKey = episode ? String(episode.id) : '';

  // Switching episodes and switching D-pad focus share this <video> element.
  //
  // React updates the `src` attribute in place, and on this Chromium build that
  // does NOT reliably re-run the media load algorithm: the element keeps the old
  // resource's readyState while pointing at a new URL, so the browser fires
  // `error` (code 4) instead of reloading. That is the "同一季切换其他集显示播放
  // 失败" report. Calling load() explicitly restarts the pipeline.
  //
  // The reset has to happen BEFORE the browser is asked to fetch: drop the
  // stale error, put the UI back to "loading", and clear the throttling clock so
  // the new episode's first progress write is not suppressed by the old one's.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setStatus('loading');
    setError('');
    setPosition(startAt || 0);
    setDuration(0);
    lastSavedSecond.current = -1;
    retriesRef.current = 0;         // a new episode gets a fresh retry budget
    resumeAttemptsRef.current = 0;  // ...and a fresh premature-ended budget
    jumpRecoveryRef.current = 0;    // ...and a fresh jump-recovery budget
    lastCtRef.current = 0;          // ...and no stale position to compare against
    cancelNextCountdown(false);
    setShelfIndex(-1);
    try {
      video.load();
    } catch (e) { /* older builds tolerate the attribute change alone */ }
  }, [episodeKey, src, cancelNextCountdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    setShowControls(true);
    setShelfTick((t) => t + 1);
  }, []);

  // Retry the CURRENT episode in place.
  //
  // This button used to call `window.location.reload()`, which threw the whole
  // app away — back to the boot screen, every list refetched — to recover from
  // what is usually one stalled HTTP Range read. Reloading is also the one
  // action a TV remote should never do silently: it loses the viewer's place
  // in the season for no reason.
  const retryPlayback = useCallback(() => {
    const video = videoRef.current;
    setStatus('loading');
    setError('');
    retriesRef.current = 0;
    resumeAttemptsRef.current = 0;
    lastSavedSecond.current = -1;
    setShowControls(true);
    setShelfTick((t) => t + 1);
    if (!video) return;
    try {
      video.load();
      video.play().catch(() => {});
    } catch (e) { /* the error handler will re-surface if this fails */ }
  }, [setShowControls, setShelfTick]);

  const seekBy = useCallback((delta) => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, Math.min((video.duration || 0), (video.currentTime || 0) + delta));
    try {
      video.currentTime = target;
      lastCtRef.current = target;   // an intentional seek must not read as a jump
      setPosition(target);
    } catch (e) { /* ignore a rejected seek */ }
    setShowControls(true);
    setShelfTick((t) => t + 1);
  }, []);

  const showPrevNext = series && series.episodes && series.episodes.length > 1;
  const prev = showPrevNext ? prevEpisode(series, episode) : null;
  const next = showPrevNext ? nextEpisode(series, episode) : null;

  const goEpisode = (target) => {
    if (!target) return;
    if (onEpisodeChange) onEpisodeChange(target);
  };

  return (
    <div className="player-root">
      <video
        ref={videoRef}
        src={src}
        autoPlay
        playsInline
        preload="metadata"
        onClick={togglePlay}
      />

      {status === 'loading' ? (
        <div className="player-buffering">
          <span className="loading-spinner" style={{ width: 26, height: 26, marginRight: 14 }} />
          正在缓冲…
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="player-error">
          <h2>播放失败</h2>
          <p>{error}</p>
          <p className="player-error-hint">按确认键重试本集，或按返回键退出</p>
          <div style={{ marginTop: 20 }}>
            <PlayerButton id="player-retry-0" onSelect={retryPlayback}>
              重试播放
            </PlayerButton>
          </div>
        </div>
      ) : null}

      {/* The auto-advance hand-off. Shown for 3s at the end of an episode so
          the viewer can read what is coming and cancel it, instead of being
          teleported into the next title the instant playback stops. */}
      {nextUp ? (
        <div className="player-nextup">
          <div className="player-nextup-label">本集播放完毕</div>
          <div className="player-nextup-title">
            {AUTO_ADVANCE_SECONDS > 0 ? `${nextUp.remaining} 秒后播放下一集` : '即将播放下一集'}
            {nextUp.episode && nextUp.episode.number ? ` · 第 ${nextUp.episode.number} 集` : ''}
          </div>
          <div className="player-nextup-hint">按任意键取消</div>
        </div>
      ) : null}

      {showControls && status !== 'error' ? (
        <div className="player-overlay">
          <div className="player-title">{series ? series.title : ''}</div>
          <div className="player-subtitle">
            第 {episode ? episode.number : 1} 集
            {series && series.episodeCount ? ` · 共 ${series.episodeCount} 集` : ''}
          </div>

          <div className="player-progress-row">
            <div className="player-progress-bar">
              <div
                className="player-progress-fill"
                style={{ width: `${duration > 0 ? Math.min(100, (position / duration) * 100) : 0}%` }}
              />
            </div>
            <div className="player-time">
              {formatDuration(position)} / {formatDuration(duration)}
            </div>
          </div>

          {/* Highlight is positional: PlayerButton asks whether its own index
              equals shelfIndex. Adding or removing prev/next therefore cannot
              desynchronise the ring, which is what broke when ids were used. */}
          <div className="player-btns">
            {prev ? (
              <PlayerButton id="player-prev-0" index={0} shelfIndex={shelfIndex} onSelect={() => goEpisode(prev)}>
                ⏮ 上一集
              </PlayerButton>
            ) : null}
            <PlayerButton id="player-play-0" index={prev ? 1 : 0} shelfIndex={shelfIndex} onSelect={togglePlay}>
              {status === 'playing' ? '⏸ 暂停' : '▶ 播放'}
            </PlayerButton>
            <PlayerButton id="player-back10-0" index={(prev ? 1 : 0) + 1} shelfIndex={shelfIndex} onSelect={() => seekBy(-10)}>
              ⟨ 后退 10 秒
            </PlayerButton>
            <PlayerButton id="player-fwd10-0" index={(prev ? 1 : 0) + 2} shelfIndex={shelfIndex} onSelect={() => seekBy(10)}>
              前进 10 秒 ⟩
            </PlayerButton>
            {next ? (
              <PlayerButton id="player-next-0" index={(prev ? 1 : 0) + 3} shelfIndex={shelfIndex} onSelect={() => goEpisode(next)}>
                ⏭ 下一集
              </PlayerButton>
            ) : null}
            <PlayerButton id="player-back-0" index={(prev ? 1 : 0) + (next ? 4 : 3)} shelfIndex={shelfIndex} onSelect={onBack}>
              ← 返回
            </PlayerButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The shelf button ids in visual order, restricted to those actually rendered
// (prev/next are conditional). Derived from the DOM so it always matches what is
// on screen, and used by the key handler to clamp Left/Right.
function shelfButtonIds() {
  const order = ['player-prev-0', 'player-play-0', 'player-back10-0', 'player-fwd10-0', 'player-next-0', 'player-back-0'];
  return order.filter((id) => document.querySelector(`[data-focus-id="${id}"]`));
}

// Index of the play/pause button among the VISIBLE shelf buttons, read from the
// DOM so it stays correct whether or not 上一集/下一集 are rendered.
function playButtonIndex() {
  const i = shelfButtonIds().indexOf('player-play-0');
  return i < 0 ? 0 : i;
}

function PlayerButton({ id, index, shelfIndex, onSelect, children }) {
  const { props } = useFocusable({ id, onSelect, group: 'player' });
  // Highlight comes from the player's own vertical/horizontal state, NOT from
  // the generic focus system: the shelf is a single row with no grid neighbours,
  // so the player navigates it itself. See setCustomKeyHandler above.
  const focused = shelfIndex === index;
  return (
    <span className={`player-btn focusable${focused ? ' focused' : ''}`} {...props}>
      {children}
    </span>
  );
}

function episodeIndex(series, episode) {
  if (!series || !episode || !Array.isArray(series.episodes)) return -1;
  return series.episodes.findIndex((e) => String(e.id) === String(episode.id));
}

function nextEpisode(series, episode) {
  const i = episodeIndex(series, episode);
  if (i < 0) return null;
  return series.episodes[i + 1] || null;
}

function prevEpisode(series, episode) {
  const i = episodeIndex(series, episode);
  if (i <= 0) return null;
  return series.episodes[i - 1] || null;
}

// Map a MediaError to something a user can act on. The media proxy returning
// 502 is by far the most likely real-world failure, and it is worth saying so
// plainly rather than showing a bare code.
function describeMediaError(err) {
  if (!err) return '播放器报告未知错误。可能是该剧集受版权保护或暂不可播。';
  switch (err.code) {
    case 1:
      return '播放被中止。请重试，或选择其他剧集。';
    case 2:
      return '网络读取失败。请确认电视已联网，然后重试。';
    case 3:
      return '视频解码失败。该剧集的编码格式可能不被电视支持。';
    case 4:
      return '视频无法播放（源不可用或格式不支持）。内容源可能已限制该剧集。';
    default:
      return `播放器错误（代码 ${err.code}）。`;
  }
}
