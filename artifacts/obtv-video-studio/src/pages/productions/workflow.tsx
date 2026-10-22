import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  customFetch,
  getProductionProject,
  getGetProductionProjectQueryKey,
  getListProductionProjectsQueryKey,
  useCreateProductionProject,
  useGetProductionProject,
  useRunProductionAction,
  useUpdateProductionProject,
} from "@workspace/api-client-react";
import type { ProductionProject } from "@workspace/api-client-react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CloudOff, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  DEFAULT_SETTINGS, STEPS, errorMessage, isConflict, needsPolling, normalizeState,
  type ProductionSettings, type ProductionState, type Story,
} from "@/lib/production-types";
import { StoryStep } from "./story-step";
import { CharactersStep, PlacesStep, WardrobeStep } from "./cast-steps";
import { CreateStep, ReviewStep } from "./render-steps";
import { draftFrom, draftPatch, rebaseDraft, sameDraftValue, ProductionDraftConflict, type ProductionDraft as Draft } from "@/lib/production-draft";

export type RunAction = (action: string, payload?: Record<string, unknown>) => Promise<ProductionProject | null>;
const isStoryActive = (status: string) => ["QUEUED", "RUNNING"].includes(status);

const EMPTY: Draft = { title: "", step: 0, story: { summary: "", script: "", targetMinutes: 3, sourceMode: "summary", scenes: [] }, settings: DEFAULT_SETTINGS };

