// Thumbnail URL normalisation.
//
// Red-berry cover URLs come from byte-dance CDNs and are already sized
// (p3-novel.byteimg.com/...). They are plain HTTPS, and unlike the reference
// project there is no separate image-proxy requirement, so this stays a small
// helper: trim, and fall back to a placeholder when nothing usable is present.

export const PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420">' +
    '<rect width="300" height="420" fill="#26272d"/>' +
    '<text x="150" y="215" fill="#5b5e69" font-size="22" text-anchor="middle" ' +
    'font-family="sans-serif">暂无封面</text></svg>'
  );

export function coverUrl(value) {
  if (!value || typeof value !== 'string') return PLACEHOLDER;
  const trimmed = value.trim();
  if (!trimmed) return PLACEHOLDER;
  // The CDN occasionally hands back a protocol-relative URL.
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  // An absolute http:// URL is blocked as mixed content inside the packaged
  // app (which the TV loads over https/file), silently yielding a blank tile.
  // The byte-dance image CDNs all serve the same asset over https, so promote
  // rather than render nothing.
  if (/^http:\/\//i.test(trimmed)) return `https://${trimmed.slice(7)}`;
  return trimmed;
}
