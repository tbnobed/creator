import { useRef, useState } from "react";
import { FileAudio, Film, ImagePlus, Plus, X } from "lucide-react";
import { ReferenceLibraryPicker } from "@/components/video-studio/ReferenceLibraryPicker";
import type { ReferenceRole } from "@/lib/video-library";
import { activeSeedanceRoles, seedanceReferenceBudget, VIDEO_MODEL_CAPABILITIES, type FalModel, type SeedanceTask } from "@/lib/video-model-capabilities";

export type ReferenceKind = "image" | "video" | "audio";
export type ReferenceMedia = { storageKey: string; mediaUrl: string; mimeType: string; name: string; kind: ReferenceKind };
export type SeedanceMedia = {
  start: ReferenceMedia | null;
  end: ReferenceMedia | null;
  source: ReferenceMedia | null;
  images: ReferenceMedia[];
  videos: ReferenceMedia[];
  audio: ReferenceMedia[];
};
export const emptySeedanceMedia = (): SeedanceMedia => ({ start: null, end: null, source: null, images: [], videos: [], audio: [] });

type Role = "start" | "end" | "source" | "images" | "videos" | "audio";
const types: Record<ReferenceKind, string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/quicktime"],
  audio: ["audio/mpeg", "audio/wav", "audio/x-wav"],
};
const accept: Record<ReferenceKind, string> = {
  image: ".jpg,.jpeg,.png,.webp",
  video: ".mp4,.mov",
  audio: ".mp3,.wav",
};
const libraryRole: Record<Role, ReferenceRole> = { start: "firstFrame", end: "lastFrame", source: "referenceVideo", images: "referenceImage", videos: "referenceVideo", audio: "referenceAudio" };
const roleKind = (role: Role): ReferenceKind => role === "start" || role === "end" || role === "images" ? "image" : role === "source" || role === "videos" ? "video" : "audio";

