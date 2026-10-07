// Small formatting helpers.

// 3725 -> "1:02:05", 125 -> "2:05"
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

// Red-berry episode counts arrive as numbers or numeric strings.
export function formatEpisodeCount(count) {
  const n = Number(count) || 0;
  return n > 0 ? `全 ${n} 集` : '';
}

// "玄幻 逆袭 修真" -> ["玄幻","逆袭","修真"]
export function splitTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.filter(Boolean).map(String);
  return String(tags)
    .split(/[\s,，、|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
