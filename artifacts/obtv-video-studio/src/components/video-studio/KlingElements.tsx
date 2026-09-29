import { useRef, useState } from "react";
import { ImagePlus, Plus, UserRound, X } from "lucide-react";
import { ReferenceLibraryPicker } from "@/components/video-studio/ReferenceLibraryPicker";
import type { ReferenceMedia } from "@/components/video-studio/SeedanceReferences";

export type KlingElement = { frontal: ReferenceMedia; angles: ReferenceMedia[] };

const KLING_IMAGE_TYPES = ["image/jpeg", "image/png"];

async function uploadImage(file: File): Promise<ReferenceMedia> {
  const response = await fetch("/api/generations/reference-media", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": file.type, "X-File-Name": file.name },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.storageKey !== "string" || typeof payload.mediaUrl !== "string" || !payload.storageKey) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed. Please try again.");
  }
  return { storageKey: payload.storageKey, mediaUrl: payload.mediaUrl, mimeType: payload.mimeType || file.type, name: file.name, kind: "image" };
}

function Thumb({ media, onRemove, label, testId }: { media: ReferenceMedia; onRemove: () => void; label: string; testId: string }) {
  return (
    <div className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-[#594353] bg-[#342833]" title={media.name}>
      {media.mediaUrl ? <img src={media.mediaUrl} alt={label} className="size-full object-cover" /> : <div className="flex size-full items-center justify-center"><ImagePlus className="size-5 text-[#eaa2c4]" /></div>}
      <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} data-testid={testId} className="absolute right-0.5 top-0.5 rounded bg-[#1d171c]/80 p-0.5 text-[#f3c5de] hover:bg-[#604252]"><X className="size-3" /></button>
    </div>
  );
}

/**
 * Kling 3.0 elements: each subject is a frontal image plus 1–3 extra angles,
 * referenced in the prompt as @Element1…N (after any selected cast/environment).
 */
