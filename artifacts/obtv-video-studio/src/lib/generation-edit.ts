export type GenerationEditLink = {
  id: string;
  longFormProjectId: string | null;
  longFormShotId: string | null;
};

export type GenerationEditDestination =
  | { kind: "long-form"; path: string }
  | { kind: "composer"; path: string }
  | { kind: "invalid"; reason: string };

export function generationEditDestination(job: GenerationEditLink): GenerationEditDestination {
  if (job.longFormProjectId && job.longFormShotId) {
    return {
      kind: "long-form",
      path: `/projects/${encodeURIComponent(job.longFormProjectId)}?shot=${encodeURIComponent(job.longFormShotId)}`,
    };
  }
  if (job.longFormProjectId || job.longFormShotId) {
    return {
      kind: "invalid",
      reason: "This generation is linked to a project shot that is no longer available.",
    };
  }
  return {
    kind: "composer",
    path: `/studio?cloneJob=${encodeURIComponent(job.id)}`,
  };
}

export type ComposerSourceLoadState = "idle" | "loading" | "ready" | "error";

export function composerSourceLoadState(input: {
  cloneJobId: string | null;
  isLoading: boolean;
  hasSourceJob: boolean;
  hasError: boolean;
}): ComposerSourceLoadState {
  if (!input.cloneJobId) return "idle";
  if (input.isLoading) return "loading";
  if (input.hasError || !input.hasSourceJob) return "error";
  return "ready";
}

export type ComposerRestoreSource = {
  provider: "COMFYUI" | "FAL";
  providerModelId: string | null;
  voiceCloningEnabled: boolean;
  providerTaskMetadata?: Record<string, unknown>;
  characterIds: string[];
  settingId: string | null;
  referenceVideoKey: string | null;
  prompt: string;
  dialogue: string;
  negativePrompt: string | null;
  cameraInstructions: string;
  motionInstructions: string;
  generationMode: string;
  durationSeconds: number;
  fps: number;
  requestedWidth: number;
  requestedHeight: number;
  requestedDurationSeconds: number | null;
  qualityPreset: string;
  seed?: number | null;
};

export function restoreComposerFields(
  source: ComposerRestoreSource,
  falModelByProviderId: Record<string, string>,
) {
  return {
    provider: source.provider,
    model: source.providerModelId ? falModelByProviderId[source.providerModelId] : undefined,
    voiceCloningEnabled: source.voiceCloningEnabled,
    nativeAudioEnabled: source.providerModelId?.includes("seedance-2.0")
      ? source.providerTaskMetadata?.nativeAudioEnabled === true
      : null,
    selectedChars: [...source.characterIds],
    selectedSetting: source.settingId ?? "",
    referenceVideoKey: source.referenceVideoKey,
    prompt: source.prompt,
    dialogue: source.dialogue,
    negativePrompt: source.negativePrompt ?? "",
    cameraInstructions: source.cameraInstructions,
    motionInstructions: source.motionInstructions,
    generationMode: source.generationMode,
    duration: source.requestedDurationSeconds ?? source.durationSeconds,
    fps: source.fps,
    width: source.requestedWidth,
    height: source.requestedHeight,
    qualityPreset: source.qualityPreset as "DRAFT" | "STANDARD" | "HIGH",
    seedMode: source.seed == null ? "RANDOM" as const : "FIXED" as const,
    seed: source.seed ?? 0,
  };
}