import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  useListCharacters, 
  useListSettings, 
  useCreateGeneration, 
  useGetGenerationCapabilities,
  useGetGeneration,
  getGetGenerationQueryKey,
  useListGenerations,
  getListGenerationsQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { VideoGenerationViewer } from "@/components/video-studio/VideoGenerationViewer";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Check, Clapperboard, Users, Map, Play, Pencil, Video, ChevronsUpDown, X, ArrowUpRight, SlidersHorizontal, Sparkles, ChevronDown, Film, Clock3, Plus, Layers3 } from "lucide-react";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PromptGuidancePanel } from "@/components/prompt-guidance-panel";
import { sanitizeProviderMessage } from "@/lib/provider-messages";
import {
  composerSourceLoadState,
  restoreComposerFields,
} from "@/lib/generation-edit";

const REFERENCE_VIDEO_STORAGE_KEY = "obtv.referenceVideo";
const COMPOSER_DRAFT_STORAGE_KEY = "obtv.composerDraft";
const DEFAULT_RESOLUTION_OPTIONS = [
  { width: 1280, height: 720, label: "1280x720 (16:9)" },
  { width: 1920, height: 1080, label: "1920x1080 (16:9)" },
  { width: 720, height: 1280, label: "720x1280 (9:16)" },
  { width: 1024, height: 1024, label: "1024x1024 (1:1)" },
] as const;
const LTX25_RESOLUTION_OPTIONS = [
  { width: 1280, height: 704, label: "1280x704 (final)" },
  { width: 1920, height: 1088, label: "1920x1088 (final)" },
  { width: 704, height: 1280, label: "704x1280 (final)" },
  { width: 1024, height: 1024, label: "1024x1024 (final)" },
] as const;

type GenerationProvider = "COMFYUI" | "FAL";
type FalModel = "veo-3.1-fast" | "kling-v3-standard" | "seedance-2.0-mini" | "seedance-2.0";

const FAL_MODELS: Array<{ value: FalModel; label: string; rate: number }> = [
  { value: "veo-3.1-fast", label: "Veo 3.1 Fast", rate: 0.10 },
  { value: "kling-v3-standard", label: "Kling v3 Standard", rate: 0.084 },
  { value: "seedance-2.0-mini", label: "Seedance 2.0 Mini", rate: 0.0721 },
  { value: "seedance-2.0", label: "Seedance 2.0 quality", rate: 0.3034 },
];

const FAL_MODEL_BY_PROVIDER_ID: Record<string, FalModel> = {
  "fal-ai/veo3.1/fast": "veo-3.1-fast",
  "fal-ai/kling-video/v3/standard/text-to-video": "kling-v3-standard",
  "bytedance/seedance-2.0/enterprise/mini/text-to-video": "seedance-2.0-mini",
  "bytedance/seedance-2.0/enterprise/v2/text-to-video": "seedance-2.0",
};

function effectiveFalDuration(model: FalModel, duration: number): number {
  if (model === "veo-3.1-fast") {
    return [4, 6, 8].reduce((best, value) => (
      Math.abs(value - duration) < Math.abs(best - duration) ? value : best
    ), 8);
  }
  if (model === "kling-v3-standard") return duration <= 5 ? 5 : 10;
  return Math.max(4, Math.min(15, Math.round(duration)));
}

function falRate(model: FalModel, quality: "DRAFT" | "STANDARD" | "HIGH"): number {
  if (model === "seedance-2.0-mini") return quality === "DRAFT" ? 0.0721 : 0.1547;
  if (model === "seedance-2.0") {
    const resolutionScale = quality === "DRAFT" ? (480 / 720) ** 2 : quality === "HIGH" ? (1080 / 720) ** 2 : 1;
    return 0.3034 * resolutionScale;
  }
  return FAL_MODELS.find((option) => option.value === model)?.rate ?? 0;
}

type ComposerDraft = {
  provider?: GenerationProvider;
  model?: FalModel;
  voiceCloningEnabled?: boolean;
  nativeAudioEnabled?: boolean | null;
  selectedChars?: string[];
  selectedSetting?: string;
  prompt?: string;
  dialogue?: string;
  negativePrompt?: string;
  cameraInstructions?: string;
  motionInstructions?: string;
  generationMode?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  qualityPreset?: "DRAFT" | "STANDARD" | "HIGH";
  seedMode?: "RANDOM" | "FIXED";
  seed?: number;
};

const SPEECH_REQUEST_PATTERN = /\b(narration|narrator|voice[- ]?over|dialogue|speaks?|talks?|says?|asks?|replies?|reads?|announces?)\b/i;

