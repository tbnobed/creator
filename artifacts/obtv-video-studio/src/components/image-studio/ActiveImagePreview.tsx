import { useEffect, useRef, useState } from "react";
import {
  ImageAsset,
  imageStudioError,
  useDeleteAsset,
  useUpdateAsset,
  useUploadAsset,
} from "@/hooks/image-studio";
import { WorkspaceMode } from "./ImageWorkspace";
import { Button } from "@/components/ui/button";
import { Check, Download, Edit2, Focus, Heart, Trash2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { PaintMaskCanvas, PaintMaskCanvasRef } from "./PaintMaskCanvas";

interface ActiveImagePreviewProps {
  asset: ImageAsset | null;
  onClear: () => void;
  mode: WorkspaceMode;
  onMaskUpdate: (maskId: string | undefined) => void;
  onAssetUpdated: (asset: ImageAsset) => void;
  onOutpaintPrepared: (asset: ImageAsset | undefined) => void;
}

const OUTPAINT_PADDING = [64, 128, 256, 512];

export function ActiveImagePreview({
  asset,
  onClear,
  mode,
  onMaskUpdate,
  onAssetUpdated,
  onOutpaintPrepared,
}: ActiveImagePreviewProps) {
  const { toast } = useToast();
  const updateAsset = useUpdateAsset();
  const deleteAsset = useDeleteAsset();
  const uploadAsset = useUploadAsset();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const [collection, setCollection] = useState("");
  const [outpaintPadding, setOutpaintPadding] = useState(256);
  const previousPadding = useRef(outpaintPadding);
  const maskCanvasRef = useRef<PaintMaskCanvasRef>(null);
  const [isUploadingMask, setIsUploadingMask] = useState(false);

  useEffect(() => {
    setEditName(asset?.name || "");
    setCollection(asset?.collection || "");
    setIsEditingName(false);
  }, [asset?.id, asset?.name, asset?.collection]);

  useEffect(() => {
    if (previousPadding.current !== outpaintPadding) {
      previousPadding.current = outpaintPadding;
      onMaskUpdate(undefined);
      onOutpaintPrepared(undefined);
    }
  }, [outpaintPadding, onMaskUpdate, onOutpaintPrepared]);

  if (!asset) {
    return (
      <div className="relative m-2 flex flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-white/5 bg-black/20 md:m-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,31,98,0.05),transparent_50%)]" />
        <Focus className="mb-4 h-12 w-12 text-muted-foreground/30" />
        <p className="text-sm font-medium text-muted-foreground">Select an image from the gallery</p>
        <p className="mt-1 text-xs text-muted-foreground/60">or generate a new one to start editing</p>
      </div>
    );
  }

  const updateMetadata = async (data: { name?: string; favorite?: boolean; collection?: string }) => {
    try {
      const result = await updateAsset.mutateAsync({ id: asset.id, data });
      onAssetUpdated(result.asset);
      return true;
    } catch (error) {
      toast({
        title: "Image update failed",
        description: imageStudioError(error),
        variant: "destructive",
      });
      return false;
    }
  };

  const handleDownload = async () => {
    try {
      const response = await fetch(asset.url, { credentials: "include" });
      if (!response.ok) throw new Error("The image could not be downloaded.");
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = asset.name || `obtv-image-${asset.id}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      toast({
        title: "Download failed",
        description: imageStudioError(error),
        variant: "destructive",
      });
    }
  };

  const handleSaveName = async () => {
    const name = editName.trim();
    if (!name) {
      toast({ title: "Enter an image name", variant: "destructive" });
      return;
    }
    if (name !== asset.name && !(await updateMetadata({ name }))) return;
    setIsEditingName(false);
  };

  const invalidateMask = () => {
    onMaskUpdate(undefined);
    onOutpaintPrepared(undefined);
  };

  const handleSaveMask = async () => {
    if (!maskCanvasRef.current) return;
    setIsUploadingMask(true);
    try {
      if (mode === "outpaint") {
        const output = await maskCanvasRef.current.getOutpaintBlobs();
        if (!output) throw new Error("Could not prepare the outpaint canvas.");
        const expanded = new File(
          [output.expandedImage],
          `outpaint-source-${asset.id}-${output.width}x${output.height}.png`,
          { type: "image/png" },
        );
        const mask = new File(
          [output.mask],
          `outpaint-mask-${asset.id}-${output.width}x${output.height}.png`,
          { type: "image/png" },
        );
        const expandedResult = await uploadAsset.mutateAsync({ data: expanded });
        const maskResult = await uploadAsset.mutateAsync({ data: mask });
        onOutpaintPrepared(expandedResult.asset);
        onMaskUpdate(maskResult.asset.id);
        toast({
          title: "Outpaint canvas prepared",
          description: `${output.width} × ${output.height} source and mask uploaded.`,
        });
      } else {
        const blob = await maskCanvasRef.current.getMaskBlob();
        if (!blob) throw new Error("Could not generate the mask.");
        const file = new File([blob], `mask-${asset.id}.png`, { type: "image/png" });
        const result = await uploadAsset.mutateAsync({ data: file });
        onMaskUpdate(result.asset.id);
        toast({ title: "Mask saved for generation" });
      }
    } catch (error) {
      toast({
        title: mode === "outpaint" ? "Outpaint preparation failed" : "Mask upload failed",
        description: imageStudioError(error),
        variant: "destructive",
      });
    } finally {
      setIsUploadingMask(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Delete this image forever?")) return;
    try {
      await deleteAsset.mutateAsync({ id: asset.id });
      onClear();
      toast({ title: "Image deleted" });
    } catch (error) {
      toast({
        title: "Image could not be deleted",
        description: imageStudioError(error),
        variant: "destructive",
      });
    }
  };

  const displayWidth = mode === "outpaint" ? asset.width + outpaintPadding * 2 : asset.width;
  const displayHeight = mode === "outpaint" ? asset.height + outpaintPadding * 2 : asset.height;

  return (
    <div className="relative flex h-full flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/60 shadow-2xl">
      <div className="absolute inset-x-0 top-0 z-20 flex min-h-12 items-center justify-between gap-2 bg-gradient-to-b from-black/90 to-transparent px-3 py-2">
        {isEditingName ? (
          <div className="flex min-w-0 items-center gap-1">
            <Input
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              className="h-7 min-w-0 max-w-48 bg-black/50 text-xs"
              autoFocus
              onKeyDown={(event) => event.key === "Enter" && void handleSaveName()}
            />
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void handleSaveName()}>
              <Check className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <button className="group flex min-w-0 items-center gap-2" onClick={() => setIsEditingName(true)}>
            <span className="truncate text-sm font-medium text-white">{asset.name || "Untitled Image"}</span>
            <Edit2 className="h-3 w-3 shrink-0 text-white/50 opacity-0 group-hover:opacity-100" />
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={asset.favorite ? "Remove favorite" : "Add favorite"}
            className={`h-8 w-8 rounded-full ${asset.favorite ? "text-red-500" : "text-white/70"}`}
            onClick={() => void updateMetadata({ favorite: !asset.favorite })}
          >
            <Heart className={`h-4 w-4 ${asset.favorite ? "fill-current" : ""}`} />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Download image" className="h-8 w-8 text-white/70" onClick={() => void handleDownload()}>
            <Download className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Delete image" className="h-8 w-8 text-white/70 hover:bg-destructive" onClick={() => void handleDelete()}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Close preview" className="h-8 w-8 text-white/70" onClick={onClear}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4 pb-20 pt-16 md:p-8 md:pb-20 md:pt-16">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: "linear-gradient(45deg,#808080 25%,transparent 25%),linear-gradient(-45deg,#808080 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#808080 75%),linear-gradient(-45deg,transparent 75%,#808080 75%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0,0 10px,10px -10px,-10px 0",
          }}
        />
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded shadow-[0_10px_40px_rgba(0,0,0,0.5)]">
          {mode !== "inpaint" && mode !== "outpaint" ? (
            <img
              src={asset.url}
              alt={asset.name || "Preview"}
              className="max-h-full max-w-full object-contain"
              style={{ aspectRatio: `${asset.width}/${asset.height}` }}
            />
          ) : (
            <div className="h-full w-full" style={{ aspectRatio: `${displayWidth}/${displayHeight}` }}>
              <PaintMaskCanvas
                ref={maskCanvasRef}
                imageSrc={asset.url}
                width={asset.width}
                height={asset.height}
                mode={mode}
                outpaintPadding={outpaintPadding}
                onDirty={invalidateMask}
              />
            </div>
          )}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 z-20 flex min-h-12 flex-wrap items-center justify-between gap-2 border-t border-white/5 bg-black/90 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{displayWidth} × {displayHeight}</span>
          <Input
            aria-label="Collection"
            title="Collection"
            placeholder="Collection"
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
            onBlur={() => {
              const next = collection.trim();
              if (next !== asset.collection) void updateMetadata({ collection: next });
            }}
            className="h-7 w-28 bg-black/50 text-[10px]"
          />
        </div>
        {(mode === "inpaint" || mode === "outpaint") && (
          <div className="flex items-center gap-2">
            {mode === "outpaint" && (
              <select
                aria-label="Outpaint padding"
                value={outpaintPadding}
                onChange={(event) => setOutpaintPadding(Number(event.target.value))}
                className="h-7 rounded-md border border-white/10 bg-black px-2 text-xs"
              >
                {OUTPAINT_PADDING.map((value) => (
                  <option key={value} value={value}>+{value}px each side</option>
                ))}
              </select>
            )}
            <Button size="sm" variant="outline" className="h-7 bg-black/50 text-xs" onClick={() => maskCanvasRef.current?.clearMask()}>
              Reset
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => void handleSaveMask()} disabled={isUploadingMask}>
              {isUploadingMask ? "Uploading…" : mode === "outpaint" ? "Prepare canvas" : "Save mask"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}