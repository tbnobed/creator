import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { ImageGenerator } from "@/components/studio/ImageGenerator";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Maximize2,
  RotateCcw,
  Star,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  CharacterImageGeneration,
  CharacterImageGenerationInputModelId,
  CharacterImageGenerationProvider,
  useGenerateCharacterImage,
  useUpdateCharacterAsset,
  useDeleteCharacterAsset,
  CharacterDossier,
  getGetCharacterDossierQueryKey,
  getListCharactersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const VIEW_LABELS = [
  "headshot",
  "profile",
  "three-quarter",
  "full-body",
  "expression",
  "wardrobe",
  "other",
] as const;

type ViewLabel = (typeof VIEW_LABELS)[number];
type CharacterAsset = CharacterDossier["assets"][number];

const CHARACTER_IMAGE_MODELS = [
  {
    id: "local-flux2-klein-4b" satisfies CharacterImageGenerationInputModelId,
    label: "Local · FLUX.2 Klein",
    modelName: "FLUX.2 Klein",
    provider: CharacterImageGenerationProvider.LOCAL,
    description: "Native reference editing runs locally with the selected original.",
  },
  {
    id: "cloud-nano-banana-pro" satisfies CharacterImageGenerationInputModelId,
    label: "Cloud · Nano Banana Pro · paid",
    modelName: "Nano Banana Pro",
    provider: CharacterImageGenerationProvider.CLOUD,
    description: "Native reference editing with the selected source photo. Identity is not guaranteed.",
  },
] as const;

type CharacterImageModelId = CharacterImageGenerationInputModelId;
type CharacterImageModel = (typeof CHARACTER_IMAGE_MODELS)[number];

type GenerationProgressStage = "preparing" | "queued" | "rendering" | "sampling" | "saving";

const GENERATION_TELEMETRY_STALE_MS = 15_000;

function newGenerationRequestKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function formatLabel(label: string): string {
  return label.replace(/-/g, " ");
}

function defaultGenerationPrompt(viewLabel: ViewLabel): string {
  if (viewLabel === "wardrobe") {
    return "Full-length outfit reference of this character wearing the outfit shown in the source image, head to toe with shoes visible. Keep the original background; do not add a closet, clothing rack, hangers, or extra garments.";
  }
  return `A ${formatLabel(viewLabel)} shot of this character`;
}

function getCharacterImageModel(modelId: string | null | undefined): CharacterImageModel | undefined {
  return CHARACTER_IMAGE_MODELS.find((model) => model.id === modelId);
}

function getCharacterImageModelByName(modelName: string | null | undefined): CharacterImageModel | undefined {
  const normalizedName = modelName?.trim().toLowerCase();
  if (!normalizedName) return undefined;
  return CHARACTER_IMAGE_MODELS.find((model) => model.modelName.toLowerCase() === normalizedName);
}

function normalizedProvider(provider: string | null | undefined): CharacterImageGenerationProvider | undefined {
  const value = provider?.trim().toUpperCase();
  return value === "LOCAL"
    ? CharacterImageGenerationProvider.LOCAL
    : value === "CLOUD"
      ? CharacterImageGenerationProvider.CLOUD
      : undefined;
}

function generationModel(
  generation: CharacterImageGeneration | null | undefined,
  fallbackModelId?: CharacterImageModelId,
): CharacterImageModel | undefined {
  return getCharacterImageModel(generation?.modelId)
    ?? getCharacterImageModelByName(generation?.modelName)
    ?? getCharacterImageModel(fallbackModelId);
}

function assetName(asset: CharacterAsset, index: number): string {
  const view = formatLabel(asset.label);
  return asset.isPrimary ? `Primary ${view} reference` : `${view} reference ${index + 1}`;
}

/**
 * The source picker deliberately does not use the newest asset. A character's
 * primary image (or its existing thumbnail) is a more stable identity source
 * than the last generated view.
 */
function defaultReferenceAsset(
  assets: CharacterAsset[],
  characterThumbnail?: string | null,
): CharacterAsset | undefined {
  const nonWardrobe = assets.filter((asset) => asset.label !== "wardrobe");
  return nonWardrobe.find((asset) => asset.isPrimary)
    ?? nonWardrobe.find((asset) => characterThumbnail && asset.mediaUrl === characterThumbnail)
    ?? nonWardrobe[0];
}

function getGenerationReferenceId(
  generation: CharacterImageGeneration | null | undefined,
): string | undefined {
  if (!generation) return undefined;
  return generation.referenceAssetId ?? generation.sourceReference?.assetId ?? undefined;
}

