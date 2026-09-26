import { VideoThumbnail } from "./VideoThumbnail";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Check, Download, Film, Star, Trash2, X } from "lucide-react";
import { useUndoableVideoDelete } from "@/components/video-studio/UndoableDelete";
import { downloadFileName, safeStorageGet, safeStorageSet } from "@/lib/media-file";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  nextSelection, TERMINAL_STATUSES, useSetVideoFavorites, useVideoLibrary, type VideoLibraryItem,
} from "@/lib/video-library";

const FAVORITE_FILTER_KEY = "obtv:video-library:favorites-only";

export function VideoLibraryPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const [favoritesOnly, setFavoritesOnly] = useState(() => safeStorageGet(FAVORITE_FILTER_KEY) === "true");
  const { data, isLoading, isError, refetch } = useVideoLibrary(favoritesOnly ? true : undefined);
  const setFavorites = useSetVideoFavorites();
  const undoable = useUndoableVideoDelete();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [error, setError] = useState("");

  const items = useMemo(() => data?.items ?? [], [data]);
  const order = useMemo(() => items.map((item) => item.id), [items]);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const busy = setFavorites.isPending || undoable.pending;

  useEffect(() => { safeStorageSet(FAVORITE_FILTER_KEY, String(favoritesOnly)); setSelected(new Set()); }, [favoritesOnly]);
  useEffect(() => {
    // Drop selections for items that disappeared after refetch.
    setSelected((prev) => { const next = new Set([...prev].filter((id) => order.includes(id))); return next.size === prev.size ? prev : next; });
  }, [order]);
  function toggle(id: string, range: boolean) {
    setSelected((prev) => nextSelection(order, prev, id, anchor.current, range));
    anchor.current = id;
  }

  async function favorite(value: boolean, ids = [...selected]) {
    setError("");
    try { await setFavorites.mutateAsync({ ids, favorite: value }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update favorites."); }
  }

  async function remove() {
    const ids = selectedItems.filter((item) => TERMINAL_STATUSES.includes(item.status)).map((item) => item.id);
    if (!ids.length) { setError("Only completed, failed or cancelled videos can be deleted."); return; }
    setError("");
    if (await undoable.deleteVideos(ids)) setSelected(new Set());
  }

  function download() {
    const withMedia = selectedItems.filter((item) => item.mediaUrl);
    withMedia.forEach((item, index) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = item.mediaUrl!;
        link.download = downloadFileName(item);
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 400);
    });
    if (withMedia.length < selectedItems.length) setError(`${selectedItems.length - withMedia.length} selected item(s) have no video to download.`);
  }

  const allSelected = items.length > 0 && selected.size === items.length;

  return (
    <section className="min-w-0 space-y-4" data-testid="section-video-library">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Library filter" className="flex rounded-md border border-border/60 p-0.5">
          <button type="button" aria-pressed={!favoritesOnly} onClick={() => setFavoritesOnly(false)} className={`rounded px-3 py-1 text-xs ${!favoritesOnly ? "bg-primary/20 text-foreground" : "text-muted-foreground"}`} data-testid="button-filter-all-videos">All videos</button>
          <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(true)} className={`flex items-center gap-1 rounded px-3 py-1 text-xs ${favoritesOnly ? "bg-primary/20 text-foreground" : "text-muted-foreground"}`} data-testid="button-filter-favorites"><Star className="size-3" /> Favorites</button>
        </div>
        {items.length > 0 && <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelected(allSelected ? new Set() : new Set(order))} data-testid="button-select-all">{allSelected ? "Clear selection" : "Select all"}</Button>}
        <p className="text-[11px] text-muted-foreground">Shift-click to select a range.</p>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-card/95 p-2 backdrop-blur" data-testid="bar-bulk-actions">
          <span className="px-2 text-xs font-semibold" data-testid="text-selected-count">{selected.size} selected</span>
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={download} disabled={busy} data-testid="button-bulk-download"><Download className="mr-1 size-3.5" />Download</Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => favorite(true)} disabled={busy} data-testid="button-bulk-favorite"><Star className="mr-1 size-3.5" />Favorite</Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => favorite(false)} disabled={busy} data-testid="button-bulk-unfavorite">Unfavorite</Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs text-destructive" onClick={remove} disabled={busy} data-testid="button-bulk-delete"><Trash2 className="mr-1 size-3.5" />Delete</Button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Clear selection" data-testid="button-clear-selection"><X className="size-4" /></button>
        </div>
      )}
      {(error || undoable.error) && <p role="alert" className="text-xs text-destructive" data-testid="status-library-error">{error || undoable.error}</p>}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="aspect-[4/3] animate-pulse rounded-xl bg-secondary/30" />)}</div>
      ) : isError ? (
        <Card className="flex flex-col items-center gap-2 border-dashed p-6 text-xs text-muted-foreground">Library could not be loaded.<Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-library">Retry</Button></Card>
      ) : items.length === 0 ? (
        <Card className="flex min-h-36 flex-col items-center justify-center gap-2 border-dashed bg-card/20 p-5 text-center text-xs text-muted-foreground" data-testid="empty-video-library">
          {favoritesOnly ? <><Star className="size-5" />No favorites yet. Star a video to keep it here.</> : <><Film className="size-5" />No videos in your library yet.</>}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => <LibraryCard key={item.id} item={item} selected={selected.has(item.id)} onToggle={toggle} onOpen={onOpen} onFavorite={(value) => favorite(value, [item.id])} disabled={busy} />)}
        </div>
      )}

      {undoable.toast}
    </section>
  );
}

