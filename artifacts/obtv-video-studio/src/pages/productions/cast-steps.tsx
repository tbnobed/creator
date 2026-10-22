import { ErrorNotice } from "@/components/shared/error-notice";
import { useState } from "react";
import type { ReactNode } from "react";
import { Loader2, Lock, MapPin, Plus, RefreshCw, Shirt, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isFailed, isPending, type ProductionCharacter, type ProductionSettings, type ProductionState } from "@/lib/production-types";
import { ModelPicker, useModelChoice, type ModelChoice } from "@/components/shared/model-picker";
import { CharacterPromptFields } from "@/components/characters/look/CharacterPromptFields";
import { LookOptionGrid } from "@/components/characters/look/LookOptionGrid";
import { OutfitCard } from "@/components/characters/look/OutfitCard";
import { mediaStateOf, outfitFromProduction } from "@/lib/wardrobe-adapters";
import { MediaFrame } from "@/components/characters/look/MediaTile";
import { ReferenceSheetStrip } from "@/components/characters/look/ReferenceSheetStrip";
import { slotsFromProduction, slotsFromSheet } from "@/lib/character-look-adapters";
import type { RunAction } from "./workflow";
import { SceneScenery, resolveSceneScenery } from "./scene-scenery";
import { useListCharacters, useListSettings, getListSettingsQueryKey } from "@workspace/api-client-react";
import { useConfirm } from "@/components/shared/confirm";

type StepProps = { state: ProductionState; run: RunAction; pendingAction: string | null; onSettings: (p: Partial<ProductionSettings>) => void };

