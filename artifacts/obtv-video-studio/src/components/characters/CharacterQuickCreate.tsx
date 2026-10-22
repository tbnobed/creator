import { useEffect, useRef, useState } from "react";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Check, Loader2, Lock, RefreshCw, SlidersHorizontal, Sparkles, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createCharacter,
  getGetCharacterDossierQueryKey,
  getGetCharacterLooksQueryKey,
  getListCharactersQueryKey,
  useGetCharacterLooks,
  useKeepCharacterLook,
  useRetryCharacterLooks,
  useStartCharacterLooks,
  type Character,
  type CharacterLooks,
} from "@workspace/api-client-react";
import { ModelPicker, useModelChoice } from "@/pages/productions/model-picker";
import { DEFAULT_SETTINGS, type ProductionSettings } from "@/lib/production-types";

function newRequestKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const v = Math.floor(Math.random() * 16);
    return (c === "x" ? v : (v & 0x3) | 0x8).toString(16);
  });
}

function deriveName(prompt: string): string {
  const firstClause = prompt.trim().split(/[,.;\n]/)[0] ?? "";
  const words = firstClause.replace(/^(an?|the)\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 5);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 60);
  return name || "Untitled character";
}

function readableError(error: unknown, fallback: string): string {
  const e = error as { data?: { error?: unknown; message?: unknown } | null; message?: unknown };
  const raw = e?.data?.error ?? e?.data?.message ?? e?.message;
  return typeof raw === "string" && raw.trim() ? raw.replace(/<[^>]*>/g, " ").trim() : fallback;
}

