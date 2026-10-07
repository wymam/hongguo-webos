// Local persistence.
//
// The red-berry API has NO account/cloud-sync surface (the upstream project
// documents this as unimplemented), so favorites, watch history and playback
// progress live entirely on the TV. That makes this module the only place
// user state survives an app restart.
//
// Everything is namespaced under `hongguo_` so it cannot collide with other
// apps sharing the same origin (file:// in a packaged .ipk).

const PREFIX = 'hongguo_';

function key(name) {
  return PREFIX + name;
}

export function get(name, fallback = null) {
  try {
    const raw = localStorage.getItem(key(name));
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function set(name, value) {
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
    return true;
  } catch (e) {
    // Quota exhaustion must not break navigation; the UI keeps working with
    // in-memory state for the rest of the session.
    return false;
  }
}

export function remove(name) {
  try {
    localStorage.removeItem(key(name));
  } catch (e) { /* nothing to do */ }
}

// ---------- settings ----------

const DEFAULT_SETTINGS = {
  // Number of columns in browse grids.
  //
  // Red-berry covers are portrait 2:3, so columns drive card HEIGHT directly.
  // Measured on the built bundle at 1920x1080 (940px viewport under the hero):
  //   2 -> 1285px card   3 -> 878px   4 -> 665px   5 -> 530px
  // Five keeps a full row plus a comfortable peek of the next on screen, which
  // is what makes D-pad browsing feel continuous rather than one-row-at-a-time.
  gridCols: 5,
  // Autoplay the next episode when one ends.
  autoplayNext: true,
  // UI font scale multiplier (read by CSS var --ui-scale).
  uiScale: 1
};

export function getSettings() {
  const saved = get('settings', {}) || {};
  return Object.assign({}, DEFAULT_SETTINGS, saved);
}

export function setSettings(patch) {
  const next = Object.assign({}, getSettings(), patch);
  set('settings', next);
  return next;
}

export function getUiScale() {
  const scale = Number(getSettings().uiScale);
  return scale > 0 ? scale : 1;
}

// Column counts the UI offers, and the clamp every grid must apply.
//
// Because red-berry posters are portrait, a column count is really a HEIGHT
// choice (see DEFAULT_SETTINGS). Both ends are bounded so a hand-edited or
// stale localStorage value cannot produce a grid that is unusable on a TV.
export const GRID_COLUMN_CHOICES = [3, 4, 5, 6];
const MIN_COLS = 2;
const MAX_COLS = 6;

export function clampCols(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.gridCols;
  return Math.min(MAX_COLS, Math.max(MIN_COLS, n));
}

// The next value in the ladder, wrapping around — used by the settings row.
export function nextCols(value) {
  const current = clampCols(value);
  const idx = GRID_COLUMN_CHOICES.indexOf(current);
  if (idx < 0) {
    const higher = GRID_COLUMN_CHOICES.find((c) => c > current);
    return higher || GRID_COLUMN_CHOICES[0];
  }
  return GRID_COLUMN_CHOICES[(idx + 1) % GRID_COLUMN_CHOICES.length];
}

// ---------- favorites ----------

const FAVORITE_LIMIT = 300;

export function getFavorites() {
  const list = get('favorites', []);
  return Array.isArray(list) ? list : [];
}

export function isFavorite(id) {
  return getFavorites().some((f) => String(f.id) === String(id));
}

// Toggling returns the new state so callers can show accurate feedback.
export function toggleFavorite(card) {
  const list = getFavorites();
  const idx = list.findIndex((f) => String(f.id) === String(card.id));
  if (idx >= 0) {
    list.splice(idx, 1);
    set('favorites', list);
    return false;
  }
  list.unshift({
    id: String(card.id),
    title: card.title || '',
    cover: card.cover || '',
    badge: card.badge || '',
    tags: card.tags || '',
    at: Date.now()
  });
  // Keep the shelf bounded; drop the oldest entries.
  while (list.length > FAVORITE_LIMIT) list.pop();
  set('favorites', list);
  return true;
}

// ---------- watch history ----------

const HISTORY_LIMIT = 100;

export function getHistory() {
  const list = get('history', []);
  return Array.isArray(list) ? list : [];
}

export function addHistory(card, episode) {
  if (!card || !card.id) return;
  const list = getHistory().filter((h) => String(h.id) !== String(card.id));
  list.unshift({
    id: String(card.id),
    title: card.title || '',
    cover: card.cover || '',
    badge: card.badge || '',
    tags: card.tags || '',
    // Carried so the watch-history grid can badge portrait/landscape too. This
    // list is rebuilt from live playback, so it never had the list payload's
    // vid_list — without this the 观看记录 page was the one grid where no card
    // could ever be tagged.
    firstEpisode: String((card.firstEpisode || (episode && episode.id) || '')),
    episodeId: episode ? String(episode.id) : '',
    episodeNumber: episode ? episode.number : 0,
    at: Date.now()
  });
  while (list.length > HISTORY_LIMIT) list.pop();
  set('history', list);
}

export function clearHistory() {
  remove('history');
}

// ---------- playback progress ----------

// { [seriesId]: { episodeId, episodeNumber, position, duration, at } }
const PROGRESS_LIMIT = 300;

export function getProgressMap() {
  const map = get('progress', {});
  return map && typeof map === 'object' ? map : {};
}

export function getProgress(seriesId) {
  if (!seriesId) return null;
  const entry = getProgressMap()[String(seriesId)];
  return entry && entry.position > 0 ? entry : null;
}

export function setProgress(seriesId, data) {
  if (!seriesId) return;
  const map = getProgressMap();
  map[String(seriesId)] = Object.assign(
    { at: Date.now() },
    map[String(seriesId)] || {},
    data
  );

  // Bound the map by recency so it cannot grow without limit.
  const entries = Object.entries(map);
  if (entries.length > PROGRESS_LIMIT) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const trimmed = {};
    for (const [k, v] of entries.slice(0, PROGRESS_LIMIT)) trimmed[k] = v;
    set('progress', trimmed);
    return;
  }
  set('progress', map);
}