export function SeedanceReferences({ value, onChange, version, task, primaryImageCount }: {
  value: SeedanceMedia;
  onChange: (value: SeedanceMedia) => void;
  version: FalModel;
  task: SeedanceTask;
  primaryImageCount: number;
}) {
  const [uploading, setUploading] = useState<Role | null>(null);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const max = VIDEO_MODEL_CAPABILITIES[version].limits;
  const roles = activeSeedanceRoles(version, task);
  const budget = seedanceReferenceBudget(version, task, {
    characterCount: primaryImageCount,
    hasSetting: false,
    images: value.images.length,
    videos: value.videos.length,
    audio: value.audio.length,
    frames: Number(Boolean(value.start)) + Number(Boolean(value.end)),
    hasSource: Boolean(value.source),
  });
  const hasFrames = task === "reference" && Boolean(value.start || value.end);
  const hasExtras = value.images.length + (roles.source ? 0 : value.videos.length) + value.audio.length > 0;
  const rows: { role: Role; label: string; hint: string }[] = roles.source
    ? [
        { role: "source", label: "Source video", hint: "Required. Edit and Extend use exactly one source video." },
        { role: "images" as const, label: "Reference images", hint: "Optional look, character or product references for the edit." },
        { role: "audio" as const, label: "Reference audio", hint: "Optional sound reference." },
      ]
    : [
        ...(roles.frames ? [
          { role: "start" as const, label: "Start frame", hint: "Optional still image to open the shot." },
          { role: "end" as const, label: "End frame", hint: "Optional closing still; add a start frame first." },
        ] : []),
        ...(roles.images ? [{ role: "images" as const, label: "Reference images", hint: "Independent visual references." }] : []),
        ...(roles.videos ? [{ role: "videos" as const, label: "Reference videos", hint: "Motion and visual references." }] : []),
        ...(roles.audio ? [{ role: "audio" as const, label: "Reference audio", hint: "Sound reference; cannot be the only reference." }] : []),
      ];

  async function upload(file: File, role: Role) {
    const kind = roleKind(role);
    if (!types[kind].includes(file.type)) { setError(`Unsupported ${kind} format. Use ${accept[kind].replaceAll(".", "").toUpperCase()}.`); return; }
    if (file.size === 0) { setError("Choose a non-empty file."); return; }
    if (busy.current) return;
    if ((role === "images" || role === "videos" || role === "audio") && (value[role].length >= max[role] || (role === "images" && budget.imageCount >= max.images) || budget.total >= max.total)) {
      setError(`Reference limit reached. Primary cast/environment images count toward the ${max.images}-image and ${max.total}-media limits.`); return;
    }
    busy.current = true;
    setUploading(role);
    setError("");
    try {
      const response = await fetch("/api/generations/reference-media", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type, "X-File-Name": file.name },
        body: file,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.storageKey !== "string" || typeof payload.mediaUrl !== "string" || !payload.storageKey || !payload.mediaUrl) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed. Please try again.");
      }
      const media: ReferenceMedia = { storageKey: payload.storageKey, mediaUrl: payload.mediaUrl, mimeType: payload.mimeType || file.type, name: file.name, kind };
      if (role === "start" || role === "end" || role === "source") onChange({ ...value, [role]: media });
      else onChange({ ...value, [role]: [...value[role], media] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed. Please try again.");
    } finally {
      busy.current = false;
      setUploading(null);
    }
  }

  function attach(role: Role, media: ReferenceMedia) {
    if (role === "start" || role === "end" || role === "source") onChange({ ...value, [role]: media });
    else onChange({ ...value, [role]: [...value[role], media] });
  }

  function remove(role: Role, index?: number) {
    setError("");
    if (role === "start") onChange({ ...value, start: null, end: null });
    else if (role === "end" || role === "source") onChange({ ...value, [role]: null });
    else onChange({ ...value, [role]: value[role].filter((_, i) => i !== index) });
  }

  return (
    <section aria-label="Seedance media references" className="space-y-4 rounded-xl border border-[#67445d] bg-[#30232f]/60 p-4" data-testid="section-seedance-references">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-[#f5e9f2]">Media direction</h3><p className="mt-1 text-xs leading-relaxed text-[#bdacbc]">{roles.source ? "Edit and Extend need one source video and can also take image and audio references. Frames and extra videos stay in your draft for Generate." : "Use start and end frames, or add independent image, video and audio references. Frames cannot be combined with extra references."}</p></div>
        <span className="shrink-0 rounded-md bg-[#50334b] px-2 py-1 font-mono text-[10px] text-[#ffe2f0]" data-testid="text-reference-count">{roles.source ? `${Number(Boolean(value.source))}/${max.source} source · ${budget.total}/${max.total} media` : `${budget.total}/${max.total} media`}</span>
      </div>
      {!roles.source && <p className="text-[11px] text-[#c9b8c5]" data-testid="text-reference-image-budget">{budget.imageCount}/{max.images} images · {primaryImageCount} selected cast/environment {primaryImageCount === 1 ? "image" : "images"} + {value.images.length} extra {value.images.length === 1 ? "image" : "images"}. Primary images count toward the limit.</p>}
      {budget.framesWithPrimary && <p role="alert" className="rounded-md border border-rose-400/40 bg-rose-400/10 p-2 text-xs text-rose-200">Frames cannot be combined with selected cast or environment images. Clear those selections before rendering.</p>}
      {rows.map(({ role, label, hint }) => {
        const kind = roleKind(role);
        const items = role === "start" || role === "end" || role === "source" ? (value[role] ? [value[role]] : []) : value[role];
        const disabled = Boolean(uploading) || (role === "end" && !value.start) || ((role === "start" || role === "end") && hasExtras) || ((role === "images" || role === "videos" || role === "audio") && (hasFrames || value[role].length >= max[role] || (role === "images" && budget.imageCount >= max.images) || budget.total >= max.total));
        return <div key={role} className="rounded-lg border border-[#54434f] bg-[#211d23] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="text-xs font-semibold text-[#eee3ec]">{label}{role === "source" && <span className="ml-1 text-[#f2a4c9]">Required</span>}</p><p className="mt-0.5 text-[11px] text-[#a99ba8]">{hint}</p></div>
            <div className="flex items-center gap-1.5">
            <ReferenceLibraryPicker kind={kind} role={libraryRole[role]} label={label} disabled={disabled} onImported={(media) => { setError(""); attach(role, { ...media, kind }); }} />
            <label className={`inline-flex min-h-8 items-center gap-1 rounded-md border border-[#75516b] px-2.5 py-1.5 text-[11px] text-[#f3c5de] ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-[#493047]"}`}>
              <Plus className="size-3.5" />{uploading === role ? "Uploading…" : items.length && !["images", "videos", "audio"].includes(role) ? "Replace" : `Add ${kind}`}
              <input type="file" className="sr-only" accept={accept[kind]} disabled={disabled} aria-label={`Upload ${label.toLowerCase()}`} data-testid={`input-seedance-${role}`} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file, role); }} />
            </label>
            </div>
          </div>
          {items.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2">{items.map((item, i) => <div key={`${item.storageKey}-${i}`} className="flex min-w-0 items-center gap-2 rounded-md border border-[#594353] bg-[#342833] p-2">
            {kind === "image" && item.mediaUrl ? <img src={item.mediaUrl} alt="" className="size-12 shrink-0 rounded object-cover" /> : kind === "video" && item.mediaUrl ? <video src={item.mediaUrl} controls preload="metadata" className="h-12 w-20 shrink-0 rounded object-cover" aria-label={`Preview ${item.name}`} /> : kind === "image" ? <ImagePlus className="size-5 shrink-0 text-[#eaa2c4]" /> : kind === "video" ? <Film className="size-5 shrink-0 text-[#eaa2c4]" /> : <FileAudio className="size-5 shrink-0 text-[#eaa2c4]" />}
            <div className="min-w-0 flex-1"><p className="truncate text-[11px]" title={item.name}>{item.name}</p>{kind === "audio" && item.mediaUrl && <audio controls preload="none" src={item.mediaUrl} aria-label={`Preview ${item.name}`} className="mt-1 h-7 w-full" />}{!item.mediaUrl && <p className="text-[10px] text-[#a99ba8]">Saved reference · preview unavailable</p>}</div>
            <button type="button" onClick={() => remove(role, i)} aria-label={`Remove ${label.toLowerCase()} ${item.name}`} data-testid={`button-remove-${role}-${i}`} className="rounded p-1 text-[#cbb0c3] hover:bg-[#604252]"><X className="size-4" /></button>
          </div>)}</div>}
          {!items.length && <div className="mt-2 flex items-center gap-2 text-[10px] text-[#806f7e]">{kind === "image" ? <ImagePlus className="size-3.5" /> : kind === "video" ? <Film className="size-3.5" /> : <FileAudio className="size-3.5" />} No {label.toLowerCase()} attached</div>}
        </div>;
      })}
      {error && <p role="alert" data-testid="status-reference-upload-error" className="rounded-md border border-rose-400/40 bg-rose-400/10 p-2 text-xs text-rose-200">{error}</p>}
    </section>
  );
}