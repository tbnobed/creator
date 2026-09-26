import type {
  Character,
  ComfyServer,
  GenerationJob,
  Setting,
  WorkflowTemplate,
} from "@workspace/db";
import { parseApiWorkflow } from "./comfy/workflow-parser";

const date = (value: Date | null) => (value ? value.toISOString() : null);

export function presentCharacter(
  character: Character,
  assetCount: number,
  dossierRevision = character.dossierRevision,
) {
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    promptDescription: character.promptDescription,
    thumbnail: character.thumbnail,
    tags: character.tags,
    assetCount,
    voiceProfile: character.voiceProfile,
    hasVoiceSample: Boolean(character.voiceStorageKey && character.voiceConsentAt),
    voiceSampleUrl: character.voiceStorageKey
      ? `/api/media/${character.voiceStorageKey.split("/").map(encodeURIComponent).join("/")}`
      : null,
    voiceConsentAt: date(character.voiceConsentAt),
    dossierRevision,
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
  };
}

export function presentSetting(setting: Setting, assetCount: number) {
  return {
    id: setting.id,
    name: setting.name,
    description: setting.description,
    promptDescription: setting.promptDescription,
    thumbnail: setting.thumbnail,
    tags: setting.tags,
    assetCount,
    createdAt: setting.createdAt.toISOString(),
    updatedAt: setting.updatedAt.toISOString(),
  };
}

export function presentServer(server: ComfyServer, supportedWorkflowCount: number) {
  return {
    id: server.id,
    displayName: server.displayName,
    hostname: server.hostname,
    gpuName: server.gpuName,
    vramGb: server.vramGb,
    tags: server.tags,
    enabled: server.enabled,
    priority: server.priority,
    status: server.status as "ONLINE" | "OFFLINE" | "UNKNOWN",
    queueSize: server.queueSize,
    activeJobCount: server.activeJobCount,
    lastHeartbeat: date(server.lastHeartbeat),
    supportedWorkflowCount,
    memoryUsedGb: server.memoryUsedGb,
  };
}

export function presentWorkflow(workflow: WorkflowTemplate) {
  const nodes = workflow.apiWorkflow ? parseApiWorkflow(workflow.apiWorkflow).nodes : [];
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    generationMode: workflow.generationMode,
    modelFamily: workflow.modelFamily,
    apiWorkflow: workflow.apiWorkflow,
    compatibleServerTags: workflow.compatibleServerTags,
    active: workflow.active,
    version: workflow.version,
    mappings: workflow.mappings,
    nodes,
    expectedInputs: workflow.expectedInputs,
    expectedOutputs: workflow.expectedOutputs,
    importedAt: workflow.createdAt.toISOString(),
  };
}

export function presentGeneration(
  job: GenerationJob,
  serverName: string | null,
  workflowName: string | null,
  longFormContext: {
    projectId: string;
    projectTitle: string;
    sceneNumber: number;
    shotNumber: number;
  } | null = null,
  restoreContext: {
    characterIds: string[];
    settingId: string | null;
    referenceVideoKey: string | null;
    cameraInstructions: string;
    motionInstructions: string;
    requestedWidth: number;
    requestedHeight: number;
    requestedDurationSeconds: number | null;
    aspectRatio?: string | null;
    outputResolution?: string | null;
    outputFormat?: string | null;
    seedanceTask?: string | null;
    startFrameKey?: string | null;
    endFrameKey?: string | null;
    referenceImageKeys?: string[];
    referenceVideoKeys?: string[];
    referenceAudioKeys?: string[];
  } | null = null,
) {
  const sanitizeProviderMessage = (message: string | null) => message
    ?.replace(/(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run|media)[^\s"'<>]*/gi, "Cloud")
    .replace(/\bfal(?:\.ai)?\b/gi, "Cloud") ?? null;
  return {
    id: job.id,
    title: job.title,
    status: job.status as "DRAFT" | "UPLOADING" | "QUEUED" | "RUNNING" | "DOWNLOADING" | "COMPLETED" | "FAILED" | "CANCELLED",
    provider: job.provider as "COMFYUI" | "FAL",
    providerModelId: job.providerModelId,
    providerRequestId: job.providerRequestId,
    providerTaskMetadata: job.providerTaskMetadata,
    voiceCloningEnabled: job.voiceCloningEnabled,
    prompt: job.prompt,
    dialogue: job.dialogue,
    negativePrompt: job.negativePrompt,
    cameraInstructions: restoreContext?.cameraInstructions ?? "",
    motionInstructions: restoreContext?.motionInstructions ?? "",
    characterIds: restoreContext?.characterIds ?? [],
    settingId: restoreContext?.settingId ?? null,
    referenceVideoKey: restoreContext?.referenceVideoKey ?? null,
    compiledPrompt: job.compiledPrompt,
    generationMode: job.generationMode,
    qualityPreset: job.qualityPreset,
    width: job.width,
    height: job.height,
    requestedWidth: restoreContext?.requestedWidth ?? job.width,
    requestedHeight: restoreContext?.requestedHeight ?? job.height,
    requestedDurationSeconds: restoreContext ? restoreContext.requestedDurationSeconds : job.durationSeconds,
    aspectRatio: restoreContext?.aspectRatio ?? null,
    outputResolution: restoreContext?.outputResolution ?? null,
    outputFormat: restoreContext?.outputFormat ?? null,
    seedanceTask: restoreContext?.seedanceTask ?? null,
    startFrameKey: restoreContext?.startFrameKey ?? null,
    endFrameKey: restoreContext?.endFrameKey ?? null,
    referenceImageKeys: restoreContext?.referenceImageKeys ?? [],
    referenceVideoKeys: restoreContext?.referenceVideoKeys ?? [],
    referenceAudioKeys: restoreContext?.referenceAudioKeys ?? [],
    fps: job.fps,
    durationSeconds: job.durationSeconds,
    seed: job.seed,
    progress: job.progress,
    currentNode: sanitizeProviderMessage(job.currentNode),
    serverName,
    workflowName,
    longFormProjectId: longFormContext?.projectId ?? null,
    longFormShotId: job.longFormShotId,
    longFormProjectTitle: longFormContext?.projectTitle ?? null,
    longFormSceneNumber: longFormContext?.sceneNumber ?? null,
    longFormShotNumber: longFormContext?.shotNumber ?? null,
    comfyPromptId: job.comfyPromptId,
    outputUrl: job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
    outputMimeType: job.outputMimeType,
    errorMessage: sanitizeProviderMessage(job.errorMessage),
    createdAt: job.createdAt.toISOString(),
    queuedAt: date(job.queuedAt),
    completedAt: date(job.completedAt),
  };
}