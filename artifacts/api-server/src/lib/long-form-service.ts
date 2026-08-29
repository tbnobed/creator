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
  type ComfyServer,
  type LongFormProject,
  type LongFormShot,
} from "@workspace/db";
import { hasRequiredTags, isLongFormWorkflow } from "./comfy/scheduler";
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

type StructuredBeat = {
  kind: "SHOT" | "B-ROLL";
  number: number;
  label: string;
  body: string;
};

function normalizeBlock(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseStructuredBeats(script: string): StructuredBeat[] | null {
  const lines = script.replaceAll("\r\n", "\n").split("\n");
  const headerPattern = /^\s*(SHOT|B-ROLL)\s+(\d+)(?:\s*(?::|[—–-])\s*(.*))?\s*$/i;
  const headers = lines
    .map((line, index) => {
      const match = line.match(headerPattern);
      if (!match) return null;
      return {
        index,
        kind: match[1].toUpperCase() as StructuredBeat["kind"],
        number: Number(match[2]),
        label: match[3]?.trim() ?? "",
      };
    })
    .filter((header): header is NonNullable<typeof header> => header !== null);
  if (headers.length === 0) return null;

  const beats = headers.map((header, index) => {
    const followingBody = normalizeBlock(lines.slice(header.index + 1, headers[index + 1]?.index ?? lines.length).join("\n"));
    return {
      kind: header.kind,
      number: header.number,
      label: followingBody ? header.label : "",
      body: followingBody || header.label,
    };
  });
  const validBeats = beats.filter((beat) => beat.body.length > 0);
  return validBeats.length > 0 ? validBeats : null;
}

const dialogueLabelPattern = /^\s*[^:\n]*\b(?:voice[-\s]?over|narration|dialogue|spoken\s+dialogue|says|speaks?)\b[^:\n]*:\s*(.*)$/iu;
const quotedLinePattern = /^\s*[“"]([^”"]+)[”"]\s*$/;

function getDialogueLabelValue(line: string): string | null {
  const match = line.match(dialogueLabelPattern);
  return match ? match[1].trim() : null;
}

function extractDialogue(body: string): string {
  const dialogue: string[] = [];
  let awaitingQuotedDialogue = false;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const labelValue = getDialogueLabelValue(line);
    if (labelValue !== null) {
      const inlineQuote = labelValue.match(/^[“"]([^”"]+)[”"]$/);
      if (inlineQuote?.[1]?.trim()) dialogue.push(inlineQuote[1].trim());
      awaitingQuotedDialogue = !inlineQuote;
      continue;
    }
    if (awaitingQuotedDialogue) {
      const quotedLine = line.match(quotedLinePattern);
      if (quotedLine?.[1]?.trim()) {
        dialogue.push(quotedLine[1].trim());
        awaitingQuotedDialogue = false;
      } else if (line.trim()) {
        awaitingQuotedDialogue = false;
      }
    }
  }
  return [...new Set(dialogue)].join("\n");
}

function removeDialogueFromPrompt(body: string): string {
  const visualLines: string[] = [];
  let omitQuotedDialogue = false;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const labelValue = getDialogueLabelValue(line);
    if (labelValue !== null) {
      const inlineQuote = labelValue.match(/^[“"]([^”"]+)[”"]$/);
      omitQuotedDialogue = !inlineQuote;
      continue;
    }
    if (omitQuotedDialogue && quotedLinePattern.test(line)) {
      omitQuotedDialogue = false;
      continue;
    }
    omitQuotedDialogue = false;
    visualLines.push(line);
  }
  return normalizeBlock(visualLines.join("\n"));
}

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

function minimumShotDuration(dialogue: string): number {
  if (!dialogue.trim()) return 2;
  const wordCount = dialogue.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const requiredSeconds = wordCount / 2.25 + 1.5;
  if (requiredSeconds > MAX_SHOT_DURATION_SECONDS) {
    throw new Error(`A spoken line needs about ${Math.ceil(requiredSeconds)} seconds. Split it across multiple shots so each line fits within ${MAX_SHOT_DURATION_SECONDS} seconds.`);
  }
  return Math.ceil(Math.max(2, requiredSeconds) * 10) / 10;
}

function allocateShotDurations(minimums: number[], targetDurationSeconds: number): number[] {
  const minimumTotal = minimums.reduce((sum, duration) => sum + duration, 0);
  const maximumTotal = minimums.length * MAX_SHOT_DURATION_SECONDS;
  if (targetDurationSeconds > maximumTotal) {
    throw new Error(`The requested duration needs more shots. Add shot headers so no shot exceeds ${MAX_SHOT_DURATION_SECONDS} seconds.`);
  }
  const plannedTotal = Math.max(targetDurationSeconds, minimumTotal);
  if (plannedTotal > 600) {
    throw new Error("The spoken script needs more than 10 minutes. Shorten the dialogue or split it into another project.");
  }

  const durations = [...minimums];
  let remaining = plannedTotal - minimumTotal;
  while (remaining > 0.001) {
    const available = durations
      .map((duration, index) => ({ duration, index }))
      .filter(({ duration }) => duration < MAX_SHOT_DURATION_SECONDS - 0.001);
    if (available.length === 0) break;
    const share = remaining / available.length;
    let added = 0;
    for (const { duration, index } of available) {
      const increment = Math.min(share, MAX_SHOT_DURATION_SECONDS - duration);
      durations[index] += increment;
      added += increment;
    }
    if (added <= 0.001) break;
    remaining -= added;
  }
  return durations.map((duration) => Number(duration.toFixed(2)));
}

function planShots(input: LongFormProjectInput): PlannedShot[] {
  const requestedShotDuration = Math.min(MAX_SHOT_DURATION_SECONDS, Math.max(2, input.shotDurationSeconds));
  const desiredCount = Math.max(1, Math.ceil(input.targetDurationSeconds / requestedShotDuration));
  const structuredBeats = parseStructuredBeats(input.script);
  const chunks = structuredBeats ?? chunkSentences(normalizeScript(input.script), desiredCount);
  const shotCount = structuredBeats?.length ?? desiredCount;
  const shotInputs = Array.from({ length: shotCount }, (_, index) => {
    const structuredBeat = structuredBeats?.[index];
    const shotBody = structuredBeat ? structuredBeat.body : chunks[index % chunks.length] as string;
    const dialogue = structuredBeat?.kind === "SHOT" ? extractDialogue(shotBody) : "";
    return {
      structuredBeat,
      dialogue,
      prompt: dialogue ? removeDialogueFromPrompt(shotBody) : shotBody,
    };
  });
  const durations = allocateShotDurations(
    shotInputs.map(({ dialogue }) => minimumShotDuration(dialogue)),
    input.targetDurationSeconds,
  );
  const shots: PlannedShot[] = [];
  let sceneNumber = 1;
  let shotNumber = 1;

  for (let index = 0; index < shotCount; index += 1) {
    const { structuredBeat, dialogue, prompt } = shotInputs[index];
    const previousPrompt = shots.at(-1)?.prompt;
    const label = structuredBeat
      ? `${structuredBeat.kind === "B-ROLL" ? "B-Roll" : "Shot"} ${structuredBeat.number}${structuredBeat.label ? ` · ${structuredBeat.label}` : ""}`
      : `Scene ${sceneNumber} · Shot ${shotNumber}`;
    shots.push({
      sceneNumber,
      shotNumber,
      title: label,
      prompt: input.storyline ? `${prompt}\n\nPROJECT VISUAL DIRECTION\n${input.storyline.trim()}` : prompt,
      dialogue,
      cameraInstructions: index % 3 === 0 ? "Establishing cinematic composition, deliberate framing." : index % 3 === 1 ? "Controlled medium shot with subtle tracking." : "Intimate detail shot with natural movement.",
      motionInstructions: "Natural, physically believable movement with consistent character and environment details.",
      continuityNote: previousPrompt
        ? `Continue visual identity, wardrobe, lighting, and narrative action from the previous shot. Previous beat: ${previousPrompt.slice(0, 220)}`
        : "Establish the visual identity, setting, lighting, and character continuity for the sequence.",
      transition: index === 0 ? "CUT" : index % 6 === 0 ? "DISSOLVE" : "CUT",
      durationSeconds: durations[index],
    });
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
  // Project totals are stored as integer seconds, while individual shot durations
  // may remain fractional for accurate dialogue timing.
  const plannedDurationSeconds = Math.ceil(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0));
  const project = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(longFormProjectsTable)
      .values({
      title: input.title.trim(),
      script: input.script.trim(),
      storyline: input.storyline?.trim() ?? "",
      status: "READY",
      targetDurationSeconds: plannedDurationSeconds,
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

export async function deleteLongFormProject(projectId: string): Promise<void> {
  const deleted = await withProjectLock(projectId, async () => {
    const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    if (!project) throw new Error("Long-form project not found");
    if (["RUNNING", "ASSEMBLING"].includes(project.status)) {
      throw new Error("Pause or cancel the project before deleting it.");
    }

    const shots = await db
      .select()
      .from(longFormShotsTable)
      .where(eq(longFormShotsTable.projectId, projectId));
    const shotIds = shots.map((shot) => shot.id);
    const linkedJobs = shotIds.length > 0
      ? await db.select().from(generationJobsTable).where(inArray(generationJobsTable.longFormShotId, shotIds))
      : [];
    const linkedJobIds = [...new Set([
      ...shots.flatMap((shot) => shot.generationJobId ? [shot.generationJobId] : []),
      ...linkedJobs.map((job) => job.id),
    ])];
    const childJobs = linkedJobIds.length > 0
      ? await db.select().from(generationJobsTable).where(inArray(generationJobsTable.id, linkedJobIds))
      : [];
    if (childJobs.some((job) => activeGenerationStatuses.includes(job.status))) {
      throw new Error("Cancel all active renders before deleting this project.");
    }

    const mediaKeys = [...new Set([
      project.finalOutputStorageKey,
      ...shots.map((shot) => shot.outputStorageKey),
      ...childJobs.map((job) => job.outputStorageKey),
    ].filter((key): key is string => Boolean(key)))];

    await db.transaction(async (tx) => {
      if (linkedJobIds.length > 0) {
        await tx.update(longFormShotsTable)
          .set({ generationJobId: null })
          .where(eq(longFormShotsTable.projectId, projectId));
        await tx.delete(generationJobsTable).where(inArray(generationJobsTable.id, linkedJobIds));
      }
      await tx.delete(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    });

    await Promise.all(mediaKeys.map((key) => mediaStorage.deleteOutput(key)));
  });
  if (deleted === null) throw new Error("Project is currently being updated; try again.");
}

type DispatchAvailability = {
  server: ComfyServer | null;
  reason: string | null;
};

async function findDispatchAvailability(project: LongFormProject): Promise<DispatchAvailability> {
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
  const compatibleWorkflows = workflows.filter(isLongFormWorkflow);
  if (compatibleWorkflows.length === 0) {
    return {
      server: null,
      reason: `Waiting for an active ${project.generationMode} workflow that accepts character and environment references.`,
    };
  }
  const onlineCompatibleServers = servers.filter((server) => (
    server.enabled &&
    server.status === "ONLINE" &&
    compatibleWorkflows.some((workflow) => hasRequiredTags(server.tags, workflow.compatibleServerTags))
  ));
  if (onlineCompatibleServers.length === 0) {
    return {
      server: null,
      reason: `Waiting for an online GPU worker compatible with the ${project.generationMode} workflow.`,
    };
  }
  const availableServers = onlineCompatibleServers.filter((server) => {
    const activeCount = Math.max(activeByServer.get(server.id) ?? 0, server.activeJobCount);
    return activeCount < (server.maxConcurrentJobs ?? 1);
  });
  const server = availableServers
    .sort((a, b) => (
      Math.max(activeByServer.get(a.id) ?? 0, a.activeJobCount) -
        Math.max(activeByServer.get(b.id) ?? 0, b.activeJobCount) ||
      a.queueSize - b.queueSize ||
      a.priority - b.priority
    ))[0] ?? null;
  return {
    server,
    reason: server
      ? null
      : `All compatible GPUs are currently rendering: ${onlineCompatibleServers.map((candidate) => candidate.displayName).join(", ")}. The next shot will start automatically when a slot opens.`,
  };
}

async function recordDispatchBlock(project: LongFormProject, reason: string): Promise<void> {
  if (project.errorMessage === reason) return;
  await db.update(longFormProjectsTable)
    .set({ errorMessage: reason })
    .where(and(eq(longFormProjectsTable.id, project.id), eq(longFormProjectsTable.status, "RUNNING")));
  logger.warn({ projectId: project.id, generationMode: project.generationMode, reason }, "Long-form dispatch waiting");
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

async function validateShotMedia(shot: LongFormShot): Promise<{ durationSeconds: number; hasAudio: boolean }> {
  if (!shot.outputStorageKey) throw new Error(`Shot ${shot.title} has no output file`);
  const result = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    mediaStorage.resolvePath(shot.outputStorageKey),
  ]);
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Shot ${shot.title} is not a playable video`);
  }
  return {
    durationSeconds,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

async function assembleProject(project: LongFormProject, shots: LongFormShot[]): Promise<void> {
  await db.update(longFormProjectsTable).set({ status: "ASSEMBLING", errorMessage: null }).where(eq(longFormProjectsTable.id, project.id));
  const workDir = path.join(tmpdir(), `obtv-assembly-${project.id}`);
  try {
    await mkdir(workDir, { recursive: true });
    const normalizedPaths: string[] = [];
    for (const [index, shot] of shots.entries()) {
      const mediaInfo = await validateShotMedia(shot);
      const normalizedPath = path.join(workDir, `shot-${String(index).padStart(3, "0")}.mp4`);
      const ffmpegArgs = [
        "-y", "-i", mediaStorage.resolvePath(shot.outputStorageKey!),
      ];
      if (!mediaInfo.hasAudio) {
        ffmpegArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      }
      ffmpegArgs.push(
        "-map", "0:v:0",
        "-map", mediaInfo.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2,fps=${project.fps}`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-b:a", "192k",
        "-af", "apad",
        "-t", String(mediaInfo.durationSeconds),
        "-movflags", "+faststart",
        normalizedPath,
      );
      await runMediaTool("ffmpeg", ffmpegArgs);
      normalizedPaths.push(normalizedPath);
    }
    const listPath = path.join(workDir, "inputs.txt");
    await writeFile(listPath, normalizedPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    const finalPath = path.join(workDir, "final.mp4");
    await runMediaTool("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c", "copy",
      "-movflags", "+faststart",
      finalPath,
    ]);
    const storageKey = await mediaStorage.storeOutput(`${project.title}.mp4`, "video/mp4", await readFile(finalPath));
    await db.update(longFormProjectsTable).set({
      status: "COMPLETED",
      progress: 100,
      finalOutputStorageKey: storageKey,
      finalOutputMimeType: "video/mp4",
      completedAt: new Date(),
      errorMessage: null,
    }).where(eq(longFormProjectsTable.id, project.id));
    if (project.finalOutputStorageKey && project.finalOutputStorageKey !== storageKey) {
      await mediaStorage.deleteOutput(project.finalOutputStorageKey).catch((error) => {
        logger.warn({ err: error, projectId: project.id }, "Could not remove superseded long-form output");
      });
    }
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

  let availability = await findDispatchAvailability(project);
  let server = availability.server;
  if (!server) {
    await recordDispatchBlock(project, availability.reason ?? "Waiting for a compatible GPU worker.");
    return;
  }
  let nextShot = remaining[0];
  while (server && nextShot) {
    const dispatched = await (async () => {
      const [currentProject] = await db.select({ status: longFormProjectsTable.status }).from(longFormProjectsTable).where(eq(longFormProjectsTable.id, project.id));
      if (currentProject?.status !== "RUNNING") return false;
      const confirmedAvailability = await findDispatchAvailability(project);
      const confirmedServer = confirmedAvailability.server;
      if (confirmedServer?.id !== server.id) return false;
      const [claimed] = await db.update(longFormShotsTable)
        .set({ status: "QUEUED", assignedServerId: server.id, errorMessage: null, startedAt: new Date() })
        .where(and(eq(longFormShotsTable.id, nextShot.id), eq(longFormShotsTable.status, "PLANNED")))
        .returning();
      if (!claimed) return false;
      try {
        const renderDurationSeconds = Math.max(claimed.durationSeconds, minimumShotDuration(claimed.dialogue));
        if (renderDurationSeconds !== claimed.durationSeconds) {
          await db.update(longFormShotsTable)
            .set({ durationSeconds: renderDurationSeconds })
            .where(eq(longFormShotsTable.id, claimed.id));
        }
        const job = await createAndSubmitGeneration({
          characterIds: project.characterIds,
          settingId: project.settingId ?? undefined,
          prompt: claimed.dialogue ? removeDialogueFromPrompt(claimed.prompt) : claimed.prompt,
          negativePrompt: project.negativePrompt,
          cameraInstructions: claimed.cameraInstructions,
          dialogue: claimed.dialogue,
          motionInstructions: claimed.motionInstructions,
          generationMode: project.generationMode,
          durationSeconds: renderDurationSeconds,
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
        if (project.errorMessage) {
          await db.update(longFormProjectsTable).set({ errorMessage: null }).where(eq(longFormProjectsTable.id, project.id));
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not submit shot";
        const deferred = message.includes("being reserved by another render") || message.includes("safe render capacity");
        await db.update(longFormShotsTable).set(
          deferred
            ? { status: "PLANNED", assignedServerId: null, startedAt: null, errorMessage: null }
            : { status: "FAILED", errorMessage: message },
        ).where(and(eq(longFormShotsTable.id, claimed.id), eq(longFormShotsTable.status, "QUEUED")));
        logger.warn({ err: error, projectId: project.id, shotId: claimed.id, server: server.displayName, deferred }, "Long-form shot dispatch failed");
        return false;
      }
    })();
    if (!dispatched) break;
    availability = await findDispatchAvailability(project);
    server = availability.server;
    nextShot = (await db.select().from(longFormShotsTable).where(and(eq(longFormShotsTable.projectId, project.id), eq(longFormShotsTable.status, "PLANNED"))).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber)))[0];
  }
  if (!server && nextShot && availability.reason) {
    await recordDispatchBlock(project, availability.reason);
  }
}

export async function orchestrateLongFormProject(projectId: string): Promise<void> {
  await withProjectLock(projectId, () => orchestrateProjectUnlocked(projectId));
}

function scheduleLongFormOrchestration(projectId: string, source: string): void {
  void orchestrateLongFormProject(projectId).catch((error) => {
    logger.error({ err: error, projectId, source }, "Could not orchestrate long-form project");
  });
}

export async function startLongFormProject(projectId: string) {
  const [project] = await db.update(longFormProjectsTable)
    .set({ status: "RUNNING", startedAt: new Date(), errorMessage: null })
    .where(and(eq(longFormProjectsTable.id, projectId), inArray(longFormProjectsTable.status, ["READY", "PAUSED", "FAILED"])))
    .returning();
  if (!project) throw new Error("Project cannot be started from its current status");
  scheduleLongFormOrchestration(project.id, "start");
  return presentLongFormProject(project, true);
}

export async function reassembleLongFormProject(projectId: string) {
  const project = await withProjectLock(projectId, async () => {
    const [current] = await db
      .select()
      .from(longFormProjectsTable)
      .where(eq(longFormProjectsTable.id, projectId));
    if (!current) throw new Error("Long-form project not found");
    if (!["COMPLETED", "FAILED"].includes(current.status)) {
      throw new Error("Only completed projects or failed assemblies can be reassembled");
    }

    const shots = await db
      .select()
      .from(longFormShotsTable)
      .where(eq(longFormShotsTable.projectId, projectId));
    if (shots.length === 0 || shots.some((shot) => shot.status !== "COMPLETED" || !shot.outputStorageKey)) {
      throw new Error("All shots must be completed before rebuilding the final video");
    }

    const [updated] = await db
      .update(longFormProjectsTable)
      .set({
        status: "ASSEMBLING",
        progress: 99,
        completedAt: null,
        errorMessage: null,
      })
      .where(eq(longFormProjectsTable.id, projectId))
      .returning();
    return updated;
  });
  if (!project) throw new Error("Project is currently being updated; try again.");
  scheduleLongFormOrchestration(project.id, "reassemble");
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
  scheduleLongFormOrchestration(projectId, "retry-shot");
  return presentShot(shot);
}

export async function startLongFormOrchestrator(): Promise<void> {
  if (orchestratorTimer) return;
  const tick = async () => {
    const projects = await db.select({ id: longFormProjectsTable.id }).from(longFormProjectsTable).where(inArray(longFormProjectsTable.status, ["RUNNING", "ASSEMBLING"]));
    const results = await Promise.allSettled(projects.map((project) => orchestrateLongFormProject(project.id)));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error({ err: result.reason, projectId: projects[index]?.id }, "Long-form orchestrator tick failed");
      }
    });
  };
  await tick();
  orchestratorTimer = setInterval(() => {
    void tick().catch((error) => logger.error({ err: error }, "Long-form orchestrator polling failed"));
  }, ORCHESTRATOR_INTERVAL_MS);
  logger.info("Long-form project orchestrator started");
}