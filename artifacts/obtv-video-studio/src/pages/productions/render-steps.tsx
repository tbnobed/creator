import { ContentActions } from "./content-manager";
import { SceneOpenings } from "./scene-openings";
import { ModelOptionLabel } from "@/components/shared/model-option";
import { videoCloudOption } from "@/lib/model-option";
import { PaidConfirm } from "@/components/shared/paid-confirm";
import { PropReference } from "./prop-reference";
import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { VIDEO_MODEL_CAPABILITIES, effectiveModelDuration, modelDurationOptions, type FalModel } from "@/lib/video-model-capabilities";
import { Link } from "wouter";
import {
  getGetLongFormProjectQueryKey,
  useCancelLongFormProject,
  useGetGenerationCapabilities,
  useGetLongFormProject,
  usePauseLongFormProject,
} from "@workspace/api-client-react";
import type { LongFormProjectDetail, LongFormShot, ProductionProject } from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, ChevronDown, Clapperboard, Download, ExternalLink, Film, Loader2, Pause, Play, Wand2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { errorMessage, isFailed, isPending, taskIsPaid, type ProductionSettings, type ProductionState } from "@/lib/production-types";
import type { RunAction } from "./workflow";
import { missingSceneryCount } from "./scene-scenery";
import { useConfirm } from "@/components/shared/confirm";
import { correctionIsDisabled, renderNeedsPolling, shotIsRendering } from "@/lib/production-shot-state";

type Base = { state: ProductionState; project?: ProductionProject; run: RunAction; pendingAction: string | null };

function useRender(renderProjectId?: string | null) {
  return useGetLongFormProject(renderProjectId ?? "", {
    query: {
      enabled: !!renderProjectId,
      queryKey: getGetLongFormProjectQueryKey(renderProjectId ?? ""),
      refetchInterval: (q) => {
        const d = q.state.data as LongFormProjectDetail | undefined;
        return d && renderNeedsPolling(d) ? 3000 : false;
      },
    },
  });
}

type ShotPhase = "Waiting" | "Creating" | "Done" | "Failed";
const phase = (s: string): ShotPhase =>
  s === "COMPLETED" ? "Done" : s === "FAILED" ? "Failed" : ["QUEUED", "RENDERING"].includes(s) ? "Creating" : "Waiting";

