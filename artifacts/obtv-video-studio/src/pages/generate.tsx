import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  useListCharacters, 
  useListSettings, 
  useCreateGeneration, 
  useGetGenerationCapabilities,
  useGetGeneration,
  getGetGenerationQueryKey,
} from "@workspace/api-client-react";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Check, Clapperboard, Users, Map, Settings2, Play, Pencil, Video } from "lucide-react";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PromptGuidancePanel } from "@/components/prompt-guidance-panel";
import { sanitizeProviderMessage } from "@/lib/provider-messages";

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
  const [draft] = useState<ComposerDraft>(() => readComposerDraft());
  const { data: characters } = useListCharacters();
  const { data: settings } = useListSettings();
  const { data: capabilities } = useGetGenerationCapabilities();
  const { data: sourceJob, isLoading: isLoadingSourceJob } = useGetGeneration(cloneJobId ?? "", {
    query: {
      enabled: Boolean(cloneJobId),
      queryKey: getGetGenerationQueryKey(cloneJobId ?? ""),
    },
  });
  const createJob = useCreateGeneration();

  const [selectedChars, setSelectedChars] = useState<string[]>(() => draft.selectedChars ?? []);
  const [selectedSetting, setSelectedSetting] = useState<string>(() => draft.selectedSetting ?? "");
  const [referenceVideoKey, setReferenceVideoKey] = useState<string | null>(
    () => queryReferenceVideoKey ?? readReferenceVideoKey(),
  );
  const [provider, setProvider] = useState<GenerationProvider>(() => draft.provider ?? "COMFYUI");
  const [model, setModel] = useState<FalModel>(() => draft.model ?? "veo-3.1-fast");
  const [voiceCloningEnabled, setVoiceCloningEnabled] = useState(() => draft.voiceCloningEnabled ?? false);
  
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
  const isLtx25Mode = capabilitiesForMode.some((cap) => cap.modelFamily === "LTX 2.5");
  const resolutionOptions = isLtx25Mode ? LTX25_RESOLUTION_OPTIONS : DEFAULT_RESOLUTION_OPTIONS;
  const isCloudProvider = provider === "FAL";
  const referenceVideoHref = `/reference-video?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;
  const inferredDialogue = extractQuotedDialogue(prompt);
  const resolvedDialogueForVoice = dialogue.trim() || inferredDialogue?.dialogue || "";
  const firstSelectedCharacter = characters?.find((character) => character.id === selectedChars[0]);
  const hasConsentedSelectedVoice = Boolean(firstSelectedCharacter?.hasVoiceSample && firstSelectedCharacter.voiceConsentAt);
  const canEnableVoiceCloning = hasConsentedSelectedVoice && Boolean(resolvedDialogueForVoice);
  const selectedFalModel = FAL_MODELS.find((option) => option.value === model) ?? FAL_MODELS[0];
  const pricedFalDuration = effectiveFalDuration(model, duration);
  const pricedFalRate = falRate(model, qualityPreset);
  const estimatedFalCost = pricedFalDuration * pricedFalRate;

  useEffect(() => {
    window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({
      provider,
      model,
      voiceCloningEnabled,
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
    provider, model, voiceCloningEnabled, selectedChars, selectedSetting, prompt, dialogue, negativePrompt, cameraInstructions,
    motionInstructions, generationMode, duration, fps, width, height, qualityPreset, seedMode, seed,
  ]);

  useEffect(() => {
    if (queryReferenceVideoKey) {
      setReferenceVideoKey(queryReferenceVideoKey);
    }
  }, [queryReferenceVideoKey]);

  useEffect(() => {
    if (!sourceJob || hasPrefilledSourceJob.current) return;
    setPrompt(sourceJob.prompt);
    setProvider(sourceJob.provider);
    if (sourceJob.providerModelId && FAL_MODEL_BY_PROVIDER_ID[sourceJob.providerModelId]) {
      setModel(FAL_MODEL_BY_PROVIDER_ID[sourceJob.providerModelId]);
    }
    setVoiceCloningEnabled(sourceJob.voiceCloningEnabled);
    setGenerationMode(sourceJob.generationMode);
    setDuration(sourceJob.durationSeconds);
    setFps(sourceJob.fps);
    setWidth(sourceJob.width);
    setHeight(sourceJob.height);
    setQualityPreset(sourceJob.qualityPreset as "DRAFT" | "STANDARD" | "HIGH");
    setSeedMode(sourceJob.seed === null ? "RANDOM" : "FIXED");
    setSeed(sourceJob.seed ?? 0);
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

    try {
      const res = await createJob.mutateAsync({
        data: {
          provider,
          model: provider === "FAL" ? model : undefined,
          voiceCloningEnabled,
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
      setLocation(`/generations/${res.id}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : null;
      alert("Failed to submit job: " + sanitizeProviderMessage(message, "Unknown error"));
    }
  };

  const availableModes = Array.from(new Set((capabilities || []).map(cap => cap.generationMode)));

  return (
    <Page className="max-w-[1600px] mx-auto">
      <div className="flex flex-col lg:flex-row gap-6 h-full pb-10">
        
        {/* Left Column - Assets & Prompts */}
        <div className="flex-1 space-y-6">
          {cloneJobId && (
            <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
              <Pencil className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-foreground">
                  {isLoadingSourceJob ? "Loading generation settings..." : sourceJob ? "Editing a copy of this generation" : "Could not load the original generation"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {sourceJob
                    ? "The prompt and render settings were copied. Reselect the cast and environment as needed, then send it to render."
                    : "Return to Queue & History and try opening the generation again."}
                </p>
              </div>
            </Card>
          )}

          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="size-10 bg-primary/20 rounded-md flex items-center justify-center">
              <Clapperboard className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Shot Composer</h1>
              <p className="text-muted-foreground text-sm">Compose your scene using studio assets.</p>
            </div>
          </div>

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
                     ? "Cloud models currently support text-to-video only. Switch to Local to use a reference video."
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
                    setLocation("/");
                  }}
                >
                  Remove
                </Button>
              )}
              <Link href={isCloudProvider ? "#" : referenceVideoHref} onClick={(event) => {
                if (isCloudProvider) event.preventDefault();
              }}>
                <Button type="button" variant={hasReferenceVideo ? "outline" : "default"} size="sm" disabled={isCloudProvider}>
                  {hasReferenceVideo ? "Change video" : "Add reference video"}
                </Button>
              </Link>
            </div>
          </Card>

          {!isCloudProvider && hasReferenceVideo && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-300">
              You can render directly with the reference video. Cast and environment are optional modifiers, not required inputs.
            </div>
          )}

            <Tabs defaultValue="prompt" className="w-full">
            <TabsList className="mb-4 grid h-12 w-full grid-cols-3 rounded-lg bg-secondary p-1">
              <TabsTrigger value="cast" className="rounded-md text-xs font-semibold text-muted-foreground sm:text-sm data-[state=active]:bg-[linear-gradient(90deg,#FF1F62_0%,#8B2BE2_100%)] data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_0_14px_rgba(255,31,98,0.25)]">1. Cast</TabsTrigger>
              <TabsTrigger value="environment" className="rounded-md text-xs font-semibold text-muted-foreground sm:text-sm data-[state=active]:bg-[linear-gradient(90deg,#FF1F62_0%,#8B2BE2_100%)] data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_0_14px_rgba(255,31,98,0.25)]">2. Environment</TabsTrigger>
              <TabsTrigger value="prompt" className="rounded-md text-xs font-semibold text-muted-foreground sm:text-sm data-[state=active]:bg-[linear-gradient(90deg,#FF1F62_0%,#8B2BE2_100%)] data-[state=active]:text-primary-foreground data-[state=active]:shadow-[0_0_14px_rgba(255,31,98,0.25)]">3. Write Shot</TabsTrigger>
            </TabsList>
            
            <TabsContent value="cast" className="space-y-6 mt-0">
              {/* Characters Selection */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label className="text-base font-semibold flex items-center gap-2">
                    <Users className="size-4 text-primary" /> Cast
                    {hasReferenceVideo && <span className="text-xs font-normal text-muted-foreground">(optional with video reference)</span>}
                  </Label>
                  <span className="text-xs text-muted-foreground">{hasReferenceVideo && selectedChars.length === 0 ? "Not needed" : `${selectedChars.length}/9 selected`}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {characters?.map(char => {
                    const isSelected = selectedChars.includes(char.id);
                    return (
                      <Card 
                        key={char.id} 
                        className={`cursor-pointer overflow-hidden rounded-[10px] border transition-all ${isSelected ? 'border-[1.5px] border-primary bg-primary/5 shadow-[0_0_16px_rgba(255,31,98,0.3)]' : 'border-border hover:border-primary/50 bg-card/30'}`}
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
                            <div className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-primary text-white shadow-[0_0_12px_rgba(255,31,98,0.55)]">
                              <Check className="size-4 stroke-[3]" />
                            </div>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                  {characters?.length === 0 && (
                    <div className="col-span-full py-8 text-center text-muted-foreground text-sm bg-card/10 border border-dashed rounded-lg">
                      No characters available. Add some in the library first.
                    </div>
                  )}
                </div>
              </div>

            </TabsContent>

            <TabsContent value="environment" className="space-y-6 mt-0">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2 text-base font-semibold">
                    <Map className="size-4 text-primary" /> Environment
                    {hasReferenceVideo && <span className="text-xs font-normal text-muted-foreground">(optional with video reference)</span>}
                  </Label>
                  <span className="text-xs text-muted-foreground">{hasReferenceVideo && !selectedSetting ? "Not needed" : selectedSetting ? "1/1 selected" : "0/1 selected"}</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {settings?.map(setting => {
                    const isSelected = selectedSetting === setting.id;
                    return (
                      <Card
                        key={setting.id}
                        className={`flex cursor-pointer items-center overflow-hidden rounded-[10px] border transition-all ${isSelected ? 'border-[1.5px] border-primary bg-primary/5 shadow-[0_0_16px_rgba(255,31,98,0.3)]' : 'border-border hover:border-primary/50 bg-card/30'}`}
                        onClick={() => setSelectedSetting(isSelected ? "" : setting.id)}
                      >
                        <div className="relative h-16 w-24 shrink-0 bg-secondary/50">
                          {setting.thumbnail && (
                            <img src={setting.thumbnail} loading="lazy" decoding="async" className="h-full w-full object-cover opacity-80" alt={setting.name} />
                          )}
                          {isSelected && (
                            <div className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-primary text-white shadow-[0_0_12px_rgba(255,31,98,0.55)]">
                              <Check className="size-4 stroke-[3]" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 p-3 text-sm font-medium">{setting.name}</div>
                      </Card>
                    );
                  })}
                  {settings?.length === 0 && (
                    <div className="col-span-full rounded-lg border border-dashed bg-card/10 py-8 text-center text-sm text-muted-foreground">
                      No settings available. Add some in the library first.
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="prompt" className="space-y-4 mt-0">
              <div className="space-y-2">
                <Label className="text-base font-semibold">Paste Your Shot Prompt</Label>
                <Textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  className="min-h-56 bg-secondary/10 border-primary/30 focus-visible:ring-primary text-base placeholder:text-muted-foreground/50"
                  placeholder={'Paste the complete shot prompt here. Put spoken words in quotes, for example: Andrea looks at camera and says, "Welcome to the show."'}
                />
                <p className="text-xs text-muted-foreground">
                  Paste and generate. Spoken words inside quotation marks are automatically extracted as exact dialogue for H3.
                </p>
              </div>

              <details className="rounded-lg border border-border/60 bg-card/20">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Optional advanced controls</summary>
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
            </TabsContent>
          </Tabs>
        </div>

        {/* Right Column - Tech Settings & Submit */}
        <div className="w-full lg:w-80 flex flex-col gap-6">
          <Card className="p-5 border-border/50 bg-card/30 backdrop-blur-sm sticky top-6">
            <h3 className="font-semibold text-lg flex items-center gap-2 mb-4 border-b border-border/50 pb-2">
              <Settings2 className="size-4 text-primary" /> Render Setup
            </h3>

            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="generation-provider">Generation target</Label>
                <Select value={provider} onValueChange={(value: GenerationProvider) => setProvider(value)}>
                  <SelectTrigger id="generation-provider" className="bg-secondary/20" data-testid="select-generation-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="COMFYUI">Local</SelectItem>
                    <SelectItem value="FAL">Cloud</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isCloudProvider && (
                <div className="space-y-2">
                  <Label htmlFor="fal-model">Cloud model</Label>
                  <Select value={model} onValueChange={(value: FalModel) => setModel(value)}>
                    <SelectTrigger id="fal-model" className="bg-secondary/20" data-testid="select-fal-model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FAL_MODELS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-3" data-testid="text-fal-cost-estimate">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Approximate cloud cost</span>
                      <span className="font-mono text-base font-semibold text-foreground">${estimatedFalCost.toFixed(2)}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {pricedFalDuration}s effective duration × ${pricedFalRate.toFixed(4)}/sec. Estimate excludes provider-native audio, which is off by default.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label>Pipeline Mode</Label>
                <Select value={generationMode} onValueChange={setGenerationMode}>
                  <SelectTrigger className="bg-secondary/20">
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModes.length > 0 ? (
                      availableModes.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)
                    ) : (
                      <SelectItem value="txt2vid">txt2vid (fallback)</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 border-t border-border/50 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="voice-cloning" className="font-medium">Clone Character voice</Label>
                  <Switch
                    id="voice-cloning"
                    checked={voiceCloningEnabled}
                    onCheckedChange={setVoiceCloningEnabled}
                    disabled={!canEnableVoiceCloning && !voiceCloningEnabled}
                    aria-describedby="voice-cloning-help"
                    data-testid="switch-voice-cloning"
                  />
                </div>
                <p id="voice-cloning-help" className="text-[11px] leading-relaxed text-muted-foreground">
                  Off by default. Requires dialogue and a selected Character with a consented voice sample. This adds cloned dialogue after generation; it is separate from provider-native audio.
                </p>
                {!canEnableVoiceCloning && (
                  <p className="text-[11px] text-amber-400" role="status">
                    Add dialogue and select a Character with a consented voice to enable.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Quality Preset</Label>
                  <Select value={qualityPreset} onValueChange={(v: any) => setQualityPreset(v)}>
                    <SelectTrigger className="bg-secondary/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="STANDARD">Standard</SelectItem>
                      <SelectItem value="HIGH">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
              </div>

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
                    <SelectContent>
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
                  <p className="text-xs text-muted-foreground">
                    Final output: {width}×{height}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{isCloudProvider ? "Framerate (provider fixed)" : "Framerate"}</Label>
                  <Select
                    value={(isCloudProvider ? 24 : fps).toString()}
                    onValueChange={v => setFps(parseInt(v))}
                    disabled={isCloudProvider}
                  >
                    <SelectTrigger className="bg-secondary/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24">24 fps</SelectItem>
                      <SelectItem value="25">25 fps</SelectItem>
                      <SelectItem value="30">30 fps</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t border-border/50">
                <div className="flex justify-between items-center">
                  <Label>Seed Behavior</Label>
                  <Select value={seedMode} onValueChange={(v: any) => setSeedMode(v)}>
                    <SelectTrigger className="h-7 w-28 text-xs bg-secondary/20 border-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
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
                  className="w-full h-12 text-base font-semibold uppercase tracking-[0.05em] shadow-[0_0_16px_rgba(255,31,98,0.35)] hover:shadow-[0_0_20px_rgba(255,31,98,0.5)] transition-all"
                  onClick={handleGenerate}
                  disabled={
                    createJob.isPending
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
          </Card>
        </div>
      </div>
    </Page>
  );
}