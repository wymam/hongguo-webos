// Fill in the portrait/landscape badge for a whole grid, up front.
//
// WHY THIS EXISTS
//
// The tag used to appear only for series that had been PLAYED, because the only
// reliable reading came from <video>.videoWidth during playback. The result was
// the inconsistency the owner reported: some cards badged, most not, with no
// pattern a viewer could understand.
//
// The service can now read the real frame size straight out of the MP4's `tkhd`
// box (see service/mp4box.js), which needs nothing but an episode id — and the
// list rows already carry one as `vid_list[0]`. So a grid can ask for all of its
// cards at once.
//
// COST DISCIPLINE — every rule below exists because the naive version would
// hammer the upstream CDN from a TV:
//   * only series with no stored reading are probed,
//   * at most one batch is in flight at a time (a fast scroller must not stack
//     requests),
//   * a series is asked at most twice — a failed read gets one retry, because
//     roughly 1 in 4 probes comes back empty and an unretried failure would
//     leave that card permanently unbadged,
//   * playback pauses probing entirely — a badge is never worth a stall.
//
// Failure is silent by design: an unreadable episode simply keeps no tag.

import { getAspects } from '../api/client';
import { getAspect, setAspect, getAspectMap, notifyProgressChange } from './storage';

// How many times a series has been asked for. A series is retried ONCE after a
// failure: measured on the TV, roughly 1 in 4 probes comes back empty (upstream
// resolve or an unreadable tkhd), and an unretried failure means a card stays
// permanently unbadged — which is the inconsistency this file exists to remove.
// Anything that still fails twice keeps no tag, silently.
const attempts = new Map();
// 3, not 2: on a cold page roughly 1 in 12 episodes still fails the first time
// (upstream resolve or an unreadable tkhd). Each retry is cheap once the
// episode id is known, and a card that gives up stays unbadged forever, which
// is precisely the "some cards have it, some don't" complaint.
const MAX_ATTEMPTS = 3;
let inFlight = null;
let lastReport = { asked: 0, resolved: 0, at: 0 };
// The grid currently on screen. probeAspects refreshes it on every render; the
// chained batches read it so navigation redirects the remaining work.
let latestItems = [];
// Cumulative, across the chained batches of one page.
const totals = { batches: 0, asked: 0, resolved: 0, changed: 0 };
// How many episodes go out in one request. Kept small so a single burst cannot
// turn into 72 upstream resolves; the chain is what makes the page complete.
const BATCH_SIZE = 32;

function playerIsOpen() {
  return typeof document !== 'undefined' && !!document.querySelector('.player-root');
}

// Which of `items` still need a probe.
function pendingOf(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    if (!it || !it.id) continue;
    const seriesId = String(it.id);
    if (seen.has(seriesId)) continue;
    seen.add(seriesId);
    if (getAspect(seriesId)) continue;      // already known
    if ((attempts.get(seriesId) || 0) >= MAX_ATTEMPTS) continue;
    // An empty `firstEpisode` is NOT a skip. The home feed ships `vid_list` as
    // an empty array, so every home card arrives here with no episode id —
    // bailing out is exactly what left the whole home grid unbadged. The
    // service resolves the episode id from the series id instead.
    out.push({ seriesId, episodeId: String(it.firstEpisode || '') });
  }
  return out;
}

// Kick off a probe for a grid's items. Safe to call on every render: it is a
// no-op unless there is genuinely unknown work to do.
//
// ONE PAGE IS PROBED IN FULL, NOT ONE BATCH.
//
// The first version asked for the first 24 unknown cards and stopped, which on
// a 72-card category page tagged exactly a third of them — "some cards badged,
// most not", the exact inconsistency this was written to remove. So instead of
// one batch per page, batches are CHAINED: when one finishes, the next unknown
// slice goes out, until the page has nothing left to ask for. Badges then fill
// in over the first few seconds after a page opens, which is what "载入的时候就
// 要探测到" actually looks like on screen.
export function probeAspects(items) {
  latestItems = items || [];
  if (inFlight) return inFlight;      // one batch at a time
  return runBatch();
}

function runBatch() {
  if (playerIsOpen()) return null;    // never compete with playback
  const pending = pendingOf(latestItems);
  if (!pending.length) return null;

  // Bound the burst: a 72-card grid must not turn into 72 upstream resolves in
  // one go. The NEXT batch picks up whatever is left.
  const batch = pending.slice(0, BATCH_SIZE);
  for (const p of batch) attempts.set(p.seriesId, (attempts.get(p.seriesId) || 0) + 1);

  totals.batches += 1;
  totals.asked += batch.length;
  lastReport = { asked: batch.length, resolved: 0, at: Date.now(), batch: totals.batches };

  inFlight = getAspects(batch)
    .then((res) => {
      const list = (res && res.items) || [];
      let changed = 0;
      for (const r of list) {
        if (!r || !r.seriesId) continue;
        if (!r.width || !r.height) continue;
        // setAspect returns null when the reading is rejected (too small) and
        // the previous entry when nothing changed — only a real write counts.
        const entry = setAspect(r.seriesId, r.width, r.height);
        if (entry) changed += 1;
      }
      totals.resolved += list.length;
      totals.changed += changed;
      lastReport.resolved = list.length;
      lastReport.changed = changed;
      lastReport.failed = (res && res.failed) || 0;
      lastReport.reasons = (res && res.errors) || [];
      lastReport.error = (res && res.error) || '';
      // `onProgressChange` is the channel every mounted VideoCard already
      // subscribes to, so the badges fill in without new plumbing.
      if (changed) notifyProgressChange();
      return list.length;
    })
    .catch(() => 0)
    .then(() => {
      inFlight = null;
      // Chain: cover the rest of the page. `latestItems` is re-read rather
      // than closed over, so if the viewer moved to another page meanwhile the
      // remaining effort follows them instead of finishing a page nobody is
      // looking at.
      if (!playerIsOpen() && pendingOf(latestItems).length) runBatch();
      return null;
    });

  return inFlight;
}

// Diagnostics: how many cards currently carry a tag, and what the last probe
// did. Reachable from CDP as window.__hongguoAspectReport().
export function aspectReport(items) {
  const map = getAspectMap();
  const ids = (items || []).map((i) => String(i && i.id)).filter(Boolean);
  return {
    stored: Object.keys(map).length,
    lastProbe: lastReport,
    totals: totals,
    pending: pendingOf(latestItems).length,
    sampled: ids.length,
    tagged: ids.filter((id) => !!map[id]).length
  };
}

// Resume after playback. Probing is suspended while the player is open (a badge
// is never worth a stall), but that can leave a page half-done the viewer is
// still looking at — so watch for the player going away and pick the chain back
// up. The observer only reacts to the OPEN -> CLOSED flip; every other DOM
// mutation (focus class changes, image loads ...) is ignored, so this costs one
// boolean compare on a busy page.
if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  let wasPlaying = false;
  new MutationObserver(function () {
    const now = playerIsOpen();
    if (wasPlaying && !now && !inFlight && pendingOf(latestItems).length) runBatch();
    wasPlaying = now;
  }).observe(document.body, { childList: true, subtree: true });
}