function PhaseBadge({ p }: { p: ShotPhase }) {
  const map = {
    Done: "bg-emerald-500/15 text-emerald-400", Creating: "bg-primary/15 text-primary",
    Waiting: "bg-muted text-muted-foreground", Failed: "bg-destructive/15 text-destructive",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${map[p]}`}>
      {p === "Creating" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}{p === "Creating" ? "Creating…" : p}
    </span>
  );
}

function Head({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">{n}</p>
      <h2 className="mt-1 text-2xl font-extrabold">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

/* ---------------- Create ---------------- */

const CLOUD_MODELS = Object.keys(VIDEO_MODEL_CAPABILITIES) as FalModel[];
function cloudModelReason(m: FalModel): string | null {
  const c = VIDEO_MODEL_CAPABILITIES[m];
  if (!c.roles.frames) return "Cannot take the previous shot's last frame as a start frame";
  if (!c.roles.images || !c.castImagesSent) return "Cannot take character and place image references";
  if (c.framesExclusiveWithReferences) return "Cannot combine a start frame with image references";
  return null;
}
function cloudDurationProblem(m: FalModel, seconds: number): string | null {
  const effective = effectiveModelDuration(m, seconds, { hasReferenceImages: true });
  if (effective === seconds) return null;
  return `${m} cannot render ${seconds}s shots with references. Supported lengths: ${modelDurationOptions(m, { hasReferenceImages: true }).join(", ")}s. Change the shot length; it is not adjusted for you.`;
}

export function CreateStep({ state, project, run, pendingAction, onSettings, save, onPlaces }: Base & {
  onPlaces: () => void;
  onSettings: (p: Partial<ProductionSettings>) => void; save: () => Promise<ProductionProject | null>;
}) {
  const { toast } = useToast();
  const confirmAction = useConfirm();
  const { data: caps = [], isLoading: capsLoading, error: capsError } = useGetGenerationCapabilities();
  const requiredSlots = Math.max(1, ...state.story.scenes.map(scene => {
    const cast = state.characters.filter(c => scene.characters.some(n => n.toLowerCase() === c.name.toLowerCase()));
    return 2 + (state.propReference ? 1 : 0);
  }));
  const compatible = caps.filter(c => !c.supportsReferenceVideo && c.supportsFirstFrame
    && (c.referenceImageSlots ?? 0) >= requiredSlots);
  const modes = compatible.filter((c, i) => compatible.findIndex(x => x.generationMode === c.generationMode) === i);
  const rid = project?.renderProjectId ?? null;
  const render = useRender(rid);
  const rp = render.data;
  const pause = usePauseLongFormProject();
  const cancel = useCancelLongFormProject();
  const s = state.settings;
  const active = rp && ["RUNNING", "ASSEMBLING"].includes(rp.status);
  const missingScenery = missingSceneryCount(state);
  const sceneryReady = missingScenery === 0;
  const invalidate = () => void render.refetch();

  const shotsByScene = new Map<number, LongFormShot[]>();
  rp?.shots.forEach((sh) => shotsByScene.set(sh.sceneNumber, [...(shotsByScene.get(sh.sceneNumber) ?? []), sh]));
  const sceneNumbers = Array.from(new Set([...state.story.scenes.map((x) => x.sceneNumber), ...shotsByScene.keys()])).sort((a, b) => a - b);

  const cloud = s.videoProvider === "FAL";
  const cloudModel = cloud && s.videoModel && (CLOUD_MODELS as string[]).includes(s.videoModel) ? (s.videoModel as FalModel) : null;
  const cloudProblem = cloud ? (!cloudModel ? "Choose a cloud model" : cloudModelReason(cloudModel) ?? cloudDurationProblem(cloudModel, s.shotDurationSeconds)) : null;
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [s.videoProvider, s.videoModel]);
  const ready = (!state.propReference || state.propReference.approvedAssetId === state.propReference.assetId)
    && state.story.scenes.every(scene=>scene.opening?.status==="READY" && !!scene.opening.assetId && scene.opening.approvedAssetId===scene.opening.assetId)
    && (cloud ? !cloudProblem && confirmed : modes.some(m => m.generationMode === s.generationMode));

  const createAll = async () => {
    if (!ready) return;
    const payload = cloud ? { cloudConfirmed: true } : {};
    setConfirmed(false);
    const saved = await save();
    if (!saved) return;
    if (await run("create-scenes", payload)) toast({ title: "Scenes queued", description: "Rendering in scene order. You can leave this page." });
  };

  return (
    <div>
      <Head n="05 / Create" title="Roll camera" sub="Choose a model, then create every scene in order." />
      {missingScenery > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" data-testid="alert-missing-scenery">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{missingScenery} scene{missingScenery === 1 ? " needs" : "s need"} scenery before rendering.</span>
          <button type="button" className="font-semibold underline" data-testid="button-go-places"
            onClick={onPlaces}>Assign in Places</button>
        </div>
      )}

      <PropReference state={state} run={run} busy={!!active || pendingAction !== null} />
      <SceneOpenings state={state} run={run} busy={!!active || pendingAction !== null || state.tasks.some(task=>["QUEUED","RUNNING"].includes(task.status))} />
      <section className="mb-6 grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6" data-testid="section-render-settings">
        <div className="space-y-2 sm:col-span-2 lg:col-span-6" data-testid="picker-video-provider">
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!!active} aria-pressed={!cloud}
              onClick={() => onSettings({ videoProvider: "COMFYUI", generationMode: s.generationMode.startsWith("cloud:") ? "" : s.generationMode })}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${!cloud ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`} data-testid="button-provider-local">
              Local workflow <span className="ml-1 text-[10px] text-emerald-400">LOCAL</span>
            </button>
            <button type="button" disabled={!!active} aria-pressed={cloud}
              onClick={() => onSettings({ videoProvider: "FAL", generationMode: s.videoModel ? `cloud:${s.videoModel}` : "" })}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${cloud ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`} data-testid="button-provider-cloud">
              Cloud model <span className="ml-1 text-[10px] text-amber-300">PAID</span>
            </button>
          </div>
        </div>
        {!cloud ? (
        <div className="sm:col-span-2">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Workflow</label>
          <Select value={s.generationMode && !s.generationMode.startsWith("cloud:") ? s.generationMode : undefined} onValueChange={(v) => onSettings({ generationMode: v, videoProvider: "COMFYUI" })} disabled={!!active}>
            <SelectTrigger className="mt-1" data-testid="select-workflow"><SelectValue placeholder={capsLoading ? "Loading workflows" : "Choose a workflow"} /></SelectTrigger>
            <SelectContent>
              {modes.map((m) => <SelectItem key={m.generationMode} value={m.generationMode}>{m.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {capsError ? <p className="mt-1 text-xs text-destructive">Could not load workflows: {errorMessage(capsError)}</p>
            : !capsLoading && !modes.some(m => m.generationMode === s.generationMode) ? <p className="mt-1 text-xs text-amber-300">{modes.length ? "Choose a compatible workflow." : `No active local workflow supports a starting frame plus ${requiredSlots} separate cast/scenery references. Install a compatible workflow before rendering.`}</p> : null}
        </div>
        ) : (
        <div className="sm:col-span-2">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Cloud model</label>
          <Select value={cloudModel ?? undefined} onValueChange={(v) => onSettings({ videoProvider: "FAL", videoModel: v, generationMode: `cloud:${v}` })} disabled={!!active}>
            <SelectTrigger className="mt-1" data-testid="select-cloud-model"><SelectValue placeholder="Choose a cloud model" /></SelectTrigger>
            <SelectContent>
              {CLOUD_MODELS.map((m) => {
                const why = cloudModelReason(m);
                return (
                  <SelectItem key={m} value={m} disabled={!!why} data-testid={`option-cloud-model-${m}`}>
                    <ModelOptionLabel option={videoCloudOption({ value: m, label: m }, why)} />
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {cloudModel && <p className="mt-1 text-xs text-muted-foreground">Native lengths: {modelDurationOptions(cloudModel, { hasReferenceImages: true }).join(", ")}s</p>}
        </div>
        )}
        <details className="sm:col-span-2 lg:col-span-6" data-testid="details-advanced-settings">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted-foreground" data-testid="toggle-advanced-settings">
            Advanced · {s.width}x{s.height} · {s.fps} fps · {s.qualityPreset.toLowerCase()} · {s.shotDurationSeconds}s shots
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <NumField label="Width" value={s.width} step={64} onChange={(v) => onSettings({ width: v })} id="width" disabled={!!active} />
        <NumField label="Height" value={s.height} step={64} onChange={(v) => onSettings({ height: v })} id="height" disabled={!!active} />
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">FPS</label>
          <Select value={String(s.fps)} onValueChange={(v) => onSettings({ fps: Number(v) as 24 | 25 | 30 })} disabled={!!active}>
            <SelectTrigger className="mt-1" data-testid="select-fps"><SelectValue /></SelectTrigger>
            <SelectContent>{[24, 25, 30].map((f) => <SelectItem key={f} value={String(f)}>{f}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Quality</label>
          <Select value={s.qualityPreset} onValueChange={(v) => onSettings({ qualityPreset: v as ProductionSettings["qualityPreset"] })} disabled={!!active}>
            <SelectTrigger className="mt-1" data-testid="select-quality"><SelectValue /></SelectTrigger>
            <SelectContent>{["DRAFT", "STANDARD", "HIGH"].map((q) => <SelectItem key={q} value={q}>{q.charAt(0) + q.slice(1).toLowerCase()}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <NumField label="Shot length (s)" value={s.shotDurationSeconds} step={1} onChange={(v) => onSettings({ shotDurationSeconds: v })} id="shot-duration" disabled={!!active} />
          </div>
        </details>
        {cloud && (
          <div className="space-y-2 sm:col-span-2 lg:col-span-6">
            {cloudProblem && <p className="text-xs text-destructive" data-testid="text-cloud-problem">{cloudProblem}</p>}
            {cloudModel && !cloudProblem && (
              <PaidConfirm checked={confirmed} onChange={setConfirmed} testId="confirm-paid-render" checkboxTestId="checkbox-paid-render">
                I confirm paid cloud rendering with {cloudModel}: one billed request per shot across all scenes. Requires configured provider credentials on the server.
              </PaidConfirm>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5">
          <Button className="brand-glow" disabled={!ready || !sceneryReady || !!active || pendingAction !== null || state.story.scenes.length === 0}
            onClick={() => void createAll()} data-testid="button-create-all">
            {pendingAction === "create-scenes" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {rp?.status === "CANCELLED" ? "Resume remaining scenes" : rp ? "Create remaining scenes" : "Create all scenes"}
          </Button>
          {rp?.status === "RUNNING" && (
            <Button variant="secondary" disabled={pause.isPending} onClick={() => pause.mutate({ id: rp.id }, { onSuccess: invalidate, onError: (e) => toast({ title: "Pause failed", description: errorMessage(e), variant: "destructive" }) })} data-testid="button-pause-render">
              <Pause className="mr-1.5 h-4 w-4" /> Pause
            </Button>
          )}
          {rp && ["RUNNING", "PAUSED", "READY"].includes(rp.status) && (
            <Button variant="outline" className="border-destructive/30 text-destructive" disabled={cancel.isPending}
              onClick={async () => { if (await confirmAction({ title: "Cancel rendering?", description: "Finished shots are kept. You can resume remaining scenes later.", confirmLabel: "Cancel rendering", destructive: true })) cancel.mutate({ id: rp.id }, { onSuccess: invalidate, onError: (e) => toast({ title: "Cancel failed", description: errorMessage(e), variant: "destructive" }) }); }}
              data-testid="button-cancel-render">
              <XCircle className="mr-1.5 h-4 w-4" /> Cancel
            </Button>
          )}
          {rid && (
            <Link href={`/projects/${rid}`} className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" data-testid="link-advanced-editor">
              Advanced timeline and still approval <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      </section>

      {rp && (
        <div className="mb-4" data-testid="status-render-progress">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{rp.status} · {rp.completedShots}/{rp.totalShots} shots</span><span>{Math.round(rp.progress)}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full brand-gradient transition-transform duration-700 origin-left" style={{ transform: `scaleX(${rp.progress / 100})` }} /></div>
          {rp.errorMessage && <p className="mt-2 text-xs text-amber-300" data-testid="text-render-message">{rp.errorMessage}</p>}
        </div>
      )}
      {render.error && <p className="mb-4 text-sm text-destructive">Could not load render status: {errorMessage(render.error)} <button className="underline" onClick={invalidate}>Retry</button></p>}

      <div className="space-y-4">
        <ol className="space-y-2" data-testid="list-scenes-render">
          {sceneNumbers.length === 0 && <li className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No scenes yet. Draft your story first.</li>}
          {sceneNumbers.map((n) => {
            const meta = state.story.scenes.find((x) => x.sceneNumber === n);
            return <SceneRow key={n} editable={!!meta} n={n} title={meta?.title ?? `Scene ${n}`} where={meta ? `${meta.location} · ${meta.timeOfDay}` : ""} shots={shotsByScene.get(n) ?? []} run={run} busy={pendingAction !== null} />;
          })}
        </ol>
        <JobQueue state={state} run={run} busy={pendingAction === "retry-task"} />
      </div>
    </div>
  );
}

function NumField({ label, value, onChange, step, id, disabled }: { label: string; value: number; onChange: (v: number) => void; step: number; id: string; disabled?: boolean }) {
  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <Input type="number" step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="mt-1" data-testid={`input-${id}`} />
    </div>
  );
}

function SceneRow({ n, title, where, shots, run, busy, editable=false }: { n: number; title: string; where: string; shots: LongFormShot[]; run: RunAction; busy: boolean; editable?:boolean }) {
  const [open, setOpen] = useState(false);
  const done = shots.filter((s) => s.status === "COMPLETED").length;
  const p: ShotPhase = shots.length === 0 ? "Waiting" : shots.some((s) => s.status === "FAILED") ? "Failed"
    : done === shots.length ? "Done" : shots.some((s) => phase(s.status) === "Creating") ? "Creating" : "Waiting";
  const thumb = shots.find((s) => s.outputUrl)?.outputUrl;
  return (
    <li className="relative rounded-xl border border-border bg-card" data-testid={`row-scene-${n}`}>
      {editable && <ContentActions step={0} id={String(n)}/>}
      <button type="button" onClick={() => setOpen((o) => !o)} className={`flex w-full items-center gap-3 p-3 text-left ${editable ? "pr-20" : ""}`} data-testid={`button-expand-scene-${n}`}>
        <div className="h-12 w-20 shrink-0 overflow-hidden rounded-md bg-muted">
          {thumb ? <video src={thumb} muted preload="metadata" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Film className="h-4 w-4 text-muted-foreground/40" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold"><span className="mr-2 font-mono text-xs text-primary">{String(n).padStart(2, "0")}</span>{title}</p>
          <p className="truncate text-xs text-muted-foreground">{where}</p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full origin-left bg-primary transition-transform duration-500" style={{ transform: `scaleX(${shots.length ? done / shots.length : 0})` }} /></div>
        </div>
        <PhaseBadge p={p} />
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 p-3">
          {shots.length === 0 ? <p className="text-xs text-muted-foreground">Shots appear once rendering is prepared.</p> : shots.map((sh) => <ShotFix key={sh.id} shot={sh} run={run} busy={busy} />)}
        </div>
      )}
    </li>
  );
}

export function ShotFix({ shot, run, busy, initial = "" }: { shot: LongFormShot; run: RunAction; busy: boolean; initial?: string }) {
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const p = phase(shot.status);
  return (
    <div className="rounded-lg bg-background/50 p-2.5" data-testid={`shot-${shot.id}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{shot.sceneNumber}.{shot.shotNumber}</span>
        <span className="min-w-0 flex-1 truncate">{shot.title}</span>
        <PhaseBadge p={p} />
        {shot.outputUrl && <Button size="sm" variant="ghost" className="h-7 text-xs"
          aria-expanded={preview} aria-controls={`preview-${shot.id}`}
          onClick={() => { setPreview(v => !v); setPlaybackError(false); }}
          data-testid={`button-preview-shot-${shot.id}`}>{preview ? "Hide preview" : "Preview"}</Button>}
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setOpen((o) => !o); if (shot.outputUrl) setPreview(true); }} disabled={busy || shotIsRendering(shot.status)} data-testid={`button-correct-shot-${shot.id}`}>Correct</Button>
      </div>
      {preview && shot.outputUrl && <div id={`preview-${shot.id}`} className="mt-3">
        <video key={shot.outputUrl} src={shot.outputUrl} controls playsInline preload="metadata"
          aria-label={`Preview scene ${shot.sceneNumber}, shot ${shot.shotNumber}`}
          className="aspect-video max-h-[60vh] w-full rounded-lg bg-black object-contain"
          onError={() => setPlaybackError(true)}
          data-testid={`video-shot-${shot.id}`} />
        {playbackError && <p role="alert" className="mt-2 text-xs text-destructive">This clip could not be loaded. <a href={shot.outputUrl} target="_blank" rel="noreferrer" className="underline">Open the video directly</a>.</p>}
      </div>}
      {shot.errorMessage && <p role="alert" className="mt-1 text-xs text-destructive">{shot.errorMessage}</p>}
      {open && (
        <div className="mt-2 flex gap-2">
          <Input value={text} onChange={(e) => setText(e.target.value)} disabled={busy || shotIsRendering(shot.status)} placeholder="Describe what to change in this shot" className="h-8 text-sm" data-testid={`input-correction-${shot.id}`} />
          <Button size="sm" disabled={correctionIsDisabled(shot.status, text, busy)} onClick={async () => { if (correctionIsDisabled(shot.status, text, busy)) return; if (await run("fix-shot", { shotId: shot.id, correction: text.trim() })) setOpen(false); }} data-testid={`button-submit-fix-${shot.id}`}>
            {shotIsRendering(shot.status) ? "Render in progress" : busy ? "Submitting…" : "Re-render shot"}
          </Button>
        </div>
      )}
    </div>
  );
}