export function clearProgress(seriesId) {
  const map = getProgressMap();
  delete map[String(seriesId)];
  set('progress', map);
}

// ---------- video aspect (portrait / landscape) ----------

// { [seriesId]: { aspect: 'portrait'|'landscape', w, h, at } }
//
// WHY THIS LIVES ON THE CLIENT
//
// Neither the list endpoint nor `detail` exposes intrinsic video dimensions —
// the API only ever hands us a poster image, and every red-berry poster is
// portrait 2:3 regardless of the actual footage (see DEFAULT_SETTINGS above and
// the 300x420 placeholder in utils/thumb.js). So the ONLY trustworthy source of
// "is this show shot vertical or horizontal" is the <video> element itself,
// after `loadedmetadata` reports videoWidth/videoHeight.
//
// That means the tag is earned, not known up front: a series shows 竖/横 only
// once at least one of its episodes has actually been played. Until then the
// card simply carries no tag — honest, and it fills itself in as the user
// browses. That is a deliberate trade-off over guessing from the poster, which
// would be wrong for every landscape title.
const ASPECT_LIMIT = 300;

// Anything at or below this is treated as noise (some decoders briefly report
// 0x0 or a 1px frame during the load handshake) and refused, so a bad reading
// cannot overwrite a good one.
const MIN_DIMENSION = 16;

export function getAspectMap() {
  const map = get('aspect', {});
  return map && typeof map === 'object' ? map : {};
}

export function getAspect(seriesId) {
  if (!seriesId) return null;
  const entry = getAspectMap()[String(seriesId)];
  if (!entry || !entry.aspect) return null;
  return entry;
}

// `w`/`h` are the element's INTRINSIC videoWidth/videoHeight. Equal width and
// height counts as landscape (square footage on a 16:9 TV letterboxes like
// landscape, so tagging it 竖 would be misleading). Returns the stored entry,
// or null when the reading was rejected.
export function setAspect(seriesId, w, h) {
  if (!seriesId) return null;
  const width = Math.round(Number(w) || 0);
  const height = Math.round(Number(h) || 0);
  if (width < MIN_DIMENSION || height < MIN_DIMENSION) return null;

  const aspect = width >= height ? 'landscape' : 'portrait';
  const map = getAspectMap();
  const prev = map[String(seriesId)];
  // Skip the write (and the subscriber storm) when nothing actually changed.
  if (prev && prev.aspect === aspect && prev.w === width && prev.h === height) {
    return prev;
  }
  const entry = { aspect, w: width, h: height, at: Date.now() };
  map[String(seriesId)] = entry;

  // Bound the map by recency, same policy as progress.
  const entries = Object.entries(map);
  if (entries.length > ASPECT_LIMIT) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const trimmed = {};
    for (const [k, v] of entries.slice(0, ASPECT_LIMIT)) trimmed[k] = v;
    set('aspect', trimmed);
    return entry;
  }
  set('aspect', map);
  return entry;
}

// Subscribers let list views refresh a resume bar without a full re-render.
const progressSubs = new Set();

export function onProgressChange(fn) {
  progressSubs.add(fn);
  return () => progressSubs.delete(fn);
}

export function notifyProgressChange() {
  progressSubs.forEach((fn) => {
    try {
      fn();
    } catch (e) { /* a bad subscriber must not break the others */ }
  });
}

// ---------- test hooks ----------
if (typeof window !== 'undefined') {
  window.__hongguoStorage = {
    get, set, remove,
    getSettings, setSettings,
    getFavorites, toggleFavorite,
    getHistory, addHistory, clearHistory,
    getProgressMap, getProgress, setProgress, clearProgress,
    getAspectMap, getAspect, setAspect
  };
}
