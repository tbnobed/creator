import type {
  Character,
  ComfyServer,
  GenerationJob,
  Setting,
  WorkflowTemplate,
} from "@workspace/db";
import { parseApiWorkflow } from "./comfy/workflow-parser";

const date = (value: Date | null) => (value ? value.toISOString() : null);

export function presentCharacter(character: Character, assetCount: number) {
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    promptDescription: character.promptDescription,
    thumbnail: character.thumbnail,
    tags: character.tags,
    assetCount,
    voiceProfile: character.voiceProfile,
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
) {
  return {
    id: job.id,
    title: job.title,
    status: job.status as "DRAFT" | "UPLOADING" | "QUEUED" | "RUNNING" | "DOWNLOADING" | "COMPLETED" | "FAILED" | "CANCELLED",
    prompt: job.prompt,
    compiledPrompt: job.compiledPrompt,
    generationMode: job.generationMode,
    qualityPreset: job.qualityPreset,
    width: job.width,
    height: job.height,
    fps: job.fps,
    durationSeconds: job.durationSeconds,
    seed: job.seed,
    progress: job.progress,
    currentNode: job.currentNode,
    serverName,
    workflowName,
    comfyPromptId: job.comfyPromptId,
    outputUrl: job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    queuedAt: date(job.queuedAt),
    completedAt: date(job.completedAt),
  };
}