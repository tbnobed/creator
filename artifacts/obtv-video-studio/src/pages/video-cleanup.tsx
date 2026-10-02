import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  getGetSessionQueryKey,
  useInspectVideoCleanup,
  useSubmitVideoCleanup,
  useListVideoCleanupJobs,
  getListVideoCleanupJobsQueryKey,
} from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FirstFrameSelector, PointPanel } from "@/components/video-cleanup/FirstFrameSelector";
import { CleanupHistory } from "@/components/video-cleanup/CleanupHistory";
import { cleanupErrorMessage as errorMessage } from "@/components/video-cleanup/errors";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/media-file";
import { AlertTriangle, ArrowUpRight, Camera, Eraser, Loader2, Move, RotateCcw, Trash2, Upload } from "lucide-react";
import {
  draftStorageKey, durationProblem, emptyDraft, isDefiniteRejection, MAX_CLEANUP_POINTS, parseDraft,
  requestIdForAttempt, resolveDraftFromHistory, selectionFingerprint, selectionLocked, validateCleanupFile,
} from "@/lib/video-cleanup";
import type { CameraMode, CleanupDraft, CleanupPointType } from "@/lib/video-cleanup";

function measureLocalDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { resolve(v.duration); URL.revokeObjectURL(url); };
    v.onerror = () => { resolve(NaN); URL.revokeObjectURL(url); };
    v.src = url;
  });
}

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export default function VideoCleanupPage() {
  const { data: session } = useGetSession({ query: { queryKey: getGetSessionQueryKey() } });
  const storageKey = draftStorageKey(session?.user?.id, session?.activeTenant?.id);
  const [draft, setDraft] = useState<CleanupDraft>(emptyDraft);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Load draft once per tenant/user scope.
  useEffect(() => {
    if (!storageKey || loadedKey === storageKey) return;
    setDraft(parseDraft(safeStorageGet(storageKey)));
    setLoadedKey(storageKey);
  }, [storageKey, loadedKey]);

  useEffect(() => {
    if (!storageKey || loadedKey !== storageKey) return;
    safeStorageSet(storageKey, JSON.stringify(draft));
  }, [draft, storageKey, loadedKey]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const update = useCallback((patch: Partial<CleanupDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    // Persist synchronously for submit-state transitions so a reload never loses the request ID.
    if (storageKey) safeStorageSet(storageKey, JSON.stringify(next));
  }, [storageKey]);

  const queryClient = useQueryClient();
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const inspect = useInspectVideoCleanup();
  const submit = useSubmitVideoCleanup();
  const [submitError, setSubmitError] = useState("");
  const [confirmedFingerprint, setConfirmedFingerprint] = useState<string | null>(null);
  const [pointType, setPointType] = useState<CleanupPointType>("positive");
  const inFlight = useRef(false);

  // jobId always equals requestId: reconcile uncertain attempts against own-tenant history.
  const { data: historyJobs } = useListVideoCleanupJobs({
    query: {
      queryKey: getListVideoCleanupJobsQueryKey(),
      refetchInterval: draft.phase === "uncertain" ? 5_000 : false,
    },
  });
  useEffect(() => {
    if (draft.phase !== "uncertain") return;
    const resolved = resolveDraftFromHistory(draftRef.current, historyJobs);
    if (resolved !== draftRef.current) {
      update(resolved);
      setSubmitError("");
      setConfirmedFingerprint(null);
    }
  }, [draft.phase, historyJobs, update]);

  const source = draft.source;
  const locked = selectionLocked(draft.phase) || draft.phase === "accepted";
  const fingerprint = source ? selectionFingerprint(source.sourceToken, draft.cameraMode, draft.points) : "";
  const confirmed = Boolean(source) && confirmedFingerprint === fingerprint;

  async function handleFile(file: File) {
    if (uploading || locked) return;
    setUploadError("");
    const problem = validateCleanupFile(file);
    if (problem) return setUploadError(problem);
    const localDuration = await measureLocalDuration(file);
    if (Number.isFinite(localDuration)) {
      const dp = durationProblem(localDuration);
      if (dp) return setUploadError(dp);
    }
    setUploading(true);
    try {
      const response = await fetch("/api/generations/reference-media", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type, "X-File-Name": file.name },
        body: file,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.storageKey !== "string" || !payload.storageKey) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed. Please try again.");
      }
      const inspected = await inspect.mutateAsync({ data: { sourceStorageKey: payload.storageKey } });
      const dp = durationProblem(inspected.durationSeconds);
      if (dp) throw new Error(dp);
      setConfirmedFingerprint(null);
      setSubmitError("");
      update({ ...emptyDraft(), source: { ...inspected }, cameraMode: draftRef.current.cameraMode });
    } catch (cause) {
      setUploadError(errorMessage(cause, "Upload failed. Please try again."));
    } finally {
      setUploading(false);
    }
  }

  function setPoints(points: CleanupDraft["points"]) {
    if (locked) return;
    update({ points, requestId: null, requestFingerprint: null });
  }

  async function handleSubmit() {
    if (!source || inFlight.current || !confirmed || draft.points.length === 0) return;
    if (!draft.points.some((p) => p.type === "positive")) return setSubmitError("Add at least one remove point on a light.");
    inFlight.current = true;
    setSubmitError("");
    const { requestId } = requestIdForAttempt(draftRef.current, fingerprint, newRequestId);
    update({ requestId, requestFingerprint: fingerprint, phase: "sending" });
    try {
      const result = await submit.mutateAsync({
        data: {
          requestId,
          sourceToken: source.sourceToken,
          sourceStorageKey: source.storageKey,
          cameraMode: draft.cameraMode,
          points: draft.points,
          confirmPaid: true,
        },
      });
      update({ phase: "accepted", jobId: result.jobId || requestId });
      setConfirmedFingerprint(null);
      queryClient.invalidateQueries({ queryKey: getListVideoCleanupJobsQueryKey() });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (isDefiniteRejection(status)) {
        update({ phase: "editing", requestId: null, requestFingerprint: null });
        setConfirmedFingerprint(null);
        setSubmitError(errorMessage(error, "The request was rejected."));
      } else {
        update({ phase: "uncertain" });
        setSubmitError("We could not confirm whether the job was created. History is checked automatically and this resolves on its own if the job exists. Retrying reuses the same request ID, so it cannot create a duplicate job.");
        queryClient.invalidateQueries({ queryKey: getListVideoCleanupJobsQueryKey() });
      }
    } finally {
      inFlight.current = false;
    }
  }

  function startOver() {
    if (draftRef.current.phase === "uncertain" && !window.confirm("Discard this local draft? This does not cancel any processing already accepted by Fal. Starting a new job may cause another charge. You can instead retry this same request safely.")) return;
    setConfirmedFingerprint(null);
    setSubmitError("");
    update(emptyDraft());
    if (storageKey) safeStorageRemove(storageKey);
  }

  function editForNewJob() {
    setConfirmedFingerprint(null);
    setSubmitError("");
    update({ phase: "editing", requestId: null, requestFingerprint: null, jobId: null });
  }

  return (
    <Page>
      <PageHeader
        title="Video Cleanup"
        description="Remove studio lights, stands and rigging from a single short shot. Works for locked-off and moving cameras."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6 min-w-0">
          {!source ? (
            <UploadPanel uploading={uploading} error={uploadError} onFile={handleFile} disabled={!storageKey} />
          ) : (
            <>
              <FirstFrameSelector
                draft={draft}
                locked={locked}
                pointType={pointType}
                onAdd={(p) => draft.points.length < MAX_CLEANUP_POINTS && setPoints([...draft.points, p])}
              />
              <section aria-labelledby="preview-heading" className="rounded-xl border border-border bg-card p-4">
                <h2 id="preview-heading" className="text-sm font-semibold">Playback preview</h2>
                <p className="mb-3 text-xs text-muted-foreground">Scrub the full clip here. Points are always placed on the first frame above.</p>
                <video src={source.mediaUrl} controls playsInline preload="metadata" className="max-h-[50dvh] w-full rounded-lg bg-black/60 object-contain" />
              </section>
            </>
          )}
        </div>

        <aside className="space-y-4">
          {source && (
            <SourceFacts source={source} onReplace={startOver} locked={selectionLocked(draft.phase)} />
          )}
          <section aria-labelledby="mode-heading" className="rounded-xl border border-border bg-card p-4">
            <h2 id="mode-heading" className="text-sm font-semibold">Camera</h2>
            <div role="radiogroup" aria-labelledby="mode-heading" className="mt-3 grid grid-cols-2 gap-2">
              {([["stationary", "Stationary", Camera], ["moving", "Moving", Move]] as const).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={draft.cameraMode === value}
                  disabled={locked}
                  onClick={() => update({ cameraMode: value as CameraMode, requestId: null, requestFingerprint: null })}
                  className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors disabled:opacity-50 ${draft.cameraMode === value ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-secondary"}`}
                  data-testid={`button-camera-${value}`}
                >
                  <Icon className="size-4" />{label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Saved with the job for your records. The same Bria tracker follows objects through both modes. Use one continuous shot with no cuts.
            </p>
          </section>

          {source && (
            <PointPanel
              draft={draft}
              locked={locked}
              pointType={pointType}
              onPointType={setPointType}
              onRemove={(i) => setPoints(draft.points.filter((_, idx) => idx !== i))}
              onUndo={() => setPoints(draft.points.slice(0, -1))}
              onClear={() => setPoints([])}
            />
          )}

          {source && (
            <section aria-labelledby="submit-heading" className="rounded-xl border border-primary/30 bg-card p-4">
              <h2 id="submit-heading" className="text-sm font-semibold">Send for cleanup</h2>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                <li>Your clip and points are sent to Bria Video Eraser through Fal. No local GPU is used.</li>
                <li>The original audio is remuxed from your source onto the cleaned video.</li>
                <li>Markers are guidance points, not a computed mask. Protection of people is best-effort, not guaranteed.</li>
              </ul>
              <div className="mt-3 rounded-lg bg-secondary/60 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">Local budget allowance</span>
                  <span className="font-mono text-lg font-semibold" data-testid="text-estimated-usd">${source.estimatedUsd.toFixed(2)}</span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{source.pricingNote}</p>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">This is a fixed amount reserved against your local spending budget. It is not a price quote and not a cap on what the provider charges.</p>
              </div>

              {draft.phase === "accepted" ? (
                <div className="mt-4 space-y-2" role="status">
                  <p className="text-sm">Job accepted. Track it in the history below.</p>
                  {draft.jobId && <Link href={`/generations/${draft.jobId}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Open job details <ArrowUpRight className="size-3.5" /></Link>}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="secondary" size="sm" onClick={editForNewJob} data-testid="button-edit-new-job">Edit for a new paid job</Button>
                    <Button variant="ghost" size="sm" onClick={startOver}>New clip</Button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="mt-4 flex items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={confirmed}
                      disabled={draft.points.length === 0 || draft.phase === "sending"}
                      onCheckedChange={(v) => setConfirmedFingerprint(v === true ? fingerprint : null)}
                      data-testid="checkbox-confirm-paid"
                      className="mt-0.5"
                    />
                    <span>I understand this is a paid cloud job and confirm this exact selection.</span>
                  </label>
                  {submitError && (
                    <p role="alert" className="mt-3 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive-foreground">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />{submitError}
                    </p>
                  )}
                  <Button
                    className="mt-4 w-full"
                    disabled={!confirmed || draft.points.length === 0 || draft.phase === "sending"}
                    onClick={handleSubmit}
                    data-testid="button-submit-cleanup"
                  >
                    {draft.phase === "sending" ? <><Loader2 className="size-4 animate-spin" />Sending</> : draft.phase === "uncertain" ? <><RotateCcw className="size-4" />Retry same request</> : <><Eraser className="size-4" />Remove marked objects</>}
                  </Button>
                  {draft.phase === "uncertain" && (
                    <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={editForNewJob}>
                      Discard local draft (does not cancel processing)
                    </Button>
                  )}
                </>
              )}
            </section>
          )}
        </aside>
      </div>

      <CleanupHistory />
    </Page>
  );
}

function UploadPanel({ uploading, error, onFile, disabled }: { uploading: boolean; error: string; onFile: (f: File) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <section
      aria-labelledby="upload-heading"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={`relative overflow-hidden rounded-xl border-2 border-dashed p-8 text-center transition-colors md:p-14 ${over ? "border-primary bg-primary/5" : "border-border bg-card"}`}
    >
      <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
        {uploading ? <Loader2 className="size-6 animate-spin text-primary" /> : <Upload className="size-6 text-primary" />}
      </div>
      <h2 id="upload-heading" className="mt-4 text-lg font-semibold">{uploading ? "Uploading and measuring clip" : "Drop a clip with lights in frame"}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        MP4 or MOV, under 5 seconds, up to 200 MB. One continuous shot. Every light you want gone must be visible on the first frame. Nothing is trimmed for you.
      </p>
      <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="sr-only" aria-label="Choose video clip"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
      <Button className="mt-5" disabled={uploading || disabled} onClick={() => inputRef.current?.click()} data-testid="button-choose-clip">
        Choose clip
      </Button>
      {error && <p role="alert" className="mx-auto mt-4 max-w-md text-sm text-destructive">{error}</p>}
    </section>
  );
}

function SourceFacts({ source, onReplace, locked }: { source: NonNullable<CleanupDraft["source"]>; onReplace: () => void; locked: boolean }) {
  return (
    <section aria-label="Source clip" className="rounded-xl border border-border bg-card p-4">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Size</dt><dd className="text-right font-mono">{source.width}x{source.height}</dd>
        <dt className="text-muted-foreground">Duration</dt><dd className="text-right font-mono">{source.durationSeconds.toFixed(2)}s</dd>
        <dt className="text-muted-foreground">Frame rate</dt><dd className="text-right font-mono">{Number(source.fps.toFixed(3))} fps</dd>
        <dt className="text-muted-foreground">Audio</dt><dd className="text-right">{source.hasAudio ? "Kept from source" : "None"}</dd>
      </dl>
      <Button variant="ghost" size="sm" className="mt-3 w-full" onClick={onReplace} disabled={locked}><Trash2 className="size-3.5" />Use a different clip</Button>
    </section>
  );
}

