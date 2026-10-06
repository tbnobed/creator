import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, Cpu, Download, ImagePlus, Loader2, Shirt, Sparkles, Square, Upload, X } from "lucide-react";
import type { GarmentArtworkSource, GarmentMode, GarmentWorkbenchProps } from "./types";
import {
  ACCEPTED_UPLOAD, clampStart, defaultRange, fileProblem, isActiveJob, MAX_PROMPT_CHARS, MAX_TARGET_CHARS, PROOF_FPS, PROOF_HEIGHT,
  PROOF_MAX_SECONDS, PROOF_MIN_SECONDS, PROOF_WIDTH, rangeProblem, submitBlocker, usesReference,
} from "./validation";

const MODES: { value: GarmentMode; label: string; hint: string; example: string; Icon: typeof Shirt }[] = [
  { value: "replace-garment", label: "Replace garment", hint: "Swap a garment for a new one", example: "Orange linen button-down, open collar, rolled sleeves", Icon: Shirt },
  { value: "animate-artwork", label: "Animate artwork", hint: "Bring a print to life", example: "Make the printed characters wave and play with a ball", Icon: Sparkles },
];

const STATUS_LABEL: Record<string, string> = { queued: "Queued", running: "Running", succeeded: "Finished", failed: "Failed", cancelled: "Cancelled" };

