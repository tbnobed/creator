import { useEffect, useMemo, useRef, useState } from "react";
import {
  ImageAsset,
  ImageJob,
  imageStudioError,
  isTransportError,
  useCreateJob,
  useGetModels,
} from "@/hooks/image-studio";
import { WorkspaceMode } from "./ImageWorkspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  AlertCircle,
  Crop,
  Image as ImageIcon,
  Info,
  Loader2,
  Maximize,
  Scissors,
  Sparkles,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";

interface GenerationPanelProps {
  activeAsset: ImageAsset | null;
  referenceAssets: ImageAsset[];
  preparedOutpaintAsset?: ImageAsset;
  maskAssetId?: string;
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  onRemoveReference: (id: string) => void;
  onMaxReferencesChange: (maximum: number) => void;
  reuseJob?: ImageJob;
}

const ASPECT_RATIOS = [
  { ratio: "1:1", label: "Square", width: 1024, height: 1024 },
  { ratio: "16:9", label: "Landscape", width: 1280, height: 720 },
  { ratio: "9:16", label: "Portrait", width: 720, height: 1280 },
  { ratio: "4:3", label: "Classic", width: 1024, height: 768 },
  { ratio: "3:4", label: "Classic portrait", width: 768, height: 1024 },
  { ratio: "3:2", label: "Standard", width: 1200, height: 800 },
  { ratio: "2:3", label: "Standard portrait", width: 800, height: 1200 },
  { ratio: "5:4", label: "Landscape", width: 1280, height: 1024 },
  { ratio: "4:5", label: "Portrait", width: 1024, height: 1280 },
  { ratio: "21:9", label: "Ultrawide", width: 1536, height: 656 },
  { ratio: "4:1", label: "Banner", width: 1536, height: 384 },
  { ratio: "1:4", label: "Tall banner", width: 384, height: 1536 },
  { ratio: "8:1", label: "Panorama", width: 2048, height: 256 },
  { ratio: "1:8", label: "Vertical panorama", width: 256, height: 2048 },
];

const STYLE_PRESETS = [
  { label: "Studio photo", modifier: "Studio photography with soft, controlled lighting and a clean backdrop." },
  { label: "Product", modifier: "Polished product photography with crisp detail and balanced commercial lighting." },
  { label: "Illustration", modifier: "Refined editorial illustration with intentional composition and cohesive color." },
  { label: "Editorial", modifier: "Contemporary editorial photography with natural texture and confident composition." },
];

const MODE_ICONS: Record<WorkspaceMode, React.ReactNode> = {
  generate: <Sparkles className="h-4 w-4" />,
  edit: <ImageIcon className="h-4 w-4" />,
  inpaint: <Crop className="h-4 w-4" />,
  outpaint: <Maximize className="h-4 w-4" />,
  upscale: <Maximize className="h-4 w-4" />,
  "remove-background": <Scissors className="h-4 w-4" />,
};