export default function ProductionWorkflowPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id && params.id !== "new" ? params.id : undefined;
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const savingRef = useRef(false);

  const query = useGetProductionProject(id ?? "", {
    query: {
      enabled: !!id,
      queryKey: getGetProductionProjectQueryKey(id ?? ""),
      refetchInterval: (q) => {
        if (savingRef.current) return false;
        const d = q.state.data as ProductionProject | undefined;
        return d && needsPolling(normalizeState(d.state as Record<string, unknown>)) ? 2000 : false;
      },
    },
  });
  const project = query.data;
  const createM = useCreateProductionProject();
  const updateM = useUpdateProductionProject();
  const actionM = useRunProductionAction();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean; canKeepLocal?: boolean } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; retry: () => void } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const initFor = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const projectRef = useRef<ProductionProject | null | undefined>(project);
  if (project && (!projectRef.current || project.id !== projectRef.current.id || project.revision >= projectRef.current.revision)) projectRef.current = project;
  const draftRef = useRef(draft);
  const baselineRef = useRef<Draft>(EMPTY);
  const retryOverrideRef = useRef<Partial<Draft> | undefined>(undefined);

  // Sync server -> draft only when the user has no unsaved edits.
  useEffect(() => {
    if (!project) return;
    if (projectRef.current && project.id === projectRef.current.id && project.revision < projectRef.current.revision) return;
    if (initFor.current !== project.id || !dirtyRef.current) {
      initFor.current = project.id;
      const next = draftFrom(project);
      baselineRef.current = next; draftRef.current = next; setDraft(next);
    }
  }, [project?.id, project?.revision, project?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const state: ProductionState = useMemo(() => {
    const server = normalizeState((project?.state ?? {}) as Record<string, unknown>);
    return { ...server, step: draft.step, story: { ...server.story, ...draft.story }, settings: draft.settings };
  }, [project, draft]);

  const edit = useCallback((patch: Partial<Draft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next; setDraft(next); dirtyRef.current = true;
    setDirty(true);
  }, []);
  const editStory = useCallback((patch: Partial<Draft["story"]>) => {
    const d = draftRef.current, next = { ...d, story: { ...d.story, ...patch } };
    draftRef.current = next; setDraft(next); dirtyRef.current = true;
    setDirty(true);
  }, []);
  const editSettings = useCallback((patch: Partial<ProductionSettings>) => {
    const d = draftRef.current, next = { ...d, settings: { ...d.settings, ...patch } };
    draftRef.current = next; setDraft(next); dirtyRef.current = true;
    setDirty(true);
  }, []);

  const commit = (p: ProductionProject) => {
    qc.setQueryData(getGetProductionProjectQueryKey(p.id), p);
    void qc.invalidateQueries({ queryKey: getListProductionProjectsQueryKey() });
  };

  const createMutRef = useRef(createM.mutateAsync); createMutRef.current = createM.mutateAsync;
  const updateMutRef = useRef(updateM.mutateAsync); updateMutRef.current = updateM.mutateAsync;
  const actionMutRef = useRef(actionM.mutateAsync); actionMutRef.current = actionM.mutateAsync;

  /** Persist the draft. Returns the latest server project, or null on failure (draft kept). */
  const save = useCallback(async (override?: Partial<Draft>, keepLocal = false): Promise<ProductionProject | null> => {
    if (savingRef.current) return null;
    savingRef.current = true; setSavingDraft(true);
    const initial = draftRef.current, base = baselineRef.current;
    const proposed = { ...initial, ...override };
    const d = { ...proposed, title: proposed.title.trim() || "Untitled production" };
    retryOverrideRef.current = override;
    setSaveError(null);
    try {
      const current = projectRef.current;
      let saved: ProductionProject;
      if (!current) {
        saved = await createMutRef.current({ data: { title: d.title, state: { step: d.step, story: d.story, settings: d.settings } } });
      } else {
        await qc.cancelQueries({ queryKey: getGetProductionProjectQueryKey(current.id) });
        saved = current;
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = await getProductionProject(current.id);
          const merged = rebaseDraft(base, d, draftFrom(latest), keepLocal);
          const patch = draftPatch(draftFrom(latest), merged);
          if (!patch.title && !Object.keys(patch.state).length) { saved = latest; break; }
          try {
            saved = await updateMutRef.current({ id: latest.id, data: { ...patch, title: patch.title ?? latest.title, revision: latest.revision } });
            break;
          } catch (err) {
            if (!isConflict(err) || attempt === 2) throw err;
            await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
          }
        }
        await qc.cancelQueries({ queryKey: getGetProductionProjectQueryKey(current.id) });
      }
      projectRef.current = saved;
      initFor.current = saved.id;
      const server = draftFrom(saved);
      const next = draftRef.current === initial ? server : rebaseDraft(initial, draftRef.current, server, true);
      baselineRef.current = server; draftRef.current = next;
      dirtyRef.current = !sameDraftValue(next, server);
      setDraft(next); setDirty(dirtyRef.current);
      commit(saved);
      retryOverrideRef.current = undefined;
      return saved;
    } catch (err) {
      const competingEdit = err instanceof ProductionDraftConflict;
      const conflict = competingEdit || isConflict(err);
      setSaveError({
        conflict, canKeepLocal: competingEdit,
        message: competingEdit ? err.message : conflict
          ? `${errorMessage(err)} Your edits are retained. Retry once the background update finishes.`
          : errorMessage(err),
      });
      return null;
    } finally {
      savingRef.current = false; setSavingDraft(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run: RunAction = useCallback(async (action, payload = {}) => {
    if (action === "fix-shot" && normalizeState(projectRef.current?.state ?? {}).settings.videoProvider === "FAL") {
      if (!window.confirm("This correction will submit a new paid render. Continue?")) return null;
      payload = { ...payload, cloudConfirmed: true };
    }
    setActionError(null);
    setPendingAction(action);
    try {
      let current = projectRef.current;
      if (action !== "cancel-story" && (!current || dirtyRef.current)) current = await save();
      else if (action === "cancel-story") { /* Never save edits or wait on the inference lock to cancel. */ }
      else if (current) {
        current = await getProductionProject(current.id);
        projectRef.current = current;
        commit(current);
      }
      if (!current) return null;
      const result = await actionMutRef.current({ id: current.id, data: { action, revision: current.revision, payload } });
      projectRef.current = result;
      commit(result);
      return result;
    } catch (err) {
      const message = errorMessage(err);
      setActionError({ message: `${action}: ${message}`, retry: () => void run(action, payload) });
      toast({ title: "Action failed", description: message, variant: "destructive" });
      return null;
    } finally {
      setPendingAction(null);
    }
  }, [save]); // eslint-disable-line react-hooks/exhaustive-deps

  const goToStep = async (step: number) => {
    const saved = await save({ step });
    if (saved) {
      if (!id) setLocation(`/productions/${saved.id}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const draftStory = async (payload: Record<string, unknown>) => {
    const result = await run("draft-story", payload);
    if (result && !id) setLocation(`/productions/${result.id}`);
  };

  const uploadScript = async (file: File) => {
    const ext = file.name.toLowerCase().split(".").pop();
    if (!["txt", "fdx", "pdf"].includes(ext ?? "")) {
      toast({ title: "Unsupported file", description: "Use a .txt, .fdx or .pdf script.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      let current = projectRef.current;
      if (!current || dirtyRef.current) current = await save();
      if (!current) return;
      const result = await customFetch<ProductionProject>(`/api/production-projects/${current.id}/script`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "x-file-name": file.name },
        body: file,
      });
      projectRef.current = result;
      commit(result);
      setDraft(draftFrom(result));
      draftRef.current = draftFrom(result); baselineRef.current = draftRef.current;
      dirtyRef.current = false; setDirty(false);
      toast({ title: "Script uploaded", description: file.name });
      if (!id) setLocation(`/productions/${result.id}`);
    } catch (err) {
      toast({ title: "Upload failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const reloadServer = async () => {
    const r = await query.refetch();
    if (r.isError || !r.data) {
      toast({ title: "Could not load the server copy", description: "Your unsaved edits are still here.", variant: "destructive" });
    } else {
      projectRef.current = r.data; draftRef.current = draftFrom(r.data); baselineRef.current = draftRef.current;
      dirtyRef.current = false; setDirty(false); setSaveError(null); setDraft(draftRef.current);
    }
  };

  if (id && query.isLoading) return <WorkflowSkeleton />;
  if (id && (query.error || !project)) {
    return (
      <div className="p-6 md:p-10">
        <div className="mx-auto max-w-lg rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-center" data-testid="error-production-load">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <h2 className="text-lg font-bold">Could not open this production</h2>
          <p className="mt-1 text-sm text-muted-foreground">{errorMessage(query.error) || "Not found"}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={() => query.refetch()} data-testid="button-retry-production">Try again</Button>
            <Link href="/projects" className="inline-flex h-9 items-center rounded-md px-4 text-sm hover:bg-muted" data-testid="link-back-projects">All productions</Link>
          </div>
        </div>
      </div>
    );
  }

  const step = draft.step;
  const saving = savingDraft || createM.isPending || updateM.isPending;
  const ds = state.story.draftStatus?.toUpperCase();
  const scenesReady = state.story.scenes.length > 0 && (!ds || ds === "READY");
  const nextDisabled = saving || (step === 0 && !scenesReady) || step === 5;

  return (
    <div className="production-flow relative min-h-full bg-background">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_20%_0%,rgba(255,31,98,0.12),transparent),radial-gradient(50%_100%_at_90%_0%,rgba(139,43,226,0.14),transparent)]" />
      <div className="relative mx-auto max-w-6xl px-4 pt-5 md:px-8 md:pt-8">
        <div className="flex items-center justify-between gap-3">
          <Link href="/projects" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground" data-testid="link-productions">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Productions
          </Link>
          <SaveIndicator saving={saving} dirty={dirty} error={!!saveError} saved={!!project} onSave={() => void save()} />
        </div>

        <input
          value={draft.title}
          onChange={(e) => edit({ title: e.target.value })}
          placeholder="Name your production"
          maxLength={180}
          className="mt-3 w-full bg-transparent text-3xl font-extrabold tracking-tight outline-none placeholder:text-muted-foreground/40 md:text-5xl"
          data-testid="input-production-title"
        />

        <Stepper current={step} onSelect={(i) => void goToStep(i)} disabled={saving || !scenesReady} />
        {state.tasks.some(t => t.type === "story" && isStoryActive(t.status)) && (
          <Banner tone="error" testId="status-writing-control">
            <span className="flex-1">Writing in progress. Cancelling keeps your source and completed scene plans. Paid requests already accepted may still be charged.</span>
            <Button variant="outline" size="sm" disabled={pendingAction === "cancel-story" || state.tasks.some(t => t.id === state.storyCancelTaskId && isStoryActive(t.status))}
              onClick={() => void run("cancel-story")} data-testid="button-cancel-writing">
              {pendingAction === "cancel-story" || state.tasks.some(t => t.id === state.storyCancelTaskId && isStoryActive(t.status)) ? "Cancelling…" : "Cancel writing"}
            </Button>
          </Banner>
        )}

        {saveError && (
          <Banner tone="error" testId="alert-save-error">
            <span className="flex-1">{saveError.message}</span>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(retryOverrideRef.current)} data-testid="button-retry-save">Retry save</Button>
            {saveError.canKeepLocal && (
              <Button size="sm" variant="outline" disabled={saving} onClick={() => { if (window.confirm("Replace the conflicting saved fields with your edits? Other server updates will be kept.")) void save(retryOverrideRef.current, true); }} data-testid="button-keep-local-edits">Keep my edits</Button>
            )}
            {saveError.conflict && (
              <Button size="sm" variant="ghost" onClick={() => { if (window.confirm("Discard your unsaved edits and load the server copy?")) void reloadServer(); }} data-testid="button-load-server">
                Load server copy
              </Button>
            )}
          </Banner>
        )}
        {actionError && (
          <Banner tone="error" testId="alert-action-error">
            <span className="flex-1">{actionError.message}</span>
            <Button size="sm" variant="outline" onClick={actionError.retry} data-testid="button-retry-action">
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setActionError(null)} data-testid="button-dismiss-action-error">Dismiss</Button>
          </Banner>
        )}

        <div key={step} className="mt-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {step === 0 && (
            <StoryStep
              story={state.story}
              onChange={editStory}
              onDraft={(payload) => draftStory(payload)}
              settings={state.settings}
              onSettings={editSettings}
              onUpload={(f) => void uploadScript(f)}
              uploading={uploading}
              drafting={pendingAction === "draft-story"}
              onContinue={() => void goToStep(1)}
            />
          )}
          {step === 1 && <CharactersStep state={state} run={run} pendingAction={pendingAction} onSettings={editSettings} />}
          {step === 2 && <WardrobeStep state={state} run={run} pendingAction={pendingAction} onSettings={editSettings} />}
          {step === 3 && <PlacesStep state={state} run={run} pendingAction={pendingAction} onSettings={editSettings} />}
          {step === 4 && (
            <CreateStep state={state} project={project} run={run} pendingAction={pendingAction} onSettings={editSettings} save={save} onPlaces={() => void goToStep(3)} />
          )}
          {step === 5 && <ReviewStep state={state} project={project} run={run} pendingAction={pendingAction} />}
        </div>
      </div>

      <footer className="sticky bottom-0 z-20 mt-10 border-t border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <Button variant="ghost" disabled={step === 0 || saving} onClick={() => void goToStep(step - 1)} data-testid="button-step-back">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
          </Button>
          <span className="hidden text-xs uppercase tracking-[0.2em] text-muted-foreground sm:block" data-testid="text-step-label">
            Step {step + 1} of 6 · {STEPS[step]}
          </span>
          {step < 5 ? (
            <Button className="brand-glow" disabled={nextDisabled} onClick={() => void goToStep(step + 1)} data-testid="button-step-next"
              title={step === 0 && !scenesReady ? "Write or parse your scenes first" : undefined}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {STEPS[step + 1]} <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          ) : <span />}
        </div>
      </footer>
    </div>
  );
}

function Stepper({ current, onSelect, disabled }: { current: number; onSelect: (i: number) => void; disabled: boolean }) {
  return (
    <ol className="mt-5 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]" data-testid="nav-steps">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="min-w-[96px] flex-1">
            <button
              type="button"
              onClick={() => onSelect(i)}
              disabled={active || (disabled && i > 0)}
              className={`group w-full text-left disabled:cursor-default`}
              data-testid={`button-step-${i}`}
            >
              <div className={`h-1 rounded-full transition-colors ${active ? "brand-gradient" : done ? "bg-primary/50" : "bg-border"}`} />
              <div className="mt-2 flex items-center gap-2">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] ${active ? "bg-primary text-primary-foreground" : done ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`}>
                  {done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span className={`text-xs font-semibold ${active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>{label}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function SaveIndicator({ saving, dirty, error, saved, onSave }: { saving: boolean; dirty: boolean; error: boolean; saved: boolean; onSave: () => void }) {
  if (saving) return <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="status-save"><Loader2 className="h-3 w-3 animate-spin" /> Saving</span>;
  if (error) return <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid="status-save"><CloudOff className="h-3 w-3" /> Not saved</span>;
  if (dirty || !saved) {
    return (
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onSave} data-testid="button-save-draft">
        <Save className="mr-1.5 h-3 w-3" /> Save draft
      </Button>
    );
  }
  return <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="status-save"><Check className="h-3 w-3 text-emerald-400" /> Saved</span>;
}

export function Banner({ tone, children, testId }: { tone: "error" | "info" | "warn"; children: ReactNode; testId?: string }) {
  const cls = tone === "error" ? "border-destructive/30 bg-destructive/10 text-destructive"
    : tone === "warn" ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-violet-400/25 bg-violet-500/10 text-violet-100";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mt-4 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${cls}`} data-testid={testId}>
      {tone !== "info" && <AlertTriangle className="h-4 w-4 shrink-0" />}
      {children}
    </div>
  );
}

function WorkflowSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 pt-8 md:px-8" data-testid="skeleton-production">
      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      <div className="h-12 w-2/3 animate-pulse rounded bg-muted" />
      <div className="grid grid-cols-6 gap-1">{STEPS.map((s) => <div key={s} className="h-8 animate-pulse rounded bg-muted/60" />)}</div>
      <div className="h-80 animate-pulse rounded-xl bg-card" />
    </div>
  );
}
