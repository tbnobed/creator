import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { ReferenceLibraryPicker } from "./ReferenceLibraryPicker";
import type { ReferenceMedia } from "./SeedanceReferences";

export function LocalImageReferences({ value, onChange, limit, onBusyChange }: {
  value: ReferenceMedia[];
  onChange: (value: ReferenceMedia[]) => void;
  limit: number;
  onBusyChange: (busy: boolean) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const disabled = uploading || limit < 1 || value.length >= limit;

  async function upload(file?: File) {
    if (!file || disabled || inFlight.current) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG or WebP image."); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("Choose an image smaller than 20 MB."); return;
    }
    inFlight.current = true;
    setUploading(true);
    onBusyChange(true);
    setError("");
    try {
      const response = await fetch("/api/generations/reference-media", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": file.type, "X-File-Name": file.name },
        body: file,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.storageKey || !result.mediaUrl) {
        throw new Error(result.error || "Image upload failed.");
      }
      onChange([...value, { storageKey: result.storageKey, mediaUrl: result.mediaUrl, mimeType: result.mimeType || file.type, name: file.name, kind: "image" }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Image upload failed.");
    } finally {
      inFlight.current = false;
      setUploading(false);
      onBusyChange(false);
    }
  }

  return <section aria-label="Reference images" className="space-y-3 rounded-xl border border-border/70 bg-card/35 p-4" data-testid="section-local-image-references">
    <div className="flex items-center gap-2"><ImagePlus className="size-4 text-primary" /><h3 className="text-sm font-semibold">Reference images</h3></div>
    <p className="text-xs text-muted-foreground">{limit
      ? `Guide the scene with uploaded or library images. Up to ${limit} direct reference${limit === 1 ? "" : "s"} for the selected local workflow. These guide appearance; they are not an exact first frame.`
      : "The selected local workflow has no image-reference mapping. Choose a compatible workflow to use an image."}</p>
    <div className="flex flex-wrap gap-2">
      <ReferenceLibraryPicker kind="image" role="referenceImage" label="Reference image" disabled={disabled}
        onBusyChange={busy => { setUploading(busy); onBusyChange(busy); }}
        onImported={media => { setError(""); onChange([...value, { ...media, kind: "image" }]); }} />
      <label className={`inline-flex min-h-8 items-center gap-2 rounded-md border px-3 text-xs ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-secondary"}`}>
        <ImagePlus className="size-3.5" />{uploading ? "Uploading…" : "Upload image"}
        <input type="file" accept=".jpg,.jpeg,.png,.webp" aria-label="Upload reference image" disabled={disabled} className="sr-only"
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void upload(file); }} />
      </label>
    </div>
    {value.map((image, index) => <div key={`${image.storageKey}-${index}`} className="flex items-center gap-3 rounded-lg border p-2">
      {image.mediaUrl && <a href={image.mediaUrl} target="_blank" rel="noreferrer" aria-label={`Preview ${image.name}`}><img src={image.mediaUrl} alt={image.name} className="size-14 rounded object-contain" /></a>}
      <span className="min-w-0 flex-1 truncate text-xs">{image.name}</span>
      <button type="button" disabled={uploading} title="Remove reference image" aria-label={`Remove ${image.name}`} className="rounded p-2 hover:bg-secondary"
        onClick={() => onChange(value.filter((_, i) => i !== index))}><X className="size-4" /></button>
    </div>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
