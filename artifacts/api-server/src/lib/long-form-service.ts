import { execFile } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  charactersTable,
  comfyServersTable,
  db,
  generationJobsTable,
  longFormProjectsTable,
  longFormShotsTable,
  pool,
  settingsTable,
  workflowTemplatesTable,
  type LongFormProject,
  type LongFormShot,
} from "@workspace/db";
import { cancelGeneration, createAndSubmitGeneration } from "./generation-service";
import { logger } from "./logger";
import { mediaStorage } from "./storage-service";

const execFileAsync = promisify(execFile);
const activeGenerationStatuses = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const activeShotStatuses = ["QUEUED", "RENDERING"];
const MAX_SHOT_DURATION_SECONDS = 30;
const ORCHESTRATOR_INTERVAL_MS = 10_000;
let orchestratorTimer: NodeJS.Timeout | null = null;

export type LongFormProjectInput = {
  title: string;
  script: string;
  storyline?: string;
  targetDurationSeconds: number;
  shotDurationSeconds: number;
  characterIds: string[];
  settingId: string;
  generationMode: string;
  negativePrompt?: string;
  width: number;
  height: number;
  fps: number;
  qualityPreset: string;
};

export type LongFormShotUpdate = Partial<Pick<
  LongFormShot,
  "title" | "prompt" | "dialogue" | "cameraInstructions" | "motionInstructions" | "continuityNote" | "transition" | "durationSeconds"
>>;

type PlannedShot = {
  sceneNumber: number;
  shotNumber: number;
  title: string;
  prompt: string;
  dialogue: string;
  cameraInstructions: string;
  motionInstructions: string;
  continuityNote: string;
  transition: "CUT" | "DISSOLVE" | "FADE";
  durationSeconds: number;
};

function normalizeScript(script: string): string[] {
  const paragraphs = script
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const source = paragraphs.length > 0 ? paragraphs : [script.replace(/\s+/g, " ").trim()];
  return source.flatMap((paragraph) => {
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
    return sentences.length > 0 ? sentences : [paragraph];
  });
}

function chunkSentences(sentences: string[], desiredCount: number): string[] {
  if (sentences.length === 0) return ["Establish the story world and continue the narrative visually."];
  if (sentences.length >= desiredCount) {
    const groupSize = Math.ceil(sentences.length / desiredCount);
    const chunks: string[] = [];
    for (let index = 0; index < sentences.length; index += groupSize) {
      chunks.push(sentences.slice(index, index + groupSize).join(" "));
    }
    return chunks;
  }
  const chunks = [...sentences];
  let cursor = 0;
  while (chunks.length < desiredCount) {
    const source = chunks[cursor % chunks.length];
    const words = source.split(" ");
    if (words.length > 12) {
      const midpoint = Math.ceil(words.length / 2);
      chunks.splice(cursor % chunks.length, 1, words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" "));
    } else {
      chunks.push(`${source} Continue this moment with a natural visual transition.`);
    }
    cursor += 1;
  }
  return chunks;
}

function planShots(input: LongFormProjectInput): PlannedShot[] {
  const requestedShotDuration = Math.min(MAX_SHOT_DURATION_SECONDS, Math.max(2, input.shotDurationSeconds));
  const desiredCount = Math.max(1, Math.ceil(input.targetDurationSeconds / requestedShotDuration));
  const chunks = chunkSentences(normalizeScript(input.script), desiredCount);
  const shots: PlannedShot[] = [];
  let remainingDuration = input.targetDurationSeconds;
  let sceneNumber = 1;
  let shotNumber = 1;

  for (let index = 0; index < desiredCount; index += 1) {
    const durationSeconds = Math.min(requestedShotDuration, remainingDuration);
    const prompt = chunks[index % chunks.length];
    const previousPrompt = shots.at(-1)?.prompt;
    shots.push({
      sceneNumber,
      shotNumber,
      title: `Scene ${sceneNumber} · Shot ${shotNumber}`,
      prompt: input.storyline ? `${input.storyline.trim()}\n\n${prompt}` : prompt,
      dialogue: "",
      cameraInstructions: index % 3 === 0 ? "Establishing cinematic composition, deliberate framing." : index % 3 === 1 ? "Controlled medium shot with subtle tracking." : "Intimate detail shot with natural movement.",
      motionInstructions: "Natural, physically believable movement with consistent character and environment details.",
      continuityNote: previousPrompt
        ? `Continue visual identity, wardrobe, lighting, and narrative action from the previous shot. Previous beat: ${previousPrompt.slice(0, 220)}`
        : "Establish the visual identity, setting, lighting, and character continuity for the sequence.",
      transition: index === 0 ? "CUT" : index % 6 === 0 ? "DISSOLVE" : "CUT",
      durationSeconds,
    });
    remainingDuration -= durationSeconds;
    shotNumber += 1;
    if (shotNumber > 4) {
      sceneNumber += 1;
      shotNumber = 1;
    }
  }
  return shots;
}