export function GenerationPanel({
  activeAsset,
  referenceAssets,
  preparedOutpaintAsset,
  maskAssetId,
  mode,
  setMode,
  onRemoveReference,
  onMaxReferencesChange,
  reuseJob,
}: GenerationPanelProps) {
  const { data: modelsData, isLoading: modelsLoading } = useGetModels();
  const models = modelsData?.models || [];
  const createJob = useCreateJob();
  const { toast } = useToast();
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [dimensions, setDimensions] = useState({ width: 1024, height: 1024 });
  const [count, setCount] = useState(1);
  const [upscaleFactor, setUpscaleFactor] = useState(2);
  const [seed, setSeed] = useState("");
  const [cloudConfirmed, setCloudConfirmed] = useState(false);
  const paidRequest = useRef<{ key: string; signature: string } | undefined>(undefined);

  const availableModels = useMemo(
    () => models.filter((model) => model.operations.includes(mode) && model.available),
    [models, mode],
  );
  const supportedModels = models.filter((model) => model.operations.includes(mode));
  const activeModel = useMemo(
    () => availableModels.find((model) => model.id === modelId),
    [availableModels, modelId],
  );
  const availableRatios = useMemo(
    () => ASPECT_RATIOS.filter((ratio) => !activeModel || activeModel.aspectRatios.includes(ratio.ratio)),
    [activeModel],
  );

  useEffect(() => {
    if (!availableModels.some((model) => model.id === modelId)) {
      setModelId(availableModels[0]?.id || "");
    }
  }, [availableModels, modelId]);

  useEffect(() => {
    setCount((current) => Math.min(current, activeModel?.maxImages || 1));
    onMaxReferencesChange(activeModel?.maxReferences || 0);
    paidRequest.current = undefined;
  }, [activeModel?.id, activeModel?.maxImages, activeModel?.maxReferences, onMaxReferencesChange]);

  useEffect(() => {
    setCloudConfirmed(false);
  }, [modelId, mode, count, dimensions.width, dimensions.height, upscaleFactor]);

  useEffect(() => {
    if (!reuseJob) return;
    setModelId(reuseJob.modelId);
    setPrompt(reuseJob.prompt);
    setNegativePrompt(reuseJob.negativePrompt || "");
    setDimensions({ width: reuseJob.width, height: reuseJob.height });
    setCount(reuseJob.count);
    setSeed(reuseJob.seed === undefined ? "" : String(reuseJob.seed));
    setCloudConfirmed(false);
    paidRequest.current = undefined;
  }, [reuseJob]);

  const sourceRequired = mode !== "generate";
  const operationSource = mode === "outpaint" ? preparedOutpaintAsset : activeAsset;
  const submittedReferences = mode === "generate"
    ? referenceAssets
    : [
        ...(operationSource ? [operationSource] : []),
        ...referenceAssets.filter((asset) => asset.id !== operationSource?.id),
      ];
  const tooManyReferences = Boolean(activeModel && submittedReferences.length > activeModel.maxReferences);
  const maskRequired = mode === "inpaint" || mode === "outpaint";
  const canSubmit = Boolean(
    activeModel
    && (!sourceRequired || operationSource)
    && (!maskRequired || maskAssetId)
    && !tooManyReferences,
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeModel) return;
    if (activeModel.provider === "CLOUD" && !cloudConfirmed) {
      toast({
        title: "Confirmation required",
        description: "Confirm the Cloud model cost before submitting.",
        variant: "destructive",
      });
      return;
    }
    if (!canSubmit) {
      toast({
        title: "Inputs are not ready",
        description: tooManyReferences
          ? `${activeModel.name} accepts at most ${activeModel.maxReferences} reference images.`
          : maskRequired && !maskAssetId
            ? mode === "outpaint"
              ? "Choose an expansion and prepare the outpaint canvas first."
              : "Draw and save a mask first."
            : "Select a source image first.",
        variant: "destructive",
      });
      return;
    }

    let width = dimensions.width;
    let height = dimensions.height;
    if (mode === "outpaint" && preparedOutpaintAsset) {
      width = preparedOutpaintAsset.width;
      height = preparedOutpaintAsset.height;
    } else if ((mode === "inpaint" || mode === "edit") && activeAsset) {
      width = activeAsset.width;
      height = activeAsset.height;
    } else if ((mode === "upscale" || mode === "remove-background") && activeAsset) {
      width = mode === "upscale" ? activeAsset.width * upscaleFactor : activeAsset.width;
      height = mode === "upscale" ? activeAsset.height * upscaleFactor : activeAsset.height;
    }

    if (seed && (!Number.isSafeInteger(Number(seed)) || Number(seed) < 0)) {
      toast({ title: "Seed must be a non-negative whole number", variant: "destructive" });
      return;
    }

    const isPaid = activeModel.provider === "CLOUD";
    const requestData = {
      modelId: activeModel.id,
      operation: mode,
      prompt,
      negativePrompt: activeModel.supportsNegativePrompt && negativePrompt.trim()
        ? negativePrompt
        : undefined,
      width,
      height,
      count,
      seed: activeModel.supportsSeed && seed ? Number(seed) : undefined,
      referenceAssetIds: submittedReferences.length
        ? submittedReferences.map((asset) => asset.id)
        : undefined,
      maskAssetId: maskRequired ? maskAssetId : undefined,
      cloudConfirmed: isPaid ? cloudConfirmed : undefined,
    };
    const requestSignature = JSON.stringify(requestData);
    if (isPaid && paidRequest.current?.signature !== requestSignature) {
      paidRequest.current = { key: crypto.randomUUID(), signature: requestSignature };
    }
    try {
      await createJob.mutateAsync({
        data: {
          ...requestData,
          requestKey: isPaid ? paidRequest.current?.key : undefined,
        },
      });
      paidRequest.current = undefined;
      setCloudConfirmed(false);
      toast({ title: "Job started", description: "Your image is being processed." });
    } catch (error) {
      if (!isTransportError(error)) paidRequest.current = undefined;
      toast({
        title: "Image job failed to start",
        description: isTransportError(error) && isPaid
          ? `${imageStudioError(error)} Retry to safely check the same request.`
          : imageStudioError(error),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto custom-scrollbar">
      <div className="sticky top-0 z-10 border-b border-border/50 bg-card/95 p-4 backdrop-blur">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <ImageIcon className="h-5 w-5 text-primary" />
          Image Studio
        </h2>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/40 p-1">
          {(["generate", "edit", "inpaint", "outpaint", "upscale", "remove-background"] as WorkspaceMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] font-medium ${
                mode === item ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-white/5"
              }`}
            >
              {MODE_ICONS[item]}
              <span className="truncate capitalize">{item.replace("-", " ")}</span>
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={(event) => void handleSubmit(event)} className="flex-1 space-y-5 p-4">
        <div className="space-y-2">
          <Label>Model engine</Label>
          <Select value={modelId} onValueChange={setModelId} disabled={modelsLoading}>
            <SelectTrigger className="h-11 w-full bg-black/40"><SelectValue placeholder="Select a model" /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>Your GPUs</SelectLabel>
                {supportedModels.filter((model) => model.provider === "LOCAL").map((model) => (
                  <SelectItem key={model.id} value={model.id} disabled={!model.available} title={model.unavailableReason}>
                    {model.name}{!model.available ? " · unavailable" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Cloud · cost applies</SelectLabel>
                {supportedModels.filter((model) => model.provider === "CLOUD").map((model) => (
                  <SelectItem key={model.id} value={model.id} disabled={!model.available} title={model.unavailableReason}>
                    {model.name}{!model.available ? " · unavailable" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {activeModel && (
            <p className="flex gap-2 rounded border border-white/5 bg-black/20 p-2 text-xs text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 text-blue-400" />{activeModel.description}
            </p>
          )}
          {!modelsLoading && availableModels.length === 0 && (
            <p className="text-xs text-destructive">No available model supports this operation.</p>
          )}
        </div>

        {sourceRequired && !activeAsset && (
          <div className="flex gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-sm text-yellow-500">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            Select a source image from the gallery.
          </div>
        )}
        {mode === "outpaint" && activeAsset && !preparedOutpaintAsset && (
          <div className="flex gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3 text-xs text-yellow-500">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Choose padding below the preview, then prepare the expanded source and mask.
          </div>
        )}

        {(mode === "generate" || mode === "edit" || mode === "inpaint" || mode === "outpaint") && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Prompt</Label>
              <Textarea
                placeholder="Describe the result you want…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                className="h-24 resize-none bg-black/40"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Style & photography presets</Label>
              <div className="flex flex-wrap gap-1.5">
                {STYLE_PRESETS.map((preset) => {
                  const applied = prompt.includes(preset.modifier);
                  return (
                    <Button
                      key={preset.label}
                      type="button"
                      size="sm"
                      variant={applied ? "default" : "outline"}
                      className="h-7 text-[10px]"
                      onClick={() => {
                        if (applied) return;
                        setPrompt((current) => current.trim()
                          ? `${current.trim()}\n${preset.modifier}`
                          : preset.modifier);
                      }}
                    >
                      {preset.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            {activeModel?.supportsNegativePrompt && (
              <div className="space-y-2">
                <Label>Negative prompt</Label>
                <Textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} className="h-16 resize-none bg-black/40" />
              </div>
            )}
          </div>
        )}

        {mode === "generate" && (
          <div className="space-y-3">
            <Label>Dimensions</Label>
            <div className="grid grid-cols-3 gap-2">
              {availableRatios.map((ratio) => (
                <button
                  key={ratio.ratio}
                  type="button"
                  title={ratio.label}
                  onClick={() => setDimensions({ width: ratio.width, height: ratio.height })}
                  className={`rounded-lg border p-2 text-[10px] ${
                    dimensions.width === ratio.width && dimensions.height === ratio.height
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-white/10 bg-black/40 text-muted-foreground"
                  }`}
                >
                  {ratio.ratio}<br />{ratio.width}×{ratio.height}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input type="number" min={1} max={32768} aria-label="Width" value={dimensions.width} onChange={(event) => setDimensions((value) => ({ ...value, width: Number(event.target.value) }))} />
              <Input type="number" min={1} max={32768} aria-label="Height" value={dimensions.height} onChange={(event) => setDimensions((value) => ({ ...value, height: Number(event.target.value) }))} />
            </div>
          </div>
        )}

        {mode === "upscale" && (
          <div className="space-y-2">
            <Label>Upscale factor</Label>
            <div className="flex gap-2">
              {[2, 4, 8].map((factor) => (
                <button key={factor} type="button" onClick={() => setUpscaleFactor(factor)} className={`flex-1 rounded-lg border py-2 text-sm ${upscaleFactor === factor ? "border-primary bg-primary/10 text-primary" : "border-white/10 bg-black/40"}`}>
                  {factor}×
                </button>
              ))}
            </div>
            {activeAsset && <p className="text-xs text-muted-foreground">{activeAsset.width * upscaleFactor} × {activeAsset.height * upscaleFactor}</p>}
          </div>
        )}

        {referenceAssets.length > 0 && (
          <div className="space-y-2">
            <Label>References · {submittedReferences.length}/{activeModel?.maxReferences ?? 0}</Label>
            <div className="flex flex-wrap gap-1">
              {referenceAssets.map((asset) => (
                <span key={asset.id} className="flex max-w-full items-center gap-1 rounded bg-white/5 px-2 py-1 text-[10px]">
                  <span className="truncate">{asset.name}</span>
                  <button type="button" aria-label={`Remove ${asset.name}`} onClick={() => onRemoveReference(asset.id)}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
            {tooManyReferences && <p className="text-xs text-destructive">Remove references to match this model's limit.</p>}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between"><Label>Number of images</Label><span className="text-xs text-primary">{count}</span></div>
            <Slider value={[count]} min={1} max={activeModel?.maxImages || 1} step={1} onValueChange={([value]) => setCount(value)} />
          </div>
          {activeModel?.supportsSeed && (
            <div className="space-y-2">
              <Label>Seed <span className="text-[10px] text-muted-foreground">optional</span></Label>
              <Input type="number" min={0} step={1} placeholder="Random" value={seed} onChange={(event) => setSeed(event.target.value)} />
            </div>
          )}
        </div>

        {activeModel?.provider === "CLOUD" && (
          <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/10 p-4">
            <p className="text-xs text-primary">{activeModel.priceNote || "This action consumes credits."}</p>
            <div className="flex items-center gap-2">
              <Checkbox id="cloud-confirm" checked={cloudConfirmed} onCheckedChange={(value) => setCloudConfirmed(Boolean(value))} />
              <label htmlFor="cloud-confirm" className="cursor-pointer text-xs">I confirm the cost for this render</label>
            </div>
          </div>
        )}

        <div className="sticky bottom-0 bg-card/95 py-3 backdrop-blur">
          <Button type="submit" className="h-12 w-full font-bold" disabled={createJob.isPending || !canSubmit}>
            {createJob.isPending ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Submitting…</> : <><Sparkles className="mr-2 h-5 w-5" />{mode === "generate" ? "Generate" : "Process"}</>}
          </Button>
        </div>
      </form>
    </div>
  );
}