function extractQuotedDialogue(prompt: string): { dialogue: string; visualPrompt: string } | null {
  if (!SPEECH_REQUEST_PATTERN.test(prompt)) return null;
  const quotedLines = [...prompt.matchAll(/[“"]([^”"\n]{2,})[”"]/g)];
  if (quotedLines.length === 0) return null;
  const dialogue = quotedLines.map((match) => match[1].trim()).filter(Boolean).join(" ");
  if (!dialogue) return null;
  const visualPrompt = prompt
    .replace(/[“"]([^”"\n]{2,})[”"]/g, "the exact supplied dialogue")
    .replace(/\s+/g, " ")
    .trim();
  return { dialogue, visualPrompt };
}

function readComposerDraft(): ComposerDraft {
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    return raw ? JSON.parse(raw) as ComposerDraft : {};
  } catch {
    return {};
  }
}

function readReferenceVideoKey(): string | null {
  try {
    const raw = window.localStorage.getItem(REFERENCE_VIDEO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { storageKey?: unknown };
    return typeof parsed.storageKey === "string" ? parsed.storageKey : null;
  } catch {
    return null;
  }
}

export default function GeneratePage() {
  const [, setLocation] = useLocation();
  const cloneJobId = new URLSearchParams(window.location.search).get("cloneJob");
  const queryReferenceVideoKey = new URLSearchParams(window.location.search).get("referenceVideoKey");
  const [draft] = useState<ComposerDraft>(() => cloneJobId ? {} : readComposerDraft());
  const { data: characters } = useListCharacters();
  const { data: settings } = useListSettings();
  const { data: capabilities } = useGetGenerationCapabilities();
  const { data: recentGenerations, isLoading: isLoadingRecent, isError: isRecentError, refetch: refetchRecent } = useListGenerations(
    { page: 1, pageSize: 24 },
    { query: {
      queryKey: getListGenerationsQueryKey({ page: 1, pageSize: 24 }),
      refetchInterval: (query) => query.state.data?.items.some(
        (job) => ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status),
      ) ? 5_000 : 30_000,
    } },
  );
  const {
    data: sourceJob,
    isLoading: isLoadingSourceJob,
    error: sourceJobError,
  } = useGetGeneration(cloneJobId ?? "", {
    query: {
      enabled: Boolean(cloneJobId),
      queryKey: getGetGenerationQueryKey(cloneJobId ?? ""),
    },
  });
  const sourceLoadState = composerSourceLoadState({
    cloneJobId,
    isLoading: isLoadingSourceJob,
    hasSourceJob: Boolean(sourceJob),
    hasError: Boolean(sourceJobError),
  });
  const createJob = useCreateGeneration();

  const [selectedChars, setSelectedChars] = useState<string[]>(() => draft.selectedChars ?? []);
  const [selectedSetting, setSelectedSetting] = useState<string>(() => draft.selectedSetting ?? "");
  const [referenceVideoKey, setReferenceVideoKey] = useState<string | null>(
    () => cloneJobId ? null : queryReferenceVideoKey ?? readReferenceVideoKey(),
  );
  const [provider, setProvider] = useState<GenerationProvider>(() => draft.provider ?? "COMFYUI");
  const [model, setModel] = useState<FalModel>(() => draft.model ?? "veo-3.1-fast");
  const [voiceCloningEnabled, setVoiceCloningEnabled] = useState(() => draft.voiceCloningEnabled ?? false);
  const [nativeAudioEnabled, setNativeAudioEnabled] = useState<boolean | null>(() => draft.nativeAudioEnabled ?? null);
  
  const [prompt, setPrompt] = useState(() => draft.prompt ?? "");
  const [dialogue, setDialogue] = useState(() => draft.dialogue ?? "");
  const [negativePrompt, setNegativePrompt] = useState(() => draft.negativePrompt ?? "ugly, distorted, blurry, low resolution, bad anatomy");
  const [cameraInstructions, setCameraInstructions] = useState(() => draft.cameraInstructions ?? "");
  const [motionInstructions, setMotionInstructions] = useState(() => draft.motionInstructions ?? "");
  
  const [generationMode, setGenerationMode] = useState(() => draft.generationMode ?? "txt2vid");
  const [duration, setDuration] = useState(() => draft.duration ?? 4);
  const [fps, setFps] = useState(() => draft.fps ?? 24);
  const [width, setWidth] = useState(() => draft.width ?? 1280);
  const [height, setHeight] = useState(() => draft.height ?? 720);
  const [qualityPreset, setQualityPreset] = useState<"DRAFT" | "STANDARD" | "HIGH">(() => draft.qualityPreset ?? "STANDARD");
  const [seedMode, setSeedMode] = useState<"RANDOM" | "FIXED">(() => draft.seedMode ?? "RANDOM");
  const [seed, setSeed] = useState<number>(() => draft.seed ?? 0);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState<"all" | "completed" | "active">("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [acceptedJobId, setAcceptedJobId] = useState<string | null>(null);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const submissionInFlight = useRef(false);
  const hasSelectedInitialMode = useRef(false);
  const hasPrefilledSourceJob = useRef(false);
  const capabilitiesForMode = capabilities?.filter((cap) => cap.generationMode === generationMode) || [];
  const hasReferenceVideo = Boolean(referenceVideoKey);
  const hasNonReferenceCapability = capabilitiesForMode.some((cap) => !cap.supportsReferenceVideo);
  const workflowRequiresReferenceVideo = capabilitiesForMode.length > 0 && !hasNonReferenceCapability;
  const eligibleCapabilities = hasReferenceVideo
    ? capabilitiesForMode
    : capabilitiesForMode.filter((cap) => !cap.supportsReferenceVideo);
  const workflowRequiresReferenceImage = eligibleCapabilities.length > 0 && eligibleCapabilities.every(
    (cap) => cap.requiresCharacterReferences
  );
  const workflowRequiresStudioSetting = eligibleCapabilities.length > 0 && eligibleCapabilities.every(
    (cap) => cap.requiresSettingReference
  );
  const promptOnlyH3AssetsOptional = eligibleCapabilities.some(
    (cap) => cap.modelFamily.toLowerCase().includes("h3")
      && !cap.requiresCharacterReferences
      && !cap.requiresSettingReference,
  );
  const isLtx25Mode = capabilitiesForMode.some((cap) => cap.modelFamily === "LTX 2.5");
  const resolutionOptions = isLtx25Mode ? LTX25_RESOLUTION_OPTIONS : DEFAULT_RESOLUTION_OPTIONS;
  const isCloudProvider = provider === "FAL";
  const referenceVideoHref = `/reference-video?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
  const inferredDialogue = extractQuotedDialogue(prompt);
  const resolvedDialogueForVoice = dialogue.trim() || inferredDialogue?.dialogue || "";
  const seedanceSelected = isCloudProvider && model.startsWith("seedance");
  const effectiveNativeAudio = nativeAudioEnabled ?? Boolean(resolvedDialogueForVoice);
  const firstSelectedCharacter = characters?.find((character) => character.id === selectedChars[0]);
  const hasConsentedSelectedVoice = Boolean(firstSelectedCharacter?.hasVoiceSample && firstSelectedCharacter.voiceConsentAt);
  const canEnableVoiceCloning = hasConsentedSelectedVoice && Boolean(resolvedDialogueForVoice);
  const selectedFalModel = FAL_MODELS.find((option) => option.value === model) ?? FAL_MODELS[0];
  const pricedFalDuration = effectiveFalDuration(model, duration);
  const pricedFalRate = falRate(model, qualityPreset);
  const estimatedFalCost = pricedFalDuration * pricedFalRate;
  const recentJobs = (recentGenerations?.items ?? []).filter((job) => {
    if (galleryFilter === "completed") return job.status === "COMPLETED";
    if (galleryFilter === "active") return ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status);
    return true;
  });

  useEffect(() => {
    if (cloneJobId && sourceLoadState !== "ready") return;
    window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({
      provider,
      model,
      voiceCloningEnabled,
      nativeAudioEnabled,
      selectedChars,
      selectedSetting,
      prompt,
      dialogue,
      negativePrompt,
      cameraInstructions,
      motionInstructions,
      generationMode,
      duration,
      fps,
      width,
      height,
      qualityPreset,
      seedMode,
      seed,
    } satisfies ComposerDraft));
  }, [
    cloneJobId, sourceLoadState,
    provider, model, voiceCloningEnabled, nativeAudioEnabled, selectedChars, selectedSetting, prompt, dialogue, negativePrompt, cameraInstructions,
    motionInstructions, generationMode, duration, fps, width, height, qualityPreset, seedMode, seed,
  ]);

  useEffect(() => {
    if (queryReferenceVideoKey && !cloneJobId) {
      setReferenceVideoKey(queryReferenceVideoKey);
    }
  }, [queryReferenceVideoKey, cloneJobId]);

  useEffect(() => {
    if (!sourceJob || hasPrefilledSourceJob.current) return;
    const restored = restoreComposerFields(sourceJob, FAL_MODEL_BY_PROVIDER_ID);
    setPrompt(restored.prompt);
    setProvider(restored.provider);
    if (restored.model) setModel(restored.model as FalModel);
    setSelectedChars(restored.selectedChars);
    setSelectedSetting(restored.selectedSetting);
    setReferenceVideoKey(restored.referenceVideoKey);
    if (restored.referenceVideoKey) {
      window.localStorage.setItem(REFERENCE_VIDEO_STORAGE_KEY, JSON.stringify({ storageKey: restored.referenceVideoKey }));
    } else {
      window.localStorage.removeItem(REFERENCE_VIDEO_STORAGE_KEY);
    }
    setVoiceCloningEnabled(restored.voiceCloningEnabled);
    setNativeAudioEnabled(restored.nativeAudioEnabled);
    setDialogue(restored.dialogue);
    setNegativePrompt(restored.negativePrompt);
    setCameraInstructions(restored.cameraInstructions);
    setMotionInstructions(restored.motionInstructions);
    setGenerationMode(restored.generationMode);
    setDuration(restored.duration);
    setFps(restored.fps);
    setWidth(restored.width);
    setHeight(restored.height);
    setQualityPreset(restored.qualityPreset);
    setSeedMode(restored.seedMode);
    setSeed(restored.seed);
    hasSelectedInitialMode.current = true;
    hasPrefilledSourceJob.current = true;
  }, [sourceJob]);

  useEffect(() => {
    if (hasSelectedInitialMode.current || !capabilities) return;
    const preferredCapability = capabilities.find((cap) => !cap.supportsReferenceVideo) ?? capabilities[0];
    if (preferredCapability) {
      setGenerationMode(preferredCapability.generationMode);
    }
    hasSelectedInitialMode.current = true;
  }, [capabilities]);

  useEffect(() => {
    if (!isLtx25Mode) return;
    const currentResolutionIsValid = LTX25_RESOLUTION_OPTIONS.some(
      (option) => option.width === width && option.height === height,
    );
    if (!currentResolutionIsValid) {
      setWidth(LTX25_RESOLUTION_OPTIONS[0].width);
      setHeight(LTX25_RESOLUTION_OPTIONS[0].height);
    }
  }, [isLtx25Mode, width, height]);

  const toggleChar = (id: string) => {
    setSelectedChars(prev => 
      prev.includes(id) 
        ? prev.filter(c => c !== id)
        : prev.length < 9 ? [...prev, id] : prev
    );
  };

  const handleGenerate = async () => {
    if (submissionInFlight.current) return;
    if (cloneJobId && sourceLoadState !== "ready") {
      return alert(sourceLoadState === "loading"
        ? "Loading the original generation before submission."
        : "The original generation could not be loaded. Return to Queue & History and open it again.");
    }
    if (!prompt) return alert("Shot prompt is required");
    if (!isCloudProvider && !hasReferenceVideo && workflowRequiresReferenceImage && selectedChars.length === 0) {
      return alert("Select at least one character with a reference image");
    }
    if (!isCloudProvider && !hasReferenceVideo && workflowRequiresStudioSetting && !selectedSetting) {
      return alert("Select a setting");
    }
    if (!isCloudProvider && workflowRequiresReferenceVideo && !referenceVideoKey) {
      return alert("The selected workflow requires a reference video.");
    }
    if (voiceCloningEnabled && !canEnableVoiceCloning) {
      return alert("Voice cloning requires dialogue and a selected Character with a consented voice sample.");
    }
    const resolvedDialogue = dialogue.trim() || inferredDialogue?.dialogue || "";
    const resolvedPrompt = !dialogue.trim() && inferredDialogue?.visualPrompt
      ? inferredDialogue.visualPrompt
      : prompt.trim();
    let resolvedDuration = duration;
    if (!isCloudProvider && !hasReferenceVideo && resolvedDialogue) {
      const wordCount = resolvedDialogue.split(/\s+/).length;
      const minimumSpeechDuration = Math.ceil(wordCount / 2.5 + 1.5);
      resolvedDuration = Math.min(30, Math.max(duration, minimumSpeechDuration));
    }

    submissionInFlight.current = true;
    try {
      const res = await createJob.mutateAsync({
        data: {
          provider,
          model: provider === "FAL" ? model : undefined,
          voiceCloningEnabled,
          nativeAudioEnabled: seedanceSelected ? effectiveNativeAudio : undefined,
          characterIds: selectedChars.length ? selectedChars : undefined,
          settingId: selectedSetting || undefined,
          prompt: resolvedPrompt,
          dialogue: resolvedDialogue || undefined,
          negativePrompt,
          cameraInstructions,
          motionInstructions,
          generationMode,
          durationSeconds: resolvedDuration,
          fps: fps as 24 | 25 | 30,
          width,
          height,
          qualityPreset,
          seedMode,
          seed: seedMode === "FIXED" ? seed : null,
          referenceVideoKey: provider === "COMFYUI" ? referenceVideoKey || undefined : undefined,
        }
      });
      window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      setAcceptedJobId(res.id);
      setPrompt("");
      setDialogue("");
      setNativeAudioEnabled(null);
      setSetupOpen(false);
      setAssetsOpen(false);
      setComposerExpanded(false);
      setGalleryFilter("all");
      // Clear the clone URL without unmounting the studio and losing the accepted-job receipt.
      if (cloneJobId) window.history.replaceState(window.history.state, "", "/studio");
      void refetchRecent().then((refreshed) => {
        if (refreshed.data?.items.some((job) => job.id === res.id)) setSelectedJobId(res.id);
      }).catch(() => {
        // The job was accepted; a gallery refresh failure must not imply submission failed.
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : null;
      alert("Failed to submit job: " + sanitizeProviderMessage(message, "Unknown error"));
    } finally {
      submissionInFlight.current = false;
    }
  };

  const availableModes = Array.from(new Set((capabilities || []).map(cap => cap.generationMode)));

  return (
    <Page className="studio-page h-full min-h-0 bg-[#101113] [&>div]:h-full [&>div]:!max-w-none [&>div]:!p-0">
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden text-[#eeeee9]">
        
        <div className="contents">
          {cloneJobId && (
            <Card
              className={`flex items-start gap-3 p-4 ${
                sourceLoadState === "error"
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-primary/30 bg-primary/5"
              }`}
              role={sourceLoadState === "error" ? "alert" : undefined}
              data-testid="status-generation-source"
            >
              <Pencil className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-foreground">
                  {sourceLoadState === "loading"
                    ? "Loading generation settings..."
                    : sourceLoadState === "ready"
                      ? "Editing a copy of this generation"
                      : "Could not load the original generation"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {sourceLoadState === "ready"
                    ? "The original prompt, provider, model, duration, geometry, seed, cast, environment, references, voice settings, and advanced fields were restored."
                    : sourceLoadState === "loading"
                      ? "The composer stays blocked until the original job is available."
                      : "The original job could not be resolved. Submission is blocked so an unrelated saved draft cannot be rendered."}
                </p>
              </div>
            </Card>
          )}

          <div className="order-1 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#303135] bg-[#161719] px-4 py-3 md:px-8">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-[9px] bg-[linear-gradient(135deg,#FF1F62,#8B2BE2)] text-white"><Film className="size-[18px]" strokeWidth={2.5} /></span>
              <span className="text-[15px] font-semibold tracking-[-0.04em]">Video Studio</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-[11px] text-[#77797d] lg:inline">Your workspace / All projects</span>
              <Link href="/generations" className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#353638] px-3 text-xs text-[#c2c3c2] hover:bg-[#292a2d] hover:text-[#f5f5f1]">Queue & history <ArrowUpRight className="size-3.5" /></Link>
            </div>
          </div>

          <section aria-labelledby="recent-creations-heading" className="order-2 flex min-h-0 flex-1 flex-col overflow-hidden bg-[#101113]">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 pb-4 pt-6 md:px-8 md:pt-7">
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[#e59ac1]"><span className="size-1.5 rounded-full bg-primary" /> Your work</div>
                <h2 id="recent-creations-heading" className="text-[23px] font-semibold tracking-[-0.045em] sm:text-[28px]">Creations <span className="ml-1 align-middle text-sm font-normal tracking-normal text-[#77797d]">{recentGenerations?.totalItems ?? ""}</span></h2>
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-[#303135] bg-[#1b1c1e] p-1" role="group" aria-label="Filter recent generations">
                {(["all", "completed", "active"] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => { setSelectedJobId(null); setGalleryFilter(filter); }}
                    aria-pressed={galleryFilter === filter}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-medium capitalize transition-colors ${galleryFilter === filter ? "bg-[#3b3d3d] text-[#f4f4ee]" : "text-[#898b8d] hover:text-[#f4f4ee]"}`}
                  >
                    {filter === "active" ? "In progress" : filter}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-8">
            {isLoadingRecent ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => <div key={item} className="aspect-[3/4] animate-pulse rounded-xl border border-[#2b2c2e] bg-[#202124]" />)}
              </div>
            ) : isRecentError ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[#383a3c] text-center">
                <Clapperboard className="size-6 text-[#888b84]" /><p className="text-sm">Could not load creations.</p>
                <Button variant="outline" size="sm" onClick={() => void refetchRecent()}>Try again</Button>
              </div>
            ) : recentJobs.length ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {recentJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => setSelectedJobId(job.id)}
                    className="group relative aspect-[3/4] overflow-hidden rounded-xl border border-[#303134] bg-[#222326] text-left transition-transform duration-200 hover:-translate-y-1 hover:border-primary/60 focus-visible:outline-2 focus-visible:outline-primary"
                    aria-label={`Open generation: ${job.prompt || job.status}`}
                    data-testid={`button-open-studio-generation-${job.id}`}
                  >
                    {job.status === "COMPLETED" && job.outputUrl ? (
                      <video
                        src={job.outputUrl}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                        onMouseEnter={(event) => { void event.currentTarget.play().catch(() => undefined); }}
                        onMouseLeave={(event) => { event.currentTarget.pause(); event.currentTarget.currentTime = 0; }}
                      />
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_52%_42%,#3a253a_0%,#25202b_38%,#1b1b20_75%)]">
                        <div className="flex size-14 items-center justify-center rounded-full border border-[#73546d] bg-[#3b2b3d]/60"><Clapperboard className={`size-6 ${job.status === "FAILED" ? "text-destructive" : "text-[#e2b5d2]"}`} /></div>
                        <span className="text-[10px] uppercase tracking-[0.15em] text-[#a2a8a0]">{job.status.toLowerCase()}</span>
                      </div>
                    )}
                    <div className="absolute left-3 top-3 rounded-md border border-white/15 bg-[#161717]/70 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-md">{job.provider === "FAL" ? "fal.ai" : "Local GPU"}</div>
                    <div className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full bg-[#161717]/70 text-white opacity-0 transition-opacity group-hover:opacity-100"><ArrowUpRight className="size-3.5" /></div>
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0d0f0e] via-[#0d0f0e]/85 to-transparent px-3.5 pb-4 pt-16">
                      <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[#f2f2ef]">{job.prompt || "Untitled generation"}</p>
                      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-[#b3b5ae]"><Clock3 className="size-3" />{job.durationSeconds}s <span className="mx-1 size-0.5 rounded-full bg-[#777]" />{job.status.toLowerCase()}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="relative flex min-h-[min(48vh,430px)] flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[#453548] bg-[radial-gradient(ellipse_at_50%_45%,#332239_0%,#211c29_38%,#16171c_75%)] px-6 text-center">
                <div className="absolute inset-5 rounded-xl border border-[#765075]/20" />
                <div className="relative mb-5 flex size-[76px] items-center justify-center rounded-2xl border border-[#94618c]/40 bg-[#3e2a40]/60 shadow-[0_18px_50px_#0005]"><Clapperboard className="size-8 text-primary" strokeWidth={1.5} /></div>
                <p className="relative text-xl font-medium tracking-tight">{galleryFilter === "all" ? "Your next frame starts here." : `No ${galleryFilter === "active" ? "active" : "completed"} generations yet.`}</p>
                <p className="relative mt-2 max-w-sm text-sm leading-relaxed text-[#a4a8a0]">{galleryFilter === "all" ? "Describe a scene in the composer below. Your renders will take their place in this gallery." : "Switch filters to see other work, or start a new render below."}</p>
                {galleryFilter !== "all" && <button type="button" onClick={() => setGalleryFilter("all")} className="relative mt-5 text-xs font-medium text-primary hover:underline">Show all creations</button>}
              </div>
            )}
            <div className="flex justify-end pt-4">
              <Link href="/generations" className="flex items-center gap-1 text-xs font-medium text-[#a9aca3] transition-colors hover:text-primary">View all generations <ArrowUpRight className="size-3" /></Link>
            </div>
            </div>
          </section>

          <Sheet open={assetsOpen} onOpenChange={setAssetsOpen}>
          <SheetContent side="right" aria-describedby={undefined} className="z-[55] flex h-full w-full max-w-[580px] flex-col gap-0 border-l border-[#383b37] bg-[#191b1b] p-0 text-[#eeeee9] shadow-2xl sm:max-w-[580px] [&>button]:hidden">
            <div className="flex shrink-0 items-center justify-between border-b border-[#343735] px-5 py-4 sm:px-7">
               <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#e497c5]">Scene direction</p><SheetTitle className="mt-1 text-xl font-semibold tracking-tight text-inherit">Cast & references</SheetTitle></div>
              <button type="button" onClick={() => setAssetsOpen(false)} aria-label="Close scene assets" className="flex size-9 items-center justify-center rounded-lg border border-[#3c3d3d] hover:bg-[#303333]"><X className="size-4" /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-8 sm:p-6">
          <Card className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${isCloudProvider ? "border-border/60 bg-card/20" : "border-primary/25 bg-primary/5"}`}>
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-lg bg-primary/15 p-2">
                <Video className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {isCloudProvider ? "Reference video unavailable for cloud models" : hasReferenceVideo ? "Reference video attached" : "Reference video"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                   {isCloudProvider
                     ? "Cloud reference videos are unavailable. Seedance can use selected character and environment images; switch to Local to use a reference video."
                     : hasReferenceVideo
                    ? "Your video supplies the presenter, movement, timing, and audio. Character and environment selections are optional."
                    : "Attach presenter footage if the video should supply the subject, movement, timing, and audio. No character or environment selection is required when it is attached."}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {!isCloudProvider && hasReferenceVideo && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReferenceVideoKey(null);
                    window.localStorage.removeItem(REFERENCE_VIDEO_STORAGE_KEY);
                    setLocation("/studio");
                  }}
                >
                  Remove
                </Button>
              )}
              {isCloudProvider ? (
                <Button type="button" size="sm" disabled>Add reference video</Button>
              ) : (
                <Link href={referenceVideoHref} className={`inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium ${hasReferenceVideo ? "border border-[#55505b] text-[#f0e7f0] hover:bg-[#342c39]" : "bg-[linear-gradient(90deg,#FF1F62,#8B2BE2)] text-white hover:brightness-110"}`}>
                  {hasReferenceVideo ? "Change video" : "Add reference video"}
                </Link>
              )}
            </div>
          </Card>

          {!isCloudProvider && hasReferenceVideo && (
             <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-300">
              You can render directly with the reference video. Cast and environment are optional modifiers, not required inputs.
            </div>
          )}

            <details className="group rounded-xl border border-border/70 bg-card/35">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Users className="size-4" /></span>
                  <span><span className="block text-sm font-semibold">Cast</span><span className="block text-xs text-muted-foreground">{selectedChars.length ? `${selectedChars.length} character${selectedChars.length === 1 ? "" : "s"} selected` : "Add characters to guide the scene"}</span></span>
                </span>
                 <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border/60 p-4">
              {/* Characters Selection */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label className="text-base font-semibold flex items-center gap-2">
                    <Users className="size-4 text-primary" /> Cast
                    {(hasReferenceVideo || isCloudProvider || promptOnlyH3AssetsOptional) && (
                      <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                    )}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {(hasReferenceVideo || isCloudProvider || promptOnlyH3AssetsOptional) && selectedChars.length === 0
                      ? "Not needed"
                      : `${selectedChars.length}/9 selected`}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {characters?.map(char => {
                    const isSelected = selectedChars.includes(char.id);
                    return (
                       <button
                         key={char.id}
                         type="button"
                         aria-pressed={isSelected}
                         aria-label={`Character: ${char.name}`}
                         className={`overflow-hidden rounded-[10px] border text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${isSelected ? 'border-[1.5px] border-primary bg-primary/5' : 'border-border hover:border-primary/50 bg-card/30'}`}
                        onClick={() => toggleChar(char.id)}
                      >
                        <div className="aspect-[3/4] bg-secondary/50 relative">
                          {char.thumbnail && (
                            <img src={char.thumbnail} loading="lazy" decoding="async" className="w-full h-full object-cover opacity-80" alt={char.name} />
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-3">
                            <span className="font-medium text-white text-sm">{char.name}</span>
                          </div>
                          {isSelected && (
                            <div className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-4 stroke-[3]" />
                            </div>
                          )}
                        </div>
                       </button>
                    );
                  })}
                  {characters?.length === 0 && (
                    <div className="col-span-full py-8 text-center text-muted-foreground text-sm bg-card/10 border border-dashed rounded-lg">
                      No characters available. Add some in the library first.
                    </div>
                  )}
                </div>
              </div>

              </div>
            </details>

            <details className="group rounded-xl border border-border/70 bg-card/35">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Map className="size-4" /></span>
                  <span><span className="block text-sm font-semibold">Environment</span><span className="block text-xs text-muted-foreground">{selectedSetting ? settings?.find((setting) => setting.id === selectedSetting)?.name : "Choose a setting for your scene"}</span></span>
                </span>
                 <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="border-t border-border/60 p-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2 text-base font-semibold">
                    <Map className="size-4 text-primary" /> Environment
                    {(hasReferenceVideo || isCloudProvider || promptOnlyH3AssetsOptional) && (
                      <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                    )}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {(hasReferenceVideo || isCloudProvider || promptOnlyH3AssetsOptional) && !selectedSetting
                      ? "Not needed"
                      : selectedSetting ? "1/1 selected" : "0/1 selected"}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {settings?.map(setting => {
                    const isSelected = selectedSetting === setting.id;
                    return (
                       <button
                        key={setting.id}
                         type="button"
                         aria-pressed={isSelected}
                         aria-label={`Environment: ${setting.name}`}
                         className={`flex items-center overflow-hidden rounded-[10px] border text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${isSelected ? 'border-[1.5px] border-primary bg-primary/5' : 'border-border hover:border-primary/50 bg-card/30'}`}
                        onClick={() => setSelectedSetting(isSelected ? "" : setting.id)}
                      >
                        <div className="relative h-16 w-24 shrink-0 bg-secondary/50">
                          {setting.thumbnail && (
                            <img src={setting.thumbnail} loading="lazy" decoding="async" className="h-full w-full object-cover opacity-80" alt={setting.name} />
                          )}
                          {isSelected && (
                            <div className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check className="size-4 stroke-[3]" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 p-3 text-sm font-medium">{setting.name}</div>
                       </button>
                    );
                  })}
                  {settings?.length === 0 && (
                    <div className="col-span-full rounded-lg border border-dashed bg-card/10 py-8 text-center text-sm text-muted-foreground">
                      No settings available. Add some in the library first.
                    </div>
                  )}
                </div>
              </div>
              </div>
            </details>
            </div>
            <div className="shrink-0 border-t border-[#353837] bg-[#1b1d1d] p-4 sm:px-6"><Button onClick={() => setAssetsOpen(false)} className="w-full">Apply to scene</Button></div>
          </SheetContent>
          </Sheet>

            <div className="order-3 z-20 shrink-0 border-t border-[#423343] bg-[#1c1a21]/95 px-3 pb-3 pt-2 shadow-[0_-18px_50px_#08090999] backdrop-blur-xl sm:px-6 sm:pb-5">
            <div className="mx-auto max-w-[1060px]">
              <div className="mb-2 flex items-center justify-between px-1">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-[#f0e6ee]"><Sparkles className="size-3.5 text-primary" /> Create a video <span className="hidden font-normal text-[#a79baa] sm:inline">/ Describe your shot</span></div>
                <span className="font-mono text-[10px] text-[#888d84]">{prompt.length} characters</span>
              </div>
              {acceptedJobId && (
                <div role="status" data-testid="status-render-accepted" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#8b426b] bg-[#382538] px-3 py-2 text-xs text-[#ffe8f4]">
                  <span>Render accepted. It will appear in your creations above.</span>
                  <span className="flex items-center gap-2">
                    <Link href={`/generations/${acceptedJobId}`} className="font-semibold underline underline-offset-2">Open job</Link>
                    <button type="button" onClick={() => setAcceptedJobId(null)} aria-label="Dismiss render confirmation" className="rounded p-1 hover:bg-white/10"><X className="size-3.5" /></button>
                  </span>
                </div>
              )}
              <div className="overflow-hidden rounded-xl border border-[#514453] bg-[#28232b] shadow-[0_10px_32px_#0004] focus-within:border-primary">
                <Textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  className="min-h-[66px] max-h-[18vh] resize-y rounded-none border-0 bg-transparent px-4 py-3 text-[13px] leading-relaxed text-[#f0f1eb] shadow-none placeholder:text-[#8f958b] focus-visible:ring-0 sm:min-h-[82px] sm:px-5 sm:py-4 sm:text-sm"
                  placeholder="Describe your scene, subject, lighting, and movement. What happens in this shot?"
                  aria-label="Describe your video shot"
                  data-testid="input-video-prompt"
                />
                <div className="flex flex-wrap items-center gap-1.5 border-t border-[#3c4039] px-2 py-2 sm:px-3">
                  <button type="button" onClick={() => setAssetsOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-[#d4c8d3] hover:bg-[#3c303e] hover:text-white" data-testid="button-scene-assets">
                    <Plus className="size-3.5 text-primary" /> Scene assets{selectedChars.length || selectedSetting || hasReferenceVideo ? <span className="rounded bg-[#55334c] px-1.5 py-0.5 text-[9px] text-[#ffe1f1]">{selectedChars.length + Number(Boolean(selectedSetting)) + Number(hasReferenceVideo)}</span> : null}
                  </button>
                  <span className="h-4 w-px bg-[#474b43]" />
                  <button type="button" onClick={() => setSetupOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium text-[#d4c8d3] hover:bg-[#3c303e] hover:text-white" data-testid="button-render-setup"><SlidersHorizontal className="size-3.5" /> {isCloudProvider ? selectedFalModel.label : "Local GPU"} <ChevronDown className="size-3" /></button>
                  <span className="hidden h-4 w-px bg-[#474b43] sm:block" />
                  <button type="button" onClick={() => setSetupOpen(true)} className="hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-[#b8a8b8] hover:bg-[#3c303e] hover:text-white sm:inline-flex">{width} × {height} <span className="text-[#756678]">/</span> {duration}s</button>
                  <div className="ml-auto flex items-center gap-2">
                    <button type="button" onClick={() => setComposerExpanded((value) => !value)} aria-expanded={composerExpanded} className="flex size-8 items-center justify-center rounded-md text-[#c3b5c5] hover:bg-[#3c303e]" aria-label={composerExpanded ? "Hide shot controls" : "Show shot controls"} data-testid="button-shot-controls"><Layers3 className="size-4" /></button>
                    <Button
                      onClick={handleGenerate}
                      disabled={createJob.isPending || sourceLoadState === "loading" || sourceLoadState === "error" || !prompt || (!isCloudProvider && !hasReferenceVideo && workflowRequiresReferenceImage && selectedChars.length === 0) || (!isCloudProvider && !hasReferenceVideo && workflowRequiresStudioSetting && !selectedSetting) || (!isCloudProvider && workflowRequiresReferenceVideo && !hasReferenceVideo) || (voiceCloningEnabled && !canEnableVoiceCloning)}
                      className="h-8 rounded-md bg-[linear-gradient(90deg,#FF1F62,#8B2BE2)] px-3 text-[11px] font-semibold text-white hover:brightness-110 disabled:bg-none disabled:bg-[#514551] disabled:text-[#a8a0aa] sm:px-5"
                      data-testid="button-generate-video"
                    >
                      {createJob.isPending ? "Queuing…" : "Generate"} {!createJob.isPending && <ArrowUpRight className="ml-1 size-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>

              {composerExpanded && <div className="mt-2 max-h-[40vh] overflow-y-auto rounded-xl border border-[#483649] bg-[#252027]">
              <details open className="rounded-xl">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Shot direction <span className="ml-2 text-[11px] font-normal text-muted-foreground">Dialogue, camera, motion & exclusions</span></summary>
                <div className="space-y-4 border-t border-border/60 p-4">
                  <div className="space-y-2">
                    <Label>Exact Dialogue Override</Label>
                    <Textarea
                      value={dialogue}
                      onChange={event => setDialogue(event.target.value)}
                      className="h-24 bg-secondary/10 border-primary/30 focus-visible:ring-primary text-base placeholder:text-muted-foreground/50"
                      placeholder={hasReferenceVideo
                        ? "Optional conditioning text. The reference video's original audio remains in the output."
                        : "Optional. Leave blank to extract quoted speech from the main prompt."}
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Camera Movement</Label>
                      <Input
                        value={cameraInstructions}
                        onChange={e => setCameraInstructions(e.target.value)}
                        className="bg-secondary/20"
                        placeholder="e.g. slow pan right, tracking shot..."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Motion Dynamics</Label>
                      <Input
                        value={motionInstructions}
                        onChange={e => setMotionInstructions(e.target.value)}
                        className="bg-secondary/20"
                        placeholder="e.g. high motion, cinematic physics..."
                      />
                    </div>
                  </div>
                  <div className="space-y-2 pt-2">
                    <Label className="text-muted-foreground text-sm">Negative Prompt</Label>
                    <Textarea
                      value={negativePrompt}
                      onChange={e => setNegativePrompt(e.target.value)}
                      className="h-16 bg-secondary/5 text-xs text-muted-foreground border-border/50"
                    />
                  </div>
                </div>
              </details>

              <div className="px-4 pb-4 sm:px-6 sm:pb-6">
              <PromptGuidancePanel
                prompt={prompt}
                onPromptChange={setPrompt}
                cameraInstructions={cameraInstructions}
                onCameraChange={setCameraInstructions}
                motionInstructions={motionInstructions}
                onMotionChange={setMotionInstructions}
                negativePrompt={negativePrompt}
                onNegativeChange={setNegativePrompt}
                dialogue={dialogue.trim() || inferredDialogue?.dialogue || ""}
                onDialogueChange={setDialogue}
                generationMode={generationMode}
                requiresReference={!isCloudProvider && workflowRequiresReferenceVideo}
                hasReference={!isCloudProvider && hasReferenceVideo}
              />
              </div>
              </div>}
              <p className="mt-2 px-1 text-[10px] text-[#a7a09f]">Draft saved automatically.{seedanceSelected ? ` Seedance native audio: ${effectiveNativeAudio ? "on" : "off"}${resolvedDialogueForVoice && !effectiveNativeAudio ? " — dialogue will not be audible" : ""}.` : " Quoted speech becomes exact dialogue on supported local workflows."}{isCloudProvider ? ` Estimated cloud cost: $${estimatedFalCost.toFixed(2)}.` : ""}</p>
            </div>
            </div>
        </div>

        <VideoGenerationViewer
          jobs={recentJobs}
          selectedJobId={selectedJobId}
          onSelectJob={setSelectedJobId}
          onClose={() => setSelectedJobId(null)}
        />

        <Sheet open={setupOpen} onOpenChange={setSetupOpen}>
        <SheetContent side="right" aria-describedby={undefined} className="z-[55] flex h-full w-full max-w-[480px] flex-col gap-0 border-l border-[#383b37] bg-[#191b1b] p-0 text-[#eeeee9] shadow-2xl sm:max-w-[480px] [&>button]:hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-[#343735] px-5 py-4 sm:px-7">
             <div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#e497c5]">Output controls</p><SheetTitle className="mt-1 text-xl font-semibold tracking-tight text-inherit">Render setup</SheetTitle></div>
            <button type="button" onClick={() => setSetupOpen(false)} aria-label="Close render setup" className="flex size-9 items-center justify-center rounded-lg border border-[#3c3d3d] hover:bg-[#303333]"><X className="size-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
          <div className="border-border/50 bg-card/30">

            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="generation-provider">Target</Label>
                  <Select value={provider} onValueChange={(value: GenerationProvider) => setProvider(value)}>
                    <SelectTrigger id="generation-provider" className="bg-secondary/20" data-testid="select-generation-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      <SelectItem value="COMFYUI">Local</SelectItem>
                      <SelectItem value="FAL">Cloud</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Pipeline</Label>
                  <Select value={generationMode} onValueChange={setGenerationMode}>
                    <SelectTrigger className="bg-secondary/20">
                      <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      {availableModes.length > 0 ? (
                        availableModes.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)
                      ) : (
                        <SelectItem value="txt2vid">txt2vid (fallback)</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isCloudProvider && (
                <div className="space-y-2">
                  <Label>Cloud model</Label>
                  <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={modelPickerOpen}
                        className="w-full justify-between h-11 bg-black/40 font-normal hover:bg-black/60 border-border/50 text-left"
                        data-testid="select-fal-model-combobox"
                      >
                        <span className="truncate">
                          {selectedFalModel ? selectedFalModel.label : "Select a model..."}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="z-[70] w-[300px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search cloud models..." />
                        <CommandList>
                          <CommandEmpty>No models found.</CommandEmpty>
                          <CommandGroup heading="Cloud · cost applies">
                            {FAL_MODELS.map((option) => (
                              <CommandItem
                                key={option.value}
                                value={option.label}
                                onSelect={() => {
                                  setModel(option.value);
                                  setModelPickerOpen(false);
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${model === option.value ? "opacity-100" : "opacity-0"}`} />
                                <span className="truncate">{option.label}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    {model.startsWith("seedance")
                      ? "Seedance receives the primary image for each selected character and one selected environment image. Without selections, it uses text only."
                      : "This model uses character and environment descriptions as text; it does not receive their reference images."}
                  </p>
                  {seedanceSelected && (
                    <div className="rounded-md border border-border/50 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <Label htmlFor="seedance-native-audio" className="text-xs">Generate native Seedance audio</Label>
                        <Switch id="seedance-native-audio" checked={effectiveNativeAudio} onCheckedChange={setNativeAudioEnabled} data-testid="switch-seedance-native-audio" />
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                        {resolvedDialogueForVoice
                          ? effectiveNativeAudio
                            ? "Seedance will attempt spoken dialogue with ambient sound. The words, voice, and lip sync are not guaranteed."
                            : "Dialogue remains in the prompt, but the delivered Seedance video will have no native sound."
                          : effectiveNativeAudio
                            ? "Seedance will generate scene audio; add dialogue in Shot direction if you want speech."
                            : "This Seedance video will be silent. Add dialogue to enable audio automatically, or turn it on for scene sound."}
                        {voiceCloningEnabled && effectiveNativeAudio ? " Cloned dialogue is added afterward and may replace native sound." : ""}
                      </p>
                    </div>
                  )}
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-3 mt-2" data-testid="text-fal-cost-estimate">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Approximate cloud cost</span>
                      <span className="font-mono text-base font-semibold text-foreground">${estimatedFalCost.toFixed(2)}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {pricedFalDuration}s effective duration × ${pricedFalRate.toFixed(4)}/sec.
                      {seedanceSelected ? " Seedance audio on/off uses the same estimated rate." : ""}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-4 border-t border-border/50 pt-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Resolution</Label>
                    <Select value={`${width}x${height}`} onValueChange={(v) => {
                      const [w, h] = v.split("x").map(Number);
                      setWidth(w); setHeight(h);
                    }}>
                      <SelectTrigger className="bg-secondary/20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[70]">
                        {resolutionOptions.map((option) => (
                          <SelectItem
                            key={`${option.width}x${option.height}`}
                            value={`${option.width}x${option.height}`}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Quality Preset</Label>
                    <Select value={qualityPreset} onValueChange={(v: any) => setQualityPreset(v)}>
                      <SelectTrigger className="bg-secondary/20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[70]">
                        <SelectItem value="DRAFT">Draft</SelectItem>
                        <SelectItem value="STANDARD">Standard</SelectItem>
                        <SelectItem value="HIGH">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Duration (sec)</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-4">{duration}s</span>
                      <Slider
                        value={[duration]}
                        onValueChange={v => setDuration(v[0])}
                        min={1} max={30} step={1}
                        className="flex-1"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{isCloudProvider ? "Framerate (fixed)" : "Framerate"}</Label>
                    <Select
                      value={(isCloudProvider ? 24 : fps).toString()}
                      onValueChange={v => setFps(parseInt(v))}
                      disabled={isCloudProvider}
                    >
                      <SelectTrigger className="bg-secondary/20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[70]">
                        <SelectItem value="24">24 fps</SelectItem>
                        <SelectItem value="25">25 fps</SelectItem>
                        <SelectItem value="30">30 fps</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-border/50">
                <div className="flex justify-between items-center">
                  <Label>Seed Behavior</Label>
                  <Select value={seedMode} onValueChange={(v: any) => setSeedMode(v)}>
                    <SelectTrigger className="h-7 w-28 text-xs bg-secondary/20 border-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      <SelectItem value="RANDOM">Randomize</SelectItem>
                      <SelectItem value="FIXED">Fixed Seed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {seedMode === "FIXED" && (
                  <Input 
                    type="number" 
                    value={seed} 
                    onChange={e => setSeed(parseInt(e.target.value) || 0)}
                    className="bg-secondary/20 font-mono text-sm"
                  />
                )}
              </div>

              <div className="space-y-2 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="voice-cloning" className="font-medium text-xs">Clone Character voice</Label>
                  <Switch
                    id="voice-cloning"
                    checked={voiceCloningEnabled}
                    onCheckedChange={setVoiceCloningEnabled}
                    disabled={!canEnableVoiceCloning && !voiceCloningEnabled}
                    aria-describedby="voice-cloning-help"
                    data-testid="switch-voice-cloning"
                  />
                </div>
                <p id="voice-cloning-help" className="text-[10px] leading-relaxed text-muted-foreground">
                  Adds cloned dialogue after generation; separate from provider-native audio.
                </p>
                {!canEnableVoiceCloning && (
                  <p className="text-[10px] text-amber-400" role="status">
                    Requires dialogue and a selected Character with a consented voice sample.
                  </p>
                )}
              </div>

              {/* Preflight Summary */}
              <div className="mt-6 pt-4 border-t border-border/50">
                <div className="text-xs font-mono text-muted-foreground space-y-1 mb-4 bg-background/50 p-3 rounded border border-border/50">
                  <div className="flex justify-between">
                     <span>Target:</span>
                     <span className="text-foreground">{isCloudProvider ? "Cloud" : "Local"}</span>
                   </div>
                   <div className="flex justify-between">
                    <span>Cast:</span>
                    <span className={selectedChars.length || hasReferenceVideo || !workflowRequiresReferenceImage ? "text-foreground" : "text-destructive"}>
                      {selectedChars.length ? selectedChars.length : hasReferenceVideo || !workflowRequiresReferenceImage ? "Optional" : "Missing"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Set:</span>
                    <span className={selectedSetting || hasReferenceVideo || !workflowRequiresStudioSetting ? "text-foreground" : "text-destructive"}>
                      {selectedSetting ? "Ready" : hasReferenceVideo || !workflowRequiresStudioSetting ? "Optional" : "Missing"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Reference:</span>
                    <span className={isCloudProvider ? "text-muted-foreground" : hasReferenceVideo ? "text-foreground" : workflowRequiresReferenceVideo ? "text-destructive" : "text-foreground"}>
                      {isCloudProvider ? "Unsupported" : hasReferenceVideo ? "Ready" : workflowRequiresReferenceVideo ? "R2V workflow only" : "Optional"}
                    </span>
                  </div>
                  <div className="flex justify-between"><span>Prompt:</span> <span className={prompt.length > 5 ? "text-foreground" : "text-destructive"}>{prompt.length > 5 ? "Ready" : "Too short"}</span></div>
                </div>

                <Button 
                  className="w-full h-12 text-sm font-semibold uppercase tracking-[0.05em]"
                  onClick={handleGenerate}
                  disabled={
                    createJob.isPending
                    || sourceLoadState === "loading"
                    || sourceLoadState === "error"
                    || !prompt
                    || (!isCloudProvider && !hasReferenceVideo && workflowRequiresReferenceImage && selectedChars.length === 0)
                    || (!isCloudProvider && !hasReferenceVideo && workflowRequiresStudioSetting && !selectedSetting)
                    || (!isCloudProvider && workflowRequiresReferenceVideo && !hasReferenceVideo)
                    || (voiceCloningEnabled && !canEnableVoiceCloning)
                  }
                >
                  {createJob.isPending ? "Queuing Job..." : "SEND TO RENDER"}
                  {!createJob.isPending && <Play className="ml-2 size-4 fill-current" />}
                </Button>
              </div>
            </div>
          </div>
          </div>
          </SheetContent>
        </Sheet>
      </div>
    </Page>
  );
}