function StepHead({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-primary">{n}</p>
      <h2 className="mt-1 text-2xl font-extrabold">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

function Thumb({ src, alt, status, className = "aspect-[3/4]" }: { src?: string; alt: string; status?: string; className?: string }) {
  return <MediaFrame src={src} state={mediaStateOf(status, src)} alt={alt} aspect={className} />;
}


/* ---------------- Characters ---------------- */

export function CharactersStep({ state, run, pendingAction, onSettings }: StepProps) {
  const library = useListCharacters();
  const portraitModel = useModelChoice("characters", "generate", state.settings, onSettings);
  const sheetModel = useModelChoice("referenceSheet", "edit", state.settings, onSettings);
  const [panel, setPanel] = useState<{ mode: "new" } | { mode: "edit"; id: string } | null>(null);
  const active = panel?.mode === "edit" ? state.characters.find((c) => c.id === panel.id) : undefined;

  return (
    <div>
      <StepHead n="02 / Characters" title="Who is in it?" sub="Describe each character, pick one of four portraits, then lock the look. We build a reference sheet in the background so every scene keeps the same face." />
      <section className="mb-6 rounded-xl border border-border bg-card p-4" data-testid="character-library">
        <h3 className="font-semibold">Use an existing character</h3>
        <p className="mb-3 text-xs text-muted-foreground">Add a character from your workspace. Its existing look is reused; no new images are generated or charged.</p>
        {library.isLoading && <p className="text-sm text-muted-foreground">Loading your characters…</p>}
        {library.isError && <Button variant="outline" onClick={() => void library.refetch()}>Retry character library</Button>}
        {!library.isLoading && !library.isError && !library.data?.length && <p className="text-sm text-muted-foreground">Your workspace has no saved characters yet.</p>}
        <div className="flex flex-wrap gap-2">
          {library.data?.map(c => {
            const included = state.characters.some(p => p.characterId === c.id);
            return <Button key={c.id} variant="outline" disabled={!!pendingAction || included} onClick={() => void run("import-character", { characterId: c.id })} data-testid={`button-import-character-${c.id}`}>
              {c.thumbnail && <img src={c.thumbnail} alt="" className="mr-2 h-7 w-7 rounded object-cover" />}{c.name}{included ? " · Added" : " · Add"}
            </Button>;
          })}
        </div>
      </section>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {state.characters.map((c) => {
          const portrait = c.options.find((o) => o.assetId === c.selectedAssetId)?.mediaUrl ?? c.referenceSheet[0]?.mediaUrl;
          const selected = panel?.mode === "edit" && panel.id === c.id;
          return (
            <button key={c.id} type="button" onClick={() => setPanel({ mode: "edit", id: c.id })}
              className={`group rounded-xl border bg-card p-2 text-left transition-all hover:-translate-y-0.5 ${selected ? "border-primary" : "border-border hover:border-foreground/30"}`}
              data-testid={`card-character-${c.id}`}>
              <div className="relative">
                <Thumb src={portrait} alt={c.name} status={c.status} />
                {c.locked && (
                  <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-bold text-emerald-950" data-testid={`badge-locked-${c.id}`}>
                    <Lock className="h-2.5 w-2.5" /> Look locked
                  </span>
                )}
              </div>
              <p className="mt-2 truncate px-1 font-semibold">{c.name}</p>
              <p className="line-clamp-2 px-1 text-xs text-muted-foreground">{c.description}</p>
            </button>
          );
        })}
        <button type="button" onClick={() => setPanel({ mode: "new" })}
          className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          data-testid="button-add-character">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/15 text-primary"><Plus className="h-5 w-5" /></span>
          Add a character
        </button>
      </div>

      {panel?.mode === "new" && (
        <NewCharacterPanel model={portraitModel} run={run} busy={pendingAction === "add-character"} onClose={() => setPanel(null)}
          onCreated={(id) => setPanel({ mode: "edit", id })} existingIds={state.characters.map((c) => c.id)} />
      )}
      {active && <CharacterPanel key={active.id} portraitModel={portraitModel} sheetModel={sheetModel} character={active} run={run} pendingAction={pendingAction} onClose={() => setPanel(null)} />}
    </div>
  );
}

function PromptFields({ name, setName, prompt, setPrompt, disabled }: { name: string; setName: (v: string) => void; prompt: string; setPrompt: (v: string) => void; disabled?: boolean }) {
  return <CharacterPromptFields prompt={prompt} setPrompt={setPrompt} name={name} setName={setName} disabled={disabled} />;
}

function NewCharacterPanel({ model, run, busy, onClose, onCreated, existingIds }: { model: ModelChoice; run: RunAction; busy: boolean; onClose: () => void; onCreated: (id: string) => void; existingIds: string[] }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const submit = async () => {
    // An empty name is derived from the prompt server-side.
    const res = await run("add-character", { ...(name.trim() ? { name: name.trim() } : {}), description: prompt.trim(), ...model.payload() });
    model.reset();
    if (!res) return;
    const chars = ((res.state as Record<string, unknown>).characters ?? []) as ProductionCharacter[];
    const created = chars.find((c) => !existingIds.includes(c.id));
    if (created) onCreated(created.id); else onClose();
  };
  return (
    <section className="mt-6 rounded-2xl border border-primary/30 bg-card p-5 animate-in fade-in slide-in-from-top-2" data-testid="panel-new-character">
      <div className="mb-4 flex items-center justify-between"><h3 className="font-bold">New character</h3>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close" data-testid="button-close-character"><X className="h-4 w-4" /></Button></div>
      <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
        <PromptFields name={name} setName={setName} prompt={prompt} setPrompt={setPrompt} />
        <div>
          <LookOptionGrid slots={slotsFromProduction({ options: [], status: busy ? "RUNNING" : "" })} choice={null} onChoose={() => undefined} />
          <div className="mt-4"><ModelPicker choice={model} label="Portrait model" /></div>
          <Button className="mt-4 w-full brand-glow" disabled={busy || !prompt.trim() || !model.canSubmit} onClick={() => void submit()} data-testid="button-generate-character">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} Generate four looks
          </Button>
        </div>
      </div>
    </section>
  );
}

function CharacterPanel({ portraitModel, sheetModel, character: c, run, pendingAction, onClose }: { portraitModel: ModelChoice; sheetModel: ModelChoice; character: ProductionCharacter; run: RunAction; pendingAction: string | null; onClose: () => void }) {
  const [name, setName] = useState(c.name);
  const [prompt, setPrompt] = useState(c.description);
  const [choice, setChoice] = useState<string | undefined>(c.selectedAssetId);
  const generating = isPending(c.status);
  const changed = name !== c.name || prompt !== c.description;

  const confirmAction = useConfirm();
  const regenerate = async () => {
    if (c.locked && !(await confirmAction({ title: `Regenerate ${c.name}?`, description: "Scenes already created with this character will be flagged for re-render.", confirmLabel: "Regenerate" }))) return;
    void run("regenerate-character", { id: c.id, name: name.trim(), description: prompt.trim(), ...portraitModel.payload() });
    portraitModel.reset();
    setChoice(undefined);
  };

  return (
    <section className="mt-6 rounded-2xl border border-primary/30 bg-card p-5 animate-in fade-in slide-in-from-top-2" data-testid={`panel-character-${c.id}`}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="font-bold">{c.name}{c.locked && <span className="ml-2 text-xs font-semibold text-emerald-400">Look locked</span>}</h3>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close" data-testid="button-close-character"><X className="h-4 w-4" /></Button>
      </div>
      {c.error && <ErrorNotice className="mb-3" testId="text-character-error" message={c.error} />}
      <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
        <div>
          <PromptFields name={name} setName={setName} prompt={prompt} setPrompt={setPrompt} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!changed || !name.trim() || pendingAction !== null}
              onClick={() => void run("update-character", { id: c.id, name: name.trim(), description: prompt.trim() })} data-testid="button-save-character">
              Save details
            </Button>
            <Button variant="outline" size="sm" disabled={!prompt.trim() || generating || pendingAction !== null || !portraitModel.canSubmit} onClick={regenerate} data-testid="button-regenerate-character">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Generate again
            </Button>
          </div>
          <div className="mt-3"><ModelPicker choice={portraitModel} label="Portrait model" /></div>
          {c.locked && <p className="mt-2 text-xs text-amber-300/80">Regenerating replaces the locked look and flags existing scenes for re-render.</p>}
        </div>
        <div>
          <LookOptionGrid slots={slotsFromProduction(generating ? { ...c, status: "RUNNING" } : c)} choice={choice} onChoose={setChoice} keptAssetId={c.locked ? c.selectedAssetId : null} />
          <div className="mt-4"><ModelPicker choice={sheetModel} label="Reference sheet model" /></div>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1 brand-glow" disabled={!choice || generating || pendingAction !== null || (c.locked && choice === c.selectedAssetId) || !sheetModel.canSubmit}
              onClick={() => { void run("keep-look", { id: c.id, assetId: choice, ...sheetModel.payload() }); sheetModel.reset(); }} data-testid="button-keep-look">
              {pendingAction === "keep-look" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />} Keep this look
            </Button>
            <Button variant="ghost" onClick={onClose} data-testid="button-cancel-character">Cancel</Button>
          </div>
          {c.locked && <div className="mt-5"><ReferenceSheetStrip slots={slotsFromSheet(c.referenceSheet)} /></div>}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Wardrobe ---------------- */

export function WardrobeStep({ state, run, pendingAction, onSettings }: StepProps) {
  const model = useModelChoice("wardrobe", "edit", state.settings, onSettings);
  const maxScene = Math.max(1, ...state.story.scenes.map((s) => s.sceneNumber));
  if (state.characters.length === 0) {
    return (<><StepHead n="03 / Wardrobe" title="What are they wearing?" sub="Outfits are generated on each locked character." />
      <Empty icon={<Shirt className="h-6 w-6" />} title="No characters yet" body="Go back and lock at least one character's look first." /></>);
  }
  return (
    <div>
      <StepHead n="03 / Wardrobe" title="What are they wearing?" sub="Add outfits by prompt and set the scenes they cover. Outfits can change state partway through, such as a torn sleeve or soaked coat." />
      <div className="space-y-6">
        {state.characters.map((c) => (
          <WardrobeRow key={c.id} model={model} character={c} outfits={state.wardrobes.filter((w) => w.characterId === c.id)} maxScene={maxScene} run={run} busy={pendingAction === "add-wardrobe"} />
        ))}
      </div>
    </div>
  );
}

function WardrobeRow({ model, character: c, outfits, maxScene, run, busy }: { model: ModelChoice; character: ProductionCharacter; outfits: ProductionState["wardrobes"]; maxScene: number; run: RunAction; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", prompt: "", fromScene: 1, toScene: maxScene, stateFromScene: "", stateNote: "" });
  const submit = async () => {
    const payload: Record<string, unknown> = { characterId: c.id, name: f.name.trim(), prompt: f.prompt.trim(), fromScene: Number(f.fromScene), toScene: Number(f.toScene), ...model.payload() };
    if (f.stateNote.trim() && f.stateFromScene) { payload.stateFromScene = Number(f.stateFromScene); payload.stateNote = f.stateNote.trim(); }
    const ok = await run("add-wardrobe", payload);
    model.reset();
    if (ok) { setOpen(false); setF({ ...f, name: "", prompt: "", stateNote: "", stateFromScene: "" }); }
  };
  const valid = f.name.trim() && f.prompt.trim() && Number(f.fromScene) >= 1 && Number(f.toScene) >= Number(f.fromScene);
  return (
    <section className="rounded-2xl border border-border bg-card/60 p-4" data-testid={`row-wardrobe-${c.id}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-bold">{c.name}</h3>
        {!c.locked && <span className="text-xs text-amber-300">Lock this character's look to add outfits</span>}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {outfits.map((w) => (
          <OutfitCard key={w.id} className="w-36 shrink-0" testId={`card-outfit-${w.id}`} outfit={outfitFromProduction(w)} />
        ))}
        <button type="button" disabled={!c.locked} onClick={() => setOpen(true)}
          className="flex aspect-[3/4] w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-40"
          data-testid={`button-add-outfit-${c.id}`}>
          <Plus className="h-4 w-4" /> Add outfit
        </button>
      </div>
      {open && (
        <div className="mt-4 grid gap-3 rounded-xl border border-primary/30 bg-background/60 p-4 md:grid-cols-2" data-testid={`form-outfit-${c.id}`}>
          <Input placeholder="Outfit name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="input-outfit-name" />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Scenes</span>
            <Input type="number" min={1} max={maxScene} value={f.fromScene} onChange={(e) => setF({ ...f, fromScene: Number(e.target.value) })} className="w-20" data-testid="input-outfit-from" />
            <span>to</span>
            <Input type="number" min={1} max={maxScene} value={f.toScene} onChange={(e) => setF({ ...f, toScene: Number(e.target.value) })} className="w-20" data-testid="input-outfit-to" />
          </div>
          <Textarea placeholder="Yellow fisherman's slicker over a grey wool jumper" value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} className="md:col-span-2" data-testid="input-outfit-prompt" />
          <div className="flex items-center gap-2 text-sm md:col-span-2">
            <span className="shrink-0 text-muted-foreground">State change</span>
            <Input placeholder="torn sleeve, wet" value={f.stateNote} onChange={(e) => setF({ ...f, stateNote: e.target.value })} data-testid="input-outfit-state-note" />
            <span className="shrink-0 text-muted-foreground">from scene</span>
            <Input type="number" min={1} max={maxScene} value={f.stateFromScene} onChange={(e) => setF({ ...f, stateFromScene: e.target.value })} className="w-20" data-testid="input-outfit-state-from" />
          </div>
          <div className="md:col-span-2"><ModelPicker choice={model} label="Outfit model" /></div>
          <div className="flex gap-2 md:col-span-2">
            <Button disabled={!valid || busy || !model.canSubmit} onClick={() => void submit()} data-testid="button-generate-outfit">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Generate outfit</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} data-testid="button-cancel-outfit">Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------- Places ---------------- */

const VARIANT_PRESETS = ["Morning", "Evening", "Night", "Storm"];

export function PlacesStep({ state, run, pendingAction, onSettings }: StepProps) {
  const library = useListSettings({ query: { queryKey: getListSettingsQueryKey(), staleTime: 0, refetchOnMount: "always" } });
  const model = useModelChoice("places", "generate", state.settings, onSettings);
  const variantModel = useModelChoice("variants", "edit", state.settings, onSettings);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [adding, setAdding] = useState(false);
  const used = (placeId: string) => state.story.scenes.filter(s => resolveSceneScenery(state, s)?.place.id === placeId).length;
  const suggestions = Array.from(new Set(state.story.scenes.filter(s => !resolveSceneScenery(state, s)).map(s => s.location).filter(Boolean))).slice(0, 8);
  const submit = async () => {
    const ok = await run("add-place", { name: name.trim(), prompt: prompt.trim(), ...model.payload() });
    model.reset();
    if (ok) { setName(""); setPrompt(""); setAdding(false); }
  };
  return (
    <div>
      <StepHead n="04 / Places" title="Where does it happen?" sub="Each place gets a wide establishing reference with a fixed seed, so every scene reuses the same set. Variants for time and weather are edited from the base." />
      <SceneScenery state={state} onSettings={onSettings} disabled={!!pendingAction} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {state.places.map((p) => <PlaceCard key={p.id} model={variantModel} place={p} usedIn={used(p.id)} run={run} busy={!!pendingAction} />)}
        <button type="button" onClick={() => setAdding(true)}
          className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-foreground" data-testid="button-add-place">
          <MapPin className="h-5 w-5 text-primary" /> Add a place
        </button>
      </div>
      {adding && (
        <section className="mt-6 space-y-3 rounded-2xl border border-primary/30 bg-card p-5" data-testid="form-place">
          <label className="block text-sm">
            Use a saved location
            <select aria-label="Use a saved location" className="mt-2 w-full rounded-md border border-border bg-background p-2"
              value="" disabled={!!pendingAction || library.isLoading}
              onChange={async e => { const id = e.target.value; if (id && await run("import-place", { settingId: id })) setAdding(false); }}>
              <option value="">Choose from Locations &amp; Scenery</option>
              {library.data?.filter(location => !state.places.some(place => place.id === location.id)).map(location =>
                <option key={location.id} value={location.id} disabled={!location.assetCount}>{location.name}{!location.assetCount ? " — no image" : ""}</option>)}
            </select>
          </label>
          {library.isError && <p role="alert" className="text-sm text-destructive">Could not load saved locations. <button type="button" onClick={() => void library.refetch()}>Retry</button></p>}
          <p className="text-xs text-muted-foreground">Reuse its images and variants without generating anything, or create a new location below.</p>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5"><span className="text-xs text-muted-foreground">From your scenes:</span>
              {suggestions.map((s) => <button key={s} type="button" onClick={() => setName(s)} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-primary" data-testid={`chip-place-${s}`}>{s}</button>)}
            </div>
          )}
          <Input placeholder="Place name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-place-name" />
          <Textarea placeholder="Weathered lighthouse on a basalt headland, iron railings, sea spray" value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="input-place-prompt" />
          <ModelPicker choice={model} label="Place model" />
          <div className="flex gap-2">
            <Button disabled={!name.trim() || !prompt.trim() || pendingAction === "add-place" || !model.canSubmit} onClick={() => void submit()} data-testid="button-generate-place">
              {pendingAction === "add-place" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Generate wide reference
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)} data-testid="button-cancel-place">Cancel</Button>
          </div>
        </section>
      )}
    </div>
  );
}

function PlaceCard({ model, place: p, usedIn, run, busy }: { model: ModelChoice; place: ProductionState["places"][number]; usedIn: number; run: RunAction; busy: boolean }) {
  const [vName, setVName] = useState("");
  const [vPrompt, setVPrompt] = useState("");
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | undefined>();
  const shown = preview ?? p.mediaUrl;
  const confirmAction = useConfirm();
  const add = async () => {
    const ok = await run("add-variant", { placeId: p.id, name: vName.trim(), prompt: vPrompt.trim() || vName.trim(), ...model.payload() });
    model.reset();
    if (ok) { setVName(""); setVPrompt(""); setOpen(false); }
  };
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card" data-testid={`card-place-${p.id}`}>
      <Thumb src={shown} alt={p.name} status={p.status} className="aspect-video !rounded-none" />
      <div className="space-y-2 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate font-bold">{p.name}</h3>
          <Button size="sm" variant="ghost" disabled={busy || isPending(p.status) || p.variants.some(v => isPending(v.status))}
            onClick={async () => { if (await confirmAction({ title: `Remove “${p.name}” from this production?`, description: "Its variants are detached too. Existing scenes and shared library media are kept.", confirmLabel: "Remove", destructive: true })) void run("remove-place", { placeId: p.id }); }}
            data-testid={`button-remove-place-${p.id}`}>Remove</Button>
          <span className="shrink-0 text-xs text-muted-foreground" data-testid={`text-place-usage-${p.id}`}>Used in {usedIn} scene{usedIn === 1 ? "" : "s"}</span>
        </div>
        {p.error && <p role="alert" className="text-xs text-destructive" data-testid={`text-place-error-${p.id}`}>{p.error}</p>}
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setPreview(undefined)} className={`rounded-full px-2 py-0.5 text-[11px] ${!preview ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`} data-testid={`pill-variant-base-${p.id}`}>Base</button>
          {p.variants.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1">
            <button type="button" onClick={() => setPreview(v.mediaUrl)} title={v.error ?? v.prompt}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${preview && preview === v.mediaUrl ? "bg-primary/20 text-primary" : isFailed(v.status) ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"}`}
              data-testid={`pill-variant-${v.id}`}>
              {isPending(v.status) && <Loader2 className="h-2.5 w-2.5 animate-spin" />}{v.name}
            </button>
            <button type="button" aria-label={`Remove ${v.name} variant`} disabled={busy || isPending(v.status)}
              onClick={async () => { if (await confirmAction({ title: `Remove the “${v.name}” variant?`, description: "Shared library media is kept.", confirmLabel: "Remove", destructive: true })) { const result = await run("remove-variant", { placeId: p.id, id: v.id }); if (result) setPreview(undefined); } }}
              className="p-1 text-muted-foreground hover:text-destructive disabled:opacity-40" data-testid={`button-remove-variant-${v.id}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          <button type="button" disabled={!p.assetId} onClick={() => setOpen((o) => !o)} className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40" data-testid={`button-add-variant-${p.id}`}>+ variant</button>
        </div>
        {open && (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-1">{VARIANT_PRESETS.map((v) => <button key={v} type="button" onClick={() => setVName(v)} className="rounded border border-border px-2 py-0.5 text-[11px] hover:border-primary" data-testid={`chip-variant-${v.toLowerCase()}`}>{v}</button>)}</div>
            <Input placeholder="Variant name" value={vName} onChange={(e) => setVName(e.target.value)} className="h-8 text-sm" data-testid="input-variant-name" />
            <Input placeholder="Optional detail: rain lashing the windows" value={vPrompt} onChange={(e) => setVPrompt(e.target.value)} className="h-8 text-sm" data-testid="input-variant-prompt" />
            <ModelPicker choice={model} label="Variant model" />
            <Button size="sm" disabled={!vName.trim() || busy || !model.canSubmit} onClick={() => void add()} data-testid="button-generate-variant">{busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}Generate variant</Button>
          </div>
        )}
      </div>
    </article>
  );
}

function Empty({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/30 p-8 text-center">
      <div className="mb-3 text-muted-foreground">{icon}</div>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
