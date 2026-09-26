import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBulkDeleteVideos, useUndoVideoDelete } from "@/lib/video-library";

export const UNDO_WINDOW_MS = 6000;
type UndoState = { token: string; count: number; expiresAt: number };

/** Soft-delete finished videos with a six-second undo. The server rejects active jobs (409). */
export function useUndoableVideoDelete() {
  const bulkDelete = useBulkDeleteVideos();
  const undoDelete = useUndoVideoDelete();
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function deleteVideos(ids: string[]): Promise<boolean> {
    if (!ids.length || inFlight.current) return false;
    inFlight.current = true;
    setError(null);
    try {
      const result = await bulkDelete.mutateAsync(ids);
      const serverExpiry = Date.parse(result.undoExpiresAt);
      setUndo({ token: result.undoToken, count: result.ids.length, expiresAt: Math.min(Date.now() + UNDO_WINDOW_MS, Number.isFinite(serverExpiry) ? serverExpiry : Infinity) });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delete failed.");
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  async function restore() {
    if (!undo) return;
    const token = undo.token;
    setUndo(null);
    try { await undoDelete.mutateAsync(token); } catch (cause) { setError(cause instanceof Error ? cause.message : "Undo failed."); }
  }

  const toast = undo ? <UndoDeleteToast undo={undo} onUndo={restore} onExpire={() => setUndo(null)} /> : null;
  return { deleteVideos, pending: bulkDelete.isPending || undoDelete.isPending, error, clearError: () => setError(null), toast };
}

function UndoDeleteToast({ undo, onUndo, onExpire }: { undo: UndoState; onUndo: () => void; onExpire: () => void }) {
  const [now, setNow] = useState(Date.now());
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= undo.expiresAt) onExpireRef.current();
    }, 250);
    return () => window.clearInterval(timer);
  }, [undo.expiresAt]);
  const seconds = Math.max(0, Math.ceil((undo.expiresAt - now) / 1000));
  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-xs shadow-lg" role="status" data-testid="toast-undo-delete">
      <span>Deleted {undo.count} {undo.count === 1 ? "video" : "videos"}</span>
      <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={onUndo} data-testid="button-undo-delete"><RotateCcw className="mr-1 size-3.5" />Undo ({seconds}s)</Button>
    </div>
  );
}