function hasSamplingStepCount(generation: CharacterImageGeneration): boolean {
  const step = generation.progressStep;
  const totalSteps = generation.progressTotalSteps;
  return (
    typeof step === "number"
    && Number.isFinite(step)
    && step >= 0
    && typeof totalSteps === "number"
    && Number.isFinite(totalSteps)
    && totalSteps > 0
    && step <= totalSteps
  );
}

function generationStage(
  generation: CharacterImageGeneration,
): GenerationProgressStage {
  const reportedStage = generation.progressStage?.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (reportedStage?.includes("sampling")) return "sampling";
  // The API calls the sampler stage "rendering". Keep the dossier language
  // explicit about what the percentage represents: sampler progress, not
  // whole-render completion.
  if (reportedStage?.includes("render")) return hasSamplingStepCount(generation) ? "sampling" : "rendering";
  if (reportedStage?.includes("saving") || reportedStage?.includes("save")) return "saving";
  if (reportedStage?.includes("prepar")) return "preparing";
  if (reportedStage?.includes("queue")) return "queued";
  return generation.status === "QUEUED" ? "queued" : "preparing";
}

function stageLabel(stage: GenerationProgressStage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function validSamplingProgress(generation: CharacterImageGeneration): number | null {
  const progress = generation.progress;
  if (
    generationStage(generation) !== "sampling"
    || typeof progress !== "number"
    || !Number.isFinite(progress)
    || !hasSamplingStepCount(generation)
    || progress < 0
    || progress > 1
  ) {
    return null;
  }
  return Math.round(progress * 100);
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatElapsedTime(elapsedSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function readableApiError(error: unknown, fallback: string): { message: string; status?: number } {
  const candidate = error as {
    status?: unknown;
    data?: { error?: unknown; message?: unknown; detail?: unknown } | null;
    message?: unknown;
  };
  const raw = candidate?.data?.error
    ?? candidate?.data?.message
    ?? candidate?.data?.detail
    ?? candidate?.message;
  const message = typeof raw === "string" ? raw : fallback;
  return {
    message: message.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || fallback,
    status: typeof candidate?.status === "number" ? candidate.status : undefined,
  };
}

function isActiveGenerationRefusal(error: unknown, message: string, status?: number): boolean {
  return status === 409 || /active|queued|running|job|in use/i.test(message);
}

function isViewLabel(value: string): value is ViewLabel {
  return (VIEW_LABELS as readonly string[]).includes(value);
}

export function DossierReferences({
  characterId,
  dossier,
  characterThumbnail,
}: {
  characterId: string;
  dossier?: CharacterDossier;
  characterThumbnail?: string | null;
}) {
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [uploadLabel, setUploadLabel] = useState<ViewLabel>("headshot");
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [removedAssetIds, setRemovedAssetIds] = useState<Set<string>>(() => new Set());
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [pendingDeleteAsset, setPendingDeleteAsset] = useState<CharacterAsset | null>(null);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [generationSources, setGenerationSources] = useState<Record<string, string>>({});
  const [generationModels, setGenerationModels] = useState<Record<string, CharacterImageModelId>>({});
  const [selectedModelId, setSelectedModelId] = useState<CharacterImageModelId>("local-flux2-klein-4b");
  const [cloudConfirmed, setCloudConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationRequestKeyRef = useRef<string | null>(null);
  const { toast } = useToast();

  const queryClient = useQueryClient();
  const updateAsset = useUpdateCharacterAsset();
  const deleteAsset = useDeleteCharacterAsset();
  const generateMutation = useGenerateCharacterImage();

  useEffect(() => {
    const status = dossier?.imageGeneration?.status;
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
      generationRequestKeyRef.current = null;
    }
  }, [dossier?.imageGeneration?.id, dossier?.imageGeneration?.status]);

  const assets = useMemo(
    () => (dossier?.assets ?? []).filter((asset) => !removedAssetIds.has(asset.id)),
    [dossier?.assets, removedAssetIds],
  );
  const filteredAssets = activeFilter === "all"
    ? assets
    : assets.filter((asset) => asset.label === activeFilter);
  const viewerAssets = assets;
  const viewerAsset = viewerAssetId
    ? viewerAssets.find((asset) => asset.id === viewerAssetId)
    : undefined;
  const viewerIndex = viewerAsset ? viewerAssets.findIndex((asset) => asset.id === viewerAsset.id) : -1;
  const selectedReferenceAsset = assets.find((asset) => asset.id === referenceAssetId);
  const defaultReference = defaultReferenceAsset(assets, characterThumbnail);
  const selectedModel = getCharacterImageModel(selectedModelId) ?? CHARACTER_IMAGE_MODELS[0];
  const selectedSourceId = selectedReferenceAsset?.id ?? defaultReference?.id;
  const isCloudModel = selectedModel.provider === "CLOUD";
  const assetIdSignature = assets.map((asset) => asset.id).join("|");

  useEffect(() => {
    setCloudConfirmed(false);
  }, [selectedModelId, selectedSourceId]);

  // Keep a source selected after refetches, but never silently switch a
  // deliberate selection to the most recently generated image.
  useEffect(() => {
    if (selectedReferenceAsset) return;
    const fallback = defaultReference?.id ?? "";
    setReferenceAssetId((current) => (current === fallback ? current : fallback));
  }, [assetIdSignature, characterThumbnail, defaultReference?.id, selectedReferenceAsset]);

  useEffect(() => {
    if (viewerAssetId && !viewerAsset) {
      setViewerAssetId(null);
      setViewerZoom(1);
    }
  }, [viewerAssetId, viewerAsset]);

  useEffect(() => {
    if (!viewerAssetId) return;
    const handleViewerKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setViewerAssetId(null);
        setViewerZoom(1);
      } else if (event.key === "ArrowLeft" && viewerAssets.length > 1) {
        event.preventDefault();
        event.stopPropagation();
        const index = viewerAssets.findIndex((asset) => asset.id === viewerAssetId);
        setViewerAssetId(viewerAssets[(index - 1 + viewerAssets.length) % viewerAssets.length].id);
        setViewerZoom(1);
      } else if (event.key === "ArrowRight" && viewerAssets.length > 1) {
        event.preventDefault();
        event.stopPropagation();
        const index = viewerAssets.findIndex((asset) => asset.id === viewerAssetId);
        setViewerAssetId(viewerAssets[(index + 1) % viewerAssets.length].id);
        setViewerZoom(1);
      }
    };
    document.addEventListener("keydown", handleViewerKeyDown);
    return () => document.removeEventListener("keydown", handleViewerKeyDown);
  }, [viewerAssetId, viewerAssets]);

  const refreshCharacterQueries = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getGetCharacterDossierQueryKey(characterId) });
    void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });
  }, [characterId, queryClient]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const response = await fetch(`/api/characters/${characterId}/assets`, {
          method: "POST",
          headers: {
            "content-type": file.type,
            "x-file-name": file.name,
            "x-asset-label": uploadLabel,
          },
          body: file,
        });

        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error ?? "Upload failed");
        }
      }
      refreshCharacterQueries();
      toast({ title: "Assets uploaded successfully" });
    } catch (error) {
      const parsed = readableApiError(error, "The image upload could not be completed.");
      toast({ title: "Error uploading", description: parsed.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleGenerate = async (prompt: string, seed?: number) => {
    try {
      if (isCloudModel && !cloudConfirmed) {
        throw new Error("Confirm the paid cloud provider before generating.");
      }
      const requestKey = generationRequestKeyRef.current ?? (
        generationRequestKeyRef.current = newGenerationRequestKey()
      );
      // Capture the exact source and model at submit time.
      const sourceId = selectedSourceId;
      if (isCloudModel && !sourceId) {
        throw new Error("Select an existing original reference before using the paid cloud provider.");
      }
      const data: Parameters<typeof generateMutation.mutateAsync>[0]["data"] = {
        prompt,
        seed,
        referenceLabel: uploadLabel,
        modelId: selectedModel.id,
        ...(isCloudModel ? { cloudConfirmed: true } : {}),
        requestKey,
        ...(sourceId ? { referenceAssetId: sourceId } : {}),
      };
      if (isCloudModel) setCloudConfirmed(false);
      const response = await generateMutation.mutateAsync({
        id: characterId,
        data,
      });
      if (response.id && sourceId) {
        setGenerationSources((current) => ({ ...current, [response.id]: sourceId }));
      }
      if (response.id) {
        setGenerationModels((current) => ({ ...current, [response.id]: selectedModel.id }));
      }
      refreshCharacterQueries();
      return response.mediaUrl ?? undefined;
    } catch (error) {
      const parsed = readableApiError(error, "Failed to generate image");
      throw new Error(parsed.message);
    }
  };

  const setPrimary = async (assetId: string) => {
    try {
      await updateAsset.mutateAsync({ id: characterId, assetId, data: { makePrimary: true } });
      setReferenceAssetId(assetId);
      refreshCharacterQueries();
      toast({ title: "Primary reference updated" });
    } catch (error) {
      const parsed = readableApiError(error, "The primary reference could not be updated.");
      toast({ title: "Error updating asset", description: parsed.message, variant: "destructive" });
    }
  };

  const updateLabel = async (assetId: string, label: string) => {
    if (!isViewLabel(label)) return;
    try {
      await updateAsset.mutateAsync({ id: characterId, assetId, data: { label } });
      refreshCharacterQueries();
    } catch (error) {
      const parsed = readableApiError(error, "The reference view could not be updated.");
      toast({ title: "Error updating label", description: parsed.message, variant: "destructive" });
    }
  };

  const requestDelete = (asset: CharacterAsset) => {
    if (deletingAssetId) return;
    setPendingDeleteAsset(asset);
  };

  const confirmDelete = async () => {
    if (!pendingDeleteAsset || deletingAssetId) return;
    const assetToDelete = pendingDeleteAsset;
    const assetIndex = viewerAssets.findIndex((asset) => asset.id === assetToDelete.id);
    setDeletingAssetId(assetToDelete.id);
    try {
      await deleteAsset.mutateAsync({ id: characterId, assetId: assetToDelete.id });

      const remainingAssets = viewerAssets.filter((asset) => asset.id !== assetToDelete.id);
      if (viewerAssetId === assetToDelete.id) {
        const nextIndex = Math.min(assetIndex, remainingAssets.length - 1);
        setViewerAssetId(nextIndex >= 0 ? remainingAssets[nextIndex].id : null);
        setViewerZoom(1);
      }
      setRemovedAssetIds((current) => {
        const next = new Set(current);
        next.add(assetToDelete.id);
        return next;
      });
      setReferenceAssetId((current) => (current === assetToDelete.id ? "" : current));
      queryClient.setQueryData<CharacterDossier>(
        getGetCharacterDossierQueryKey(characterId),
        (current) => current
          ? { ...current, assets: current.assets.filter((asset) => asset.id !== assetToDelete.id) }
          : current,
      );
      refreshCharacterQueries();
      setPendingDeleteAsset(null);
      toast({ title: "Reference deleted", description: `${assetName(assetToDelete, assetIndex)} was removed.` });
    } catch (error) {
      const parsed = readableApiError(error, "The reference could not be deleted.");
      if (isActiveGenerationRefusal(error, parsed.message, parsed.status)) {
        toast({
          title: "Cannot delete reference while a generation is active",
          description: parsed.message || "Wait for the active image job to finish, then try again.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Error deleting reference", description: parsed.message, variant: "destructive" });
      }
    } finally {
      setDeletingAssetId(null);
    }
  };

  const generation = dossier?.imageGeneration;
  const generationReferenceId = getGenerationReferenceId(generation)
    ?? (generation?.id ? generationSources[generation.id] : undefined);
  const generationReference = generationReferenceId
    ? assets.find((asset) => asset.id === generationReferenceId)
    : undefined;
  const generationSourceText = generationReference
    ? assetName(generationReference, assets.findIndex((asset) => asset.id === generationReference.id))
    : generationReferenceId
      ? "Reference no longer available"
      : generation?.referenceUsed === false
        ? "Prompt-only (no image source)"
        : "Not reported by the server";
  const activeGenerationModel = generationModel(
    generation,
    generation?.id ? generationModels[generation.id] : undefined,
  );
  const activeGenerationProvider = activeGenerationModel?.label
    ?? (normalizedProvider(generation?.provider) === "CLOUD" ? "Cloud provider" : undefined)
    ?? (normalizedProvider(generation?.provider) === "LOCAL" ? "Local provider" : undefined)
    ?? "Provider not reported";
  const generationWaitingText = normalizedProvider(generation?.provider) === "CLOUD"
    || activeGenerationModel?.provider === "CLOUD"
    ? "Waiting for the cloud provider to process this request. You can leave and return; it continues in the background."
    : "The local provider is processing this request. You can leave and return; it continues in the background.";
  const generationProgressWaitingText = normalizedProvider(generation?.provider) === "CLOUD"
    || activeGenerationModel?.provider === "CLOUD"
    ? "Waiting for cloud provider progress"
    : "Waiting for local provider progress";
  const isGenerationActive = generation?.status === "QUEUED" || generation?.status === "RUNNING";
  const generationStartedAt = parseTimestamp(generation?.startedAt) ?? parseTimestamp(generation?.createdAt);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  useEffect(() => {
    if (!isGenerationActive) return;
    const updateClock = () => setCurrentTime(Date.now());
    updateClock();
    const timer = window.setInterval(updateClock, 1_000);
    return () => window.clearInterval(timer);
  }, [generation?.id, isGenerationActive]);

  const elapsedSeconds = generationStartedAt === null
    ? 0
    : Math.max(0, (currentTime - generationStartedAt) / 1_000);
  const progressUpdatedAt = parseTimestamp(generation?.progressUpdatedAt);
  const isTelemetryStale = Boolean(
    isGenerationActive
    && progressUpdatedAt !== null
    && currentTime >= progressUpdatedAt
    && currentTime - progressUpdatedAt > GENERATION_TELEMETRY_STALE_MS,
  );
  const generationStageValue = generation ? generationStage(generation) : "preparing";
  const samplingProgress = generation && isGenerationActive ? validSamplingProgress(generation) : null;

  const moveViewer = (direction: -1 | 1) => {
    if (viewerIndex < 0 || viewerAssets.length < 2) return;
    const nextIndex = (viewerIndex + direction + viewerAssets.length) % viewerAssets.length;
    setViewerAssetId(viewerAssets[nextIndex].id);
    setViewerZoom(1);
  };

  return (
    <div className="@container flex min-w-0 flex-col space-y-6">
      <div>
        <h3 className="mb-1 text-lg font-semibold">Visual References</h3>
        <p className="text-sm text-muted-foreground">
          Approved images used to guide character continuity. Open any thumbnail to inspect the uncropped original.
        </p>
      </div>

      {generation && isGenerationActive && (
        <section
          className="overflow-hidden rounded-xl border border-primary/30 bg-primary/[0.06] shadow-sm"
          data-testid={`status-character-image-generation-${characterId}`}
          aria-busy="true"
        >
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-primary/15 px-4 py-4 sm:px-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 rounded-full bg-primary/15 p-2 text-primary">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h4 className="font-semibold">Generating visual reference</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {generationWaitingText}
                </p>
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0 border border-primary/20 bg-primary/10 text-primary">
              In progress
            </Badge>
          </div>

          <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-5">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Target view</p>
              <p
                className="mt-1 truncate text-sm font-medium capitalize"
                data-testid={`text-character-image-generation-target-view-${characterId}`}
              >
                {generation.referenceLabel ? formatLabel(generation.referenceLabel) : "Not specified"}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Source</p>
              <p
                className="mt-1 truncate text-sm font-medium"
                data-testid={`text-character-image-generation-source-${characterId}`}
                title={generationSourceText}
              >
                {generationSourceText}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Provider</p>
              <p
                className="mt-1 truncate text-sm font-medium"
                data-testid={`text-character-image-generation-provider-${characterId}`}
                title={activeGenerationProvider}
              >
                {activeGenerationProvider}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Stage</p>
              <Badge
                variant="outline"
                className="mt-1 border-primary/30 capitalize text-primary"
                data-testid={`status-character-image-generation-stage-${characterId}`}
              >
                {stageLabel(generationStageValue)}
              </Badge>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Elapsed</p>
              <p
                className="mt-1 font-mono text-sm font-medium tabular-nums"
                data-testid={`text-character-image-generation-elapsed-${characterId}`}
                aria-live="off"
              >
                {formatElapsedTime(elapsedSeconds)}
              </p>
            </div>
          </div>

          <div className="space-y-2 border-t border-primary/15 px-4 py-4 sm:px-5">
            {samplingProgress !== null ? (
              <>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">Sampling</span>
                  <span
                    className="font-mono text-xs tabular-nums text-muted-foreground"
                    data-testid={`text-character-image-generation-progress-${characterId}`}
                  >
                    {samplingProgress}% sampler · step {generation.progressStep} of {generation.progressTotalSteps}
                  </span>
                </div>
                <Progress
                  value={samplingProgress}
                  aria-label={`Sampling progress: ${samplingProgress}%`}
                  data-testid={`progress-character-image-generation-${characterId}`}
                  className="h-2"
                />
              </>
            ) : (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-testid={`status-character-image-generation-progress-${characterId}`}
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {generationProgressWaitingText}
              </p>
            )}
            {isTelemetryStale && (
              <p
                className="text-xs text-amber-600 dark:text-amber-400"
                data-testid={`status-character-image-generation-stale-${characterId}`}
              >
                Provider progress telemetry is stale; the latest stage may be out of date.
              </p>
            )}
          </div>
        </section>
      )}

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 @min-[960px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/50 pb-3">
            <Button
              variant={activeFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveFilter("all")}
              className="shrink-0 rounded-full"
            >
              All
            </Button>
            {VIEW_LABELS.map((label) => (
              <Button
                key={label}
                variant={activeFilter === label ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setActiveFilter(label);
                  setUploadLabel(label);
                }}
                className="shrink-0 rounded-full capitalize"
              >
                {formatLabel(label)}
              </Button>
            ))}
          </div>

          {filteredAssets.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/50 bg-card/10 p-12 text-center">
              <Camera className="mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No references found for this view</p>
              <p className="mt-1 text-xs text-muted-foreground">Upload or generate new images below.</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-4">
              {filteredAssets.map((asset) => {
                const assetIndex = assets.findIndex((candidate) => candidate.id === asset.id);
                const isDeleting = deletingAssetId === asset.id;
                return (
                  <div key={asset.id} className="overflow-hidden rounded-xl border border-border/50 bg-secondary/10">
                    <button
                      type="button"
                      className="group relative block aspect-square w-full overflow-hidden bg-secondary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => {
                        setViewerAssetId(asset.id);
                        setViewerZoom(1);
                      }}
                      aria-label={`Open ${assetName(asset, assetIndex)} in the image viewer`}
                    >
                      <img
                        src={asset.mediaUrl}
                        alt={assetName(asset, assetIndex)}
                        className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
                        loading="lazy"
                      />
                      <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-8 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        <Maximize2 className="h-3.5 w-3.5" /> Open full image
                      </span>
                    </button>

                    <div className="space-y-3 p-3">
                      <div className="flex min-h-5 items-center justify-between gap-2">
                        <Badge variant="secondary" className="max-w-full truncate text-[10px] capitalize">
                          {formatLabel(asset.label)}
                        </Badge>
                        {asset.isPrimary && (
                          <Badge className="shrink-0 gap-1 bg-primary text-[10px]">
                            <Star className="h-3 w-3 fill-current" /> Primary
                          </Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={asset.isPrimary ? "secondary" : "outline"}
                          className="h-10 min-w-0 gap-1.5 rounded-lg px-2 text-xs"
                          onClick={() => setPrimary(asset.id)}
                          disabled={asset.isPrimary || updateAsset.isPending || isDeleting}
                        >
                          <Star className={`h-3.5 w-3.5 shrink-0 ${asset.isPrimary ? "fill-current" : ""}`} />
                          {asset.isPrimary ? "Primary" : "Set primary"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-10 w-10 rounded-lg p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Delete ${assetName(asset, assetIndex)}`}
                          title="Delete image"
                          onClick={() => requestDelete(asset)}
                          disabled={Boolean(deletingAssetId) || deleteAsset.isPending || updateAsset.isPending}
                        >
                          {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </div>

                      <Select
                        value={asset.label}
                        onValueChange={(label) => updateLabel(asset.id, label)}
                        disabled={updateAsset.isPending || isDeleting}
                      >
                        <SelectTrigger
                          aria-label={`View label for ${assetName(asset, assetIndex)}`}
                          className="h-10 w-full min-w-0 rounded-lg bg-background/50 text-xs capitalize [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left"
                        >
                          <SelectValue>{formatLabel(asset.label)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {VIEW_LABELS.map((label) => (
                            <SelectItem key={label} value={label} className="capitalize">
                              {formatLabel(label)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <div className="space-y-4 rounded-xl border border-border/50 bg-secondary/10 p-4">
            <div>
              <h4 className="font-semibold text-sm">Add New Reference</h4>
              <p className="mt-1 text-xs text-muted-foreground">Choose the target view, then upload or generate an image.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reference-target-view">Target view</Label>
              <Select value={uploadLabel} onValueChange={(value) => isViewLabel(value) && setUploadLabel(value)}>
                <SelectTrigger id="reference-target-view" className="bg-background capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIEW_LABELS.map((label) => (
                    <SelectItem key={label} value={label} className="capitalize">{formatLabel(label)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Target view is a requested output angle, not a confirmed pose.
              </p>
              {uploadLabel === "wardrobe" && (
                <p className="text-xs text-muted-foreground">
                  Shows the clothing worn by the character, not a wardrobe or dressing-room scene. Describe an outfit change in the prompt if needed.
                </p>
              )}
            </div>

            <div className="space-y-2 border-t border-border/50 pt-3">
              <div>
                <Label htmlFor="reference-source">Image reference source</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  The selected original guides the edit. It is not the last generated image unless you choose it.
                </p>
              </div>
              <Select
                value={referenceAssetId}
                onValueChange={setReferenceAssetId}
                disabled={assets.length === 0 || generateMutation.isPending}
              >
                <SelectTrigger id="reference-source" className="h-auto min-h-10 bg-background py-2 text-left">
                  <SelectValue placeholder="No image reference available" />
                </SelectTrigger>
                <SelectContent>
                  {assets.map((asset, index) => (
                    <SelectItem key={asset.id} value={asset.id}>
                      <span className="flex items-center gap-2">
                        {asset.isPrimary && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-primary" />}
                        <span className="truncate">{assetName(asset, index)}</span>
                        <span className="text-xs capitalize text-muted-foreground">({formatLabel(asset.label)})</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {selectedReferenceAsset
                  ? <>Selected source: <span className="font-medium text-foreground">{assetName(selectedReferenceAsset, assets.findIndex((asset) => asset.id === selectedReferenceAsset.id))}</span></>
                  : "No image source selected; this will be prompt-only."}
              </p>
            </div>

            <div className="space-y-3 border-t border-border/50 pt-3">
              <div>
                <Label className="mb-2 block">Upload file</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*"
                  multiple
                  onChange={handleUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                >
                  {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Upload image
                </Button>
              </div>
            </div>

            <div className="space-y-3 border-t border-border/50 pt-3">
              <div>
                <Label className="mb-2 block">Generate view</Label>
                <div className="rounded-md border border-border/50 bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  <strong className="text-foreground">Reference-guided character edit:</strong>{" "}
                  Uses the selected original to guide identity and the requested camera angle. Review each result before approving.
                </div>
              </div>

              <div className="space-y-2 border-t border-border/50 pt-3">
                <div>
                  <Label htmlFor="character-image-model">Model</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose where this reference edit runs. Local is selected by default.
                  </p>
                </div>
                <Select
                  value={selectedModel.id}
                  onValueChange={(value) => {
                    const model = getCharacterImageModel(value);
                    if (model) setSelectedModelId(model.id);
                  }}
                  disabled={generateMutation.isPending}
                >
                  <SelectTrigger id="character-image-model" className="h-auto min-h-10 bg-background py-2 text-left">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHARACTER_IMAGE_MODELS.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{selectedModel.description}</p>
                {isCloudModel && (
                  <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      This uses the paid cloud provider and sends the selected reference image to it.
                    </p>
                    {!selectedSourceId && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Select an existing original reference before using the paid cloud provider.
                      </p>
                    )}
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="character-cloud-confirm"
                        checked={cloudConfirmed}
                        onCheckedChange={(value) => setCloudConfirmed(Boolean(value))}
                        disabled={generateMutation.isPending}
                      />
                      <label htmlFor="character-cloud-confirm" className="cursor-pointer text-xs leading-relaxed">
                        I confirm this paid cloud generation and sending the selected reference image.
                      </label>
                    </div>
                  </div>
                )}
              </div>

              {generation && !isGenerationActive && (
                <div
                  className="rounded-md border border-border/50 bg-background/50 p-3 text-xs"
                  data-testid={`status-character-image-generation-${characterId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Latest image task</span>
                    <Badge
                      variant={generation.status === "FAILED" ? "destructive" : "secondary"}
                      className="text-[10px]"
                    >
                      {generation.status === "FAILED"
                        ? "Error"
                        : generation.status.charAt(0) + generation.status.slice(1).toLowerCase()}
                    </Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    <span className="font-medium text-foreground">Source used:</span> {generationSourceText}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    <span className="font-medium text-foreground">Provider:</span> {activeGenerationProvider}
                  </p>
                  {(generation.status === "QUEUED" || generation.status === "RUNNING") && (
                    <>
                      <p className="mt-1 text-muted-foreground">{generationWaitingText}</p>
                      {generation.errorMessage && <p className="mt-1 text-muted-foreground">{generation.errorMessage}</p>}
                    </>
                  )}
                  {generation.status === "FAILED" && generation.errorMessage && (
                    <p className="mt-1 text-destructive">{generation.errorMessage}</p>
                  )}
                </div>
              )}

              <ImageGenerator
                onGenerate={handleGenerate}
                defaultPrompt={defaultGenerationPrompt(uploadLabel)}
                generateLabel={isCloudModel ? "Generate with paid cloud" : undefined}
                generateDisabled={isCloudModel && (!cloudConfirmed || !selectedSourceId)}
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(viewerAsset)}
        onOpenChange={(open) => {
          if (!open) {
            setViewerAssetId(null);
            setViewerZoom(1);
          }
        }}
      >
        <DialogContent
          data-dossier-image-viewer
          className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setViewerAssetId(null);
            setViewerZoom(1);
          }}
          onInteractOutside={(event) => {
            // The delete confirmation is a separate Radix portal. Its focus
            // and overlay are outside this dialog, but opening/cancelling it
            // must not dismiss the image the user is inspecting.
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onFocusOutside={(event) => {
            event.preventDefault();
          }}
        >
          {viewerAsset && (
            <>
              <DialogHeader className="shrink-0 border-b border-border/50 px-4 py-3 pr-14 text-left sm:px-6">
                <DialogTitle className="truncate text-base sm:text-lg">
                  {assetName(viewerAsset, viewerIndex)}
                </DialogTitle>
                <DialogDescription className="flex items-center gap-2 text-xs">
                  <span className="capitalize">{formatLabel(viewerAsset.label)}</span>
                  <span aria-hidden="true">•</span>
                  <span aria-live="polite">{viewerIndex + 1} of {viewerAssets.length}</span>
                </DialogDescription>
              </DialogHeader>

              <div className="relative flex min-h-0 min-h-[280px] flex-1 items-center justify-center overflow-hidden bg-black/90 p-2 sm:p-6">
                <img
                  key={`${viewerAsset.id}:${viewerAsset.mediaUrl}`}
                  src={viewerAsset.mediaUrl}
                  alt={assetName(viewerAsset, viewerIndex)}
                  className="max-h-[min(62vh,620px)] max-w-full object-contain transition-transform duration-200"
                  style={{ transform: `scale(${viewerZoom})` }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="absolute left-2 top-1/2 h-10 w-10 -translate-y-1/2 bg-background/80 shadow-lg sm:left-4"
                  onClick={() => moveViewer(-1)}
                  disabled={viewerAssets.length < 2}
                  aria-label="Previous image"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="absolute right-2 top-1/2 h-10 w-10 -translate-y-1/2 bg-background/80 shadow-lg sm:right-4"
                  onClick={() => moveViewer(1)}
                  disabled={viewerAssets.length < 2}
                  aria-label="Next image"
                >
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>

              <div className="flex flex-col gap-3 border-t border-border/50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setViewerZoom((zoom) => Math.max(0.75, zoom - 0.25))}
                    disabled={viewerZoom <= 0.75}
                    aria-label="Zoom out"
                  >
                    <ZoomOut className="mr-1.5 h-4 w-4" /> Zoom out
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setViewerZoom((zoom) => Math.min(3, zoom + 0.25))}
                    disabled={viewerZoom >= 3}
                    aria-label="Zoom in"
                  >
                    <ZoomIn className="mr-1.5 h-4 w-4" /> Zoom in
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setViewerZoom(1)}
                    disabled={viewerZoom === 1}
                  >
                    <RotateCcw className="mr-1.5 h-4 w-4" /> Reset
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <a
                    href={viewerAsset.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ExternalLink className="h-4 w-4" /> Open full resolution
                  </a>
                  <a
                    href={viewerAsset.mediaUrl}
                    download
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Download className="h-4 w-4" /> Download
                  </a>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => requestDelete(viewerAsset)}
                    disabled={Boolean(deletingAssetId) || deleteAsset.isPending || updateAsset.isPending}
                  >
                    {deletingAssetId === viewerAsset.id
                      ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      : <Trash2 className="mr-1.5 h-4 w-4" />}
                    Delete reference
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(pendingDeleteAsset)}
        onOpenChange={(open) => {
          if (!open && !deletingAssetId) setPendingDeleteAsset(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this visual reference?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteAsset && (
                <>
                  This will permanently remove <span className="font-medium text-foreground">{assetName(pendingDeleteAsset, assets.findIndex((asset) => asset.id === pendingDeleteAsset.id))}</span> from this character dossier. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingAssetId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingAssetId)}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deletingAssetId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {deletingAssetId ? "Deleting..." : "Delete reference"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}