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
 * Prompt-first image generation for a library location. Base images use text-to-image;
 * named variants edit an existing reference so the set stays recognisable.
 * Jobs are durable server-side: closing the dialog does not lose the result.
 */
export function LocationImageJob({ ensureSaved, defaultPrompt, references }: {
  ensureSaved: () => Promise<string>; defaultPrompt: string; references: Ref[];
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"base" | "variant">("base");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [refName, setRefName] = useState("");
  const editable = references.filter((r) => r.imageAssetId);
  const [sourceId, setSourceId] = useState<string>("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const baseModel = useStandaloneModelChoice("places", "generate");
  const variantModel = useStandaloneModelChoice("variants", "edit");
  const model = mode === "base" ? baseModel : variantModel;
  const source = editable.find((r) => r.id === sourceId) ?? editable[0];

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
    if (job && job.status !== lastStatus.current && !ACTIVE.includes(job.status)) {
      void queryClient.invalidateQueries({ queryKey: getListSettingsQueryKey() });
    }
    lastStatus.current = job?.status;
  }, [job, queryClient]);

  const submit = async () => {
    if (!prompt.trim() || !model.canSubmit || busy) return;
    if (mode === "variant" && (!source?.imageAssetId || !refName.trim())) return;
    setBusy(true); setError(null);
    try {
      const id = await ensureSaved();
      const requestKey = keyRef.current ?? (keyRef.current = newRequestKey());
      const created = await startLocationImageJob(id, {
        ...model.payload(), operation: mode === "base" ? "generate" : "edit", prompt: prompt.trim(),
        width: 1344, height: 768, count: 1, requestKey,
        referenceAssetIds: mode === "variant" && source?.imageAssetId ? [source.imageAssetId] : [],
        ...(refName.trim() ? { referenceName: refName.trim() } : {}),
      });
      keyRef.current = null;
      setJobId(created.id);
      if (mode === "variant") setRefName("");
    } catch (err) {
      setError(readableError(err, "The image could not be queued."));
    } finally {
      model.reset(); // paid confirmation is required again for every image
      setBusy(false);
    }
  };

  const output = job?.assets?.[0] as { url?: string; mediaUrl?: string } | undefined;
  const outputUrl = output?.mediaUrl ?? output?.url;

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-secondary/10 p-3" data-testid="panel-location-image">
      <div className="flex gap-1 rounded-md bg-secondary/40 p-1 text-xs" role="tablist" aria-label="Image type">
        {(["base", "variant"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={`flex-1 rounded px-2 py-1.5 font-medium ${mode === m ? "bg-background text-foreground shadow" : "text-muted-foreground"}`} data-testid={`tab-location-${m}`}>
            {m === "base" ? "New reference" : "Named variant"}
          </button>
        ))}
      </div>
      {mode === "variant" && (
        editable.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-variant-needs-source">Variants are edited from an existing reference. Generate or upload a base image first.</p>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs text-muted-foreground">Source reference
              <select className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" value={source?.id ?? ""} onChange={(e) => setSourceId(e.target.value)} data-testid="select-variant-source">
                {editable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-1">{VARIANT_PRESETS.map((v) => <button key={v} type="button" onClick={() => setRefName(v)} className="rounded border border-border px-2 py-0.5 text-[11px] hover:border-primary" data-testid={`chip-location-variant-${v.toLowerCase()}`}>{v}</button>)}</div>
          </div>
        )
      )}
      <Input value={refName} onChange={(e) => setRefName(e.target.value)} placeholder={mode === "variant" ? "Variant name (required)" : "Reference name (optional)"} className="bg-background/60" data-testid="input-location-reference-name" />
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-20 bg-background/60" placeholder={mode === "variant" ? "Same room at night, rain on the windows" : "Wide establishing view of the location"} data-testid="input-location-image-prompt" />
      <ModelPicker choice={model} label={mode === "base" ? "Location model" : "Variant model"} />
      <Button type="button" className="w-full gap-2" onClick={() => void submit()}
        disabled={busy || running || !prompt.trim() || !model.canSubmit || (mode === "variant" && (!source?.imageAssetId || !refName.trim()))} data-testid="button-generate-location-image">
        {busy || running ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        {running ? (job?.status === "QUEUED" ? "Queued" : "Generating") : mode === "base" ? "Generate reference" : "Generate variant"}
      </Button>
      {running && <p className="text-xs text-muted-foreground" data-testid="status-location-job">You can close this dialog. The image is added to this location when it finishes.</p>}
      {job?.status === "COMPLETED" && outputUrl && <img src={outputUrl} alt="Generated reference" className="aspect-video w-full rounded-md object-cover" data-testid="img-location-generated" />}
      {job?.status === "COMPLETED" && <p className="text-xs text-emerald-400" data-testid="status-location-job-done">Added to this location's references.</p>}
      {(job?.status === "FAILED" || job?.status === "CANCELLED") && <ErrorNotice testId="status-location-job-failed" message={job.errorMessage ?? `Image job ${job.status.toLowerCase()}.`} />}
      {error && <ErrorNotice testId="status-location-image-error" message={error} onDismiss={() => setError(null)} />}
    </section>
  );
}