function LibraryCard({ item, selected, onToggle, onOpen, onFavorite, disabled }: { item: VideoLibraryItem; selected: boolean; onToggle: (id: string, range: boolean) => void; onOpen: (id: string) => void; onFavorite: (value: boolean) => void; disabled: boolean }) {
  const [hovering, setHovering] = useState(false);
  const src = item.previewUrl || item.mediaUrl;
  return (
    <div onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)} className={`group relative aspect-[4/3] overflow-hidden rounded-xl border bg-secondary/30 ${selected ? "border-primary ring-2 ring-primary/50" : "border-border/60 hover:border-primary/50"}`} data-testid={`card-library-video-${item.id}`}>
      {src && item.status === "COMPLETED" ? <div className="absolute inset-0"><VideoThumbnail previewUrl={item.previewUrl} mediaUrl={item.mediaUrl} hoverPlay active={hovering} /></div> : <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground">{item.status.toLowerCase()}</div>}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/30" />
      <button type="button" className="absolute inset-0 z-0" onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey) ? onToggle(item.id, e.shiftKey) : onOpen(item.id)} aria-label={`Open ${item.title || "video"}`} data-testid={`button-open-library-${item.id}`} />
      <button type="button" role="checkbox" aria-checked={selected} onClick={(e) => onToggle(item.id, e.shiftKey)} className={`absolute left-2 top-2 z-10 flex size-6 items-center justify-center rounded border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-white/50 bg-black/40 text-transparent"}`} aria-label={`Select ${item.title || "video"}`} data-testid={`checkbox-library-${item.id}`}><Check className="size-3.5" /></button>
      <button type="button" disabled={disabled} onClick={() => onFavorite(!item.favorite)} aria-pressed={item.favorite} className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded bg-black/45 text-white hover:bg-black/70" aria-label={item.favorite ? "Remove from favorites" : "Add to favorites"} data-testid={`button-favorite-${item.id}`}><Star className={`size-3.5 ${item.favorite ? "fill-amber-300 text-amber-300" : ""}`} /></button>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 p-3">
        <p className="line-clamp-2 text-xs font-medium text-white">{item.title || "Untitled video"}</p>
        <p className="mt-1 text-[9px] text-white/70">{formatDistanceToNow(new Date(item.createdAt))} ago</p>
      </div>
    </div>
  );
}