async function withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [key],
    );
    if (!lock.rows[0]?.locked) return null;
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    client.release();
  }
}

async function withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T | null> {
  return withAdvisoryLock(`long-form-project:${projectId}`, work);
}

function date(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function presentShot(shot: LongFormShot) {
  const [server] = shot.assignedServerId
    ? await db.select({ displayName: comfyServersTable.displayName }).from(comfyServersTable).where(eq(comfyServersTable.id, shot.assignedServerId))
    : [];
  return {
    id: shot.id,
    sceneNumber: shot.sceneNumber,
    shotNumber: shot.shotNumber,
    title: shot.title,
    prompt: shot.prompt,
    dialogue: shot.dialogue,
    cameraInstructions: shot.cameraInstructions,
    motionInstructions: shot.motionInstructions,
    continuityNote: shot.continuityNote,
    transition: shot.transition as "CUT" | "DISSOLVE" | "FADE",
    durationSeconds: shot.durationSeconds,
    status: shot.status as "PLANNED" | "QUEUED" | "RENDERING" | "COMPLETED" | "FAILED" | "CANCELLED",
    retryCount: shot.retryCount,
    characterIds: shot.characterIds,
    settingId: shot.settingId,
    generationId: shot.generationJobId,
    serverName: server?.displayName ?? null,
    outputUrl: shot.outputStorageKey ? `/api/media/${shot.outputStorageKey}` : null,
    errorMessage: shot.errorMessage,
  };
}

export async function presentLongFormProject(project: LongFormProject, includeShots = false) {
  const base = {
    id: project.id,
    title: project.title,
    script: project.script,
    storyline: project.storyline,
    status: project.status as "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "ASSEMBLING" | "COMPLETED" | "FAILED" | "CANCELLED",
    targetDurationSeconds: project.targetDurationSeconds,
    generationMode: project.generationMode,
    width: project.width,
    height: project.height,
    fps: project.fps,
    qualityPreset: project.qualityPreset,
    characterIds: project.characterIds,
    settingId: project.settingId,
    totalShots: project.totalShots,
    completedShots: project.completedShots,
    failedShots: project.failedShots,
    progress: project.progress,
    finalOutputUrl: project.finalOutputStorageKey ? `/api/media/${project.finalOutputStorageKey}` : null,
    errorMessage: project.errorMessage,
    startedAt: date(project.startedAt),
    completedAt: date(project.completedAt),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
  if (!includeShots) return base;
  const shots = await db
    .select()
    .from(longFormShotsTable)
    .where(eq(longFormShotsTable.projectId, project.id))
    .orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
  return { ...base, shots: await Promise.all(shots.map(presentShot)) };
}

export async function createLongFormProject(input: LongFormProjectInput) {
  const [characters, setting] = await Promise.all([
    db.select({ id: charactersTable.id }).from(charactersTable).where(inArray(charactersTable.id, input.characterIds)),
    db.select({ id: settingsTable.id }).from(settingsTable).where(eq(settingsTable.id, input.settingId)),
  ]);
  if (characters.length !== input.characterIds.length || !setting[0]) {
    throw new Error("Select characters and an environment from the current library");
  }
  if (input.targetDurationSeconds > 600) throw new Error("Long-form projects are limited to 10 minutes.");
  const shots = planShots(input);
  const project = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(longFormProjectsTable)
      .values({
      title: input.title.trim(),
      script: input.script.trim(),
      storyline: input.storyline?.trim() ?? "",
      status: "READY",
      targetDurationSeconds: input.targetDurationSeconds,
      generationMode: input.generationMode,
      negativePrompt: input.negativePrompt ?? "",
      width: input.width,
      height: input.height,
      fps: input.fps,
      qualityPreset: input.qualityPreset,
      characterIds: input.characterIds,
      settingId: input.settingId,
      totalShots: shots.length,
      })
      .returning();
    await tx.insert(longFormShotsTable).values(
      shots.map((shot) => ({
        ...shot,
        projectId: created.id,
        characterIds: input.characterIds,
        settingId: input.settingId,
        status: "PLANNED",
      })),
    );
    return created;
  });
  return presentLongFormProject(project, true);
}

