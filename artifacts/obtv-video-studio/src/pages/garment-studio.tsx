import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListGarmentWorkers,
  getListGarmentWorkersQueryKey,
  useInspectGarmentSource,
  useSubmitGarmentJob,
  useListGarmentJobs,
  getListGarmentJobsQueryKey,
  useCancelGarmentJob,
  useReuseArtworkSource,
} from "@workspace/api-client-react";
import type { GarmentJob as ApiGarmentJob } from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { CloudReplacementWorkbench, GarmentWorkbench, PreserveArtworkWorkbench, isActiveJob, usesReference } from "@/components/garment-studio";
import type { PreserveSubmitRequest, CloudSubmitRequest, GarmentProvider, GarmentReference, GarmentSource, GarmentSubmitRequest } from "@/components/garment-studio";
import { AlertTriangle, Cloud, Cpu, Lock, FlaskConical, RotateCcw, Shirt, Sparkles, Wand2 } from "lucide-react";

import { prepareReferenceImage } from "@/components/garment-studio/reference-image";

function newRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function errorText(cause: unknown, fallback: string): string {
  const e = cause as { data?: { error?: unknown }; message?: unknown };
  if (e?.data && typeof e.data.error === "string") return e.data.error;
  if (typeof e?.message === "string" && e.message) return e.message;
  return fallback;
}

/** Authenticated, tenant-scoped generation-reference upload (same route as Video Cleanup and Kling elements). */
async function uploadReferenceMedia(file: File): Promise<{ storageKey: string; mediaUrl: string }> {
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
  return { storageKey: payload.storageKey, mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : "" };
}

type Source = GarmentSource & { sourceStorageKey: string };