function JobQueue({ state, run, busy }: { state: ProductionState; run: RunAction; busy: boolean }) {
  const all = [...state.tasks].reverse();
  const live = all.filter((t) => isPending(t.status) || isFailed(t.status));
  const done = all.filter((t) => !isPending(t.status) && !isFailed(t.status));
  if (!all.length) return null;
  return (
    <aside className="rounded-xl border border-border bg-card/60 p-3" data-testid="panel-job-queue">
      {live.length > 0 && <TaskList tasks={live} run={run} busy={busy} />}
      {done.length > 0 && (
        <details className={live.length ? "mt-2" : ""} data-testid="details-job-history">
          <summary className="cursor-pointer text-xs text-muted-foreground" data-testid="toggle-job-history">Completed jobs ({done.length})</summary>
          <div className="mt-2"><TaskList tasks={done} run={run} busy={busy} /></div>
        </details>
      )}
    </aside>
  );
}

function TaskList({ tasks, run, busy }: { tasks: ProductionState["tasks"]; run: RunAction; busy: boolean }) {
  const confirmAction = useConfirm();
  return (
        <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2 text-xs" data-testid={`task-${t.id}`}>
              {isPending(t.status) ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-primary" /> : isFailed(t.status) ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" /> : <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />}
              <div className="min-w-0"><p className="truncate">{t.type.replace(/-/g, " ")} <span className="text-muted-foreground">· {t.status.toLowerCase()}</span></p>
                {t.error && <p role="alert" className="text-destructive">{t.error}</p>}
                {isFailed(t.status) && <button type="button" disabled={busy} onClick={async () => {
                  if (taskIsPaid(t)) {
                    if (!(await confirmAction({ title: `Retry "${t.type.replace(/-/g, " ")}"?`, description: "This uses a paid provider and will be billed again.", confirmLabel: "Retry paid task" }))) return;
                    void run("retry-task", { id: t.id, cloudConfirmed: true });
                  } else void run("retry-task", { id: t.id });
                }} className="mt-0.5 text-primary underline disabled:opacity-50" data-testid={`button-retry-task-${t.id}`}>Retry</button>}</div>
            </li>
          ))}
        </ul>
  );
}

