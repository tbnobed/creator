const KNOWN = ["mp4", "mov", "webm", "m4v"];
const MIME_EXT: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

function extOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const clean = path.split(/[?#]/)[0];
  const match = /\.([a-z0-9]+)$/i.exec(clean);
  const ext = match?.[1].toLowerCase();
  return ext && KNOWN.includes(ext) ? ext : null;
}

/** Derive a video download extension from storage key, then URL, then content type; defaults to mp4. */
export function videoExtension(item: { outputStorageKey?: string | null; mediaUrl?: string | null }, contentType?: string | null): string {
  return extOf(item.outputStorageKey) ?? extOf(item.mediaUrl) ?? (contentType ? MIME_EXT[contentType.split(";")[0].trim().toLowerCase()] : undefined) ?? "mp4";
}

export function downloadFileName(item: { id: string; title?: string | null; outputStorageKey?: string | null; mediaUrl?: string | null }, contentType?: string | null): string {
  const base = (item.title || "obtv-video").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "obtv-video";
  return `${base}-${item.id.slice(0, 8)}.${videoExtension(item, contentType)}`;
}

/** localStorage access that never throws (SecurityError in locked-down contexts). */
export function safeStorageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function safeStorageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable; keep in-memory state */ }
}
export function safeStorageRemove(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
