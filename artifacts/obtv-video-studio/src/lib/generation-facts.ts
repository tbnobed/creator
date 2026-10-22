// One metadata list for a video generation, shared by the viewer pop-up and the detail page.
import { displayDuration } from "./studio-display";

export interface GenerationFactSource {
  status: string; provider: string; providerModelId?: string | null; workflowName?: string | null; qualityPreset: string;
  width: number; height: number; durationSeconds: number; fps: number; seed?: number | null; serverName?: string | null;
  generationMode?: string | null; voiceCloningEnabled?: boolean | null; longFormSceneNumber?: number | null; longFormShotNumber?: number | null;
  createdAt: string; queuedAt?: string | null; completedAt?: string | null;
}
export interface GenerationFact { key: string; label: string; value: string; testId?: string }

const MODEL_NAMES: Record<string, string> = {
  "fal-ai/topaz/upscale/video": "Topaz Proteus · Upscale",
  "fal-ai/veo3.1/fast": "Veo 3.1 Fast",
  "fal-ai/kling-video/v3/standard/text-to-video": "Kling v3 Standard",
  "bytedance/seedance-2.0/enterprise/mini/text-to-video": "Seedance 2.0 Mini",
  "bytedance/seedance-2.0/enterprise/mini/reference-to-video": "Seedance 2.0 Mini · References",
  "bytedance/seedance-2.0/enterprise/v2/text-to-video": "Seedance 2.0 quality",
  "bytedance/seedance-2.0/enterprise/v2/reference-to-video": "Seedance 2.0 quality · References",
};

export function generationModelLabel(job: Pick<GenerationFactSource, "provider" | "providerModelId" | "workflowName">): string {
  if (job.provider === "FAL") return (job.providerModelId && MODEL_NAMES[job.providerModelId]) || job.providerModelId || "Cloud model";
  return job.workflowName?.replace(/\s*\((?:A100|H100|RTX[^)]*)\)/gi, "") || "Comfy workflow";
}

export function generationFacts(job: GenerationFactSource): GenerationFact[] {
  const facts: GenerationFact[] = [
    { key: "status", label: "Status", value: job.status },
    { key: "provider", label: "Provider", value: job.provider === "FAL" ? "Paid cloud" : "Local GPU / Comfy", testId: "text-generation-provider" },
    { key: "model", label: "Model / workflow", value: generationModelLabel(job), testId: "text-generation-model" },
    { key: "quality", label: "Quality", value: job.qualityPreset },
    { key: "resolution", label: "Resolution", value: `${job.width} × ${job.height}` },
    { key: "duration", label: "Duration", value: displayDuration(job.durationSeconds) },
    { key: "fps", label: "Frame rate", value: `${job.fps} fps` },
    { key: "seed", label: "Seed", value: job.seed == null ? "Random" : String(job.seed) },
  ];
  if (job.generationMode) facts.push({ key: "mode", label: "Mode", value: job.generationMode });
  if (job.voiceCloningEnabled != null) facts.push({ key: "voice", label: "Voice cloning", value: job.voiceCloningEnabled ? "Enabled" : "Off" });
  if (job.serverName) facts.push({ key: "server", label: "Server", value: job.serverName });
  if (job.longFormSceneNumber != null) facts.push({ key: "scene", label: "Scene", value: String(job.longFormSceneNumber) });
  if (job.longFormShotNumber != null) facts.push({ key: "shot", label: "Shot", value: String(job.longFormShotNumber) });
  facts.push({ key: "created", label: "Created", value: new Date(job.createdAt).toLocaleString() });
  if (job.queuedAt) facts.push({ key: "started", label: "Started", value: new Date(job.queuedAt).toLocaleString() });
  if (job.completedAt) facts.push({ key: "finished", label: "Finished", value: new Date(job.completedAt).toLocaleString() });
  return facts;
}