/* ---------------- Review ---------------- */

export function ReviewStep({ state, project, run, pendingAction }: Base) {
  const rid = project?.renderProjectId ?? null;
  const render = useRender(rid);
  const rp = render.data;
  const issues = state.review.issues;
  const notChecked = state.review.status === "NOT_IMPLEMENTED";
  const shotById = new Map((rp?.shots ?? []).map((s) => [s.id, s]));
  const allShots = rp?.shots ?? [];
  const doneShots = allShots.filter((s) => s.status === "COMPLETED" && !!s.outputUrl);
  // Export only a complete cut: every shot must be finished with a playable output.
  const exportReady = allShots.length > 0 && doneShots.length === allShots.length;
  const exporting = pendingAction === "export" || rp?.status === "ASSEMBLING";

  return (
    <div>
      <Head n="06 / Review" title="Watch it through" sub="Check the assembled cut, correct any shot in plain language, then export one MP4." />
      {!rid ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground" data-testid="empty-review">
          <Clapperboard className="mx-auto mb-3 h-6 w-6" /> Nothing rendered yet. Create your scenes in step 5 first.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <section>
            <div className="overflow-hidden rounded-xl border border-border bg-black/60">
              {rp?.finalOutputUrl ? <video src={rp.finalOutputUrl} controls playsInline className="aspect-video w-full" data-testid="video-final-cut" />
                : <div className="flex aspect-video flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                  {exporting ? <><Loader2 className="h-6 w-6 animate-spin text-primary" /> Stitching shots</> : <><Film className="h-6 w-6" /> Export to assemble the cut</>}
                </div>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button className="brand-glow" disabled={exporting || !exportReady || pendingAction !== null} onClick={() => void run("export", {})} data-testid="button-export">
                {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Film className="mr-2 h-4 w-4" />} {rp?.finalOutputUrl ? "Re-export" : "Export MP4"}
              </Button>
              {!exportReady && allShots.length > 0 && !exporting && (
                <span className="self-center text-xs text-muted-foreground" data-testid="text-export-blocked">{doneShots.length} of {allShots.length} shots finished. Export unlocks when every shot has a clip.</span>
              )}
              {rp?.finalOutputUrl && (
                <a href={rp.finalOutputUrl} download className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm hover:bg-muted" data-testid="link-download-final">
                  <Download className="h-4 w-4" /> Download
                </a>
              )}
              <Link href={`/projects/${rid}`} className="inline-flex h-9 items-center gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground" data-testid="link-advanced-editor-review">
                Open full editor <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
            {doneShots.length > 0 && (
              <details className="mt-5 rounded-xl border border-border bg-card/60 p-3">
                <summary className="cursor-pointer text-sm font-semibold" data-testid="toggle-manual-corrections">Correct a shot manually</summary>
                <div className="mt-3 space-y-2">{doneShots.map((s) => <ShotFix key={s.id} shot={s} run={run} busy={pendingAction !== null} />)}</div>
              </details>
            )}
          </section>

          <aside className="space-y-3" data-testid="panel-review-issues">
            <div className="flex items-center justify-between">
              <h3 className="font-bold" data-testid="text-issue-count">{issues.length} thing{issues.length === 1 ? "" : "s"} to check</h3>
              {notChecked && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300" data-testid="status-continuity">Continuity: not checked</span>}
            </div>
            {notChecked && (
              <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-100/80">
                Automatic continuity checking is not available yet. Watch the cut and use manual corrections for anything that looks off.
              </p>
            )}
            {issues.map((iss) => {
              const shot = iss.shotId ? shotById.get(iss.shotId) : undefined;
              return (
                <article key={iss.id} className="rounded-xl border border-border bg-card p-3" data-testid={`card-issue-${iss.id}`}>
                  <p className="font-mono text-[11px] text-primary">{iss.timecode ?? (iss.sceneNumber ? `Scene ${iss.sceneNumber}` : "")}</p>
                  <p className="mt-1 text-sm">{iss.description}</p>
                  {(iss.shotId || iss.sceneNumber != null) && (
                    <Button size="sm" className="mt-2" disabled={pendingAction !== null || (shot && phase(shot.status) === "Creating")}
                      onClick={() => void run("fix-shot", { shotId: iss.shotId, sceneNumber: iss.sceneNumber, correction: iss.correction ?? iss.description })} data-testid={`button-fix-issue-${iss.id}`}>
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" /> Fix it for me
                    </Button>
                  )}
                </article>
              );
            })}
            {issues.length === 0 && !notChecked && (
              <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-300" data-testid="text-all-clear">The continuity check reported no issues. Watch the cut before exporting.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
