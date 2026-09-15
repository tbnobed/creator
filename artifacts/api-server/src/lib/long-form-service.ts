import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  charactersTable,
  comfyServersTable,
  db,
  generationJobsTable,
  imageStudioAssetsTable,
  imageStudioJobsTable,
  longFormProjectsTable,
  longFormShotsTable,
  pool,
  settingsTable,
  workflowTemplatesTable,
  type ComfyServer,
  type LongFormProject,
  type LongFormShot,
  type LongFormTimelineClip,
  type LongFormContinuitySettings,
  type LongFormShotContinuity,
} from "@workspace/db";
import { hasRequiredTags, isLongFormWorkflow } from "./comfy/scheduler";
import { cancelGeneration, createAndSubmitGeneration } from "./generation-service";
import { logger } from "./logger";
import { mediaStorage } from "./storage-service";
import { assertOwnedAssetSelections, ResourceNotFoundError } from "./resource-errors";
import {
  activeShotsForProject,
  defaultContinuity,
  defaultShotContinuity,
  invalidateShotStill,
  invalidatedStillValues,
  missingApprovedContinuityShot,
  stillForShot,
  validateContinuitySettings,
  validateShotContinuity,
} from "./continuity-service";

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
  characterIds?: string[];
  settingId?: string | null;
  generationMode: string;
  negativePrompt?: string;
  width: number;
  height: number;
  fps: number;
  qualityPreset: string;
  continuity?: LongFormContinuitySettings;
};

export type OwnedLongFormProjectInput = LongFormProjectInput & {
  tenantId: string;
  createdByUserId: string;
};

export type LongFormShotUpdate = Partial<Pick<
  LongFormShot,
  "title" | "prompt" | "dialogue" | "cameraInstructions" | "motionInstructions" | "continuityNote" | "transition" | "durationSeconds" | "sceneNumber"
>>;
export type LongFormShotContinuityUpdate = LongFormShotUpdate & {
  continuity?: LongFormShotContinuity;
};

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

export function characterIdsForLongFormShot(
  projectCharacterIds: string[],
  shot: Pick<LongFormShot, "characterIds" | "continuity">,
): string[] {
  return shot.continuity?.characterIds?.length ? shot.continuity.characterIds : projectCharacterIds;
}

export type LongFormTimelineInput = {
  clips: LongFormTimelineClip[];
};

