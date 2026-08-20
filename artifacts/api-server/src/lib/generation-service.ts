import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  comfyServersTable,
  db,
  generationCharactersTable,
  generationJobsTable,
  generationSettingsTable,
  settingAssetsTable,
  settingsTable,
  workflowTemplatesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { ComfyUIClient } from "./comfy/client";
import { selectServer } from "./comfy/scheduler";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import { mediaStorage } from "./storage-service";

type GenerationRequest = {
  characterIds?: string[];
  settingId?: string;
  prompt: string;
  negativePrompt?: string;
  cameraInstructions?: string;
  dialogue?: string;
  motionInstructions?: string;
  audioInstructions?: string;
  generationMode: string;
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
  qualityPreset: string;
  seedMode: string;
  seed?: number | null;
  referenceVideoKey?: string;
};

function compilePrompt(
  characters: { name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  const sections = [
    characters.length
      ? `CHARACTERS\n${characters.map((character) => `${character.name}: ${character.promptDescription}`).join("\n\n")}`
      : "",
    setting?.promptDescription ? `SETTING\n${setting.promptDescription}` : "",
    `ACTION\n${input.prompt}`,
    input.dialogue ? `DIALOGUE\n${input.dialogue}` : "",
    input.cameraInstructions ? `CAMERA\n${input.cameraInstructions}` : "",
    input.motionInstructions ? `MOTION\n${input.motionInstructions}` : "",
    input.audioInstructions ? `AUDIO\n${input.audioInstructions}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

async function uploadMappedReferences(
  client: ComfyUIClient,
  mappings: ParameterMappings,
  characterIds: string[] = [],
  settingId?: string,
): Promise<Record<string, string>> {
  const [characterAssets, settingAssets] = await Promise.all([
    characterIds.length
      ? db
        .select()
        .from(characterAssetsTable)
        .where(inArray(characterAssetsTable.characterId, characterIds))
        .orderBy(asc(characterAssetsTable.sortOrder))
      : Promise.resolve([]),
    settingId
      ? db
        .select()
        .from(settingAssetsTable)
        .where(eq(settingAssetsTable.settingId, settingId))
        .orderBy(asc(settingAssetsTable.sortOrder))
      : Promise.resolve([]),
  ]);
  const fields: Array<readonly [string, { storageKey: string; originalName: string; mimeType: string }]> = [
    ...characterAssets.map((asset, index) => [`referenceImage${index + 1}`, asset] as const),
    ...settingAssets.map((asset, index) => [`settingImage${index + 1}`, asset] as const),
  ];
  const mapped: Record<string, string> = {};
  for (const [field, asset] of fields) {
    if (!mappings[field]) continue;
    const uploaded = await client.uploadImage({
      name: asset.originalName,
      mimeType: asset.mimeType,
      bytes: await mediaStorage.readBuffer(asset.storageKey),
    });
    mapped[field] = uploaded.name;
  }
  return mapped;
}

type ComfyOutputFile = {
  filename?: unknown;
  subfolder?: unknown;
  type?: unknown;
};

function chooseOutput(history: Record<string, unknown>): { filename: string; subfolder: string; type: string } | null {
  const first = Object.values(history)[0];
  if (!first || typeof first !== "object") return null;
  const outputs = (first as { outputs?: Record<string, Record<string, unknown>> }).outputs;
  if (!outputs) return null;
  for (const output of Object.values(outputs)) {
    for (const collectionName of ["gifs", "videos", "images"]) {
      const collection = output[collectionName];
      if (!Array.isArray(collection)) continue;
      for (const file of collection as ComfyOutputFile[]) {
        if (typeof file.filename === "string" && file.filename.match(/\.(mp4|webm|mov|mkv)$/i)) {
          return {
            filename: file.filename,
            subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
            type: typeof file.type === "string" ? file.type : "output",
          };
        }
      }
    }
  }
  return null;
}

export async function resumeActiveGenerations(): Promise<void> {
  const jobs = await db
    .select()
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.status, ["QUEUED", "RUNNING", "DOWNLOADING"]));
  for (const job of jobs) {
    if (!job.comfyPromptId || !job.comfyServerId) continue;
    const [server] = await db
      .select()
      .from(comfyServersTable)
      .where(eq(comfyServersTable.id, job.comfyServerId));
    if (!server) {
      logger.warn({ jobId: job.id, serverId: job.comfyServerId }, "Cannot resume generation: ComfyUI server is missing");
      continue;
    }
    void monitorGeneration(job.id, new ComfyUIClient(server), job.comfyPromptId);
  }
}

export async function createAndSubmitGeneration(input: GenerationRequest) {
  const [characters, setting] = await Promise.all([
    input.characterIds?.length
      ? db.select().from(charactersTable).where(inArray(charactersTable.id, input.characterIds))
      : Promise.resolve([]),
    input.settingId
      ? db.select().from(settingsTable).where(eq(settingsTable.id, input.settingId))
      : Promise.resolve([]),
  ]);
  const wantsReferenceVideo = Boolean(input.referenceVideoKey);
  if (!wantsReferenceVideo && (characters.length !== input.characterIds?.length || !setting[0])) {
    throw new Error("Select characters and a setting from the current library");
  }
  const workflows = await db
    .select()
    .from(workflowTemplatesTable)
    .where(and(eq(workflowTemplatesTable.generationMode, input.generationMode), eq(workflowTemplatesTable.active, true)))
    .orderBy(desc(workflowTemplatesTable.version));
  const compatibleWorkflows = workflows.filter((candidate) => (
    candidate.apiWorkflow &&
    Boolean((candidate.mappings as ParameterMappings).referenceVideo) === wantsReferenceVideo
  ));
  const servers = await db.select().from(comfyServersTable);
  const selected = compatibleWorkflows
    .map((candidate) => ({
      workflow: candidate,
      server: selectServer(servers, candidate.compatibleServerTags),
    }))
    .filter((candidate) => candidate.server !== null)
    .sort((a, b) => (
      a.server!.queueSize - b.server!.queueSize ||
      a.server!.activeJobCount - b.server!.activeJobCount ||
      a.server!.priority - b.server!.priority
    ))[0];
  const workflow = selected?.workflow ?? compatibleWorkflows[0] ?? workflows[0];
  if (!workflow?.apiWorkflow) {
    throw new Error("No active imported API workflow is configured for this generation mode");
  }
  if ((workflow.mappings as ParameterMappings).referenceVideo && !input.referenceVideoKey) {
    throw new Error("No active workflow without reference-video input is configured for this generation mode");
  }
  const server = selected?.server ?? selectServer(servers, workflow.compatibleServerTags);
  if (!server) {
    throw new Error("No healthy, compatible ComfyUI server is available. Configure and test a server first.");
  }
  const compiledPrompt = compilePrompt(characters, setting[0], input);
  const frameCount = Math.round(input.durationSeconds * input.fps);
  const [job] = await db
    .insert(generationJobsTable)
    .values({
      title: `${characters[0]?.name ?? "Reference video"} — ${setting[0]?.name ?? "Presenter"}`,
      status: "UPLOADING",
      workflowTemplateId: workflow.id,
      comfyServerId: server.id,
      prompt: input.prompt,
      compiledPrompt,
      negativePrompt: input.negativePrompt ?? null,
      width: input.width,
      height: input.height,
      fps: input.fps,
      frameCount,
      durationSeconds: input.durationSeconds,
      seed: input.seedMode === "FIXED" && input.seed != null ? Math.floor(input.seed) : null,
      generationMode: input.generationMode,
      qualityPreset: input.qualityPreset,
    })
    .returning();
  if (characters.length > 0) {
    await db.insert(generationCharactersTable).values(
      characters.map((character, index) => ({ generationJobId: job.id, characterId: character.id, sortOrder: index })),
    );
  }
  if (setting[0]) {
    await db.insert(generationSettingsTable).values({ generationJobId: job.id, settingId: setting[0].id });
  }
  try {
    const client = new ComfyUIClient(server);
    const assetParameters = await uploadMappedReferences(client, workflow.mappings as ParameterMappings, input.characterIds, input.settingId);
    const referenceVideo = input.referenceVideoKey
      ? await mediaStorage.readReferenceVideo(input.referenceVideoKey)
      : null;
    const referenceVideoParameters = referenceVideo
      ? { referenceVideo: (await client.uploadVideo(referenceVideo)).name }
      : {};
    const submittedWorkflow = buildWorkflow(workflow.apiWorkflow, workflow.mappings as ParameterMappings, {
      prompt: compiledPrompt,
      negativePrompt: input.negativePrompt,
      width: input.width,
      height: input.height,
      frames: frameCount,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
      seed: input.seedMode === "FIXED" ? input.seed ?? 0 : Math.floor(Math.random() * 2_147_483_647),
      ...assetParameters,
      ...referenceVideoParameters,
    });
    const submitted = await client.submitWorkflow(submittedWorkflow, job.id);
    const [queuedJob] = await db
      .update(generationJobsTable)
      .set({ status: "QUEUED", comfyPromptId: submitted.prompt_id, queuedAt: new Date() })
      .where(eq(generationJobsTable.id, job.id))
      .returning();
    void monitorGeneration(job.id, client, submitted.prompt_id);
    return queuedJob;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation submission failed";
    await db
      .update(generationJobsTable)
      .set({ status: "FAILED", errorMessage: message, failedAt: new Date() })
      .where(eq(generationJobsTable.id, job.id));
    throw error;
  }
}

async function monitorGeneration(jobId: string, client: ComfyUIClient, promptId: string) {
  const timeoutAt = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < timeoutAt) {
    try {
      const history = await client.getHistory(promptId);
      const output = chooseOutput(history);
      if (output) {
        await db.update(generationJobsTable).set({ status: "DOWNLOADING", currentNode: "Retrieving output" }).where(eq(generationJobsTable.id, jobId));
        const bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
        const mimeType = output.filename.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
        const storageKey = await mediaStorage.storeOutput(output.filename, mimeType, bytes);
        await db
          .update(generationJobsTable)
          .set({ status: "COMPLETED", outputStorageKey: storageKey, outputMimeType: mimeType, progress: 1, completedAt: new Date() })
          .where(eq(generationJobsTable.id, jobId));
        return;
      }
      await db.update(generationJobsTable).set({ status: "RUNNING", currentNode: "ComfyUI processing" }).where(eq(generationJobsTable.id, jobId));
    } catch (error) {
      logger.warn({ err: error, jobId }, "Generation monitor retrying after ComfyUI error");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: "Timed out while waiting for ComfyUI", failedAt: new Date() })
    .where(eq(generationJobsTable.id, jobId));
}