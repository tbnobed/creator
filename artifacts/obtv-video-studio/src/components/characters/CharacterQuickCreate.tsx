import { useEffect, useRef, useState } from "react";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertCircle, Loader2, SlidersHorizontal, Sparkles, Upload } from "lucide-react";
import {
  useCreateCharacter,
  useGenerateCharacterImage,
  useGetCharacterDossier,
  getGetCharacterDossierQueryKey,
  getListCharactersQueryKey,
  type CharacterImageGeneration,
  type Character,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const LOCAL_MODEL_ID = "local-flux2-klein-4b" as const;

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

function progressPercent(g: CharacterImageGeneration): number | null {
  const p = g.progress;
  const ok = typeof p === "number" && p >= 0 && p <= 1
    && typeof g.progressStep === "number" && typeof g.progressTotalSteps === "number" && g.progressTotalSteps > 0;
  return ok ? Math.round((p as number) * 100) : null;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const submitLock = useRef(false);
  const requestKeyRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const createCharacter = useCreateCharacter();
  const generateImage = useGenerateCharacterImage();

  const { data: dossier } = useGetCharacterDossier(characterId ?? "", {
    query: {
      enabled: !!characterId,
      queryKey: getGetCharacterDossierQueryKey(characterId ?? ""),
      refetchInterval: (q) => {
        const s = q.state.data?.imageGeneration?.status;
        return s === "QUEUED" || s === "RUNNING" ? 2000 : false;
      },
    },
  });

  const generation = dossier?.imageGeneration && (!jobId || dossier.imageGeneration.id === jobId)
    ? dossier.imageGeneration
    : null;
  const status = generation?.status;
  const isActive = status === "QUEUED" || status === "RUNNING";
  const busy = submitting || isActive;

  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status && status !== lastStatus.current) {
      lastStatus.current = status;
      if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
        requestKeyRef.current = null;
        void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
        if (characterId) void queryClient.invalidateQueries({ queryKey: getGetCharacterDossierQueryKey(characterId) });
      }
    }
  }, [status, characterId, queryClient]);

  const handleGenerate = async () => {
    const text = prompt.trim();
    if (!text || busy || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let id = characterId;
      if (!id) {
        const created = await createCharacter.mutateAsync({
          data: {
            name: name.trim() || deriveName(text),
            description: text.slice(0, 160),
            promptDescription: text,
            tags: [],
          },
        });
        id = created.id;
        queryClient.setQueryData<Character[]>(getListCharactersQueryKey(), (old) =>
          [...(old ?? []).filter(c => c.id !== created.id), created],
        );
        onCharacterCreated(id);
        void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
      }
      const requestKey = requestKeyRef.current ?? (requestKeyRef.current = newRequestKey());
      const job = await generateImage.mutateAsync({
        id,
        data: {
          prompt: text,
          modelId: LOCAL_MODEL_ID,
          referenceLabel: "headshot",
          allowNewIdentity: true,
          requestKey,
        },
      });
      setJobId(job.id);
      lastStatus.current = undefined;
      queryClient.setQueryData(getGetCharacterDossierQueryKey(id), (old: typeof dossier) =>
        old ? { ...old, imageGeneration: job } : old,
      );
      void queryClient.invalidateQueries({ queryKey: getGetCharacterDossierQueryKey(id) });
    } catch (err) {
      setError(readableError(err, "The character could not be generated."));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const handleRetry = () => {
    requestKeyRef.current = null;
    setJobId(null);
    void handleGenerate();
  };

  const pct = generation && isActive ? progressPercent(generation) : null;
  const stage = generation?.status === "QUEUED" ? "Queued" : generation?.progressStage
    ? generation.progressStage.charAt(0).toUpperCase() + generation.progressStage.slice(1)
    : "Running";

  return (
    <DialogContent
      onInteractOutside={e => { if (submitting) e.preventDefault(); }}
      onEscapeKeyDown={e => { if (submitting) e.preventDefault(); }}
      className="w-full max-w-2xl max-h-[100dvh] overflow-y-auto bg-background border-border p-0"
      data-testid="dialog-new-character"
    >
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-xl font-bold tracking-tight">New character</DialogTitle>
        <DialogDescription>Describe who you want. We'll save the character and generate a first look locally, free.</DialogDescription>
      </DialogHeader>

      <div className="px-6 pb-6 space-y-5">
        <div className="space-y-2">
          <label htmlFor="new-character-prompt" className="text-sm font-medium">Describe the character</label>
          <Textarea
            id="new-character-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleGenerate(); }}
            placeholder="A weathered harbor pilot in her fifties, salt-gray braid, wind-burned cheeks, navy wool peacoat, calm skeptical eyes"
            className="min-h-32 resize-none bg-secondary/20"
            maxLength={4000}
            disabled={busy}
            data-testid="input-new-character-prompt"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="new-character-name" className="text-sm font-medium">
            Name <span className="text-muted-foreground font-normal">(optional, derived from the description if blank)</span>
          </label>
          <Input
            id="new-character-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={prompt.trim() ? deriveName(prompt) : "e.g. Captain Ines Varga"}
            className="bg-secondary/20"
            disabled={busy || !!characterId}
            data-testid="input-new-character-name"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge variant="outline" className="border-border/60 text-muted-foreground" data-testid="badge-new-character-model">
            Local · FLUX.2 Klein · free
          </Badge>
          <Button
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || busy}
            className="gap-2"
            data-testid="button-generate-character"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {submitting ? "Starting..." : isActive ? "Generating..." : status === "COMPLETED" ? "Generate another look" : "Generate character"}
          </Button>
        </div>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert" data-testid="status-new-character-error">
            <AlertCircle className="size-4 mt-0.5 text-destructive shrink-0" />
            <p className="flex-1">{error}</p>
          </div>
        )}

        {generation && isActive && (
          <div className="rounded-lg border border-primary/30 bg-primary/[0.06] p-4 space-y-3" aria-busy="true" data-testid="status-new-character-generation">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium"><Loader2 className="size-4 animate-spin text-primary" /> Generating first look</span>
              <Badge variant="outline" className="border-primary/30 text-primary" data-testid="status-new-character-stage">{stage}</Badge>
            </div>
            {pct !== null ? (
              <>
                <Progress value={pct} className="h-2" data-testid="progress-new-character" />
                <p className="font-mono text-xs text-muted-foreground" data-testid="text-new-character-progress">{pct}% · step {generation.progressStep} of {generation.progressTotalSteps}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for local provider progress. You can close this; the character is already saved and generation continues.</p>
            )}
          </div>
        )}

        {generation?.status === "FAILED" || generation?.status === "CANCELLED" ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" data-testid="status-new-character-failed">
            <AlertCircle className="size-4 mt-0.5 text-destructive shrink-0" />
            <p className="flex-1">{generation.errorMessage || `Generation ${generation.status.toLowerCase()}.`}</p>
            <Button size="sm" variant="outline" onClick={handleRetry} disabled={busy || !prompt.trim()} data-testid="button-retry-new-character">Try again</Button>
          </div>
        ) : null}

        {generation?.status === "COMPLETED" && generation.mediaUrl && (
          <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden" data-testid="card-new-character-output">
            <img src={generation.mediaUrl} alt="Generated character" className="w-full max-h-[50dvh] object-contain bg-black/40" data-testid="img-new-character-output" />
            <p className="px-4 py-3 text-sm text-muted-foreground">Saved to this character as a headshot reference.</p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => onOpenAdvanced(characterId)} disabled={submitting} data-testid="button-open-advanced-editor">
              <SlidersHorizontal className="size-4" /> {characterId ? "Add details" : "Advanced editor"}
            </Button>
            <Button variant="ghost" size="sm" className="gap-2" onClick={() => onOpenAdvanced(characterId)} disabled={submitting} data-testid="button-upload-reference-instead">
              <Upload className="size-4" /> Start from uploaded photos
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting} data-testid="button-close-new-character">
            {characterId ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