type StructuredBeat = {
  kind: "SHOT" | "B-ROLL";
  number: number;
  label: string;
  body: string;
  source: "ORIGINAL" | "NORMALIZED";
  durationSeconds?: number;
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

type ParsedHeader = {
  index: number;
  kind: StructuredBeat["kind"];
  number: number;
  label: string;
  source: StructuredBeat["source"];
  durationSeconds?: number;
};

const shotLikeHeaderPattern = /^\s*(?:#{1,6}\s*)?(?:SHOT|B[\s-]*ROLL)\b/i;
const originalShotHeaderPattern = /^\s*#{1,6}\s*(SHOT|B[\s-]*ROLL)\s+(\d+)\s*[·•]\s*[^·•]+\s*[·•]\s*(\d+(?:\.\d+)?)\s*s\s*$/i;
const normalizedShotHeaderPattern = /^\s*(?:#{1,6}\s*)?(SHOT|B[\s-]*ROLL)\s+(\d+)(?:\s*(?::|[—–-])\s*(.*))?\s*$/i;

function structuredKind(value: string): StructuredBeat["kind"] {
  return value.toUpperCase().replace(/[\s-]/g, "") === "BROLL" ? "B-ROLL" : "SHOT";
}

function parseStructuredBeats(script: string): StructuredBeat[] | null {
  const lines = script.replaceAll("\r\n", "\n").split("\n");
  const originalHeaders: ParsedHeader[] = [];
  const normalizedHeaders: ParsedHeader[] = [];
  for (const [index, line] of lines.entries()) {
    const original = line.match(originalShotHeaderPattern);
    if (original) {
      originalHeaders.push({
        index,
        kind: structuredKind(original[1]),
        number: Number(original[2]),
        label: line.replace(/^\s*#{1,6}\s*/, "").trim(),
        source: "ORIGINAL",
        durationSeconds: Number(original[3]),
      });
      continue;
    }
    const normalized = line.match(normalizedShotHeaderPattern);
    if (normalized) {
      normalizedHeaders.push({
        index,
        kind: structuredKind(normalized[1]),
        number: Number(normalized[2]),
        label: normalized[3]?.trim() ?? "",
        source: "NORMALIZED",
      });
    }
  }
  const headers = originalHeaders.length > 0 ? originalHeaders : normalizedHeaders;
  const hasMalformedShotHeader = lines.some((line) => shotLikeHeaderPattern.test(line)
    && !originalShotHeaderPattern.test(line)
    && !normalizedShotHeaderPattern.test(line));
  if (hasMalformedShotHeader) {
    throw new Error("The script contains a malformed SHOT/B-ROLL heading; use SHOT N: or ### Shot N · time · Ns.");
  }
  if (originalHeaders.length > 0 && normalizedHeaders.length > 0) {
    throw new Error("The script mixes original and normalized shot heading formats; use one format consistently.");
  }
  if (headers.length === 0) {
    if (/^\s*#{1,6}\s*style\s*prefix\b/im.test(script)) {
      throw new Error("The authored script contains a style prefix but no complete SHOT/B-ROLL blocks.");
    }
    return null;
  }
  const seenNumbers = new Set<string>();
  for (const header of headers) {
    const key = `${header.kind}:${header.number}`;
    if (seenNumbers.has(key)) {
      throw new Error(`The script repeats ${header.kind} ${header.number}; each authored shot must be unique.`);
    }
    seenNumbers.add(key);
  }

  const beats = headers.map((header, index) => {
    const followingBody = normalizeBlock(lines.slice(header.index + 1, headers[index + 1]?.index ?? lines.length).join("\n"));
    const body = followingBody || (header.source === "NORMALIZED" ? header.label : "");
    if (!body) {
      throw new Error(`${header.kind} ${header.number} is missing a body.`);
    }
    return {
      kind: header.kind,
      number: header.number,
      label: header.label,
      source: header.source,
      durationSeconds: header.durationSeconds,
      body,
    };
  });
  return beats;
}

const dialogueLabelPattern = /^\s*[^:\n]*\b(?:voice[-\s]?over|narration|dialogue|spoken\s+dialogue|says|speaks?)\b[^:\n]*:\s*(.*)$/iu;
const quotedLinePattern = /^\s*[“"]([^”"]+)[”"]\s*$/;
const promptLabelPattern = /^\s*(?:[*_`>#-]+\s*)?(?:visual\s+)?prompt\s*:\s*(.*)$/i;
const postProductionLabelPattern = /^\s*(?:[*_`>#-]+\s*)?(?:VO|voice[-\s]?over|narration|text(?:\s*\([^)]*\))?|music|audio|dialogue|spoken\s+dialogue|post[-\s]?production|transition|transitions|colour|color|notes?|running\s+time|deliverable|aspect)\s*(?:\([^)]*\))?\s*:/i;
const postProductionHeadingPattern = /^\s*#{1,6}\s*(?:post[-\s]?production|topic\s+coverage|notes?)\b/i;
const actHeadingPattern = /^\s*#{1,6}\s*ACT\b/i;

function isPostProductionLine(line: string): boolean {
  return postProductionLabelPattern.test(line)
    || postProductionHeadingPattern.test(line)
    || actHeadingPattern.test(line)
    || /^\s*[-*_]{3,}\s*$/.test(line)
    || /^\s*\|/.test(line);
}

function extractVisualPrompt(body: string): { prompt: string; hasPostProduction: boolean } {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const promptIndex = lines.findIndex((line) => promptLabelPattern.test(line));
  if (promptIndex >= 0) {
    const promptLine = (lines[promptIndex].match(promptLabelPattern)?.[1] ?? "")
      .replace(/^\s*[*_`]+\s*/, "");
    const promptLines = [promptLine];
    for (const line of lines.slice(promptIndex + 1)) {
      if (isPostProductionLine(line)) break;
      promptLines.push(line);
    }
    return {
      prompt: normalizeBlock(promptLines.join("\n")),
      hasPostProduction: lines.some((line) => postProductionLabelPattern.test(line)),
    };
  }

  const visualLines: string[] = [];
  let skipPostProductionValue = false;
  for (const line of lines) {
    if (isPostProductionLine(line)) {
      skipPostProductionValue = true;
      continue;
    }
    if (skipPostProductionValue) {
      if (!line.trim() || quotedLinePattern.test(line)) {
        if (!line.trim()) skipPostProductionValue = false;
        continue;
      }
      skipPostProductionValue = false;
    }
    visualLines.push(line);
  }
  return {
    prompt: normalizeBlock(visualLines.join("\n")),
    hasPostProduction: lines.some((line) => postProductionLabelPattern.test(line)),
  };
}

function extractStylePrefix(script: string): string | undefined {
  const lines = script.replaceAll("\r\n", "\n").split("\n");
  const headingIndex = lines.findIndex((line) => /^\s*#{1,6}\s*style\s*prefix\b/i.test(line));
  if (headingIndex < 0) return undefined;
  const prefixLines: string[] = [];
  let started = false;
  for (const line of lines.slice(headingIndex + 1)) {
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      started = true;
      prefixLines.push(quote[1]);
      continue;
    }
    if (started) break;
    if (line.trim()) break;
  }
  const prefix = normalizeBlock(prefixLines.join("\n"));
  return prefix || undefined;
}

function resolvePromptPrefix(prompt: string, stylePrefix: string | undefined, storyline: string | undefined): {
  prompt: string;
  usedStorylineAsPrefix: boolean;
} {
  if (!/\[prefix\]/i.test(prompt)) {
    return { prompt, usedStorylineAsPrefix: false };
  }
  const normalizedStoryline = normalizeBlock(storyline ?? "");
  const replacement = stylePrefix || (
    normalizedStoryline
    && !/\[prefix\]/i.test(normalizedStoryline)
    && !/^(?:none|n\/a)$/i.test(normalizedStoryline)
      ? normalizedStoryline
      : undefined
  );
  if (!replacement) {
    throw new Error("The authored prompt contains unresolved [prefix]; add a Style prefix block or a valid Visual Storyline.");
  }
  const resolved = prompt.replace(/\[prefix\]/gi, replacement).trim();
  if (/\[prefix\]/i.test(resolved)) {
    throw new Error("The authored prompt contains unresolved [prefix].");
  }
  return {
    prompt: resolved,
    usedStorylineAsPrefix: !stylePrefix,
  };
}

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
  for (const match of body.matchAll(/[“"]([^”"\n]+)[”"]/g)) {
    if (match[1]?.trim()) dialogue.push(match[1].trim());
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
  return normalizeBlock(
    visualLines
      .join("\n")
      .replace(/[“"]([^”"\n]+)[”"]/g, "")
      .replace(/\s+([,.;!?])/g, "$1"),
  );
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
  const stylePrefix = structuredBeats ? extractStylePrefix(input.script) : undefined;
  const storyline = normalizeBlock(input.storyline ?? "");
  const shotInputs = Array.from({ length: shotCount }, (_, index) => {
    const structuredBeat = structuredBeats?.[index];
    const shotBody = structuredBeat ? structuredBeat.body : chunks[index % chunks.length] as string;
    const extractedVisual = structuredBeat
      ? extractVisualPrompt(shotBody)
      : { prompt: shotBody, hasPostProduction: false };
    const dialogue = structuredBeat?.source !== "ORIGINAL"
      && !extractedVisual.hasPostProduction
      && (structuredBeat?.kind === "SHOT" || !structuredBeat)
      ? extractDialogue(shotBody)
      : "";
    const resolvedPrefix = resolvePromptPrefix(extractedVisual.prompt, stylePrefix, storyline);
    const visualPrompt = dialogue || extractedVisual.hasPostProduction
      ? removeDialogueFromPrompt(resolvedPrefix.prompt)
      : resolvedPrefix.prompt;
    if (!visualPrompt) {
      throw new Error(`${structuredBeat?.kind ?? "Script"} ${structuredBeat?.number ?? index + 1} is missing a visual prompt/body.`);
    }
    return {
      structuredBeat,
      dialogue,
      prompt: visualPrompt,
      usedStorylineAsPrefix: resolvedPrefix.usedStorylineAsPrefix,
    };
  });
  const authoredDurations = structuredBeats?.map(({ durationSeconds }) => durationSeconds);
  let durations: number[];
  if (authoredDurations?.some((duration) => duration !== undefined)) {
    if (authoredDurations.some((duration) => duration === undefined)) {
      throw new Error("Every authored SHOT/B-ROLL block must include a duration when one block specifies one.");
    }
    const exactDurations = authoredDurations as number[];
    exactDurations.forEach((duration, index) => {
      if (!Number.isFinite(duration) || duration < 2 || duration > MAX_SHOT_DURATION_SECONDS) {
        throw new Error(`Authored shot ${index + 1} duration must be between 2 and ${MAX_SHOT_DURATION_SECONDS} seconds.`);
      }
      const minimum = minimumShotDuration(shotInputs[index].dialogue);
      if (duration < minimum) {
        throw new Error(`Authored shot ${index + 1} duration is too short for its spoken dialogue.`);
      }
    });
    const authoredTotal = exactDurations.reduce((sum, duration) => sum + duration, 0);
    if (authoredTotal > 600) {
      throw new Error("Authored shot durations cannot exceed 10 minutes.");
    }
    if (Math.abs(authoredTotal - input.targetDurationSeconds) > 0.01) {
      throw new Error(`Authored shot durations total ${authoredTotal} seconds, but the project target is ${input.targetDurationSeconds} seconds.`);
    }
    durations = exactDurations;
  } else {
    durations = allocateShotDurations(
      shotInputs.map(({ dialogue }) => minimumShotDuration(dialogue)),
      input.targetDurationSeconds,
    );
  }
  const shots: PlannedShot[] = [];
  let sceneNumber = 1;
  let shotNumber = 1;

  for (let index = 0; index < shotCount; index += 1) {
    const { structuredBeat, dialogue, prompt, usedStorylineAsPrefix } = shotInputs[index];
    const previousPrompt = shots.at(-1)?.prompt;
    const label = structuredBeat?.source === "ORIGINAL"
      ? structuredBeat.label
      : structuredBeat
        ? `${structuredBeat.kind === "B-ROLL" ? "B-Roll" : "Shot"} ${structuredBeat.number}${structuredBeat.label ? ` · ${structuredBeat.label}` : ""}`
        : `Scene ${sceneNumber} · Shot ${shotNumber}`;
    const projectDirection = storyline && !usedStorylineAsPrefix
      ? `\n\nPROJECT VISUAL DIRECTION\n${storyline}`
      : "";
    shots.push({
      sceneNumber,
      shotNumber,
      title: label,
      prompt: `${prompt}${projectDirection}`,
      dialogue,
      cameraInstructions: structuredBeat
        ? ""
        : index % 3 === 0
          ? "Establishing cinematic composition, deliberate framing."
          : index % 3 === 1
            ? "Controlled medium shot with subtle tracking."
            : "Intimate detail shot with natural movement.",
      motionInstructions: structuredBeat ? "" : "Natural, physically believable movement with consistent character and environment details.",
      continuityNote: structuredBeat
        ? ""
        : previousPrompt
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

export function planLongFormShotsForTest(input: LongFormProjectInput): PlannedShot[] {
  return planShots(input);
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

function defaultTimeline(shots: LongFormShot[]): LongFormTimelineClip[] {
  return shots
    .filter((shot) => shot.status === "COMPLETED" && shot.outputStorageKey)
    .map((shot) => ({
      shotId: shot.id,
      trimStartSeconds: 0,
      trimEndSeconds: shot.durationSeconds,
    }));
}

function timelineForProject(project: LongFormProject, shots: LongFormShot[]): LongFormTimelineClip[] {
  return project.timelineClips?.length ? project.timelineClips : defaultTimeline(shots);
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
    continuity: shot.continuity ?? defaultShotContinuity(),
    still: stillForShot(shot),
  };
}

export async function presentShotForContinuity(shot: LongFormShot) {
  return presentShot(shot);
}

export async function presentLongFormProject(project: LongFormProject, includeShots = false) {
  const base = {
    id: project.id,
    title: project.title,
    script: project.script,
    storyline: project.storyline,
    status: project.status as "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "EDITING" | "ASSEMBLING" | "COMPLETED" | "FAILED" | "CANCELLED",
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
    timelineClips: project.timelineClips ?? [],
    finalOutputUrl: project.finalOutputStorageKey ? `/api/media/${project.finalOutputStorageKey}` : null,
    errorMessage: project.errorMessage,
    continuity: project.continuity ?? defaultContinuity(),
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

export async function createLongFormProject(input: OwnedLongFormProjectInput) {
  const characterIds = input.characterIds ?? [];
  const settingId = input.settingId ?? undefined;
  const [characters, setting] = await Promise.all([
    characterIds.length
      ? db.select({ id: charactersTable.id }).from(charactersTable).where(and(
        inArray(charactersTable.id, characterIds),
        eq(charactersTable.tenantId, input.tenantId),
      ))
      : Promise.resolve([]),
    settingId
      ? db.select({ id: settingsTable.id }).from(settingsTable).where(and(
        eq(settingsTable.id, settingId),
        eq(settingsTable.tenantId, input.tenantId),
      ))
      : Promise.resolve([]),
  ]);
  assertOwnedAssetSelections({
    characterIds,
    foundCharacterIds: characters.map((character) => character.id),
    settingId,
    settingFound: Boolean(setting[0]),
  });
  if (input.targetDurationSeconds > 600) throw new Error("Long-form projects are limited to 10 minutes.");
  const shots = planShots(input);
  const continuity = await validateContinuitySettings(
    input.tenantId,
    input.continuity ?? defaultContinuity(),
    characterIds,
  );
  const authoredSceneNumbers = new Set(shots.map((shot) => shot.sceneNumber));
  if (continuity.scenes.some((scene) => !authoredSceneNumbers.has(scene.sceneNumber))) {
    throw new Error("Continuity scenes may only target scene numbers authored by the project script");
  }
  // Project totals are stored as integer seconds, while individual shot durations
  // may remain fractional for accurate dialogue timing.
  const plannedDurationSeconds = Math.ceil(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0));
  const project = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(longFormProjectsTable)
      .values({
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId,
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
      characterIds,
      settingId: settingId ?? null,
      timelineClips: [],
       continuity,
      totalShots: shots.length,
      })
      .returning();
    await tx.insert(longFormShotsTable).values(
      shots.map((shot) => ({
        ...shot,
        projectId: created.id,
        characterIds,
        settingId: settingId ?? null,
        status: "PLANNED",
        continuity: defaultShotContinuity(),
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
      ...shots.map((shot) => shot.stillStorageKey),
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

async function findDispatchAvailability(project: LongFormProject, requiredReferenceSlots = 0): Promise<DispatchAvailability> {
  const [servers, workflows, activeJobs, activeImageJobs] = await Promise.all([
    db.select().from(comfyServersTable),
    db.select().from(workflowTemplatesTable).where(and(eq(workflowTemplatesTable.generationMode, project.generationMode), eq(workflowTemplatesTable.active, true))),
    db
      .select({ comfyServerId: generationJobsTable.comfyServerId })
      .from(generationJobsTable)
      .where(inArray(generationJobsTable.status, activeGenerationStatuses)),
    db
      .select({ comfyServerId: imageStudioJobsTable.comfyServerId })
      .from(imageStudioJobsTable)
      .where(inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"])),
  ]);
  const activeByServer = new Map<string, number>();
  for (const job of activeJobs) {
    if (job.comfyServerId) activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
  }
  for (const job of activeImageJobs) {
    if (job.comfyServerId) activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
  }
  const compatibleWorkflows = workflows.filter((workflow) => (
    isLongFormWorkflow(workflow) &&
    (!project.continuity?.enabled || (
      Boolean(workflow.mappings.referenceImage1) &&
      Object.keys(workflow.mappings).filter((field) => /^referenceImage\d+$/.test(field)).length >= requiredReferenceSlots
    ))
  ));
  if (compatibleWorkflows.length === 0) {
    return {
      server: null,
      reason: project.continuity?.enabled
        ? `Continuity is enabled, but no active ${project.generationMode} workflow accepts the approved still reference.`
        : `Waiting for an active ${project.generationMode} workflow that accepts character and environment references.`,
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

function conciseContinuityContext(project: LongFormProject, shot: LongFormShot): string | undefined {
  const continuity = project.continuity ?? defaultContinuity();
  if (!continuity.enabled) return undefined;
  const cast = characterIdsForLongFormShot(shot.characterIds, shot);
  const locks = continuity.characters
    .filter((character) => cast.includes(character.characterId))
    .map((character) => [
      character.appearance && `appearance: ${character.appearance}`,
      character.behavior && `behavior: ${character.behavior}`,
      character.voiceDescription && `voice delivery: ${character.voiceDescription}`,
    ].filter(Boolean).join("; "))
    .filter(Boolean)
    .join(" | ");
  const scene = continuity.scenes.find((candidate) => candidate.sceneNumber === shot.sceneNumber);
  const wardrobe = scene?.wardrobeAssignments
    .filter((assignment) => cast.includes(assignment.characterId))
    .map((assignment) => {
      const character = continuity.characters.find((candidate) => candidate.characterId === assignment.characterId);
      return character?.wardrobes.find((item) => item.id === assignment.wardrobeId)?.description;
    })
    .filter((value): value is string => Boolean(value))
    .join("; ");
  return [
    locks && `Character locks: ${locks.slice(0, 900)}`,
    scene?.settingNotes && `Scene setting: ${scene.settingNotes.slice(0, 400)}`,
    scene?.emotionNotes && `Scene emotion: ${scene.emotionNotes.slice(0, 300)}`,
    wardrobe && `Wardrobe: ${wardrobe.slice(0, 500)}`,
    shot.continuity?.emotionNotes && `Shot emotion: ${shot.continuity.emotionNotes.slice(0, 300)}`,
    shot.continuity?.performanceNotes && `Performance: ${shot.continuity.performanceNotes.slice(0, 400)}`,
  ].filter(Boolean).join("\n") || undefined;
}

async function wardrobeReferenceKeys(project: LongFormProject, shot: LongFormShot): Promise<string[]> {
  if (!project.continuity?.enabled) return [];
  const cast = characterIdsForLongFormShot(project.characterIds, shot);
  const scene = project.continuity.scenes.find((item) => item.sceneNumber === shot.sceneNumber);
  if (!scene) return [];
  const assetIds = cast.flatMap((characterId) => {
    const assignment = scene.wardrobeAssignments.find((item) => item.characterId === characterId);
    const character = project.continuity!.characters.find((item) => item.characterId === characterId);
    const wardrobe = character?.wardrobes.find((item) => item.id === assignment?.wardrobeId);
    return wardrobe?.referenceAssetId ? [wardrobe.referenceAssetId] : [];
  });
  if (!assetIds.length) return [];
  const assets = await db.select({ id: imageStudioAssetsTable.id, storageKey: imageStudioAssetsTable.storageKey })
    .from(imageStudioAssetsTable)
    .where(and(eq(imageStudioAssetsTable.tenantId, project.tenantId), inArray(imageStudioAssetsTable.id, assetIds)));
  const byId = new Map(assets.map((asset) => [asset.id, asset.storageKey]));
  if (assetIds.some((assetId) => !byId.has(assetId))) {
    throw new Error("A continuity wardrobe reference asset is unavailable; update the wardrobe before dispatching.");
  }
  return assetIds.map((assetId) => byId.get(assetId)!);
}

async function reconcileShotJobs(project: LongFormProject, shots: LongFormShot[]) {
  const generationIds = shots.flatMap((shot) => shot.generationJobId ? [shot.generationJobId] : []);
  const correlatedJobs = await db
    .select()
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.longFormShotId, shots.map((shot) => shot.id)))
    .orderBy(desc(generationJobsTable.createdAt));
  for (const shot of shots) {
    if (shot.generationJobId) continue;
    // Retried shots may have historical failed jobs. Only a newest active job
    // may be recovered into a planned shot; never resurrect an old attempt.
    const correlatedJob = correlatedJobs.find((job) => (
      job.longFormShotId === shot.id && activeGenerationStatuses.includes(job.status)
    ));
    if (correlatedJob) {
      await db.update(longFormShotsTable)
        .set({ generationJobId: correlatedJob.id })
        .where(and(
          eq(longFormShotsTable.id, shot.id),
          eq(longFormShotsTable.status, "QUEUED"),
          sql`${longFormShotsTable.generationJobId} IS NULL`,
        ));
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

async function runMediaTool(
  command: "ffmpeg" | "ffprobe" | "zip",
  args: string[],
  options: { cwd?: string } = {},
) {
  await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024, ...options });
}

async function validateShotMedia(shot: LongFormShot): Promise<{
  durationSeconds: number;
  hasAudio: boolean;
  width: number;
  height: number;
}> {
  if (!shot.outputStorageKey) throw new Error(`Shot ${shot.title} has no output file`);
  const result = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    mediaStorage.resolvePath(shot.outputStorageKey),
  ]);
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Shot ${shot.title} is not a playable video`);
  }
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Shot ${shot.title} does not expose playable video dimensions`);
  }
  return {
    durationSeconds,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
    width,
    height,
  };
}

type LongFormAssemblyProject = Pick<LongFormProject, "generationMode" | "width" | "height" | "fps">;
type LongFormAssemblyMediaInfo = Awaited<ReturnType<typeof validateShotMedia>>;

function isH3Assembly(project: LongFormAssemblyProject): boolean {
  return project.generationMode.toLowerCase().includes("h3");
}

function assemblyVideoFilter(
  project: LongFormAssemblyProject,
  mediaInfo: LongFormAssemblyMediaInfo,
  padFrames: number,
): string {
  const filters = isH3Assembly(project)
    && mediaInfo.width >= project.width
    && mediaInfo.height >= project.height
    ? [
      `crop=${project.width}:${project.height}:(iw-${project.width})/2:(ih-${project.height})/2`,
      "setsar=1",
    ]
    : [
      `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`,
      `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2`,
    ];
  filters.push(`fps=${project.fps}`);
  if (padFrames > 0) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${(padFrames / project.fps).toFixed(6)}`);
  }
  return filters.join(",");
}

export type LongFormAssemblyFfmpegOptions = {
  sourcePath: string;
  destinationPath: string;
  project: LongFormAssemblyProject;
  mediaInfo: LongFormAssemblyMediaInfo;
  clip: Pick<LongFormTimelineClip, "trimStartSeconds" | "trimEndSeconds">;
};

export function buildLongFormAssemblyFfmpegArgs(options: LongFormAssemblyFfmpegOptions): string[] {
  const { project, mediaInfo, clip } = options;
  const trimStart = Math.max(0, clip.trimStartSeconds);
  const requestedTrimEnd = clip.trimEndSeconds;
  if (
    !Number.isFinite(trimStart)
    || !Number.isFinite(requestedTrimEnd)
    || requestedTrimEnd <= trimStart
  ) {
    throw new Error("The timeline trim points are invalid.");
  }
  const targetFrames = Math.max(1, Math.round((requestedTrimEnd - trimStart) * project.fps));
  const availableFrames = Math.max(0, Math.floor((mediaInfo.durationSeconds - trimStart) * project.fps + 1e-6));
  const missingFrames = targetFrames - availableFrames;
  // A one-frame shortfall can come from ffprobe's duration rounding. Clone only
  // that final frame; silently padding a materially short render hides a bad
  // source clip and must fail closed.
  if (missingFrames > 1) {
    throw new Error("The source clip is shorter than its timeline trim.");
  }
  if (availableFrames === 0) {
    throw new Error("The source clip has no frames at the requested trim start.");
  }
  const padFrames = Math.max(0, missingFrames);
  const durationSeconds = targetFrames / project.fps;
  const ffmpegArgs = [
    "-y",
    "-i", options.sourcePath,
  ];
  if (!mediaInfo.hasAudio) {
    ffmpegArgs.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  ffmpegArgs.push(
    "-ss", String(trimStart),
    "-map", "0:v:0",
    "-map", mediaInfo.hasAudio ? "0:a:0" : "1:a:0",
    "-vf", assemblyVideoFilter(project, mediaInfo, padFrames),
    "-frames:v", String(targetFrames),
    "-t", String(durationSeconds),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "192k",
    "-af", "apad",
    "-movflags", "+faststart",
    options.destinationPath,
  );
  return ffmpegArgs;
}

async function assembleProject(project: LongFormProject, shots: LongFormShot[]): Promise<void> {
  await db.update(longFormProjectsTable).set({ status: "ASSEMBLING", errorMessage: null }).where(eq(longFormProjectsTable.id, project.id));
  const workDir = path.join(tmpdir(), `obtv-assembly-${project.id}`);
  try {
    await mkdir(workDir, { recursive: true });
    const shotById = new Map(shots.map((shot) => [shot.id, shot]));
    const timeline = timelineForProject(project, shots);
    if (timeline.length === 0) throw new Error("Add at least one completed clip to the timeline before rendering.");
    const normalizedPaths: string[] = [];
    for (const [index, clip] of timeline.entries()) {
      const shot = shotById.get(clip.shotId);
      if (!shot || shot.status !== "COMPLETED" || !shot.outputStorageKey) {
        throw new Error("The timeline contains a clip that is no longer available.");
      }
      const mediaInfo = await validateShotMedia(shot);
      const trimStart = Math.max(0, clip.trimStartSeconds);
      const trimEnd = Math.min(mediaInfo.durationSeconds, clip.trimEndSeconds);
      if (trimEnd <= trimStart) {
        throw new Error(`The trim for ${shot.title} is empty.`);
      }
      const normalizedPath = path.join(workDir, `shot-${String(index).padStart(3, "0")}.mp4`);
      const ffmpegArgs = buildLongFormAssemblyFfmpegArgs({
        sourcePath: mediaStorage.resolvePath(shot.outputStorageKey),
        destinationPath: normalizedPath,
        project,
        mediaInfo,
        clip: { trimStartSeconds: trimStart, trimEndSeconds: clip.trimEndSeconds },
      });
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
    const storageKey = await mediaStorage.storeOutput(`${project.title}.mp4`, "video/mp4", await readFile(finalPath), project.tenantId);
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

function safeExportName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "obtv-project";
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function timecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps));
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, secs, frames].map((value) => String(value).padStart(2, "0")).join(":");
}

export async function createLongFormNlePackage(projectId: string): Promise<{
  filePath: string;
  filename: string;
}> {
  const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
  if (!project) throw new Error("Long-form project not found");
  const shots = await db
    .select()
    .from(longFormShotsTable)
    .where(eq(longFormShotsTable.projectId, projectId))
    .orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
  if (shots.length === 0 || shots.some((shot) => shot.status !== "COMPLETED" || !shot.outputStorageKey)) {
    throw new Error("All clips must be completed before exporting the NLE package.");
  }

  const shotById = new Map(shots.map((shot) => [shot.id, shot]));
  const timeline = timelineForProject(project, shots);
  if (timeline.length === 0) throw new Error("Add at least one completed clip to the timeline before exporting.");

  const workDir = path.join(tmpdir(), `obtv-nle-${project.id}`);
  const mediaDir = path.join(workDir, "media");
  await mkdir(mediaDir, { recursive: true });
  const sourceFilenameByShotId = new Map<string, string>();
  const sourceClips: Array<Record<string, unknown>> = [];
  const manifestClips: Array<Record<string, unknown>> = [];
  const csvRows = [
    ["sequence", "shot_id", "filename", "source_in", "source_out", "duration_seconds", "timeline_in", "timeline_out", "transition"].join(","),
  ];
  const edlRows = [`TITLE: ${project.title}`, "FCM: NON-DROP FRAME", ""];
  let timelineCursor = 0;

  try {
    for (const shot of shots) {
      const filename = `scene-${String(shot.sceneNumber).padStart(3, "0")}_shot-${String(shot.shotNumber).padStart(3, "0")}_${safeExportName(shot.title)}.mp4`;
      sourceFilenameByShotId.set(shot.id, filename);
      await copyFile(mediaStorage.resolvePath(shot.outputStorageKey!), path.join(mediaDir, filename));
      sourceClips.push({
        shotId: shot.id,
        sceneNumber: shot.sceneNumber,
        shotNumber: shot.shotNumber,
        title: shot.title,
        filename: `media/${filename}`,
      });
    }

    for (const [index, clip] of timeline.entries()) {
      const shot = shotById.get(clip.shotId);
      if (!shot || !shot.outputStorageKey) throw new Error("The timeline contains a clip that is no longer available.");
      const mediaInfo = await validateShotMedia(shot);
      const trimStart = Math.max(0, clip.trimStartSeconds);
      const trimEnd = Math.min(mediaInfo.durationSeconds, clip.trimEndSeconds);
      if (trimEnd <= trimStart) throw new Error(`The trim for ${shot.title} is empty.`);

      const filename = sourceFilenameByShotId.get(shot.id);
      if (!filename) throw new Error("The timeline contains a clip that is no longer available.");
      const relativeFilename = `media/${filename}`;
      const duration = trimEnd - trimStart;
      csvRows.push([
        index + 1,
        csvCell(shot.id),
        csvCell(relativeFilename),
        trimStart.toFixed(3),
        trimEnd.toFixed(3),
        duration.toFixed(3),
        timelineCursor.toFixed(3),
        (timelineCursor + duration).toFixed(3),
        csvCell(shot.transition),
      ].join(","));
      edlRows.push(
        `${String(index + 1).padStart(3, "0")}  AX       V     C        ${timecode(trimStart, project.fps)} ${timecode(trimEnd, project.fps)} ${timecode(timelineCursor, project.fps)} ${timecode(timelineCursor + duration, project.fps)}`,
        `* FROM CLIP NAME: ${filename}`,
        `* SOURCE FILE: ${relativeFilename}`,
        "",
      );
      manifestClips.push({
        sequence: index + 1,
        shotId: shot.id,
        title: shot.title,
        filename: relativeFilename,
        sourceInSeconds: trimStart,
        sourceOutSeconds: trimEnd,
        durationSeconds: duration,
        timelineInSeconds: timelineCursor,
        timelineOutSeconds: timelineCursor + duration,
        transition: shot.transition,
      });
      timelineCursor += duration;
    }

    await writeFile(path.join(workDir, "OBTV-sequence.csv"), `${csvRows.join("\n")}\n`);
    await writeFile(path.join(workDir, "OBTV-sequence.edl"), `${edlRows.join("\n")}\n`);
    await writeFile(path.join(workDir, "OBTV-sequence.json"), JSON.stringify({
      format: "OBTV NLE sequence",
      version: 1,
      project: {
        id: project.id,
        title: project.title,
        width: project.width,
        height: project.height,
        fps: project.fps,
      },
      sourceClips,
      timeline: manifestClips,
    }, null, 2));
    await writeFile(path.join(workDir, "README.txt"), [
      "OBTV AI Video Studio NLE package",
      "",
      "Import every file in media/ into your editor. This folder contains every original generated source clip, including clips omitted from the saved cut.",
      "OBTV-sequence.edl contains the ordered video edit with source in/out points.",
      "OBTV-sequence.csv is a human-readable edit decision list and OBTV-sequence.json contains the full project metadata.",
      "The media files are untouched source renders; the trim decisions are non-destructive.",
      "",
      `Project: ${project.title}`,
      `Sequence duration: ${timelineCursor.toFixed(3)} seconds`,
      `Frame rate: ${project.fps} fps`,
    ].join("\n"));

    const zipPath = path.join(tmpdir(), `${safeExportName(project.title)}-nle-package-${project.id}.zip`);
    await rm(zipPath, { force: true });
    await runMediaTool("zip", ["-q", "-r", zipPath, "."], { cwd: workDir });
    return { filePath: zipPath, filename: `${safeExportName(project.title)}-nle-package.zip` };
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

async function openProjectEditor(project: LongFormProject, shots: LongFormShot[]): Promise<void> {
  await db
    .update(longFormProjectsTable)
    .set({
      status: "EDITING",
      progress: 100,
      completedShots: shots.length,
      failedShots: 0,
      timelineClips: project.timelineClips.length ? project.timelineClips : defaultTimeline(shots),
      errorMessage: null,
    })
    .where(eq(longFormProjectsTable.id, project.id));
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
      await openProjectEditor(project, shots);
    }
    return;
  }
  if (project.continuity?.enabled) {
    const missingStill = missingApprovedContinuityShot(true, remaining);
    if (missingStill) {
      await recordDispatchBlock(
        project,
        `Continuity is enabled: approve the current still for Scene ${missingStill.sceneNumber}, Shot ${missingStill.shotNumber} before dispatching it.`,
      );
      return;
    }
  }

  let nextShot = remaining[0];
  let nextWardrobeReferences = nextShot ? await wardrobeReferenceKeys(project, nextShot) : [];
  let availability = await findDispatchAvailability(
    project,
    project.continuity?.enabled ? 1 + nextWardrobeReferences.length : 0,
  );
  let server = availability.server;
  if (!server) {
    await recordDispatchBlock(project, availability.reason ?? "Waiting for a compatible GPU worker.");
    return;
  }
  while (server && nextShot) {
    const dispatched = await (async () => {
      const [currentProject] = await db.select({ status: longFormProjectsTable.status }).from(longFormProjectsTable).where(eq(longFormProjectsTable.id, project.id));
      if (currentProject?.status !== "RUNNING") return false;
      const confirmedAvailability = await findDispatchAvailability(
        project,
        project.continuity?.enabled ? 1 + nextWardrobeReferences.length : 0,
      );
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
        const wardrobeReferences = await wardrobeReferenceKeys(project, claimed);
        const job = await createAndSubmitGeneration({
          tenantId: project.tenantId,
          createdByUserId: project.createdByUserId,
          characterIds: characterIdsForLongFormShot(project.characterIds, claimed),
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
           speakerCharacterId: claimed.continuity?.speakerCharacterId,
           voiceCloningEnabled: claimed.continuity?.voiceCloningEnabled === true,
            referenceImageKeys: project.continuity?.enabled && claimed.stillStorageKey
              ? [claimed.stillStorageKey, ...wardrobeReferences]
              : [],
            mandatoryReferenceImageCount: project.continuity?.enabled && claimed.stillStorageKey
              ? 1 + wardrobeReferences.length
              : 0,
           continuityContext: conciseContinuityContext(project, claimed),
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
    nextShot = (await db.select().from(longFormShotsTable).where(and(eq(longFormShotsTable.projectId, project.id), eq(longFormShotsTable.status, "PLANNED"))).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber)))[0];
    nextWardrobeReferences = nextShot ? await wardrobeReferenceKeys(project, nextShot) : [];
    availability = await findDispatchAvailability(
      project,
      project.continuity?.enabled ? 1 + nextWardrobeReferences.length : 0,
    );
    server = availability.server;
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
  const project = await withProjectLock(projectId, async () => {
    const [current] = await db.select({
      status: longFormProjectsTable.status,
      continuity: longFormProjectsTable.continuity,
      generationMode: longFormProjectsTable.generationMode,
    }).from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    if (current?.continuity?.enabled) {
      const requiredReferenceSlots = 1 + Math.max(
        0,
        ...current.continuity.scenes.map((scene) => scene.wardrobeAssignments.filter((assignment) => {
          const character = current.continuity!.characters.find((item) => item.characterId === assignment.characterId);
          return Boolean(character?.wardrobes.find((wardrobe) => wardrobe.id === assignment.wardrobeId)?.referenceAssetId);
        }).length),
      );
      const workflows = await db.select({
        apiWorkflow: workflowTemplatesTable.apiWorkflow,
        mappings: workflowTemplatesTable.mappings,
      }).from(workflowTemplatesTable).where(and(
        eq(workflowTemplatesTable.generationMode, current.generationMode),
        eq(workflowTemplatesTable.active, true),
      ));
      if (!workflows.some((workflow) =>
        isLongFormWorkflow(workflow) &&
        Boolean(workflow.mappings.referenceImage1) &&
        Object.keys(workflow.mappings).filter((field) => /^referenceImage\d+$/.test(field)).length >= requiredReferenceSlots,
      )) {
        throw new Error("Continuity is enabled, but no active compatible workflow has enough reference slots for the approved still and assigned wardrobes.");
      }
      const [missingStill] = await db.select({
        sceneNumber: longFormShotsTable.sceneNumber,
        shotNumber: longFormShotsTable.shotNumber,
      }).from(longFormShotsTable).where(and(
        eq(longFormShotsTable.projectId, projectId),
        eq(longFormShotsTable.status, "PLANNED"),
        // SQL's three-valued null comparison is not relevant: still status is
        // non-null and old projects receive the migration default.
        sql`${longFormShotsTable.stillStatus} <> 'APPROVED' OR ${longFormShotsTable.stillStorageKey} IS NULL`,
      )).orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber)).limit(1);
      if (missingStill) {
        throw new Error(
          `Continuity is enabled: approve the current still for Scene ${missingStill.sceneNumber}, Shot ${missingStill.shotNumber} before starting production.`,
        );
      }
    }
    const [updated] = await db.update(longFormProjectsTable)
      .set({ status: "RUNNING", startedAt: new Date(), errorMessage: null })
      .where(and(eq(longFormProjectsTable.id, projectId), inArray(longFormProjectsTable.status, ["READY", "PAUSED", "FAILED"])))
      .returning();
    return updated;
  });
  if (project === null) throw new Error("Project is currently being updated; try again.");
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
    if (!["EDITING", "COMPLETED", "FAILED"].includes(current.status)) {
      throw new Error("Only projects with completed clips can render a final video");
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

export async function updateLongFormTimeline(projectId: string, input: LongFormTimelineInput) {
  const result = await withProjectLock(projectId, async () => {
    const [project] = await db
      .select()
      .from(longFormProjectsTable)
      .where(eq(longFormProjectsTable.id, projectId));
    if (!project) throw new ResourceNotFoundError("Long-form project not found");
    if (!["EDITING", "COMPLETED", "FAILED"].includes(project.status)) {
      throw new Error("The timeline can only be changed after all clips are generated.");
    }

    const shots = await db
      .select()
      .from(longFormShotsTable)
      .where(eq(longFormShotsTable.projectId, projectId))
      .orderBy(asc(longFormShotsTable.sceneNumber), asc(longFormShotsTable.shotNumber));
    if (shots.length === 0 || shots.some((shot) => shot.status !== "COMPLETED" || !shot.outputStorageKey)) {
      throw new Error("All clips must be completed before editing the timeline.");
    }

    const shotById = new Map(shots.map((shot) => [shot.id, shot]));
    const seen = new Set<string>();
    const clips: LongFormTimelineClip[] = [];
    for (const clip of input.clips) {
      const shot = shotById.get(clip.shotId);
      if (!shot) throw new ResourceNotFoundError("The timeline contains an unknown clip.");
      if (!shot.outputStorageKey) throw new Error("The timeline contains a clip without completed output.");
      if (seen.has(clip.shotId)) throw new Error("Each source clip can appear only once in the timeline.");
      seen.add(clip.shotId);
      const mediaInfo = await validateShotMedia(shot);
      const trimStartSeconds = Number(clip.trimStartSeconds.toFixed(3));
      const trimEndSeconds = Number(Math.min(clip.trimEndSeconds, mediaInfo.durationSeconds).toFixed(3));
      if (trimStartSeconds < 0 || trimEndSeconds <= trimStartSeconds) {
        throw new Error(`The trim points for ${shot.title} are outside the source clip.`);
      }
      clips.push({ shotId: shot.id, trimStartSeconds, trimEndSeconds });
    }

    const [updated] = await db
      .update(longFormProjectsTable)
      .set({
        status: "EDITING",
        timelineClips: clips,
        finalOutputStorageKey: null,
        finalOutputMimeType: null,
        completedAt: null,
        errorMessage: null,
      })
      .where(eq(longFormProjectsTable.id, projectId))
      .returning();
    return { updated, previousFinalOutputKey: project.finalOutputStorageKey };
  });
  if (!result) throw new Error("Project is currently being updated; try again.");
  if (result.previousFinalOutputKey) {
    await mediaStorage.deleteOutput(result.previousFinalOutputKey).catch((error) => {
      logger.warn({ err: error, projectId }, "Could not remove superseded long-form output");
    });
  }
  return presentLongFormProject(result.updated, true);
}

export async function pauseLongFormProject(projectId: string) {
  const project = await withProjectLock(projectId, async () => {
    const [updated] = await db.update(longFormProjectsTable)
      .set({ status: "PAUSED" })
      .where(and(eq(longFormProjectsTable.id, projectId), eq(longFormProjectsTable.status, "RUNNING")))
      .returning();
    return updated;
  });
  if (project === null) throw new Error("Project is currently being updated; try again.");
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

export async function updateLongFormShot(projectId: string, shotId: string, input: LongFormShotContinuityUpdate) {
  const result = await withProjectLock(projectId, async () => {
    const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    if (!project) throw new Error("Long-form project not found");
    if (!["READY", "PAUSED", "FAILED", "EDITING", "COMPLETED", "RUNNING"].includes(project.status)) {
      throw new Error("A shot cannot be edited while the final video is being assembled");
    }

    const [existingShot] = await db
      .select()
      .from(longFormShotsTable)
      .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId)));
    if (!existingShot) throw new Error("Long-form shot not found");
    if (activeShotStatuses.includes(existingShot.status)) {
      throw new Error("This shot is currently rendering and cannot be edited");
    }
    const continuity = input.continuity
      ? await validateShotContinuity(project.tenantId, project.characterIds, input.continuity)
      : undefined;
    const update = { ...input, ...(continuity ? { continuity } : {}) };
    delete (update as { continuity?: LongFormShotContinuity }).continuity;
    if (input.sceneNumber !== undefined && (!Number.isInteger(input.sceneNumber) || input.sceneNumber < 1)) {
      throw new Error("Scene number must be a positive whole number");
    }
    if (Object.keys(input).length > 0) await invalidateShotStill(existingShot.id);

    if (input.sceneNumber && input.sceneNumber !== existingShot.sceneNumber) {
      const [lastInScene] = await db.select({ shotNumber: longFormShotsTable.shotNumber })
        .from(longFormShotsTable)
        .where(and(eq(longFormShotsTable.projectId, projectId), eq(longFormShotsTable.sceneNumber, input.sceneNumber)))
        .orderBy(desc(longFormShotsTable.shotNumber)).limit(1);
      (update as Partial<LongFormShot>).shotNumber = (lastInScene?.shotNumber ?? 0) + 1;
    }
    const regenerate = existingShot.status === "COMPLETED";
    const [shot] = await db.update(longFormShotsTable)
      .set(regenerate
        ? {
            ...update,
            ...(continuity ? { continuity } : {}),
            status: "PLANNED",
            generationJobId: null,
            assignedServerId: null,
            outputStorageKey: null,
            outputMimeType: null,
            errorMessage: null,
            completedAt: null,
            retryCount: existingShot.retryCount + 1,
          }
        : { ...update, ...(continuity ? { continuity } : {}) })
      .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId)))
      .returning();

    if (regenerate) {
      await db.update(longFormProjectsTable)
        .set({
          status: "RUNNING",
          completedShots: Math.max(0, project.completedShots - 1),
          progress: Math.min(99, project.progress),
          finalOutputStorageKey: null,
          finalOutputMimeType: null,
          completedAt: null,
          errorMessage: null,
        })
        .where(eq(longFormProjectsTable.id, projectId));
    }
    return {
      shot,
      regenerate,
      previousFinalOutputKey: regenerate ? project.finalOutputStorageKey : null,
    };
  });
  if (!result) throw new Error("Project is currently being updated; try again.");
  if (result.previousFinalOutputKey) {
    await mediaStorage.deleteOutput(result.previousFinalOutputKey).catch((error) => {
      logger.warn({ err: error, projectId }, "Could not remove stale long-form final output");
    });
  }
  if (result.regenerate) scheduleLongFormOrchestration(projectId, "edit-completed-shot");
  return presentShot(result.shot);
}

export async function updateLongFormContinuity(
  projectId: string,
  input: LongFormContinuitySettings,
) {
  const result = await withProjectLock(projectId, async () => {
    const [project] = await db.select().from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    if (!project) throw new ResourceNotFoundError("Long-form project not found");
    if (["RUNNING", "ASSEMBLING", "COMPLETED"].includes(project.status)) {
      throw new Error("Pause production before changing continuity; completed projects must retry a shot first.");
    }
    const active = await activeShotsForProject(projectId);
    if (active.length) {
      throw new Error("Pause until active shots finish before changing continuity locks");
    }
    const projectShots = await db.select({ sceneNumber: longFormShotsTable.sceneNumber })
      .from(longFormShotsTable).where(eq(longFormShotsTable.projectId, projectId));
    const projectSceneNumbers = new Set(projectShots.map((shot) => shot.sceneNumber));
    if (input.scenes.some((scene) => !projectSceneNumbers.has(scene.sceneNumber))) {
      throw new Error("Continuity scenes may only target existing project shot scene numbers");
    }
    const continuity = await validateContinuitySettings(project.tenantId, input, project.characterIds);
    const [updated] = await db.update(longFormProjectsTable).set({ continuity, errorMessage: null })
      .where(eq(longFormProjectsTable.id, projectId)).returning();
    const shots = await db.select({ id: longFormShotsTable.id }).from(longFormShotsTable)
      .where(eq(longFormShotsTable.projectId, projectId));
    await Promise.all(shots.map((shot) => invalidateShotStill(shot.id)));
    return updated;
  });
  if (!result) throw new Error("Project is currently being updated; try again.");
  return presentLongFormProject(result, true);
}

export async function retryLongFormShot(projectId: string, shotId: string) {
  const result = await withProjectLock(projectId, async () => {
    const [project] = await db.select({
      continuity: longFormProjectsTable.continuity,
      status: longFormProjectsTable.status,
    }).from(longFormProjectsTable).where(eq(longFormProjectsTable.id, projectId));
    if (!project) throw new ResourceNotFoundError("Long-form project not found");
    const [existingShot] = await db
      .select({
        retryCount: longFormShotsTable.retryCount,
        status: longFormShotsTable.status,
        stillRevision: longFormShotsTable.stillRevision,
        stillStorageKey: longFormShotsTable.stillStorageKey,
        outputStorageKey: longFormShotsTable.outputStorageKey,
      })
      .from(longFormShotsTable)
      .where(and(eq(longFormShotsTable.id, shotId), eq(longFormShotsTable.projectId, projectId)));
    if (!existingShot) throw new Error("Long-form shot not found");
    const preparingCompletedRevision = existingShot.status === "COMPLETED" && project.continuity?.enabled;
    if (preparingCompletedRevision && (["RUNNING", "ASSEMBLING"].includes(project.status) || (await activeShotsForProject(projectId)).length > 0)) {
      throw new Error("Pause production and wait for active renders to finish before preparing a completed-shot revision.");
    }
    if (!preparingCompletedRevision && !["FAILED", "CANCELLED"].includes(existingShot.status)) {
      throw new Error("Only failed or cancelled shots can be retried. With continuity enabled, use Prepare revision for a completed shot.");
    }
    const [updated] = await db.update(longFormShotsTable).set({
      status: "PLANNED",
      generationJobId: null,
      assignedServerId: null,
      outputStorageKey: null,
      outputMimeType: null,
      errorMessage: null,
      retryCount: existingShot.retryCount + 1,
      ...(preparingCompletedRevision
        ? invalidatedStillValues(existingShot.stillStorageKey, existingShot.stillRevision)
        : {}),
    }).where(and(
      eq(longFormShotsTable.id, shotId),
      eq(longFormShotsTable.projectId, projectId),
      eq(longFormShotsTable.status, existingShot.status),
    )).returning();
    if (!updated) throw new Error("The shot changed before the retry could be prepared");
    await db.update(longFormProjectsTable).set({
      status: preparingCompletedRevision ? "PAUSED" : "RUNNING",
      errorMessage: null,
    })
      .where(eq(longFormProjectsTable.id, projectId));
    return {
      shot: updated,
      outputStorageKey: preparingCompletedRevision ? existingShot.outputStorageKey : null,
      shouldSchedule: !preparingCompletedRevision,
    };
  });
  if (result === null) throw new Error("Project is currently being updated; try again.");
  if (result.outputStorageKey) await mediaStorage.deleteOutput(result.outputStorageKey);
  if (result.shouldSchedule) scheduleLongFormOrchestration(projectId, "retry-shot");
  return presentShot(result.shot);
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