export function GarmentWorkbench({
  source, workers, job, onUpload, onSubmit, onCancel, loading = false, error,
  reference, referenceUploading = false, onReferenceUpload, onReferenceClear, onInputChange, onArtworkSourceChange,
}: GarmentWorkbenchProps) {
  const refInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<GarmentMode>("replace-garment");
  const [prompts, setPrompts] = useState<Record<GarmentMode, string>>({ "replace-garment": "", "animate-artwork": "" });
  const [artworkSource, setArtworkSource] = useState<GarmentArtworkSource>("existing");
  const onArtworkSourceChangeRef = useRef(onArtworkSourceChange);
  onArtworkSourceChangeRef.current = onArtworkSourceChange;
  useEffect(() => { onArtworkSourceChangeRef.current?.(artworkSource); }, [artworkSource]);
  const [targetGarment, setTargetGarment] = useState("");
  const [workerId, setWorkerId] = useState<string>("");
  const [start, setStart] = useState(0);
  const [duration, setDuration] = useState(PROOF_MAX_SECONDS);
  const [seed, setSeed] = useState(1234);
  const [fileError, setFileError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceVideo = useRef<HTMLVideoElement>(null);

  const sourceKey = source ? `${source.mediaUrl}|${source.durationSeconds}` : "";
  useEffect(() => {
    if (!source) return;
    const r = defaultRange(source.durationSeconds);
    setStart(r.start);
    setDuration(r.duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Auto-select the first ready idle worker when none chosen or chosen disappears.
  useEffect(() => {
    if (workerId && workers.some((w) => w.id === workerId)) return;
    const pick = workers.find((w) => w.ready && !w.busy) ?? workers[0];
    setWorkerId(pick?.id ?? "");
  }, [workers, workerId]);

  const worker = workers.find((w) => w.id === workerId);
  const prompt = prompts[mode];
  const active = isActiveJob(job);
  const blocker = submitBlocker({ source, worker, prompt, targetGarment, start, duration, job, loading: loading || referenceUploading, mode, hasReference: Boolean(reference), artworkSource });
  const needsRef = usesReference(mode, artworkSource);
  const modeInfo = MODES.find((m) => m.value === mode) ?? MODES[0];
  const onInputChangeRef = useRef(onInputChange);
  onInputChangeRef.current = onInputChange;
  useEffect(() => { onInputChangeRef.current?.(); }, [mode, artworkSource, prompt, targetGarment, workerId, start, duration, seed, reference?.storageKey, source?.mediaUrl]);
  const rangeErr = source ? rangeProblem(start, duration, source.durationSeconds) : null;
  const maxDur = source ? Math.min(PROOF_MAX_SECONDS, source.durationSeconds) : PROOF_MAX_SECONDS;

  const scale = useMemo(() => {
    if (!source) return null;
    return { long: Math.max(source.width, source.height), factor: (source.width / PROOF_WIDTH).toFixed(1) };
  }, [source]);

  function handleFile(file: File) {
    const p = fileProblem(file);
    if (p) return setFileError(p);
    setFileError("");
    onUpload(file);
  }

  function preview(t: number) {
    const v = sourceVideo.current;
    if (v) { v.pause(); v.currentTime = t; }
  }

  function switchMode(next: GarmentMode) {
    if (next === mode) return;
    // The reference slot means different things per mode (garment photo vs artwork); never carry it across silently.
    if (reference) onReferenceClear?.();
    setMode(next);
  }

  function submit() {
    if (blocker || !worker) return;
    onSubmit({ workerId: worker.id, mode, prompt: prompt.trim(), targetGarment: targetGarment.trim(), ...(mode === "animate-artwork" ? { artworkSource } : {}), startSeconds: start, durationSeconds: duration, seed });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" data-testid="garment-workbench">
      <div className="min-w-0 space-y-6">
        {!source ? (
          <section
            aria-labelledby="garment-upload-heading"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            className="rounded-xl border-2 border-dashed border-border bg-card p-8 text-center md:p-14"
          >
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
              {loading ? <Loader2 className="size-6 animate-spin text-primary" /> : <Upload className="size-6 text-primary" />}
            </div>
            <h2 id="garment-upload-heading" className="mt-4 text-lg font-semibold">{loading ? "Uploading clip" : "Drop a clip of someone wearing the garment"}</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              MP4 or MOV. Longer clips are fine; you will pick a window of up to {PROOF_MAX_SECONDS} seconds to process.
            </p>
            <input ref={inputRef} type="file" accept={ACCEPTED_UPLOAD} className="sr-only" aria-label="Choose source video"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleFile(f); }} />
            <Button className="mt-5" disabled={loading} onClick={() => inputRef.current?.click()} data-testid="button-garment-upload">Choose clip</Button>
            {fileError && <p role="alert" className="mt-4 text-sm text-destructive">{fileError}</p>}
          </section>
        ) : (
          <section aria-labelledby="garment-source-heading" className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="garment-source-heading" className="text-sm font-semibold">Source</h2>
              <span className="font-mono text-xs text-muted-foreground">{source.width}x{source.height} / {source.durationSeconds.toFixed(2)}s</span>
            </div>
            <video ref={sourceVideo} src={source.mediaUrl} controls playsInline preload="metadata" className="max-h-[50dvh] w-full rounded-lg bg-black/60 object-contain" />
            <RangeBar total={source.durationSeconds} start={start} duration={duration} />
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" disabled={loading || active} onClick={() => inputRef.current?.click()}>
                <Upload className="size-3.5" />Use a different clip
              </Button>
              <input ref={inputRef} type="file" accept={ACCEPTED_UPLOAD} className="sr-only" aria-label="Replace source video"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleFile(f); }} />
            </div>
            {fileError && <p role="alert" className="mt-2 text-sm text-destructive">{fileError}</p>}
          </section>
        )}

        <ResultPanel job={job} sourceUrl={job?.sourceUrl ?? source?.mediaUrl} start={job?.sourceUrl ? 0 : start} onCancel={onCancel} />
      </div>

      <aside className="space-y-4">
        <section aria-labelledby="garment-mode-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="garment-mode-heading" className="text-sm font-semibold">Mode</h2>
          <div role="radiogroup" aria-labelledby="garment-mode-heading" className="mt-3 grid grid-cols-2 gap-2">
            {MODES.map(({ value, label, hint, Icon }) => (
              <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={active} onClick={() => switchMode(value)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${mode === value ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                data-testid={`button-garment-mode-${value}`}>
                <span className="flex items-center gap-1.5 text-sm font-medium"><Icon className="size-3.5" />{label}</span>
                <span className="block text-[11px] text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
          <label htmlFor="garment-target" className="mt-4 flex items-baseline justify-between text-xs font-medium">
            <span>Target garment</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-primary">Required</span>
          </label>
          <input id="garment-target" type="text" value={targetGarment} disabled={active} maxLength={MAX_TARGET_CHARS + 20}
            onChange={(e) => setTargetGarment(e.target.value)}
            placeholder="e.g. jacket worn by the person on the left, dress, trousers"
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
            data-testid="input-garment-target" />
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Which piece of clothing, and whose, if there are several people.</span>
            <span className={`font-mono ${targetGarment.length > MAX_TARGET_CHARS ? "text-destructive" : ""}`}>{targetGarment.length}/{MAX_TARGET_CHARS}</span>
          </div>
          {mode === "animate-artwork" && (
            <div className="mt-4">
              <span id="garment-artsrc-heading" className="text-xs font-medium">Which artwork?</span>
              <div role="radiogroup" aria-labelledby="garment-artsrc-heading" className="mt-1.5 grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1">
                {([["existing", "On the garment", "No upload needed"], ["upload", "Upload a design", "JPEG, PNG or WebP"]] as const).map(([v, l, h]) => (
                  <button key={v} type="button" role="radio" aria-checked={artworkSource === v} disabled={active} onClick={() => setArtworkSource(v)}
                    className={`rounded-md px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${artworkSource === v ? "bg-card shadow-sm ring-1 ring-primary/40" : "hover:bg-card/60"}`}
                    data-testid={`button-garment-artwork-source-${v}`}>
                    <span className="block text-xs font-medium">{l}</span>
                    <span className="block text-[10px] text-muted-foreground">{h}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <label htmlFor="garment-prompt" className="mt-4 flex items-baseline justify-between text-xs font-medium">
            <span>{mode === "replace-garment" ? "Describe the new garment" : "Describe the motion"}</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-primary">Required</span>
          </label>
          <Textarea
            id="garment-prompt"
            value={prompt}
            disabled={active}
            maxLength={MAX_PROMPT_CHARS + 50}
            onChange={(e) => setPrompts((p) => ({ ...p, [mode]: e.target.value }))}
            placeholder={mode === "replace-garment" ? modeInfo.example : `In your own words, e.g. "${modeInfo.example}"`}
            className="mt-1.5 min-h-24 text-sm"
            data-testid="input-garment-prompt"
          />
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <button type="button" className="hover:text-foreground disabled:opacity-50" disabled={active}
              onClick={() => setPrompts((p) => ({ ...p, [mode]: modeInfo.example }))} data-testid="button-garment-example">Use example</button>
            <span className={`font-mono ${prompt.length > MAX_PROMPT_CHARS ? "text-destructive" : ""}`}>{prompt.length}/{MAX_PROMPT_CHARS}</span>
          </div>
          {needsRef && (
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium">{mode === "replace-garment" ? "Garment reference image" : "Artwork to animate"}</span>
                <span className="text-[10px] font-medium uppercase tracking-wide text-primary">Required</span>
              </div>
              {reference ? (
                <div className="mt-1.5 flex items-center gap-3 rounded-lg border border-border p-2" data-testid="card-garment-reference">
                  <img src={reference.mediaUrl} alt={mode === "replace-garment" ? "Garment reference" : "Uploaded artwork"} className="size-14 rounded-md bg-secondary object-cover" />
                  <span className="min-w-0 flex-1 truncate text-xs">{reference.name}</span>
                  <Button variant="ghost" size="icon" disabled={active} onClick={onReferenceClear} aria-label="Remove image" data-testid="button-garment-reference-clear"><X className="size-3.5" /></Button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" className="mt-1.5 w-full" disabled={active || referenceUploading || !onReferenceUpload}
                  onClick={() => refInput.current?.click()} data-testid="button-garment-reference-upload">
                  {referenceUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
                  {referenceUploading ? "Uploading image" : mode === "replace-garment" ? "Add a photo of the garment" : "Upload artwork (JPEG, PNG, WebP)"}
                </Button>
              )}
              <input ref={refInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only"
                aria-label={mode === "replace-garment" ? "Choose garment reference image" : "Choose artwork image"}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onReferenceUpload?.(f); }} />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {mode === "replace-garment"
                  ? "The full reference guides garment shape and print. Describe only changes you want, such as an orange fabric background. For moving prints, use Animate artwork after checking the replacement."
                  : "Any design works. It is placed on the target garment inside the garment mask and animated following your instruction."}
              </p>
            </div>
          )}
          <div className="mt-4 rounded-lg border border-border bg-secondary/40 p-3 text-[11px] leading-relaxed" data-testid="text-garment-inputs">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">This run will use</p>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Mode</dt><dd>{modeInfo.label}</dd>
              <dt className="text-muted-foreground">Garment</dt><dd className="truncate" data-testid="text-garment-target">{targetGarment.trim() || <span className="text-muted-foreground">Not named yet</span>}</dd>
              {mode === "animate-artwork" && (<><dt className="text-muted-foreground">Artwork</dt><dd data-testid="text-garment-artwork-source">{artworkSource === "existing" ? "Already printed on the target garment" : reference ? `Uploaded: ${reference.name}` : "Upload pending"}</dd></>)}
              {mode === "replace-garment" && (<><dt className="text-muted-foreground">Reference</dt><dd className="truncate">{reference ? reference.name : "None yet"}</dd></>)}
              <dt className="text-muted-foreground">Instruction</dt><dd className="line-clamp-2 break-words">{prompt.trim() || <span className="text-muted-foreground">Not written yet</span>}</dd>
            </dl>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground" data-testid="text-garment-artwork-note">
            {mode === "replace-garment"
              ? "The target garment is segmented, regenerated frame by frame, and composited back. Pixels outside the mask are kept from the source."
              : "Experimental local generative animation (VACE) inside the garment mask. Your instruction is passed to the model as written; simple motion works best and complex actions are not guaranteed. Review every output before using it."}
          </p>
        </section>

        <section aria-labelledby="garment-range-heading" className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <h2 id="garment-range-heading" className="text-sm font-semibold">Range</h2>
            <span className="font-mono text-xs text-muted-foreground">max {PROOF_MAX_SECONDS}s</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumberField label="Start (s)" value={start} step={0.1} min={0} max={source ? Math.max(0, source.durationSeconds - PROOF_MIN_SECONDS) : 0}
              disabled={!source || active} onChange={(v) => { setStart(v); preview(v); }} testId="input-garment-start" />
            <NumberField label="Length (s)" value={duration} step={0.1} min={PROOF_MIN_SECONDS} max={maxDur}
              disabled={!source || active} onChange={setDuration} testId="input-garment-duration" />
          </div>
          {source && (
            <div className="mt-2 flex gap-2">
              <Button variant="ghost" size="sm" disabled={active} onClick={() => preview(start)}>Jump to start</Button>
              <Button variant="ghost" size="sm" disabled={active} onClick={() => { const s = clampStart(start, duration, source.durationSeconds); setStart(s); preview(s); }}>Fit inside clip</Button>
            </div>
          )}
          {rangeErr && <p role="alert" className="mt-2 text-xs text-destructive">{rangeErr}</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Only this window is processed. The output is cropped to it; the rest of the clip is not included.
          </p>
        </section>

        <section aria-labelledby="garment-worker-heading" className="rounded-xl border border-border bg-card p-4">
          <h2 id="garment-worker-heading" className="text-sm font-semibold">Local GPU worker</h2>
          {workers.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No workers registered. Start a worker on the GPU host.</p>
          ) : (
            <div role="radiogroup" aria-labelledby="garment-worker-heading" className="mt-3 space-y-1.5">
              {workers.map((w) => {
                const state = !w.ready ? "Not ready" : w.busy ? "Busy" : "Idle";
                return (
                  <button key={w.id} type="button" role="radio" aria-checked={w.id === workerId} disabled={active} onClick={() => setWorkerId(w.id)}
                    className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${w.id === workerId ? "border-primary bg-primary/10" : "border-border hover:bg-secondary"}`}
                    data-testid={`button-garment-worker-${w.id}`}>
                    <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{w.name}</span>
                      {!w.ready && w.reason && <span className="block text-[11px] text-muted-foreground">{w.reason}</span>}
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${!w.ready ? "bg-destructive/15 text-destructive" : w.busy ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary"}`}>{state}</span>
                  </button>
                );
              })}
            </div>
          )}
          <label className="mt-3 flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Seed</span>
            <input type="number" value={seed} disabled={active} onChange={(e) => setSeed(Math.trunc(Number(e.target.value) || 0))}
              className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right font-mono" data-testid="input-garment-seed" />
          </label>
        </section>

        <section aria-labelledby="garment-submit-heading" className="rounded-xl border border-primary/30 bg-card p-4">
          <h2 id="garment-submit-heading" className="text-sm font-semibold">Draft proof render</h2>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            <li>Output is {PROOF_WIDTH}x{PROOF_HEIGHT} at {PROOF_FPS} fps, at most 49 frames (about {PROOF_MAX_SECONDS}s). This is draft quality for checking the result, not a final render.{scale && scale.long > PROOF_WIDTH ? ` Your source is about ${scale.factor}x wider.` : ""}</li>
            <li>Runs on your selected local GPU worker only. Nothing is sent to a cloud service.</li>
            <li>Source audio is retained for the selected window, not AI-generated. Preparing the clip may re-encode it.</li>
            <li>Results vary between seeds and can flicker or drift; review the mask and output before relying on them.</li>
          </ul>
          {error && (
            <p role="alert" className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />{error}
            </p>
          )}
          <Button className="mt-4 w-full" disabled={Boolean(blocker)} onClick={submit} data-testid="button-garment-submit">
            {loading ? <><Loader2 className="size-4 animate-spin" />Sending</> : mode === "replace-garment" ? <><Shirt className="size-4" />Render garment proof</> : <><Sparkles className="size-4" />Render artwork proof</>}
          </Button>
          {blocker && <p className="mt-2 text-xs text-muted-foreground" data-testid="text-garment-blocker">{blocker}</p>}
        </section>
      </aside>
    </div>
  );
}

function NumberField({ label, value, step, min, max, disabled, onChange, testId }: {
  label: string; value: number; step: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void; testId: string;
}) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm disabled:opacity-50" data-testid={testId} />
    </label>
  );
}

function RangeBar({ total, start, duration }: { total: number; start: number; duration: number }) {
  const left = Math.max(0, Math.min(100, (start / total) * 100));
  const width = Math.max(0, Math.min(100 - left, (duration / total) * 100));
  return (
    <div className="mt-3" aria-label={`Selected range ${start.toFixed(2)}s to ${(start + duration).toFixed(2)}s of ${total.toFixed(2)}s`}>
      <div className="relative h-2 overflow-hidden rounded-full bg-secondary">
        <div className="absolute inset-y-0 rounded-full bg-primary" style={{ left: `${left}%`, width: `${width}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0s</span><span>{start.toFixed(2)}s to {(start + duration).toFixed(2)}s</span><span>{total.toFixed(2)}s</span>
      </div>
    </div>
  );
}

export function ResultPanel({ job, sourceUrl, start, onCancel }: { job: GarmentWorkbenchProps["job"]; sourceUrl?: string; start: number; onCancel: (id: string) => void }) {
  if (!job) {
    return (
      <section className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        No job yet. The mask preview and output appear here once the worker reports them.
      </section>
    );
  }
  const active = isActiveJob(job);
  return (
    <section aria-labelledby="garment-result-heading" className="rounded-xl border border-border bg-card p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="garment-result-heading" className="flex items-center gap-2 text-sm font-semibold">
          {active && <Loader2 className="size-3.5 animate-spin text-primary" />}
          {STATUS_LABEL[job.status] ?? job.status}
          {job.stage && <span className="font-normal text-muted-foreground">/ {job.stage}</span>}
        </h2>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{job.id}</span>
          {active && <Button variant="secondary" size="sm" onClick={() => onCancel(job.id)} data-testid="button-garment-cancel"><Square className="size-3.5" />Cancel</Button>}
        </div>
      </div>
      {job.error && <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs">{job.error}</p>}
      {(sourceUrl || job.maskUrl || job.outputUrl) && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {sourceUrl && (
            <Figure label={start > 0 ? `Original from ${start.toFixed(2)}s` : "Original"}>
              <video src={start > 0 ? `${sourceUrl}#t=${start}` : sourceUrl} controls muted playsInline preload="metadata" className="w-full rounded-lg bg-black/60" />
            </Figure>
          )}
          {job.outputUrl && (
            <Figure label="Output (draft)">
              <video src={job.outputUrl} controls playsInline preload="metadata" className="w-full rounded-lg bg-black/60" />
            </Figure>
          )}
          {job.maskUrl && (
            <Figure label="Garment mask">
              {/\.(mp4|mov|webm)(\?|$)/i.test(job.maskUrl)
                ? <video src={job.maskUrl} controls muted playsInline preload="metadata" className="w-full rounded-lg bg-black/60" />
                : <img src={job.maskUrl} alt="Garment mask reported by the worker" className="w-full rounded-lg bg-black/60 object-contain" />}
            </Figure>
          )}
        </div>
      )}
      {job.outputUrl && (
        <a href={job.outputUrl} download className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline" data-testid="link-garment-download">
          <Download className="size-3.5" />Download draft output
        </a>
      )}
    </section>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure>
      {children}
      <figcaption className="mt-1 text-[11px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
