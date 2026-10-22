import { useFileDrop } from "@/components/shared/use-file-drop";
import { useEffect, useState } from "react";
import { ImageAsset, imageStudioError, useUploadAsset } from "@/hooks/image-studio";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ImagePlus, Loader2, UploadCloud } from "lucide-react";

export type UploadIntent = "generate" | "edit" | "upscale";

const OPTIONS: { value: UploadIntent; label: string; description: string }[] = [
  { value: "generate", label: "Use as reference", description: "Guide a new image with this upload." },
  { value: "edit", label: "Edit image", description: "Describe changes to this image." },
  { value: "upscale", label: "Upscale image", description: "Increase this image's resolution." },
];

export function UploadImageDialog({ initialIntent, onClose, onUploaded }: {
  initialIntent: UploadIntent;
  onClose: () => void;
  onUploaded: (asset: ImageAsset, intent: UploadIntent) => void;
}) {
  const [intent, setIntent] = useState(initialIntent);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState("");
  const upload = useUploadAsset();

  useEffect(() => {
    if (!file) { setPreview(undefined); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chooseFile = (next?: File) => {
    if (!next || upload.isPending) return;
    setFile(undefined);
    if (!["image/png", "image/jpeg", "image/webp"].includes(next.type)) {
      setError("Only PNG, JPEG, and WebP images are supported.");
    } else if (next.size === 0 || next.size > 12 * 1024 * 1024) {
      setError("Choose a non-empty image up to 12 MB.");
    } else {
      setError("");
      setFile(next);
    }
  };

  const drop = useFileDrop({ accept: "image/png,image/jpeg,image/webp", noun: "image", disabled: upload.isPending,
    onFiles: ([f]) => chooseFile(f), onReject: (m) => { setFile(undefined); setError(m); } });

  const submit = async () => {
    if (!file || upload.isPending) return;
    setError("");
    try {
      const { asset } = await upload.mutateAsync({ data: file });
      onUploaded(asset, intent);
    } catch (cause) {
      setError(imageStudioError(cause));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !upload.isPending) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload an image</DialogTitle>
          <DialogDescription>Choose how to use your image. The original stays in your workspace gallery.</DialogDescription>
        </DialogHeader>
        <label
          className={`relative flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors focus-within:ring-2 focus-within:ring-primary ${drop.dragging ? "border-primary bg-primary/10" : "border-white/15 bg-black/20"}`}
          {...drop.dropProps}
        >
          <input
            type="file"
            aria-label="Choose image file"
            {...drop.inputProps}
            className="sr-only"
          />
          {preview ? <img src={preview} alt="Image to upload" className="h-36 max-w-full rounded-lg object-contain" /> : <ImagePlus className="h-9 w-9 text-primary" />}
          <span className="max-w-full break-all text-sm font-medium">{file?.name || "Choose an image or drop it here"}</span>
          <span className="text-xs text-muted-foreground">PNG, JPEG or WebP · up to 12 MB{file ? " · click to replace" : ""}</span>
        </label>
        <div className="space-y-2" aria-label="Upload purpose">
          {OPTIONS.map((option) => (
            <button key={option.value} type="button" aria-pressed={intent === option.value} disabled={upload.isPending}
              onClick={() => setIntent(option.value)}
              className={`w-full rounded-lg border p-3 text-left ${intent === option.value ? "border-primary bg-primary/10" : "border-white/10 hover:bg-white/5"}`}>
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Uploading does not start a render. A compatible model will be selected when available; Cloud processing requires cost confirmation.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button onClick={() => void submit()} disabled={!file || upload.isPending}>
          {upload.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}
          {upload.isPending ? "Uploading…" : "Upload and continue"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}