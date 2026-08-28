import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
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
  pool,
  type GenerationJob,
} from "@workspace/db";
import { logger } from "./logger";
import { ComfyUIClient } from "./comfy/client";
import { hasRequiredTags, isLongFormWorkflow, selectServer } from "./comfy/scheduler";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import { mediaStorage } from "./storage-service";

const activeGenerationStatuses = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const generationTimeoutMessage = "Timed out while waiting for ComfyUI";
const generationTimeoutMs = 6 * 60 * 60 * 1000;

async function withServerSlotLock<T>(serverId: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`comfy-server:${serverId}`],
    );
    if (!lock.rows[0]?.locked) {
      throw new Error("The selected GPU is being reserved by another render. Try again shortly.");
    }
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`comfy-server:${serverId}`]);
    }
  } finally {
    client.release();
  }
}

export type GenerationRequest = {
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
  preferredServerId?: string;
  longFormShotId?: string;
  onJobCreated?: (job: GenerationJob) => Promise<void>;
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
    input.dialogue ? `DIALOGUE\n${input.dialogue}` : "",
    `ACTION\n${input.prompt}`,
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
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: "Submission was interrupted before ComfyUI returned a prompt ID.", failedAt: new Date() })
    .where(and(eq(generationJobsTable.status, "UPLOADING"), sql`${generationJobsTable.comfyPromptId} IS NULL`));
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
    wantsReferenceVideo
      ? Boolean(candidate.apiWorkflow && (candidate.mappings as ParameterMappings).referenceVideo)
      : isLongFormWorkflow(candidate)
  ));
  const servers = await db.select().from(comfyServersTable);
  const requestedServer = input.preferredServerId
    ? servers.find((server) => server.id === input.preferredServerId)
    : undefined;
  const workflowsForRequestedServer = requestedServer
    ? compatibleWorkflows.filter((candidate) => (
      requestedServer.enabled &&
      requestedServer.status === "ONLINE" &&
      hasRequiredTags(requestedServer.tags, candidate.compatibleServerTags)
    ))
    : compatibleWorkflows;
  const selected = workflowsForRequestedServer
    .map((candidate) => ({
      workflow: candidate,
      server: requestedServer ?? selectServer(servers, candidate.compatibleServerTags),
    }))
    .filter((candidate) => candidate.server !== null)
    .sort((a, b) => (
      a.server!.queueSize - b.server!.queueSize ||
      a.server!.activeJobCount - b.server!.activeJobCount ||
      a.server!.priority - b.server!.priority
    ))[0];
  const workflow = selected?.workflow ?? workflowsForRequestedServer[0] ?? workflows[0];
  if (!workflow?.apiWorkflow) {
    throw new Error("No active imported API workflow is configured for this generation mode");
  }
  if ((workflow.mappings as ParameterMappings).referenceVideo && !input.referenceVideoKey) {
    throw new Error("No active workflow without reference-video input is configured for this generation mode");
  }
  const apiWorkflow = workflow.apiWorkflow;
  const server = selected?.server ?? requestedServer ?? selectServer(servers, workflow.compatibleServerTags);
  if (!server) {
    throw new Error("No healthy, compatible ComfyUI server is available. Configure and test a server first.");
  }
  return withServerSlotLock(server.id, async () => {
    const activeJobs = await db
      .select({ id: generationJobsTable.id })
      .from(generationJobsTable)
      .where(and(eq(generationJobsTable.comfyServerId, server.id), inArray(generationJobsTable.status, activeGenerationStatuses)));
    if (activeJobs.length >= (server.maxConcurrentJobs ?? 1)) {
      throw new Error(`${server.displayName} is at its safe render capacity.`);
    }
  const compiledPrompt = compilePrompt(characters, setting[0], input);
  const frameCount = Math.round(input.durationSeconds * input.fps);
  const [job] = await db
    .insert(generationJobsTable)
    .values({
      title: `${characters[0]?.name ?? "Reference video"} — ${setting[0]?.name ?? "Presenter"}`,
      status: "UPLOADING",
      workflowTemplateId: workflow.id,
      longFormShotId: input.longFormShotId ?? null,
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
  await input.onJobCreated?.(job);
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
    if (
      !wantsReferenceVideo &&
      !Object.keys(assetParameters).some((field) => /^referenceImage\d+$/.test(field))
    ) {
      throw new Error("Select a character with at least one reference image before generating.");
    }
    const referenceVideo = input.referenceVideoKey
      ? await mediaStorage.readReferenceVideo(input.referenceVideoKey)
      : null;
    const referenceVideoParameters = referenceVideo
      ? { referenceVideo: (await client.uploadVideo(referenceVideo)).name }
      : {};
    const submittedWorkflow = buildWorkflow(apiWorkflow, workflow.mappings as ParameterMappings, {
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
  });
}

export async function cancelGeneration(jobId: string) {
  const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, jobId));
  if (!job) {
    throw new Error("Generation job not found");
  }
  const alreadyCancelled = job.status === "CANCELLED";
  if (!activeGenerationStatuses.includes(job.status) && !alreadyCancelled) {
    throw new Error("Only active generation jobs can be cancelled");
  }

  let cancellationNote = "Cancelled by user.";
  if (job.comfyServerId && job.comfyPromptId) {
    const [server] = await db.select().from(comfyServersTable).where(eq(comfyServersTable.id, job.comfyServerId));
    if (server) {
      try {
        const client = new ComfyUIClient(server);
        await client.removeQueuedPrompt(job.comfyPromptId);
        if (job.status === "RUNNING" || alreadyCancelled) {
          await client.interrupt(job.comfyPromptId);
        }
      } catch (error) {
        logger.warn({ err: error, jobId }, "Could not cancel generation on ComfyUI worker");
        cancellationNote = "Cancelled in OBTV. The ComfyUI worker could not be reached to confirm cancellation.";
      }
    }
  }

  if (alreadyCancelled) {
    const [retried] = await db
      .update(generationJobsTable)
      .set({ errorMessage: cancellationNote })
      .where(eq(generationJobsTable.id, jobId))
      .returning();
    return retried ?? job;
  }

  const [cancelled] = await db
    .update(generationJobsTable)
    .set({ status: "CANCELLED", currentNode: null, errorMessage: cancellationNote })
    .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
    .returning();
  if (!cancelled) {
    throw new Error("Generation job finished before it could be cancelled");
  }
  return cancelled;
}

async function downloadCompletedOutput(
  jobId: string,
  client: ComfyUIClient,
  promptId: string,
  allowTimedOutFailure = false,
): Promise<boolean> {
  const history = await client.getHistory(promptId);
  const output = chooseOutput(history);
  if (!output) return false;

  const eligibleStatus = allowTimedOutFailure
    ? or(
      inArray(generationJobsTable.status, activeGenerationStatuses),
      and(eq(generationJobsTable.status, "FAILED"), eq(generationJobsTable.errorMessage, generationTimeoutMessage)),
    )
    : inArray(generationJobsTable.status, activeGenerationStatuses);
  const [downloading] = await db
    .update(generationJobsTable)
    .set({ status: "DOWNLOADING", currentNode: "Retrieving output", errorMessage: null })
    .where(and(eq(generationJobsTable.id, jobId), eligibleStatus))
    .returning({ id: generationJobsTable.id });
  if (!downloading) return false;

  try {
    const bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
    const mimeType = output.filename.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";
    const storageKey = await mediaStorage.storeOutput(output.filename, mimeType, bytes);
    await db
      .update(generationJobsTable)
      .set({
        status: "COMPLETED",
        outputStorageKey: storageKey,
        outputMimeType: mimeType,
        progress: 1,
        currentNode: null,
        errorMessage: null,
        failedAt: null,
        completedAt: new Date(),
      })
      .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
    return true;
  } catch (error) {
    await db
      .update(generationJobsTable)
      .set({
        status: allowTimedOutFailure ? "FAILED" : "RUNNING",
        currentNode: null,
        errorMessage: allowTimedOutFailure
          ? generationTimeoutMessage
          : error instanceof Error ? error.message : "Output download failed",
        failedAt: allowTimedOutFailure ? new Date() : null,
      })
      .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
    throw error;
  }
}

export async function recoverTimedOutGeneration(jobId: string): Promise<boolean> {
  const [job] = await db
    .select()
    .from(generationJobsTable)
    .where(eq(generationJobsTable.id, jobId));
  if (
    !job ||
    job.status !== "FAILED" ||
    job.errorMessage !== generationTimeoutMessage ||
    !job.comfyPromptId ||
    !job.comfyServerId
  ) {
    return false;
  }
  const [server] = await db
    .select()
    .from(comfyServersTable)
    .where(eq(comfyServersTable.id, job.comfyServerId));
  if (!server) return false;

  try {
    return await downloadCompletedOutput(job.id, new ComfyUIClient(server), job.comfyPromptId, true);
  } catch (error) {
    logger.warn({ err: error, jobId }, "Could not recover timed-out generation output");
    return false;
  }
}

async function monitorGeneration(jobId: string, client: ComfyUIClient, promptId: string) {
  const timeoutAt = Date.now() + generationTimeoutMs;
  while (Date.now() < timeoutAt) {
    try {
      const [currentJob] = await db
        .select({ status: generationJobsTable.status })
        .from(generationJobsTable)
        .where(eq(generationJobsTable.id, jobId));
      if (!currentJob || currentJob.status === "CANCELLED") return;
      if (await downloadCompletedOutput(jobId, client, promptId)) return;
      const [running] = await db
        .update(generationJobsTable)
        .set({ status: "RUNNING", currentNode: "ComfyUI processing" })
        .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
        .returning({ id: generationJobsTable.id });
      if (!running) return;
    } catch (error) {
      logger.warn({ err: error, jobId }, "Generation monitor retrying after ComfyUI error");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: generationTimeoutMessage, failedAt: new Date() })
    .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
}