export function KlingElements({ value, onChange, max, minAngles, maxAngles, primaryCount, disabledReason }: {
  value: KlingElement[];
  onChange: (value: KlingElement[]) => void;
  max: number;
  minAngles: number;
  maxAngles: number;
  primaryCount: number;
  disabledReason?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const remaining = max - primaryCount - value.length;

  async function handleFile(file: File, target: "new" | number) {
    if (!KLING_IMAGE_TYPES.includes(file.type)) { setError("Kling elements accept JPG or PNG only."); return; }
    if (file.size === 0 || lock.current) return;
    lock.current = true;
    setBusy(target === "new" ? "new" : `angle-${target}`);
    setError("");
    try {
      const media = await uploadImage(file);
      add(media, target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed. Please try again.");
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  function add(media: ReferenceMedia, target: "new" | number) {
    if (target === "new") onChange([...value, { frontal: media, angles: [] }]);
    else onChange(value.map((element, i) => i === target ? { ...element, angles: [...element.angles, media].slice(0, maxAngles) } : element));
  }

  const addDisabled = Boolean(busy) || remaining <= 0 || Boolean(disabledReason);

  return (
    <div className="rounded-lg border border-[#54434f] bg-[#211d23] p-3" data-testid="section-kling-elements">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-[#eee3ec]">Character / object elements</p>
          <p className="mt-0.5 text-[11px] text-[#a99ba8]">One frontal image plus up to {maxAngles} optional extra angles per subject. Refer to them in the prompt as @Element{primaryCount + 1}{max - primaryCount > 1 ? `…@Element${max}` : ""}.{primaryCount ? ` Cast, environment and reference images take @Element1${primaryCount > 1 ? `–${primaryCount}` : ""}.` : ""}</p>
        </div>
        <span className="rounded-md bg-[#50334b] px-2 py-1 font-mono text-[10px] text-[#ffe2f0]" data-testid="text-kling-element-count">{primaryCount + value.length}/{max} elements</span>
      </div>
      {disabledReason && <p className="mt-2 text-[11px] text-[#e7c89c]" data-testid="text-kling-elements-disabled">{disabledReason}</p>}

      <div className="mt-3 space-y-2">
        {value.map((element, index) => {
          const needsAngle = minAngles > 0 && element.angles.length < minAngles;
          const angleDisabled = Boolean(busy) || element.angles.length >= maxAngles;
          return (
            <div key={`${element.frontal.storageKey}-${index}`} className={`rounded-md border p-2 ${needsAngle ? "border-[#b0795a] bg-[#3a2a24]" : "border-[#594353] bg-[#2b2229]"}`} data-testid={`card-kling-element-${index}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 font-mono text-[11px] text-[#f3c5de]"><UserRound className="size-3.5" />@Element{primaryCount + index + 1}</p>
                <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))} className="text-[10px] text-[#cbb0c3] hover:text-white" data-testid={`button-remove-kling-element-${index}`}>Remove element</button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1"><p className="text-[9px] uppercase tracking-[0.14em] text-[#a99ba8]">Frontal</p><Thumb media={element.frontal} label={`element ${index + 1} frontal`} testId={`button-remove-kling-frontal-${index}`} onRemove={() => onChange(value.filter((_, i) => i !== index))} /></div>
                <div className="space-y-1">
                  <p className="text-[9px] uppercase tracking-[0.14em] text-[#a99ba8]">Angles {element.angles.length}/{maxAngles}</p>
                  <div className="flex gap-2">
                    {element.angles.map((angle, a) => <Thumb key={`${angle.storageKey}-${a}`} media={angle} label={`element ${index + 1} angle ${a + 1}`} testId={`button-remove-kling-angle-${index}-${a}`} onRemove={() => onChange(value.map((el, i) => i === index ? { ...el, angles: el.angles.filter((_, j) => j !== a) } : el))} />)}
                    {!angleDisabled && <label className="flex size-16 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-[#75516b] text-[10px] text-[#f3c5de] hover:bg-[#493047]">
                      <Plus className="size-3.5" />{busy === `angle-${index}` ? "…" : "Angle"}
                      <input type="file" className="sr-only" accept=".jpg,.jpeg,.png" aria-label={`Upload angle for element ${index + 1}`} data-testid={`input-kling-angle-${index}`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void handleFile(file, index); }} />
                    </label>}
                  </div>
                </div>
                {!angleDisabled && <ReferenceLibraryPicker kind="image" role="referenceImage" label={`Element ${index + 1} angle`} disabled={Boolean(busy)} onImported={(media) => { setError(""); add({ ...media, kind: "image" }, index); }} />}
              </div>
              {needsAngle && <p className="mt-2 text-[10px] text-[#f0c7a4]">Add at least {minAngles} extra angle for this element.</p>}
            </div>
          );
        })}
        {!value.length && <p className="flex items-center gap-2 text-[10px] text-[#806f7e]"><UserRound className="size-3.5" />No elements attached</p>}
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <ReferenceLibraryPicker kind="image" role="referenceImage" label="Element frontal image" disabled={addDisabled} onImported={(media) => { setError(""); add({ ...media, kind: "image" }, "new"); }} />
        <label className={`inline-flex min-h-8 items-center gap-1 rounded-md border border-[#75516b] px-2.5 py-1.5 text-[11px] text-[#f3c5de] ${addDisabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-[#493047]"}`}>
          <Plus className="size-3.5" />{busy === "new" ? "Uploading…" : "New element (frontal)"}
          <input type="file" className="sr-only" accept=".jpg,.jpeg,.png" disabled={addDisabled} aria-label="Upload element frontal image" data-testid="input-kling-element-frontal" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void handleFile(file, "new"); }} />
        </label>
      </div>
      {error && <p role="alert" className="mt-2 rounded-md border border-rose-400/40 bg-rose-400/10 p-2 text-xs text-rose-200" data-testid="status-kling-element-error">{error}</p>}
    </div>
  );
}