export function CharacterQuickCreate({
  characterId,
  onCharacterCreated,
  onOpenAdvanced,
  onClose,
}: {
  characterId: string | null;
  onCharacterCreated: (id: string) => void;
  onOpenAdvanced: (id: string | null) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  // Request keys are reused until the server accepts, so a retried click never creates a second batch.
  const startKey = useRef<string | null>(null);
  const keepKey = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const startLooks = useStartCharacterLooks();
  const keepLook = useKeepCharacterLook();
  const retryLooks = useRetryCharacterLooks();

  // Model choice is local to this dialog; defaults to a supported local model, never paid.
  const [settings, setSettings] = useState<ProductionSettings>(DEFAULT_SETTINGS);
  const onSettings = (p: Partial<ProductionSettings>) => setSettings((s) => ({ ...s, ...p }));
  const portraitModel = useModelChoice("characters", "generate", settings, onSettings);
  const sheetModel = useModelChoice("referenceSheet", "edit", settings, onSettings);

  const { data: looks } = useGetCharacterLooks(characterId ?? "", {
    query: {
      enabled: !!characterId,
      queryKey: getGetCharacterLooksQueryKey(characterId ?? ""),
      refetchInterval: (q) => {
        const d = q.state.data;
        return d?.portraits?.status === "ACTIVE" || d?.sheet?.status === "ACTIVE" ? 2500 : false;
      },
    },
  });
  const portraits = looks?.portraits ?? null;
  const sheet = looks?.sheet ?? null;
  const generating = portraits?.status === "ACTIVE";
  const sheetRunning = sheet?.status === "ACTIVE";
  const portraitFailures = portraits?.slots.filter((s) => s.status === "FAILED") ?? [];
  const sheetFailures = sheet?.slots.filter((s) => s.status === "FAILED") ?? [];
  const keptAsset = portraits?.selectedAssetId ?? null;
  const hasReady = portraits?.slots.some((s) => s.status === "READY") ?? false;

  // On reopen, prefill the prompt from the saved batch and preselect the kept look.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !portraits) return;
    initialized.current = true;
    setPrompt((p) => p || portraits.prompt);
    setChoice((c) => c ?? portraits.selectedAssetId);
  }, [portraits]);

  const lastSheetState = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = sheet ? `${sheet.id}:${sheet.slots.map((s) => s.status).join(",")}` : undefined;
    if (key && lastSheetState.current && key !== lastSheetState.current && characterId) {
      void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getGetCharacterDossierQueryKey(characterId) });
    }
    lastSheetState.current = key;
  }, [sheet, characterId, queryClient]);

  const apply = (id: string, data: CharacterLooks) => {
    queryClient.setQueryData(getGetCharacterLooksQueryKey(id), data);
    void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetCharacterDossierQueryKey(id) });
  };

  const handleGenerate = async () => {
    const text = prompt.trim();
    if (!text || busy || generating || !portraitModel.canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      let id = characterId;
      if (!id) {
        const created = await createCharacter({
          name: name.trim() || deriveName(text), description: text.slice(0, 160), promptDescription: text, tags: [],
        });
        id = created.id;
        queryClient.setQueryData<Character[]>(getListCharactersQueryKey(), (old) => [...(old ?? []).filter((c) => c.id !== created.id), created]);
        onCharacterCreated(id);
      }
      const requestKey = startKey.current ?? (startKey.current = newRequestKey());
      const data = await startLooks.mutateAsync({ id, data: { prompt: text, requestKey, ...portraitModel.payload() } });
      startKey.current = null;
      setChoice(null);
      apply(id, data);
    } catch (err) {
      setError(readableError(err, "The portraits could not be started."));
    } finally {
      portraitModel.reset(); // paid confirmation is required again for every batch
      setBusy(false);
    }
  };

  const handleKeep = async () => {
    if (!choice || !portraits || !characterId || busy || sheetRunning || !sheetModel.canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const requestKey = keepKey.current ?? (keepKey.current = newRequestKey());
      const data = await keepLook.mutateAsync({ id: characterId, batchId: portraits.id, data: { assetId: choice, requestKey, ...sheetModel.payload() } });
      keepKey.current = null;
      apply(characterId, data);
    } catch (err) {
      setError(readableError(err, "The look could not be kept."));
    } finally {
      sheetModel.reset();
      setBusy(false);
    }
  };

  const handleRetry = async (batchId: string, paid: boolean, confirmed: boolean, reset: () => void) => {
    if (!characterId || busy) return;
    setBusy(true);
    setError(null);
    try {
      apply(characterId, await retryLooks.mutateAsync({ id: characterId, batchId, data: { cloudConfirmed: paid ? confirmed : false } }));
    } catch (err) {
      setError(readableError(err, "The failed images could not be retried."));
    } finally {
      reset();
      setBusy(false);
    }
  };

  // Retrying a paid batch needs the same model selected and confirmed again; finished images are never resubmitted.
  const retryState = (batch: NonNullable<typeof portraits>, choiceFor: typeof portraitModel) => {
    const paid = batch.provider === "CLOUD";
    const ok = !paid || (choiceFor.modelId === batch.modelId && choiceFor.confirmed);
    return { paid, ok };
  };
  const pRetry = portraits ? retryState(portraits, portraitModel) : null;
  const sRetry = sheet ? retryState(sheet, sheetModel) : null;

  return (
    <DialogContent
      onInteractOutside={(e) => { if (busy) e.preventDefault(); }}
      onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}
      className="w-full max-w-3xl max-h-[100dvh] overflow-y-auto bg-background border-border p-0"
      data-testid="dialog-new-character"
    >
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-xl font-bold tracking-tight">{characterId ? "Character look" : "New character"}</DialogTitle>
        <DialogDescription>Describe who you want, pick one of four portraits, then keep the look. You can close this at any time; generation continues.</DialogDescription>
      </DialogHeader>

      <div className="px-6 pb-6 space-y-5">
        <div className="grid gap-5 md:grid-cols-[1fr_1.2fr]">
          <div className="space-y-3">
            <Textarea
              id="new-character-prompt" aria-label="Describe the character"
              value={prompt} onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleGenerate(); }}
              placeholder="A weathered harbor pilot in her fifties, salt-gray braid, wind-burned cheeks, navy wool peacoat"
              className="min-h-32 resize-none bg-secondary/20" maxLength={4000} disabled={busy || generating}
              data-testid="input-new-character-prompt"
            />
            <Input
              aria-label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={prompt.trim() ? `Name (optional): ${deriveName(prompt)}` : "Name (optional)"}
              className="bg-secondary/20" disabled={busy || !!characterId} data-testid="input-new-character-name"
            />
            <ModelPicker choice={portraitModel} label="Portrait model" />
            <Button className="w-full gap-2" onClick={() => void handleGenerate()}
              disabled={!prompt.trim() || busy || generating || !portraitModel.canSubmit} data-testid="button-generate-character">
              {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {generating ? "Generating four looks..." : portraits ? "Generate four new looks" : "Generate four looks"}
            </Button>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Portrait options">
              {[0, 1, 2, 3].map((i) => {
                const slot = portraits?.slots[i];
                if (slot?.status === "READY" && slot.assetId && slot.mediaUrl) {
                  const assetId = slot.assetId;
                  return (
                    <button key={assetId} type="button" role="radio" aria-checked={choice === assetId} onClick={() => setChoice(assetId)}
                      disabled={sheetRunning}
                      className={`relative overflow-hidden rounded-lg border-2 transition-all ${choice === assetId ? "border-primary" : "border-transparent hover:border-foreground/30"}`}
                      data-testid={`option-portrait-${i}`}>
                      <img src={slot.mediaUrl} alt={`Option ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
                      {choice === assetId && <span className="absolute right-1.5 top-1.5 rounded-full bg-primary p-0.5 text-primary-foreground"><Check className="size-3" /></span>}
                      {keptAsset === assetId && <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground"><Lock className="size-2.5" /> Kept</span>}
                    </button>
                  );
                }
                return (
                  <div key={i} className="flex aspect-[3/4] items-center justify-center rounded-lg border border-dashed border-border px-1 text-center text-xs text-muted-foreground" title={slot?.error ?? undefined}>
                    {slot?.status === "FAILED" ? "Failed" : slot ? <Loader2 className="size-4 animate-spin text-primary" /> : `Option ${i + 1}`}
                  </div>
                );
              })}
            </div>
            {portraits && portraitFailures.length > 0 && !generating && pRetry && (
              <div className="flex items-center justify-between gap-2 text-xs text-destructive" data-testid="status-new-character-failed">
                <span className="flex-1">{portraitFailures[0]?.error || "Some portraits failed."}</span>
                <Button size="sm" variant="outline" className="gap-1.5" disabled={busy || !pRetry.ok}
                  onClick={() => void handleRetry(portraits.id, pRetry.paid, portraitModel.confirmed, portraitModel.reset)} data-testid="button-retry-portraits">
                  <RefreshCw className="size-3.5" /> Retry {portraitFailures.length} failed
                </Button>
              </div>
            )}
            {generating && portraits?.slots.find((s) => s.error) && (
              <p className="text-xs text-muted-foreground">{portraits.slots.find((s) => s.error)?.error}</p>
            )}
            {hasReady && (
              <>
                <ModelPicker choice={sheetModel} label="Reference sheet model" />
                <Button className="w-full gap-2" onClick={() => void handleKeep()}
                  disabled={!choice || busy || sheetRunning || choice === keptAsset || !sheetModel.canSubmit || !characterId}
                  data-testid="button-keep-look">
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />} Keep this look
                </Button>
              </>
            )}
            {sheet && (
              <div data-testid="reference-sheet">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reference sheet</p>
                <div className="grid grid-cols-4 gap-2">
                  {sheet.slots.map((slot) => (
                    <figure key={slot.index}>
                      {slot.status === "READY" && slot.mediaUrl
                        ? <img src={slot.mediaUrl} alt={slot.view ?? "reference"} className="aspect-[3/4] w-full rounded-md object-cover" />
                        : <div className="flex aspect-[3/4] items-center justify-center rounded-md bg-muted/40 text-[10px] text-muted-foreground" title={slot.error ?? undefined}>
                            {slot.status === "FAILED" ? "Failed" : <Loader2 className="size-3 animate-spin text-primary" />}
                          </div>}
                      <figcaption className="mt-1 truncate text-[10px] text-muted-foreground">{slot.view}</figcaption>
                    </figure>
                  ))}
                </div>
                {sheetFailures.length > 0 && !sheetRunning && sRetry && (
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
                    <span className="flex-1">{sheetFailures[0]?.error || "Some views failed."}</span>
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={busy || !sRetry.ok}
                      onClick={() => void handleRetry(sheet.id, sRetry.paid, sheetModel.confirmed, sheetModel.reset)} data-testid="button-retry-sheet">
                      <RefreshCw className="size-3.5" /> Retry {sheetFailures.length} failed
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert" data-testid="status-new-character-error">
            <AlertCircle className="size-4 mt-0.5 text-destructive shrink-0" /><p className="flex-1">{error}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => onOpenAdvanced(characterId)} disabled={busy} data-testid="button-open-advanced-editor">
              <SlidersHorizontal className="size-4" /> {characterId ? "Add details" : "Advanced editor"}
            </Button>
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => onOpenAdvanced(characterId)} disabled={busy} data-testid="button-upload-reference-instead">
              <Upload className="size-4" /> Start from uploaded photos
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy} data-testid="button-close-new-character">
            {characterId ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
