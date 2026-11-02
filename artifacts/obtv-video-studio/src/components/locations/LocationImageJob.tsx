import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetImageStudioJobQueryKey, getListSettingsQueryKey, useGetImageStudioJob, type SettingReferencesItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker, useStandaloneModelChoice } from "@/components/shared/model-picker";
import { ErrorNotice, readableError } from "@/components/shared/error-notice";
import { newRequestKey, startLocationImageJob } from "./location-api";

type Ref = SettingReferencesItem;
const VARIANT_PRESETS = ["Morning", "Evening", "Night", "Storm"];
const ACTIVE = ["QUEUED", "RUNNING"];

/**
 * Image generation for a library location.
 * - mode "base": text-to-image from the shared location prompt (owned by the parent form).
 * - mode "variant": edits an existing reference with its own change prompt.
 * Jobs are durable server-side: closing the dialog does not lose the result.
 */
export function LocationImageJob({ ensureSaved, mode, basePrompt = "", references, disabled }: {
  ensureSaved: () => Promise<string>; mode: "base" | "variant"; basePrompt?: string; references: Ref[]; disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const isBase = mode === "base";
  const [variantPrompt, setVariantPrompt] = useState("");
  const [refName, setRefName] = useState("");
  const editable = references.filter((r) => r.imageAssetId);
  const [sourceId, setSourceId] = useState<string>("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const keyRef = useRef<string | null>(null);
  const model = useStandaloneModelChoice(isBase ? "places" : "variants", isBase ? "generate" : "edit");
  const source = editable.find((r) => r.id === sourceId) ?? editable[0];
  const prompt = (isBase ? basePrompt : variantPrompt).trim();

  const { data: jobResult } = useGetImageStudioJob(jobId ?? "", {
    query: {
      enabled: !!jobId, queryKey: getGetImageStudioJobQueryKey(jobId ?? ""),
      refetchInterval: (q) => (q.state.data && !ACTIVE.includes(q.state.data.job.status) ? false : 2500),
    },
  });
  const job = jobResult?.job;
  const running = !!job && ACTIVE.includes(job.status);
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Refresh references as soon as a job settles so the new image is editable without reopening.
    if (job && job.status !== lastStatus.current && !ACTIVE.includes(job.status)) {
      void queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
    }
    lastStatus.current = job?.status;
  }, [job, queryClient]);

  const submit = async () => {
    if (inFlight.current || !prompt || !model.canSubmit || disabled) return;
    if (!isBase && !source?.imageAssetId) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const id = await ensureSaved();
      const requestKey = keyRef.current ?? (keyRef.current = newRequestKey());
      const created = await startLocationImageJob(id, {
        ...model.payload(), operation: isBase ? "generate" : "edit", prompt,
        width: 1344, height: 768, count: 1, requestKey,
        referenceAssetIds: !isBase && source?.imageAssetId ? [source.imageAssetId] : [],
        referenceName: refName.trim() || (isBase ? "Base" : `${source?.name ?? "Location"} — edited`),
      });
      keyRef.current = null;
      setJobId(created.id);
      setRefName("");
    } catch (err) {
      setError(readableError(err, "The image could not be queued."));
    } finally {
      model.reset(); // paid confirmation is required again for every image
      inFlight.current = false; setBusy(false);
    }
  };

  const output = job?.assets?.[0] as { url?: string; mediaUrl?: string } | undefined;
  const outputUrl = output?.mediaUrl ?? output?.url;
  const t = isBase ? "location" : "variant";

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-secondary/10 p-3" data-testid={`panel-${t}-image`} aria-busy={busy || running}>
      {!isBase && (editable.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="text-variant-needs-source">Variants are edited from an existing image. Generate or upload one first.</p>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs text-muted-foreground">Source image
            <select className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" value={source?.id ?? ""} onChange={(e) => setSourceId(e.target.value)} data-testid="select-variant-source">
              {editable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Variant name presets">{VARIANT_PRESETS.map((v) => <button key={v} type="button" aria-pressed={refName === v} onClick={() => setRefName(v)} className={`rounded border px-2 py-0.5 text-[11px] hover:border-primary ${refName === v ? "border-primary text-foreground" : "border-border"}`} data-testid={`chip-location-variant-${v.toLowerCase()}`}>{v}</button>)}</div>
          <Textarea value={variantPrompt} onChange={(e) => setVariantPrompt(e.target.value)} aria-label="What to change" className="min-h-20 bg-background/60" placeholder="Same room at night, rain on the windows" data-testid="input-variant-image-prompt" />
          <p className="text-xs text-muted-foreground">AI may also alter other details.</p>
        </div>
      ))}
      {isBase ? <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Image name (optional)</summary>
        <Input value={refName} onChange={(e) => setRefName(e.target.value)} aria-label="Image name (optional)" placeholder="Image name" className="mt-2 bg-background/60" data-testid="input-location-reference-name" />
      </details> : <Input value={refName} onChange={(e) => setRefName(e.target.value)} aria-label="Variant name (optional)" placeholder="Variant name (optional)" className="bg-background/60" data-testid="input-variant-reference-name" />}
      <ModelPicker choice={model} label={isBase ? "Location model" : "Variant model"} />
      <Button type="button" className="w-full gap-2" onClick={() => void submit()}
        disabled={disabled || busy || running || !prompt || !model.canSubmit || (!isBase && !source?.imageAssetId)} data-testid={`button-generate-${t}-image`}>
        {busy || running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        {running ? (job?.status === "QUEUED" ? "Queued" : "Generating") : busy ? "Saving…" : isBase ? "Generate image" : "Create edited image"}
      </Button>
      {isBase && !prompt && <p className="text-xs text-muted-foreground">Add a description above to generate.</p>}
      <div aria-live="polite" className="space-y-2">
        {running && <p className="text-xs text-muted-foreground" data-testid={`status-${t}-job`}>You can close this dialog. The image is added to this location when it finishes.</p>}
        {job?.status === "COMPLETED" && outputUrl && <img src={outputUrl} alt="Generated reference" className="aspect-video w-full rounded-md object-cover" data-testid={`img-${t}-generated`} />}
        {job?.status === "COMPLETED" && <p className="text-xs text-emerald-400" data-testid={`status-${t}-job-done`}>Added to this location's images.</p>}
        {(job?.status === "FAILED" || job?.status === "CANCELLED") && <ErrorNotice testId={`status-${t}-job-failed`} message={job.errorMessage ?? `Image job ${job.status.toLowerCase()}.`} />}
        {error && <ErrorNotice testId={`status-${t}-image-error`} message={error} onDismiss={() => setError(null)} />}
      </div>
    </section>
  );
}
