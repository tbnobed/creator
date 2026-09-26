import { useState } from "react";
import { VideoThumbnail } from "./VideoThumbnail";
import { FileAudio, Film, Library, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { importReference, useReferenceLibrary, type ReferenceKind, type ReferenceLibraryItem, type ReferenceRole } from "@/lib/video-library";

const sourceLabel: Record<ReferenceLibraryItem["sourceType"], string> = {
  upload: "Upload", referenceVideo: "Reference video", generation: "Completed run", imageAsset: "Image studio", characterAsset: "Character", settingAsset: "Environment",
};

export function ReferenceLibraryPicker({ kind, role, label, disabled, onImported }: {
  kind: ReferenceKind;
  role: ReferenceRole;
  label: string;
  disabled: boolean;
  onImported: (media: { storageKey: string; mediaUrl: string; mimeType: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { data, isLoading, isError, refetch } = useReferenceLibrary(kind, role, open);
  const items = data?.items ?? [];

  async function choose(item: ReferenceLibraryItem) {
    if (importing) return;
    setImporting(`${item.sourceType}:${item.sourceId}`);
    setError("");
    try {
      // Server resolves the tenant-owned source and writes a fresh private reference key.
      const result = await importReference({ sourceType: item.sourceType, sourceId: item.sourceId, role });
      onImported({ ...result, name: item.name });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      setImporting(null);
    }
  }

  return (
    <>
      <button type="button" disabled={disabled} onClick={() => { setError(""); setOpen(true); }} className="inline-flex min-h-8 items-center gap-1 rounded-md border border-[#75516b] px-2.5 py-1.5 text-[11px] text-[#f3c5de] hover:bg-[#493047] disabled:cursor-not-allowed disabled:opacity-40" data-testid={`button-library-${role}`}>
        <Library className="size-3.5" />Library
      </button>
      <Dialog open={open} onOpenChange={(value) => !importing && setOpen(value)}>
        <DialogContent className="z-[80] max-w-2xl border-[#67445d] bg-[#231c24] text-[#f5e9f2]">
          <DialogTitle>Choose {label.toLowerCase()}</DialogTitle>
          <DialogDescription className="text-xs text-[#bdacbc]">Uploads and completed runs that fit this slot. Picking one makes a private copy for this render.</DialogDescription>
          {error && <p role="alert" className="rounded-md border border-rose-400/40 bg-rose-400/10 p-2 text-xs text-rose-200" data-testid="status-library-import-error">{error}</p>}
          <div className="max-h-[55vh] overflow-y-auto">
            {isLoading ? <div className="grid grid-cols-3 gap-2">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="aspect-video animate-pulse rounded-md bg-[#342833]" />)}</div>
              : isError ? <div className="flex flex-col items-center gap-2 p-6 text-xs">Library could not be loaded.<Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-reference-library">Retry</Button></div>
              : items.length === 0 ? <p className="p-6 text-center text-xs text-[#a99ba8]" data-testid="empty-reference-library">Nothing in your library fits this slot yet. Upload a file instead.</p>
              : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{items.map((item) => {
                  const key = `${item.sourceType}:${item.sourceId}`;
                  const src = item.previewUrl || item.mediaUrl;
                  return <button key={key} type="button" disabled={Boolean(importing)} onClick={() => void choose(item)} className="relative overflow-hidden rounded-md border border-[#594353] bg-[#342833] text-left hover:border-[#ee87b4] disabled:opacity-60" data-testid={`button-pick-reference-${item.sourceId}`}>
                    <div className="flex aspect-video items-center justify-center bg-[#1c171d]">
                      {item.kind === "image" && src ? <img src={src} alt="" className="size-full object-cover" /> : item.kind === "video" ? <VideoThumbnail previewUrl={item.previewUrl} mediaUrl={item.mediaUrl} /> : <FileAudio className="size-6 text-[#eaa2c4]" />}
                    </div>
                    <div className="p-2"><p className="truncate text-[11px]">{item.name}</p><p className="text-[10px] text-[#a99ba8]">{sourceLabel[item.sourceType]}</p></div>
                    {importing === key && <div className="absolute inset-0 flex items-center justify-center bg-black/50"><Loader2 className="size-5 animate-spin" /></div>}
                  </button>;
                })}</div>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
