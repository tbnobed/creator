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

// Selection precedence: explicit edit > cloned/saved selection > capability default.
// Keep this separate from query arrival order; a mounted composer can change source.
export class ComposerModelSelection {
  private sourceId: string | null;
  private restoredSourceId: string | null = null;
  private explicit = false;
  private initialized: boolean;

  constructor(savedMode: string | undefined, sourceId: string | null) {
    this.sourceId = sourceId;
    this.initialized = Boolean(savedMode);
  }

  syncSource(sourceId: string | null) {
    if (sourceId === this.sourceId) return;
    this.sourceId = sourceId;
    this.restoredSourceId = null;
    this.explicit = false;
    // Removing cloneJob keeps the current composer selection.
    this.initialized = sourceId === null;
  }

  selectExplicitly(sourceId: string | null) {
    this.syncSource(sourceId);
    this.explicit = true;
    this.initialized = true;
  }

  needsRestore(sourceId: string | null, loadedId: string | undefined) {
    this.syncSource(sourceId);
    return Boolean(sourceId && loadedId === sourceId && this.restoredSourceId !== sourceId);
  }

  restoreSelection(sourceId: string) {
    this.restoredSourceId = sourceId;
    this.initialized = true;
    return !this.explicit;
  }

  initialMode(sourceId: string | null, capabilities: readonly { generationMode: string; supportsReferenceVideo: boolean }[] | undefined) {
    this.syncSource(sourceId);
    if (sourceId || this.initialized || !capabilities?.length) return undefined;
    this.initialized = true;
    return (capabilities.find((cap) => !cap.supportsReferenceVideo) ?? capabilities[0]).generationMode;
  }
}

export function localPipelineError(
  mode: string,
  capabilities: readonly { generationMode: string }[] | undefined,
): string | null {
  if (!capabilities) return "Loading local pipelines before submission.";
  if (!capabilities.some((cap) => cap.generationMode === mode)) {
    return `The selected local pipeline "${mode}" is unavailable. Choose an available pipeline in Render setup before submitting.`;
  }
  return null;
}

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