async function findAvailableServer(project: LongFormProject) {
  const [servers, workflows, activeJobs] = await Promise.all([
    db.select().from(comfyServersTable),
    db.select().from(workflowTemplatesTable).where(and(eq(workflowTemplatesTable.generationMode, project.generationMode), eq(workflowTemplatesTable.active, true))),
    db
      .select({ comfyServerId: generationJobsTable.comfyServerId })
      .from(generationJobsTable)
      .where(inArray(generationJobsTable.status, activeGenerationStatuses)),
  ]);
  const activeByServer = new Map<string, number>();
  for (const job of activeJobs) {
    if (job.comfyServerId) activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
  }
  const compatibleWorkflows = workflows.filter((workflow) => workflow.apiWorkflow && !("referenceVideo" in workflow.mappings));
  return servers
    .filter((server) => {
      const activeCount = activeByServer.get(server.id) ?? 0;
      const capacity = server.maxConcurrentJobs ?? 1;
      return server.enabled &&
        server.status === "ONLINE" &&
        activeCount < capacity &&
        compatibleWorkflows.some((workflow) => workflow.compatibleServerTags.every((tag) => server.tags.includes(tag)));
    })
    .sort((a, b) => (
      (activeByServer.get(a.id) ?? 0) - (activeByServer.get(b.id) ?? 0) ||
      a.queueSize - b.queueSize ||
      a.priority - b.priority
    ))[0] ?? null;
}

async function reconcileShotJobs(project: LongFormProject, shots: LongFormShot[]) {
  const generationIds = shots.flatMap((shot) => shot.generationJobId ? [shot.generationJobId] : []);
  const correlatedJobs = await db
    .select()
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.longFormShotId, shots.map((shot) => shot.id)));
  for (const shot of shots) {
    if (shot.generationJobId) continue;
    const correlatedJob = correlatedJobs.find((job) => job.longFormShotId === shot.id);
    if (correlatedJob) {
      await db.update(longFormShotsTable)
        .set({ generationJobId: correlatedJob.id })
        .where(and(eq(longFormShotsTable.id, shot.id), eq(longFormShotsTable.status, "QUEUED")));
    }
  }
  const reconciledShotIds = [...new Set([...generationIds, ...correlatedJobs.map((job) => job.id)])];
  if (reconciledShotIds.length === 0) return shots;
  const jobs = await db.select().from(generationJobsTable).where(inArray(generationJobsTable.id, reconciledShotIds));
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const shot of shots) {
    const job = shot.generationJobId ? byId.get(shot.generationJobId) : null;
    if (!job) continue;
    if (job.status === "COMPLETED" && job.outputStorageKey && shot.status !== "COMPLETED") {
      await db.update(longFormShotsTable).set({
        status: "COMPLETED",
        outputStorageKey: job.outputStorageKey,
        outputMimeType: job.outputMimeType,
        errorMessage: null,
        completedAt: new Date(),
      }).where(eq(longFormShotsTable.id, shot.id));
    } else if (["FAILED", "CANCELLED"].includes(job.status) && !["COMPLETED", "FAILED", "CANCELLED"].includes(shot.status)) {
      await db.update(longFormShotsTable).set({
        status: job.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        errorMessage: job.errorMessage ?? "Render did not complete",
      }).where(eq(longFormShotsTable.id, shot.id));
    } else if (activeGenerationStatuses.includes(job.status) && shot.status !== "RENDERING") {
      await db.update(longFormShotsTable).set({ status: "RENDERING" }).where(eq(longFormShotsTable.id, shot.id));
    }
  }
  return db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, project.id)).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
}

