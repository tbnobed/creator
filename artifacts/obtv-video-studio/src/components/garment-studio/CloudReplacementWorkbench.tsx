import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Cloud, Download, ImagePlus, Loader2, Square, Upload, Wand2, X } from "lucide-react";
import type { GarmentJob, GarmentReference, GarmentSource } from "./types";
import { ACCEPTED_UPLOAD, fileProblem, isActiveJob, MAX_PROMPT_CHARS, MAX_TARGET_CHARS } from "./validation";

export const CLOUD_MIN_SECONDS = 4;
export const CLOUD_MAX_SECONDS = 15;
export const CLOUD_MODEL = "seedance-2.5" as const;

export interface CloudSubmitRequest {
  model: "seedance-2.5" | "kling-o3-edit";
  prompt: string;
  targetGarment: string;
  startSeconds: number;
  durationSeconds: number;
  seed: number;
  confirmPaid: true;
}

export interface CloudReplacementWorkbenchProps {
  source: GarmentSource | null;
  job: GarmentJob | null;
  onUpload: (file: File) => void;
  onSubmit: (request: CloudSubmitRequest) => void;
  onCancel: (jobId: string) => void;
  loading?: boolean;
  error?: string | null;
  reference?: GarmentReference | null;
  referenceUploading?: boolean;
  onReferenceUpload?: (file: File) => void;
  onReferenceClear?: () => void;
  onInputChange?: () => void;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function cloudRangeProblem(start: number, duration: number, total: number | undefined, minimum = CLOUD_MIN_SECONDS): string | null {
  if (!total || !Number.isFinite(total)) return "Source duration is unknown.";
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return "Start and length must be numbers.";
  if (start < 0) return "Start cannot be negative.";
  if (total < minimum) return `Cloud editing needs a source of at least ${minimum}s.`;
  if (duration < minimum) return `Source window must be at least ${minimum}s.`;
  if (duration > CLOUD_MAX_SECONDS + 1e-6) return `Source window is capped at ${CLOUD_MAX_SECONDS}s.`;
  if (start + duration > total + 1e-3) return `Window ends at ${r2(start + duration)}s but the source is ${r2(total)}s.`;
  return null;
}

export function CloudReplacementWorkbench({
  source, job, onUpload, onSubmit, onCancel, loading = false, error,
  reference, referenceUploading = false, onReferenceUpload, onReferenceClear, onInputChange,
}: CloudReplacementWorkbenchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [target, setTarget] = useState("");
  const [prompt, setPrompt] = useState("");
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(5);
  const [confirmed, setConfirmed] = useState(false);
  const [model, setModel] = useState<CloudSubmitRequest["model"]>("seedance-2.5");
  const minimum = model === "kling-o3-edit" ? 3 : 4;
  const [fileError, setFileError] = useState("");

  const sourceKey = source ? `${source.mediaUrl}|${source.durationSeconds}` : "";
  useEffect(() => {
    if (!source) return;
    setStart(0);
    setDuration(r2(Math.min(CLOUD_MAX_SECONDS, Math.max(minimum, source.durationSeconds))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Any input change invalidates paid confirmation and rotates the request ID.
  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;
  useEffect(() => {
    setConfirmed(false);
    onInputChangeRef.current?.();
  }, [model, target, prompt, start, duration, reference?.storageKey, source?.mediaUrl]);

  const active = isActiveJob(job);
  useEffect(() => {
    if (active) setConfirmed(false);
  }, [active]);
  const rangeErr = source ? cloudRangeProblem(start, duration, source.durationSeconds, minimum) : null;
  const t = target.trim();
  const p = prompt.trim();
  const blocker = loading || referenceUploading ? "Waiting for the current request to finish."
    : active ? "A job is already running. Cancel it or wait for it to finish."
      : !source ? "Upload a source clip first."
        : rangeErr ? rangeErr
          : model === "kling-o3-edit" && (Math.min(source.width, source.height) < 720 || Math.max(source.width, source.height) > 3840) ? "Kling O3 requires video sides of 720–3840 pixels."
          : !t ? "Describe what to replace, e.g. the red car parked on the left."
            : t.length > MAX_TARGET_CHARS ? `Target is over ${MAX_TARGET_CHARS} characters.`
              : !p ? "Write the edit prompt."
                : p.length > MAX_PROMPT_CHARS ? `Prompt is over ${MAX_PROMPT_CHARS} characters.`
                  : !confirmed ? "Confirm the paid cloud run to continue."
                    : null;

  function handleFile(file: File) {
    const prob = fileProblem(file);
    if (prob) return setFileError(prob);
    setFileError("");
    onUpload(file);
  }
  function preview(s: number) { const v = video.current; if (v) { v.pause(); v.currentTime = s; } }
  function submit() {
    if (blocker) return;
    onSubmit({ model, prompt: p, targetGarment: t, startSeconds: start, durationSeconds: duration, seed: 0, confirmPaid: true });
  }

  const fileInput = (
    <input ref={inputRef} type="file" accept={ACCEPTED_UPLOAD} className="sr-only" aria-label="Choose source video"
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleFile(f); }} />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="cloud-replacement-workbench">
      <div className="min-w-0 space-y-6">
        {!source ? (
          <section onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            className="rounded-xl border-2 border-dashed border-border bg-card p-8 text-center md:p-14">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
              {loading ? <Loader2 className="size-6 animate-spin text-primary" /> : <Upload className="size-6 text-primary" />}
            </div>
            <h2 className="mt-4 text-lg font-semibold">{loading ? "Uploading clip" : "Drop the clip you want to edit"}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">MP4 or MOV. You will pick a source window of {minimum} to {CLOUD_MAX_SECONDS} seconds to send.</p>
            {fileInput}
            <Button className="mt-5" disabled={loading} onClick={() => inputRef.current?.click()} data-testid="button-cloud-upload">Choose clip</Button>
            {fileError && <p role="alert" className="mt-4 text-sm text-destructive">{fileError}</p>}
          </section>
        ) : (
          <section className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Source</h2>
              <span className="font-mono text-xs text-muted-foreground">{source.width}x{source.height} / {source.durationSeconds.toFixed(2)}s</span>
            </div>
            <video ref={video} src={source.mediaUrl} controls playsInline preload="metadata" className="max-h-[50dvh] w-full rounded-lg bg-black/60 object-contain" />
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary relative">
              <div className="absolute inset-y-0 rounded-full bg-primary" style={{
                left: `${Math.min(100, (start / source.durationSeconds) * 100)}%`,
                width: `${Math.max(0, Math.min(100 - (start / source.durationSeconds) * 100, (duration / source.durationSeconds) * 100))}%`,
              }} />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>0s</span><span>{start.toFixed(2)}s to {(start + duration).toFixed(2)}s</span><span>{source.durationSeconds.toFixed(2)}s</span>
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" disabled={loading || active} onClick={() => inputRef.current?.click()}><Upload className="size-3.5" />Use a different clip</Button>
              {fileInput}
            </div>
            {fileError && <p role="alert" className="mt-2 text-sm text-destructive">{fileError}</p>}
          </section>
        )}

        {!job ? (
          <section className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">No job yet. The edited output appears here when the provider returns it.</section>
        ) : (
          <section className="rounded-xl border border-border bg-card p-4" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold capitalize">
                {active && <Loader2 className="size-3.5 animate-spin text-primary" />}{job.status}
                {job.stage && <span className="font-normal normal-case text-muted-foreground">/ {job.stage}</span>}
              </h2>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{job.id}</span>
                {active && <Button variant="secondary" size="sm" onClick={() => onCancel(job.id)} data-testid="button-cloud-cancel"><Square className="size-3.5" />Cancel</Button>}
              </div>
            </div>
            {active && <p className="mt-2 text-[11px] text-muted-foreground">Cancelling stops tracking here; a provider run that already started may still be billed.</p>}
            {job.error && <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">{job.error}</p>}
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {job.sourceUrl && (
                <figure><video src={job.sourceUrl} controls muted playsInline preload="metadata" className="w-full rounded-lg bg-black/60" />
                  <figcaption className="mt-1 text-[11px] text-muted-foreground">Original</figcaption></figure>
              )}
              {job.outputUrl && (
                <figure><video src={job.outputUrl} controls playsInline preload="metadata" className="w-full rounded-lg bg-black/60" />
                  <figcaption className="mt-1 text-[11px] text-muted-foreground">Edited output</figcaption></figure>
              )}
            </div>
            {job.outputUrl && (
              <a href={job.outputUrl} download className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline" data-testid="link-cloud-download">
                <Download className="size-3.5" />Download output
              </a>
            )}
          </section>
        )}
      </div>

      <aside className="space-y-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Wand2 className="size-4 text-primary" />Replace item</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">People, clothing, objects or any other visible item.</p>
          <label htmlFor="cloud-target" className="mt-4 flex items-baseline justify-between text-xs font-medium">
            <span>What to replace</span><span className="text-[10px] font-medium uppercase tracking-wide text-primary">Required</span>
          </label>
          <input id="cloud-target" type="text" value={target} disabled={active} maxLength={MAX_TARGET_CHARS + 20}
            onChange={(e) => setTarget(e.target.value)} placeholder="e.g. the man in the grey hoodie, the coffee mug on the desk"
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50" data-testid="input-cloud-target" />
          <div className="mt-1 flex justify-end text-[11px] text-muted-foreground">
            <span className={`font-mono ${target.length > MAX_TARGET_CHARS ? "text-destructive" : ""}`}>{target.length}/{MAX_TARGET_CHARS}</span>
          </div>
          <label htmlFor="cloud-prompt" className="mt-3 flex items-baseline justify-between text-xs font-medium">
            <span>Edit prompt</span><span className="text-[10px] font-medium uppercase tracking-wide text-primary">Required</span>
          </label>
          <Textarea id="cloud-prompt" value={prompt} disabled={active} maxLength={MAX_PROMPT_CHARS + 50}
            onChange={(e) => setPrompt(e.target.value)} placeholder="Replace it with a woman in a yellow raincoat, same pose and lighting"
            className="mt-1.5 min-h-24 text-sm" data-testid="input-cloud-prompt" />
          <div className="mt-1 flex justify-end text-[11px] text-muted-foreground">
            <span className={`font-mono ${prompt.length > MAX_PROMPT_CHARS ? "text-destructive" : ""}`}>{prompt.length}/{MAX_PROMPT_CHARS}</span>
          </div>
          <div className="mt-3">
            <div className="flex items-baseline justify-between"><span className="text-xs font-medium">Reference image</span><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Optional</span></div>
            {reference ? (
              <div className="mt-1.5 flex items-center gap-3 rounded-lg border border-border p-2" data-testid="card-cloud-reference">
                <img src={reference.mediaUrl} alt="Replacement reference" className="size-14 rounded-md bg-secondary object-cover" />
                <span className="min-w-0 flex-1 truncate text-xs">{reference.name}</span>
                <Button variant="ghost" size="icon" disabled={active} onClick={onReferenceClear} aria-label="Remove image"><X className="size-3.5" /></Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" className="mt-1.5 w-full" disabled={active || referenceUploading || !onReferenceUpload}
                onClick={() => refInput.current?.click()} data-testid="button-cloud-reference-upload">
                {referenceUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
                {referenceUploading ? "Uploading image" : "Add an image of the replacement"}
              </Button>
            )}
            <input ref={refInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose reference image"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onReferenceUpload?.(f); }} />
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Source window</h2>
            <span className="font-mono text-xs text-muted-foreground">{minimum}–{CLOUD_MAX_SECONDS}s</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block text-xs"><span className="text-muted-foreground">Start (s)</span>
              <input type="number" value={start} step={0.1} min={0} disabled={!source || active}
                onChange={(e) => { const v = Number(e.target.value); setStart(v); preview(v); }}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm disabled:opacity-50" data-testid="input-cloud-start" /></label>
            <label className="block text-xs"><span className="text-muted-foreground">Length (s)</span>
              <input type="number" value={duration} step={0.1} min={minimum} max={CLOUD_MAX_SECONDS} disabled={!source || active}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm disabled:opacity-50" data-testid="input-cloud-duration" /></label>
          </div>
          {rangeErr && <p role="alert" className="mt-2 text-xs text-destructive">{rangeErr}</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Only this window is sent. The output length is decided by the model and may differ from the window.</p>
        </section>

        <section className="rounded-xl border border-primary/30 bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Cloud className="size-4 text-primary" />Paid cloud edit</h2>
          <label className="mt-3 block text-xs">Editing model
            <select value={model} disabled={active || loading} onChange={e => setModel(e.target.value as CloudSubmitRequest["model"])} className="mt-1 w-full rounded border border-border bg-background p-2" data-testid="select-cloud-model">
              <option value="seedance-2.5">Seedance 2.5</option>
              <option value="kling-o3-edit">Kling O3 Standard · Video Edit</option>
            </select>
          </label>
          <p className="mt-2 text-xs text-muted-foreground">{model === "kling-o3-edit" ? "3–15s source; each side 720–3840px. Provider acceptance and output quality are not guaranteed." : "4–15s source. Seedance may reject real-person footage under its likeness/privacy rules."}</p>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            <li>Your source window, prompt and optional image are sent to the cloud provider.</li>
            <li>The original clip’s audio is retained at its original timing. Any extra generated video may have no audio.</li>
            <li>Results vary. Areas outside the target can change too; review before using.</li>
          </ul>
          <label className="mt-3 flex cursor-pointer gap-2.5 rounded-lg border border-border bg-secondary/40 p-3 text-xs leading-relaxed">
            <input type="checkbox" checked={confirmed} disabled={active || !source} onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]" data-testid="checkbox-cloud-confirm-paid" />
            <span>{model === "kling-o3-edit" ? "I approve a paid Kling O3 edit. The local allowance is $0.20 per source second, not a confirmed provider bill. Workspace spending limits apply." : "I understand this is a paid run. Billing covers the provider output duration, chosen automatically up to 30 seconds, plus source processing, and is subject to my workspace spending limits."}</span>
          </label>
          {error && (
            <p role="alert" className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />{error}
            </p>
          )}
          <Button className="mt-4 w-full" disabled={Boolean(blocker)} onClick={submit} data-testid="button-cloud-submit">
            {loading ? <><Loader2 className="size-4 animate-spin" />Sending</> : <><Cloud className="size-4" />Start paid cloud edit</>}
          </Button>
          {blocker && <p className="mt-2 text-xs text-muted-foreground" data-testid="text-cloud-blocker">{blocker}</p>}
        </section>
      </aside>
    </div>
  );
}