export default function GarmentStudioPage() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source | null>(null);
  const [reference, setReference] = useState<GarmentReference | null>(null);
  const [uploading, setUploading] = useState(false);
  const [refUploading, setRefUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [provider, setProvider] = useState<GarmentProvider>("LOCAL");
  const [preserve, setPreserve] = useState(false);
  const [plate, setPlate] = useState<GarmentReference | null>(null);
  const [plateUploading, setPlateUploading] = useState(false);
  const [usingResult, setUsingResult] = useState(false);
  const inFlight = useRef(false);
  const requestId = useRef<string | null>(null);

  const inspect = useInspectGarmentSource();
  const submit = useSubmitGarmentJob();
  const cancel = useCancelGarmentJob();
  const reuse = useReuseArtworkSource();

  const jobsQuery = useListGarmentJobs({
    query: {
      queryKey: getListGarmentJobsQueryKey(),
      refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.status === "queued" || j.status === "running") ? 2_000 : 15_000),
    },
  });
  const workersQuery = useListGarmentWorkers({ query: { queryKey: getListGarmentWorkersQueryKey(), refetchInterval: 5_000 } });

  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);
  const workers = useMemo(() => workersQuery.data ?? [], [workersQuery.data]);
  const selected: ApiGarmentJob | null = jobs.find((j) => j.id === selectedId) ?? jobs[0] ?? null;

  const rotateRequest = useCallback(() => { if (!inFlight.current) requestId.current = null; }, []);

  async function handleUpload(file: File) {
    if (uploading) return;
    setError(null);
    setUploading(true);
    try {
      const { storageKey } = await uploadReferenceMedia(file);
      const inspected = await inspect.mutateAsync({ data: { sourceStorageKey: storageKey } });
      setSource({ ...inspected });
      requestId.current = null;
    } catch (cause) {
      setError(errorText(cause, "Upload failed. Please try again."));
    } finally {
      setUploading(false);
    }
  }

  async function handleReference(file: File) {
    if (refUploading) return;
    setError(null);
    setRefUploading(true);
    try {
      const normalized = await prepareReferenceImage(file);
      const up = await uploadReferenceMedia(normalized);
      requestId.current = inFlight.current ? requestId.current : null;
      setReference({ storageKey: up.storageKey, mediaUrl: up.mediaUrl || URL.createObjectURL(file), name: file.name });
    } catch (cause) {
      setError(errorText(cause, "Reference upload failed."));
    } finally {
      setRefUploading(false);
    }
  }

  async function handleSubmit(req: GarmentSubmitRequest) {
    if (!source) return;
    await send({
      provider: "LOCAL",
      sourceStorageKey: source.sourceStorageKey,
      ...(usesReference(req.mode, req.artworkSource ?? "existing") && reference ? { referenceStorageKey: reference.storageKey } : {}),
      ...(req.mode === "animate-artwork" ? { artworkSource: req.artworkSource ?? "existing" } : {}),
      workerId: req.workerId,
      mode: req.mode,
      prompt: req.prompt,
      targetGarment: req.targetGarment,
      startSeconds: req.startSeconds,
      durationSeconds: req.durationSeconds,
      seed: req.seed,
    });
  }

  async function handleCloudSubmit(req: CloudSubmitRequest) {
    if (!source) return;
    await send({
      provider: "FAL",
      model: req.model,
      confirmPaid: req.confirmPaid,
      mode: "replace-item",
      sourceStorageKey: source.sourceStorageKey,
      ...(reference ? { referenceStorageKey: reference.storageKey } : {}),
      prompt: req.prompt,
      targetGarment: req.targetGarment,
      startSeconds: req.startSeconds,
      durationSeconds: req.durationSeconds,
      seed: req.seed,
    });
  }

  async function handlePlate(file: File) {
    if (plateUploading) return;
    setError(null);
    setPlateUploading(true);
    try {
      const normalized = await prepareReferenceImage(file);
      const up = await uploadReferenceMedia(normalized);
      rotateRequest();
      setPlate({ storageKey: up.storageKey, mediaUrl: up.mediaUrl || URL.createObjectURL(file), name: file.name });
    } catch (cause) {
      setError(errorText(cause, "Plate upload failed."));
    } finally {
      setPlateUploading(false);
    }
  }

  /** Re-inspects a finished job's output server-side; the server resolves storage by job id only. */
  async function handleUseResult(jobId: string) {
    if (usingResult) return;
    setError(null);
    setUsingResult(true);
    try {
      const inspected = await reuse.mutateAsync({ data: { jobId } });
      setPlate(null);
      setSource({ ...inspected });
      requestId.current = null;
    } catch (cause) {
      setError(errorText(cause, "Could not use that result as a source."));
    } finally {
      setUsingResult(false);
    }
  }

  async function handlePreserveSubmit(req: PreserveSubmitRequest) {
    if (!source) return;
    await send({
      provider: "LOCAL",
      mode: "animate-artwork",
      artworkSource: "existing",
      sourceStorageKey: source.sourceStorageKey,
      prompt: req.prompt,
      targetGarment: req.targetGarment,
      startSeconds: req.startSeconds,
      durationSeconds: req.durationSeconds,
      seed: req.seed,
      pixelAnimation: req.pixelAnimation,
    });
  }

  type SubmitBody = Omit<Parameters<typeof submit.mutateAsync>[0]["data"], "requestId">;

  async function send(body: SubmitBody) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    const id = requestId.current ?? newRequestId();
    requestId.current = id;
    try {
      const result = await submit.mutateAsync({
        data: { requestId: id, ...body },
      });
      requestId.current = null;
      setSelectedId(result.jobId);
      await queryClient.invalidateQueries({ queryKey: getListGarmentJobsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListGarmentWorkersQueryKey() });
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        requestId.current = null;
        setError(errorText(cause, "The request was rejected."));
      } else {
        setError("Could not confirm the job was created. Submitting again reuses the same request ID, so it cannot start a duplicate.");
        queryClient.invalidateQueries({ queryKey: getListGarmentJobsQueryKey() });
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  async function handleCancel(jobId: string) {
    setError(null);
    try {
      await cancel.mutateAsync({ id: jobId });
    } catch (cause) {
      setError(errorText(cause, "Cancel failed."));
    } finally {
      queryClient.invalidateQueries({ queryKey: getListGarmentJobsQueryKey() });
    }
  }

  return (
    <Page>
      <PageHeader
        title="Video Replacement"
        description="Replace people, clothing, objects or other visible items in a clip. Choose a local experiment or a paid cloud edit."
      />
      <div role="radiogroup" aria-label="Workflow" className="mb-6 grid gap-2 sm:grid-cols-3" data-testid="provider-selector">
        {([
          ["LOCAL", "Local GPU", "Free experiments on your own workers. Garment swap and artwork animation.", Cpu],
          ["PRESERVE", "Preserve artwork", "Move original print pixels. No AI redraw, no charges.", Lock],
          ["FAL", "Cloud · Seedance 2.5", "Paid video editing. Replace any visible item. Confirmed per run.", Cloud],
        ] as const).map(([value, label, hint, Icon]) => {
          const current = preserve ? "PRESERVE" : provider;
          const on = current === value;
          return (
            <button key={value} type="button" role="radio" aria-checked={on}
              disabled={sending || isActiveJob(selected)}
              onClick={() => {
                if (on) return;
                setPreserve(value === "PRESERVE");
                setProvider(value === "FAL" ? "FAL" : "LOCAL");
                setReference(null); setPlate(null); setError(null); requestId.current = null;
              }}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${on ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-secondary"}`}
              data-testid={`button-provider-${value.toLowerCase()}`}>
              <Icon className={`mt-0.5 size-5 shrink-0 ${on ? "text-primary" : "text-muted-foreground"}`} />
              <span><span className="block text-sm font-semibold">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
            </button>
          );
        })}
      </div>
      {preserve && (
        <PreserveArtworkWorkbench
          source={source}
          job={selected}
          loading={uploading || sending || cancel.isPending}
          error={error}
          onUpload={(f) => { setPlate(null); handleUpload(f); }}
          onSubmit={handlePreserveSubmit}
          onCancel={handleCancel}
          plate={plate}
          plateUploading={plateUploading}
          onPlateUpload={handlePlate}
          onPlateClear={() => { setPlate(null); rotateRequest(); }}
          onUseResult={handleUseResult}
          usingResult={usingResult}
          onInputChange={rotateRequest}
          anyActiveJob={jobs.some(isActiveJob)}
        />
      )}
      {!preserve && provider === "LOCAL" && (<>
      <div className="mb-6 flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-relaxed" data-testid="text-garment-experimental">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-primary" />
        <p><span className="font-semibold">Experimental local generation.</span> Outputs need human review; complex motion is not guaranteed. Each run produces a short draft proof of at most 49 frames (about 3 seconds) from the window you pick. There is no cloud fallback: if no local worker is ready, nothing runs.</p>
      </div>

      {workersQuery.isError && (
        <ErrorBar text={errorText(workersQuery.error, "Could not load GPU workers.")} onRetry={() => workersQuery.refetch()} />
      )}

      <GarmentWorkbench
        source={source}
        workers={workers}
        job={selected}
        onUpload={handleUpload}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        loading={uploading || sending || cancel.isPending}
        error={error}
        reference={reference}
        referenceUploading={refUploading}
        onReferenceUpload={handleReference}
        onReferenceClear={() => { setReference(null); rotateRequest(); }}
        onInputChange={rotateRequest}
        onArtworkSourceChange={() => rotateRequest()}
      />
      </>)}
      {!preserve && provider === "FAL" && (
        <CloudReplacementWorkbench
          source={source}
          job={selected}
          onUpload={handleUpload}
          onSubmit={handleCloudSubmit}
          onCancel={handleCancel}
          loading={uploading || sending || cancel.isPending}
          error={error}
          reference={reference}
          referenceUploading={refUploading}
          onReferenceUpload={handleReference}
          onReferenceClear={() => { setReference(null); rotateRequest(); }}
          onInputChange={rotateRequest}
        />
      )}

      <section aria-labelledby="garment-jobs-heading" className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="garment-jobs-heading" className="text-sm font-semibold">Saved jobs</h2>
          <span className="font-mono text-[11px] text-muted-foreground">{jobs.length} total</span>
        </div>
        {jobsQuery.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-secondary/60" />)}</div>
        ) : jobsQuery.isError ? (
          <ErrorBar text={errorText(jobsQuery.error, "Could not load jobs.")} onRetry={() => jobsQuery.refetch()} />
        ) : jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Shirt className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm">No replacement jobs yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Proofs you render are saved here and survive a reload.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {jobs.map((j) => {
              const active = isActiveJob(j);
              const isSel = selected?.id === j.id;
              return (
                <li key={j.id}>
                  <button type="button" onClick={() => setSelectedId(j.id)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${isSel ? "bg-primary/10" : "hover:bg-secondary"}`}
                    data-testid={`row-garment-job-${j.id}`}>
                    {j.mode === "animate-artwork" ? <Sparkles className="size-4 shrink-0 text-muted-foreground" /> : j.mode === "replace-item" ? <Wand2 className="size-4 shrink-0 text-muted-foreground" /> : <Shirt className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{j.title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {j.mode === "animate-artwork" ? "Animate artwork" : j.mode === "replace-item" ? "Replace item" : "Replace garment"} / {j.provider === "FAL" ? `Cloud${j.model ? ` · ${j.model}` : ""}` : "Local"} / {new Date(j.createdAt).toLocaleString()}
                        {j.stage && active ? ` / ${j.stage}` : ""}
                      </span>
                    </span>
                    <StatusPill status={j.status} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Page>
  );
}

function StatusPill({ status }: { status: ApiGarmentJob["status"] }) {
  const tone = status === "succeeded" ? "bg-primary/15 text-primary"
    : status === "failed" ? "bg-destructive/15 text-destructive"
      : status === "cancelled" ? "bg-secondary text-muted-foreground"
        : "bg-accent text-accent-foreground";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${tone}`} data-testid="status-garment-job">{status}</span>
  );
}

function ErrorBar({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
      <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
      <span className="flex-1">{text}</span>
      <Button variant="ghost" size="sm" onClick={onRetry} data-testid="button-garment-retry"><RotateCcw className="size-3.5" />Retry</Button>
    </div>
  );
}