async function runMediaTool(command: "ffmpeg" | "ffprobe", args: string[]) {
  await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
}

async function validateShotMedia(shot: LongFormShot): Promise<void> {
  if (!shot.outputStorageKey) throw new Error(`Shot ${shot.title} has no output file`);
  const result = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    mediaStorage.resolvePath(shot.outputStorageKey),
  ]);
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string } };
  if (!parsed.format?.duration || Number(parsed.format.duration) <= 0) {
    throw new Error(`Shot ${shot.title} is not a playable video`);
  }
}

async function assembleProject(project: LongFormProject, shots: LongFormShot[]): Promise<void> {
  await db.update(longFormProjectsTable).set({ status: "ASSEMBLING", errorMessage: null }).where(eq(longFormProjectsTable.id, project.id));
  const workDir = path.join(tmpdir(), `obtv-assembly-${project.id}`);
  try {
    await mkdir(workDir, { recursive: true });
    const normalizedPaths: string[] = [];
    for (const [index, shot] of shots.entries()) {
      await validateShotMedia(shot);
      const normalizedPath = path.join(workDir, `shot-${String(index).padStart(3, "0")}.mp4`);
      await runMediaTool("ffmpeg", [
        "-y", "-i", mediaStorage.resolvePath(shot.outputStorageKey!),
        "-vf", `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2,fps=${project.fps}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", normalizedPath,
      ]);
      normalizedPaths.push(normalizedPath);
    }
    const listPath = path.join(workDir, "inputs.txt");
    await writeFile(listPath, normalizedPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    const finalPath = path.join(workDir, "final.mp4");
    await runMediaTool("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", finalPath]);
    const storageKey = await mediaStorage.storeOutput(`${project.title}.mp4`, "video/mp4", await readFile(finalPath));
    await db.update(longFormProjectsTable).set({
      status: "COMPLETED",
      progress: 100,
      finalOutputStorageKey: storageKey,
      finalOutputMimeType: "video/mp4",
      completedAt: new Date(),
      errorMessage: null,
    }).where(eq(longFormProjectsTable.id, project.id));
  } catch (error) {
    await db.update(longFormProjectsTable).set({
      status: "FAILED",
      errorMessage: error instanceof Error ? `Assembly failed: ${error.message}` : "Assembly failed",
    }).where(eq(longFormProjectsTable.id, project.id));
    logger.error({ err: error, projectId: project.id }, "Long-form assembly failed");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function updateProjectProgress(project: LongFormProject, shots: LongFormShot[]) {
  const completedShots = shots.filter((shot) => shot.status === "COMPLETED");
  const completedSeconds = completedShots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
  const failedShots = shots.filter((shot) => shot.status === "FAILED").length;
  const progress = Math.min(99, (completedSeconds / project.targetDurationSeconds) * 100);
  await db.update(longFormProjectsTable).set({
    completedShots: completedShots.length,
    failedShots,
    progress,
  }).where(eq(longFormProjectsTable.id, project.id));
}

async function orchestrateProjectUnlocked(projectId: string): Promise<void> {
  const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
  if (!project) return;
  let shots = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, project.id)).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
  if (project.status === "ASSEMBLING") {
    if (shots.length > 0 && shots.every((shot) => shot.status === "COMPLETED")) {
      await assembleProject(project, shots);
    }
    return;
  }
  if (project.status !== "RUNNING") return;
  shots = await reconcileShotJobs(project, shots);
  await updateProjectProgress(project, shots);

  const remaining = shots.filter((shot) => shot.status === "PLANNED");
  const active = shots.filter((shot) => activeShotStatuses.includes(shot.status));
  if (remaining.length === 0 && active.length === 0) {
    const failed = shots.filter((shot) => shot.status === "FAILED");
    if (failed.length > 0) {
      await db.update(longFormProjectsTable).set({ status: "FAILED", errorMessage: `${failed.length} shot${failed.length === 1 ? "" : "s"} need a retry.` }).where(eq(longFormProjectsTable.id, project.id));
    } else if (shots.length > 0 && shots.every((shot) => shot.status === "COMPLETED")) {
      await assembleProject(project, shots);
    }
    return;
  }

  let server = await findAvailableServer(project);
  let nextShot = remaining[0];
  while (server && nextShot) {
    const dispatched = await (async () => {
      const [currentProject] = await db.select({ status: longFormProjectsTable.status }).from(longFormProjectsTable).where(eq(longFormProjectsTable.id, project.id));
      if (currentProject?.status !== "RUNNING") return false;
      const confirmedServer = await findAvailableServer(project);
      if (confirmedServer?.id !== server.id) return false;
      const [claimed] = await db.update(longFormShotsTable)
        .set({ status: "QUEUED", assignedServerId: server.id, errorMessage: null, startedAt: new Date() })
        .where(and(eq(longFormShotsTable.id, nextShot.id), eq(longFormShotsTable.status, "PLANNED")))
        .returning();
      if (!claimed) return false;
      try {
        const job = await createAndSubmitGeneration({
          characterIds: project.characterIds,
          settingId: project.settingId ?? undefined,
          prompt: claimed.prompt,
          negativePrompt: project.negativePrompt,
          cameraInstructions: claimed.cameraInstructions,
          dialogue: claimed.dialogue,
          motionInstructions: claimed.motionInstructions,
          generationMode: project.generationMode,
          durationSeconds: Math.min(MAX_SHOT_DURATION_SECONDS, claimed.durationSeconds),
          fps: project.fps,
          width: project.width,
          height: project.height,
          qualityPreset: project.qualityPreset,
          seedMode: "RANDOM",
          preferredServerId: server.id,
          longFormShotId: claimed.id,
          onJobCreated: async (job) => {
            await db.update(longFormShotsTable).set({ generationJobId: job.id })
              .where(and(eq(longFormShotsTable.id, claimed.id), eq(longFormShotsTable.status, "QUEUED")));
          },
        });
        await db.update(longFormShotsTable).set({
          status: "RENDERING",
          assignedServerId: job.comfyServerId ?? server.id,
        }).where(and(eq(longFormShotsTable.id, claimed.id), eq(longFormShotsTable.generationJobId, job.id), eq(longFormShotsTable.status, "QUEUED")));
        logger.info({ projectId: project.id, shotId: claimed.id, jobId: job.id, server: server.displayName }, "Long-form shot dispatched");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not submit shot";
        const deferred = message.includes("being reserved by another render") || message.includes("safe render capacity");
        await db.update(longFormShotsTable).set(
          deferred
            ? { status: "PLANNED", assignedServerId: null, startedAt: null, errorMessage: null }
            : { status: "FAILED", errorMessage: message },
        ).where(and(eq(longFormShotsTable.id, claimed.id), eq(longFormShotsTable.status, "QUEUED")));
        return false;
      }
    })();
    if (!dispatched) break;
    server = await findAvailableServer(project);
    nextShot = (await db.select().from(longFormShotsTable).where(and(eq(longFormShotsTable.projectId, project.id), eq(longFormShotsTable.status, "PLANNED"))).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber)))[0];
  }
}

export async function orchestrateLongFormProject(projectId: string): Promise<void> {
  await withProjectLock(projectId, () => orchestrateProjectUnlocked(projectId));
}

export async function startLongFormProject(projectId: string) {
  const [project] = await db.update(longFormProjectsTable)
    .set({ status: "RUNNING", startedAt: new Date(), errorMessage: null })
    .where(and(eq(longFormProjectsTable.id, projectId), inArray(longFormProjectsTable.status, ["READY", "PAUSED", "FAILED"])))
    .returning();
  if (!project) throw new Error("Project cannot be started from its current status");
  void orchestrateLongFormProject(project.id);
  return presentLongFormProject(project, true);
}

export async function pauseLongFormProject(projectId: string) {
  const [project] = await db.update(longFormProjectsTable)
    .set({ status: "PAUSED" })
    .where(and(eq(longFormProjectsTable.id, projectId), eq(longFormProjectsTable.status, "RUNNING")))
    .returning();
  if (!project) throw new Error("Only a running project can be paused");
  return presentLongFormProject(project, true);
}

export async function cancelLongFormProject(projectId: string) {
  const result = await withProjectLock(projectId, async () => {
  const [project] = await db.update(longFormProjectsTable)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(and(eq(longFormProjectsTable.id, projectId), inArray(longFormProjectsTable.status, ["READY", "RUNNING", "PAUSED", "FAILED"])))
    .returning();
  if (!project) throw new Error("Project cannot be cancelled from its current status");
  const shots = await db.select().from(longFormShotsTable).where(eq(longFormShotsTable.projectId, project.id));
  await Promise.all(shots.map(async (shot) => {
    if (shot.generationJobId && activeShotStatuses.includes(shot.status)) {
      await cancelGeneration(shot.generationJobId).catch((error) => logger.warn({ err: error, shotId: shot.id }, "Could not cancel child generation"));
    }
  }));
  await db.update(longFormShotsTable).set({ status: "CANCELLED" })
    .where(and(eq(longFormShotsTable.projectId, project.id), inArray(longFormShotsTable.status, ["PLANNED", "QUEUED", "RENDERING"])));
  return presentLongFormProject(project, true);
  });
  if (!result) throw new Error("Project is currently being updated; try again.");
  return result;
}

export async function updateLongFormShot(projectId: string, shotId: string, input: LongFormShotUpdate) {
  const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
  if (!project) throw new Error("Long-form project not found");
  if (!["READY", "PAUSED", "FAILED"].includes(project.status)) throw new Error("Pause the project before editing a shot");
  const [shot] = await db.update(longFormShotsTable)
    .set(input)
    .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId), eq(longFormShotsTable.status, "PLANNED")))
    .returning();
  if (!shot) throw new Error("Only planned shots can be edited");
  return presentShot(shot);
}

export async function retryLongFormShot(projectId: string, shotId: string) {
  const [existingShot] = await db
    .select({ retryCount: longFormShotsTable.retryCount })
    .from(longFormShotsTable)
    .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId)));
  if (!existingShot) throw new Error("Long-form shot not found");
  const [shot] = await db.update(longFormShotsTable).set({
    status: "PLANNED",
    generationJobId: null,
    assignedServerId: null,
    outputStorageKey: null,
    outputMimeType: null,
    errorMessage: null,
    retryCount: existingShot.retryCount + 1,
  }).where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId), inArray(longFormShotsTable.status, ["FAILED", "CANCELLED"]))).returning();
  if (!shot) throw new Error("Only failed or cancelled shots can be retried");
  await db.update(longFormProjectsTable).set({ status: "RUNNING", errorMessage: null }).where(eq(longFormProjectsTable.id, projectId));
  void orchestrateLongFormProject(projectId);
  return presentShot(shot);
}

export async function startLongFormOrchestrator(): Promise<void> {
  if (orchestratorTimer) return;
  const tick = async () => {
    const projects = await db.select({ id: longFormProjectsTable.id }).from(longFormProjectsTable).where(inArray(longFormProjectsTable.status, ["RUNNING", "ASSEMBLING"]));
    await Promise.allSettled(projects.map((project) => orchestrateLongFormProject(project.id)));
  };
  await tick();
  orchestratorTimer = setInterval(() => void tick(), ORCHESTRATOR_INTERVAL_MS);
  logger.info("Long-form project orchestrator started");
}