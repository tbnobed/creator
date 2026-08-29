import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  useListCharacters, 
  useListSettings, 
  useCreateGeneration, 
  useListWorkflows,
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

const REFERENCE_VIDEO_STORAGE_KEY = "obtv.referenceVideo";
const COMPOSER_DRAFT_STORAGE_KEY = "obtv.composerDraft";

type ComposerDraft = {
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
  const { data: workflows } = useListWorkflows();
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
  const activeWorkflows = workflows?.filter(w => w.active) || [];
  const activeWorkflowsForMode = activeWorkflows.filter((workflow) => workflow.generationMode === generationMode);
  const hasNonReferenceWorkflow = activeWorkflowsForMode.some((workflow) => !workflow.mappings?.referenceVideo);
  const workflowRequiresReferenceVideo = activeWorkflowsForMode.length > 0 && !hasNonReferenceWorkflow;
  const hasReferenceVideo = Boolean(referenceVideoKey);
  const referenceVideoHref = `/reference-video?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`;

  useEffect(() => {
    window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({
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
    selectedChars, selectedSetting, prompt, dialogue, negativePrompt, cameraInstructions,
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
    if (hasSelectedInitialMode.current || !workflows) return;
    const preferredWorkflow = activeWorkflows.find((workflow) => !workflow.mappings?.referenceVideo) ?? activeWorkflows[0];
    if (preferredWorkflow) {
      setGenerationMode(preferredWorkflow.generationMode);
    }
    hasSelectedInitialMode.current = true;
  }, [workflows]);

  const toggleChar = (id: string) => {
    setSelectedChars(prev => 
      prev.includes(id) 
        ? prev.filter(c => c !== id)
        : prev.length < 9 ? [...prev, id] : prev
    );
  };

  const handleGenerate = async () => {
    if (!prompt) return alert("Shot prompt is required");
    if (!hasReferenceVideo && selectedChars.length === 0) return alert("Select at least one character");
    if (!hasReferenceVideo && !selectedSetting) return alert("Select a setting");
    if (workflowRequiresReferenceVideo && !referenceVideoKey) {
      return alert("The selected workflow requires a reference video.");
    }
    const requestsSpeech = /\b(narration|narrator|voice[- ]?over|dialogue|speaks?|talks?|says?|reads?|announces?)\b/i.test(prompt);
    if (!hasReferenceVideo && requestsSpeech && !dialogue.trim()) {
      return alert("This shot requests narration or speech, but no exact dialogue was entered. Add the words to speak before rendering.");
    }
    if (!hasReferenceVideo && dialogue.trim()) {
      const wordCount = dialogue.trim().split(/\s+/).length;
      const minimumSpeechDuration = Math.ceil(wordCount / 2.5 + 1.5);
      if (duration < minimumSpeechDuration) {
        return alert(`The dialogue needs about ${minimumSpeechDuration} seconds. Increase the shot duration or shorten the spoken line.`);
      }
    }

    try {
      const res = await createJob.mutateAsync({
        data: {
          characterIds: selectedChars.length ? selectedChars : undefined,
          settingId: selectedSetting || undefined,
          prompt,
          dialogue: dialogue.trim() || undefined,
          negativePrompt,
          cameraInstructions,
          motionInstructions,
          generationMode,
          durationSeconds: duration,
          fps: fps as 24 | 25 | 30,
          width,
          height,
          qualityPreset,
          seedMode,
          seed: seedMode === "FIXED" ? seed : null,
          referenceVideoKey: referenceVideoKey || undefined,
        }
      });
      window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      setLocation(`/generations/${res.id}`);
    } catch (err: any) {
      alert("Failed to submit job: " + (err.message || "Unknown error"));
    }
  };

  const availableModes = Array.from(new Set(activeWorkflows.map(w => w.generationMode)));

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

          <Card className="flex flex-col gap-3 border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-lg bg-primary/15 p-2">
                <Video className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {hasReferenceVideo ? "Reference video attached" : "Reference video"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hasReferenceVideo
                    ? "Your video supplies the presenter, movement, timing, and audio. Character and environment selections are optional."
                    : "Attach presenter footage if the video should supply the subject, movement, timing, and audio. No character or environment selection is required when it is attached."}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {hasReferenceVideo && (
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
              <Link href={referenceVideoHref}>
                <Button type="button" variant={hasReferenceVideo ? "outline" : "default"} size="sm">
                  {hasReferenceVideo ? "Change video" : "Add reference video"}
                </Button>
              </Link>
            </div>
          </Card>

          {hasReferenceVideo && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-300">
              You can render directly with the reference video. Cast and environment are optional modifiers, not required inputs.
            </div>
          )}

          <Tabs defaultValue="cast" className="w-full">
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
              <PromptGuidancePanel
                prompt={prompt}
                onPromptChange={setPrompt}
                cameraInstructions={cameraInstructions}
                onCameraChange={setCameraInstructions}
                motionInstructions={motionInstructions}
                onMotionChange={setMotionInstructions}
                negativePrompt={negativePrompt}
                onNegativeChange={setNegativePrompt}
                dialogue={dialogue}
                onDialogueChange={setDialogue}
                generationMode={generationMode}
                requiresReference={workflowRequiresReferenceVideo}
                hasReference={hasReferenceVideo}
              />
              <div className="space-y-2">
                <Label className="text-base font-semibold">Action & Composition (Main Prompt)</Label>
                <Textarea 
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  className="h-32 bg-secondary/10 border-primary/30 focus-visible:ring-primary text-base placeholder:text-muted-foreground/50"
                  placeholder="Describe what is happening in the shot... e.g. Character walks slowly towards the camera, looking determined."
                />
              </div>

              <div className="space-y-2">
                <Label className="text-base font-semibold">Exact Dialogue / Narration</Label>
                <Textarea
                  value={dialogue}
                  onChange={event => setDialogue(event.target.value)}
                  className="h-24 bg-secondary/10 border-primary/30 focus-visible:ring-primary text-base placeholder:text-muted-foreground/50"
                  placeholder={hasReferenceVideo
                    ? "Optional conditioning text. The uploaded reference video's original audio remains in the output."
                    : "Enter only the exact words that should be spoken. Leave blank for a silent shot."}
                />
                <p className="text-xs text-muted-foreground">
                  Keep visual direction in the main prompt. Spoken words are placed first in model conditioning to reduce invented or garbled speech.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                <Label className="text-muted-foreground text-sm">Negative Prompt (Exclusions)</Label>
                <Textarea 
                  value={negativePrompt}
                  onChange={e => setNegativePrompt(e.target.value)}
                  className="h-16 bg-secondary/5 text-xs text-muted-foreground border-border/50"
                />
              </div>
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
                      <SelectItem value="1280x720">1280x720 (16:9)</SelectItem>
                      <SelectItem value="1920x1080">1920x1080 (16:9)</SelectItem>
                      <SelectItem value="720x1280">720x1280 (9:16)</SelectItem>
                      <SelectItem value="1024x1024">1024x1024 (1:1)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Framerate</Label>
                  <Select value={fps.toString()} onValueChange={v => setFps(parseInt(v))}>
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
                  <div className="flex justify-between"><span>Cast:</span> <span className={selectedChars.length || hasReferenceVideo ? "text-foreground" : "text-destructive"}>{selectedChars.length || hasReferenceVideo ? selectedChars.length || "Not needed" : "Missing"}</span></div>
                  <div className="flex justify-between"><span>Set:</span> <span className={selectedSetting || hasReferenceVideo ? "text-foreground" : "text-destructive"}>{selectedSetting ? "Ready" : hasReferenceVideo ? "Not needed" : "Missing"}</span></div>
                  <div className="flex justify-between"><span>Reference:</span> <span className={hasReferenceVideo ? "text-foreground" : workflowRequiresReferenceVideo ? "text-destructive" : "text-foreground"}>{hasReferenceVideo ? "Ready" : workflowRequiresReferenceVideo ? "R2V workflow only" : "Optional"}</span></div>
                  <div className="flex justify-between"><span>Prompt:</span> <span className={prompt.length > 5 ? "text-foreground" : "text-destructive"}>{prompt.length > 5 ? "Ready" : "Too short"}</span></div>
                </div>

                <Button 
                  className="w-full h-12 text-base font-semibold uppercase tracking-[0.05em] shadow-[0_0_16px_rgba(255,31,98,0.35)] hover:shadow-[0_0_20px_rgba(255,31,98,0.5)] transition-all"
                  onClick={handleGenerate}
                  disabled={createJob.isPending || !prompt || (!hasReferenceVideo && (selectedChars.length === 0 || !selectedSetting)) || (workflowRequiresReferenceVideo && !hasReferenceVideo)}
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