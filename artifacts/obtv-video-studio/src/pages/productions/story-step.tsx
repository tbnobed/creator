import { PaidConfirm } from "@/components/shared/paid-confirm";
import { useEffect, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ArrowRight, FileText, Loader2, MapPin, PenLine, RefreshCw, Sun, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isFailed, isPending, type ProductionSettings, type Scene, type Story, type TargetMinutes } from "@/lib/production-types";

const LENGTHS: { minutes: TargetMinutes; name: string; note: string }[] = [
  { minutes: 3, name: "Test", note: "3 minutes" },
  { minutes: 10, name: "Short", note: "about 10 min" },
  { minutes: 30, name: "Episode", note: "about 30 min" },
  { minutes: 90, name: "Feature", note: "about 90 min" },
];

type Props = {
  story: Story;
  onChange: (patch: Partial<Pick<Story, "summary" | "script" | "targetMinutes" | "scenes" | "sourceMode">>) => void;
  onDraft: (payload: Record<string, unknown>) => Promise<void>;
  settings: ProductionSettings;
  onSettings: (p: Partial<ProductionSettings>) => void;
  onUpload: (file: File) => void;
  onContinue: () => void;
  uploading: boolean;
  drafting: boolean;
};

export function StoryStep({ story, onChange, onDraft: draftAction, onUpload, onContinue, uploading, drafting, settings, onSettings }: Props) {
  const storyModel = settings.storyModel || "local";
  const paid = storyModel.startsWith("openai:");
  const [modelIdDraft, setModelIdDraft] = useState(paid ? storyModel.slice(7) : "gpt-4.1");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [storyModel]);
  const onDraft = () => {
    const payload = paid ? { cloudConfirmed: confirmed } : {};
    setConfirmed(false);
    void draftAction(payload);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = story.sourceMode ?? (story.script ? "script" : "summary");
  const setMode = (sourceMode: "summary" | "script") => onChange({ sourceMode });
  const running = drafting || isPending(story.draftStatus);
  const ready = !running && !isFailed(story.draftStatus) && (!story.draftStatus || story.draftStatus.toUpperCase() === "READY");
  const hasInput = (mode === "summary" ? story.summary : story.script).trim().length > 0;
  const authored = mode === "script" || /^\s*(?:SCENE\s+\d+\b|(?:INT|EXT|INT\/EXT)\.)/mi.test(story.summary);
  const validDuration = Number.isInteger(story.targetMinutes) && story.targetMinutes >= 1 && story.targetMinutes <= 90;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="space-y-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">01 / Story</p>
          <h2 className="mt-1 text-2xl font-extrabold">What happens?</h2>
          <p className="mt-1 text-sm text-muted-foreground">Write a summary, or paste or upload a script.</p>
        </div>

        <div className="inline-flex rounded-lg border border-border bg-card p-1 text-xs" role="tablist">
          {(["summary", "script"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 font-semibold transition-colors ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              data-testid={`tab-story-${m}`}>
              {m === "summary" ? "Summary" : "Script"}
            </button>
          ))}
        </div>

        {mode === "summary" ? (
          <Textarea value={story.summary} onChange={(e) => onChange({ summary: e.target.value })}
            placeholder="A storm-chaser named Eli returns to the coastal town he fled ten years ago..."
            className="min-h-[220px] resize-y bg-card text-base leading-relaxed" data-testid="input-story-summary" />
        ) : (
          <div className="space-y-2">
            <Textarea value={story.script} onChange={(e) => onChange({ script: e.target.value })}
              placeholder="INT. LIGHTHOUSE - NIGHT ..." className="min-h-[220px] resize-y bg-card font-mono text-sm" data-testid="input-story-script" />
            {story.scriptName && <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-script-name"><FileText className="h-3 w-3" /> From {story.scriptName}</p>}
          </div>
        )}

        <div>
          <input ref={fileRef} type="file" accept=".txt,.fdx,.pdf" className="hidden" data-testid="input-script-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { setMode("script"); onUpload(f); } e.target.value = ""; }} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground disabled:opacity-60"
            data-testid="button-upload-script">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            <span><span className="font-semibold text-foreground">Upload a script instead</span> · .txt, .fdx or .pdf</span>
          </button>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{authored ? "Script timing" : "Target length"}</p>
          {authored && <p className="text-sm text-muted-foreground" data-testid="text-script-timing">Your scene timings are kept as written.</p>}
          {!authored && <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {LENGTHS.map((l) => {
              const active = story.targetMinutes === l.minutes;
              return (
                <button key={l.minutes} type="button" onClick={() => onChange({ targetMinutes: l.minutes })}
                  className={`rounded-xl border p-3 text-left transition-all ${active ? "border-primary bg-primary/10 brand-glow" : "border-border bg-card hover:border-foreground/30"}`}
                  data-testid={`button-length-${l.minutes}`} aria-pressed={active}>
                  <span className="block font-bold">{l.name}</span>
                  <span className="text-xs text-muted-foreground">{l.note}</span>
                </button>
              );
            })}
          </div>
          <label className="mt-3 flex items-center gap-3 text-sm">
            Exact target (minutes)
            <Input type="number" min={1} max={90} step={1} value={story.targetMinutes} disabled={running}
              onChange={e => onChange({ targetMinutes: Number(e.target.value) })} className="w-24" data-testid="input-target-minutes" />
          </label>
          {!validDuration && <p role="alert" className="text-sm text-destructive">Choose a whole number from 1 to 90 minutes.</p>}
          </>}
        </div>

        <div className="space-y-2 rounded-xl border border-border bg-card p-3" data-testid="picker-story-model">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Writing model</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onSettings({ storyModel: "local" })} aria-pressed={!paid}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${!paid ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`} data-testid="button-story-model-local">
              Local GPU <span className="ml-1 text-[10px] text-emerald-400">LOCAL</span>
            </button>
            <button type="button" onClick={() => onSettings({ storyModel: `openai:${modelIdDraft.trim() || "gpt-4.1"}` })} aria-pressed={paid}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${paid ? "border-primary bg-primary/10" : "border-border text-muted-foreground"}`} data-testid="button-story-model-openai">
              OpenAI-compatible <span className="ml-1 text-[10px] text-amber-300">PAID</span>
            </button>
          </div>
          {paid && (
            <>
              <Input value={modelIdDraft} onChange={(e) => setModelIdDraft(e.target.value)}
                onBlur={() => onSettings({ storyModel: `openai:${modelIdDraft.trim() || "gpt-4.1"}` })}
                placeholder="gpt-4.1" className="h-8 font-mono text-xs" data-testid="input-story-model-id" />
              <PaidConfirm checked={confirmed} onChange={setConfirmed} testId="confirm-paid-story" checkboxTestId="checkbox-paid-story">
                I confirm paid requests to {storyModel.slice(7)}: one outline request plus one request per scene (a feature can need around 46 requests). Billed by your provider.
              </PaidConfirm>
            </>
          )}
        </div>

        <Button size="lg" className="w-full brand-glow" disabled={!hasInput || running || (!authored && !validDuration) || (paid && !confirmed)} onClick={onDraft} data-testid="button-draft-story">
          {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Writing scenes</> : story.scenes.length
            ? <><RefreshCw className="mr-2 h-4 w-4" /> Redraft scenes</> : <><PenLine className="mr-2 h-4 w-4" /> {mode === "script" ? "Break script into scenes" : "Write scenes and dialogue"}</>}
        </Button>
        {story.progress && (
          <div className="space-y-1 rounded-lg border border-border bg-card p-3 text-xs" role="status" aria-live="polite" data-testid="status-story-progress">
            <p className="font-semibold">{story.progress.stage}</p>
            <p className="text-muted-foreground">{story.progress.target} · {story.progress.model}</p>
            {running && <p className="text-muted-foreground">{story.progress.stage.startsWith("Waiting for GB10") ? "Video jobs have priority; writing resumes shortly." : story.progress.gpuVerified ? "GPU model verified." : story.progress.target === "Paid provider" ? "Waiting for the provider." : "Loading the writer."} Your input is saved.</p>}
          </div>
        )}
        {story.scenes.length > 0 && !running && <p className="text-xs text-muted-foreground">Redrafting replaces the scenes on the right.</p>}
      </section>

      <section className="min-w-0" data-testid="section-scene-review">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">Draft review</p>
            <h3 className="text-lg font-bold">{story.scenes.length ? `${story.scenes.length} scenes` : "Scenes"}</h3>
          </div>
          {story.scenes.length > 0 && ready && (
            <Button size="sm" onClick={onContinue} data-testid="button-approve-draft">Looks right <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Button>
          )}
        </div>
        {isFailed(story.draftStatus) && story.error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" data-testid="text-draft-error">
            {story.error} <button className="ml-2 underline" onClick={onDraft} data-testid="button-retry-draft">Try again</button>
          </div>
        )}
        {running ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl border border-border/50 bg-card" style={{ animationDelay: `${i * 120}ms` }} />)}</div>
        ) : story.scenes.length === 0 || !ready ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/30 p-8 text-center" data-testid="empty-scenes">
            <div className="mb-4 grid grid-cols-3 gap-1 opacity-40">{Array.from({ length: 9 }).map((_, i) => <div key={i} className="h-4 w-10 rounded-sm bg-muted" />)}</div>
            <p className="font-semibold">Nothing drafted yet</p>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">Drafted scenes appear here for review.</p>
          </div>
        ) : (
          <ol className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {story.scenes.map((scene, i) => (
              <SceneCard key={`${scene.sceneNumber}-${i}`} scene={scene}
                onChange={(patch) => onChange({ scenes: story.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) })} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function SceneCard({ scene, onChange }: { scene: Scene; onChange: (patch: Partial<Scene>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-xl border border-border bg-card p-4" data-testid={`card-scene-${scene.sceneNumber}`}>
      <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen((o) => !o)} data-testid={`button-toggle-scene-${scene.sceneNumber}`}>
        <span className="font-mono text-xs text-primary">{String(scene.sceneNumber).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{scene.title}</p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{scene.location || "Unplaced"}</span>
            <span className="flex items-center gap-1"><Sun className="h-3 w-3" />{scene.timeOfDay || "Any time"}</span>
            {scene.characters.length > 0 && <span className="flex items-center gap-1"><Users className="h-3 w-3" />{scene.characters.join(", ")}</span>}
          </div>
          {!open && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{scene.action}</p>}
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Action</label>
          <Textarea value={scene.action} onChange={(e) => onChange({ action: e.target.value })} className="min-h-[90px] text-sm" data-testid={`input-scene-action-${scene.sceneNumber}`} />
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dialogue</label>
          <Textarea value={scene.dialogue} onChange={(e) => onChange({ dialogue: e.target.value })} className="min-h-[120px] font-mono text-xs" data-testid={`input-scene-dialogue-${scene.sceneNumber}`} />
          {scene.shots && scene.shots.length > 0 && <p className="text-xs text-muted-foreground">{scene.shots.length} shots planned</p>}
        </div>
      )}
    </li>
  );
}
