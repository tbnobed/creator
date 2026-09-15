import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  comfyServersTable,
  db,
  generationCharactersTable,
  generationJobsTable,
  generationSettingsTable,
  imageStudioJobsTable,
  settingAssetsTable,
  settingsTable,
  tenantsTable,
  workflowTemplatesTable,
  pool,
  type GenerationJob,
} from "@workspace/db";
import { logger } from "./logger";
import { ComfyUIClient, isTransientComfyUIRequestError } from "./comfy/client";
import { hasRequiredTags } from "./comfy/scheduler";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import { getWorkflowReferenceRequirements } from "./comfy/workflow-references";
import { mediaStorage } from "./storage-service";
import { normalizeLtx25OutputDimension } from "./seed-data/ltx-25";
import { generateClonedSpeech, muxClonedSpeech } from "./voice-cloning-service";
import { assertOwnedAssetSelections, ResourceNotFoundError } from "./resource-errors";
import {
  falModels,
  FalHttpError,
  FalQueueClient,
  getFalVideoUrl,
  normalizeFalRequest,
  validateFalQueueUrl,
  type FalModel,
  type FalQueueEndpoints,
} from "./fal/client";
import { quoteVideoSpend } from "./spending-pricing";
import { reserveSpend, settleSpend } from "./spending-service";

const activeGenerationStatuses = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const generationTimeoutMessage = "Timed out while waiting for ComfyUI";
const generationTimeoutMs = 6 * 60 * 60 * 1000;
const maxConsecutiveMonitorErrors = 3;
const FAL_SPEND_LIFECYCLE_VERSION = 1;
const MINIMAX_H3_FPS = 24;
const MINIMAX_H3_DIMENSION_MULTIPLE = 32;
const MINIMAX_H3_MIN_FRAMES = 5;
const MINIMAX_H3_FRAME_STEP = 17;
// Keep this in lockstep with the ComfyMathExpression in the seeded H3 graph.
// The expression is the model's input-length contract; it is not a generic
// video frame rounding rule.
const MINIMAX_H3_LENGTH_EXPRESSION =
  "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17";

type MiniMaxH3SubmissionGeometry = {
  width: number;
  height: number;
  frameCount: number;
  requestedDurationSeconds: number;
  effectiveDurationSeconds: number;
};

function ceilToMultiple(value: number, multiple: number): number {
  return Math.ceil(value / multiple) * multiple;
}

/**
 * Return the dimensions and frame grid accepted by the seeded MiniMax H3
 * workflow. H3 emits the effective dimensions; the long-form project keeps
 * its authored target dimensions for final assembly.
 */
export function normalizeMiniMaxH3SubmissionGeometry(input: {
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
}): MiniMaxH3SubmissionGeometry {
  if (
    !Number.isFinite(input.width)
    || !Number.isFinite(input.height)
    || input.width <= 0
    || input.height <= 0
  ) {
    throw new Error("MiniMax H3 requires positive output dimensions");
  }
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error("MiniMax H3 requires a positive duration");
  }
  // The seeded node 131 expression is hard-coded to 24fps. Rejecting other
  // rates avoids submitting a graph whose model length would be shorter than
  // the requested duration.
  if (input.fps !== MINIMAX_H3_FPS) {
    throw new Error("MiniMax H3 long-form renders require 24 fps");
  }

  const requestedFrames = Math.max(
    MINIMAX_H3_MIN_FRAMES,
    Math.round(input.durationSeconds * MINIMAX_H3_FPS),
  );
  // This mirrors node 131 exactly: valid lengths are 5 + 17n, with the
  // smallest valid length at or above the requested 24fps frame count.
  const frameCount = requestedFrames
    + (
      MINIMAX_H3_MIN_FRAMES
      - (requestedFrames % MINIMAX_H3_FRAME_STEP)
      + MINIMAX_H3_FRAME_STEP
    ) % MINIMAX_H3_FRAME_STEP;

  return {
    width: ceilToMultiple(input.width, MINIMAX_H3_DIMENSION_MULTIPLE),
    height: ceilToMultiple(input.height, MINIMAX_H3_DIMENSION_MULTIPLE),
    frameCount,
    requestedDurationSeconds: input.durationSeconds,
    effectiveDurationSeconds: frameCount / MINIMAX_H3_FPS,
  };
}

type WorkflowNodeForGeometry = {
  class_type?: unknown;
  inputs?: Record<string, unknown>;
};

function workflowNodeForGeometry(
  workflow: Record<string, unknown>,
  nodeId: string | undefined,
): WorkflowNodeForGeometry | null {
  if (!nodeId) return null;
  const node = workflow[nodeId];
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const candidate = node as WorkflowNodeForGeometry;
  return candidate.inputs && typeof candidate.inputs === "object" && !Array.isArray(candidate.inputs)
    ? candidate
    : null;
}

function isLinkTo(value: unknown, nodeId: string): boolean {
  return Array.isArray(value) && value[0] === nodeId && typeof value[1] === "number";
}

/**
 * H3 dimensions and length are only normalized when the imported workflow
 * exposes the actual seeded H3 nodes. This fails closed for an incomplete or
 * incompatible workflow rather than guessing at a model's geometry contract.
 */
function validateMiniMaxH3WorkflowCapabilities(
  apiWorkflow: Record<string, unknown>,
  mappings: ParameterMappings,
): void {
  const widthMapping = mappings.width;
  const heightMapping = mappings.height;
  const durationMapping = mappings.durationSeconds;
  const fpsMapping = mappings.fps;
  if (!widthMapping || !heightMapping || !durationMapping || !fpsMapping) {
    throw new Error("MiniMax H3 workflow is missing its geometry input mappings");
  }

  const outputNode = workflowNodeForGeometry(apiWorkflow, widthMapping.nodeId);
  const heightNode = workflowNodeForGeometry(apiWorkflow, heightMapping.nodeId);
  const durationNode = workflowNodeForGeometry(apiWorkflow, durationMapping.nodeId);
  const fpsNode = workflowNodeForGeometry(apiWorkflow, fpsMapping.nodeId);
  if (
    !outputNode
    || outputNode.class_type !== "MiniMaxH3ReferenceToVideo"
    || !(widthMapping.input in outputNode.inputs!)
    || heightNode !== outputNode
    || !(heightMapping.input in outputNode.inputs!)
    || !durationNode
    || !(durationMapping.input in durationNode.inputs!)
    || !fpsNode
    || fpsNode.class_type !== "CreateVideo"
    || !(fpsMapping.input in fpsNode.inputs!)
  ) {
    throw new Error("MiniMax H3 workflow does not expose the supported geometry nodes");
  }

  const lengthExpression = Object.entries(apiWorkflow).find(([nodeId]) => {
    const node = workflowNodeForGeometry(apiWorkflow, nodeId);
    return node?.class_type === "ComfyMathExpression"
      && node.inputs?.expression === MINIMAX_H3_LENGTH_EXPRESSION;
  });
  const lengthNodeId = lengthExpression?.[0];
  const lengthNode = workflowNodeForGeometry(apiWorkflow, lengthNodeId);
  const lengthValue = lengthNode?.inputs?.["values.a"];
  if (!lengthNodeId || !lengthNode || !isLinkTo(lengthValue, durationMapping.nodeId)) {
    throw new Error("MiniMax H3 workflow is missing its official 24fps frame-grid expression");
  }
  if (!isLinkTo(outputNode.inputs?.length, lengthNodeId)) {
    throw new Error("MiniMax H3 workflow does not connect its frame-grid expression to length");
  }
}

function cloudProviderErrorDetail(value: unknown): string {
  return String(value)
    .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run)[^\s"'<>]*/gi, "Cloud")
    .replace(/\bfal(?:\.ai)?\b/gi, "Cloud");
}

function repeatedComfyRequestFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown ComfyUI request error";
  return `ComfyUI request failed ${maxConsecutiveMonitorErrors} consecutive times. Last error: ${detail}`;
}

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
  tenantId: string;
  createdByUserId: string;
  provider?: "COMFYUI" | "FAL";
  model?: FalModel;
  voiceCloningEnabled?: boolean;
  /** Deliberately selected consented voice identity; never inferred from text. */
  speakerCharacterId?: string;
  characterIds?: string[];
  /** Ordered image storage keys. Long-form continuity puts its approved still first. */
  referenceImageKeys?: string[];
  /** Required continuity references (still plus assigned wardrobes); cast refs may be capped. */
  mandatoryReferenceImageCount?: number;
  continuityContext?: string;
  settingId?: string | null;
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

function falEndpointsFromMetadata(metadata: Record<string, unknown>): FalQueueEndpoints {
  const submission = metadata.submission && typeof metadata.submission === "object"
    ? metadata.submission as Record<string, unknown>
    : metadata;
  return {
    statusUrl: validateFalQueueUrl(submission.status_url ?? submission.statusUrl, "status URL"),
    responseUrl: validateFalQueueUrl(submission.response_url ?? submission.responseUrl, "response URL"),
    cancelUrl: validateFalQueueUrl(submission.cancel_url ?? submission.cancelUrl, "cancel URL"),
  };
}

function mergeFalMetadata(
  metadata: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadata, ...update };
}

function falSpendQuoteInput(normalized: ReturnType<typeof normalizeFalRequest>): {
  duration: number;
  resolution?: string;
  generateAudio?: boolean;
} {
  const submittedDuration = normalized.input.duration;
  const parsedDuration = typeof submittedDuration === "number"
    ? submittedDuration
    : typeof submittedDuration === "string"
      ? Number.parseFloat(submittedDuration)
      : Number.NaN;
  const resolution = normalized.input.resolution;
  const generateAudio = normalized.input.generate_audio;
  return {
    duration: Number.isFinite(parsedDuration) ? parsedDuration : normalized.durationSeconds,
    ...(typeof resolution === "string" ? { resolution } : {}),
    ...(typeof generateAudio === "boolean" ? { generateAudio } : {}),
  };
}

function falSubmissionDefinitelyRejected(error: unknown): boolean {
  if (!(error instanceof FalHttpError) || error.status === null) return false;
  return error.status >= 400
    && error.status < 500
    && ![408, 409, 425, 429].includes(error.status);
}

async function settleVideoSpendIfReserved(
  jobId: string,
  outcome: "estimated" | "released" | "uncertain",
  note: string,
): Promise<void> {
  try {
    await settleSpend("video", jobId, outcome, note);
  } catch (error) {
    // Jobs accepted before spending ledgers were introduced must remain recoverable.
    if (
      error
      && typeof error === "object"
      && "statusCode" in error
      && error.statusCode === 404
    ) return;
    logger.error(
      { err: error, jobId, outcome },
      "Could not settle Cloud video spend; restart reconciliation will retry",
    );
  }
}

function hasFalSpendLifecycle(metadata: Record<string, unknown>): boolean {
  return metadata.spendLifecycleVersion === FAL_SPEND_LIFECYCLE_VERSION;
}

function latestFalStatus(metadata: Record<string, unknown>): string {
  const latest = metadata.latestStatus;
  return latest && typeof latest === "object"
    ? String((latest as { status?: unknown }).status ?? "").toUpperCase()
    : "";
}

function compileGenericPrompt(
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
    input.continuityContext ? `CONTINUITY\n${input.continuityContext}` : "",
    `ACTION\n${input.prompt}`,
    input.cameraInstructions ? `CAMERA\n${input.cameraInstructions}` : "",
    input.motionInstructions ? `MOTION\n${input.motionInstructions}` : "",
    input.audioInstructions ? `AUDIO\n${input.audioInstructions}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function compactPromptText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapedWordPattern(value: string): RegExp {
  const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function shotPromptOnly(prompt: string): string {
  return prompt.split(/\bPROJECT\s+VISUAL\s+DIRECTION\b/i)[0].trim();
}

function ensureSentenceEnding(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function extractPromptAudio(prompt: string): { soundscape: string | null; music: string | null } {
  const audioSentence = prompt
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => /\b(ambience|ambient|room tone|soundscape|equipment sounds?|music|score)\b/i.test(sentence));
  if (!audioSentence) return { soundscape: null, music: null };

  const musicIndex = audioSentence.search(/\b(?:music|score)\b/i);
  const beforeMusic = musicIndex >= 0 ? audioSentence.slice(0, musicIndex) : "";
  const separatorCandidates = [" and ", ", ", "; "]
    .map((separator) => ({ separator, index: beforeMusic.lastIndexOf(separator) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => right.index - left.index);
  const musicStart = separatorCandidates[0]
    ? separatorCandidates[0].index + separatorCandidates[0].separator.length
    : 0;
  const sentenceWithoutMusic = audioSentence
    .slice(0, musicIndex >= 0 ? musicStart : audioSentence.length)
    .replace(/^(?:add|include|use)\s+/i, "")
    .replace(/\s+(?:and|,|;)\s*$/i, "")
    .replace(/[,\s;]+$/i, "")
    .trim();
  const soundscape = sentenceWithoutMusic.match(
    /\b(?:[\w-]+\s+){0,4}(?:ambience|ambient|room tone|soundscape|equipment sounds?|static)[^.?!]*/i,
  )?.[0]?.replace(/^[,\s]+|[,\s]+$/g, "") ?? null;
  const music = musicIndex >= 0
    ? audioSentence.slice(musicStart).replace(/^(?:add|include|use|a|an|the)\s+/i, "").trim()
    : null;

  return {
    soundscape: soundscape ? compactPromptText(soundscape) : null,
    music: music ? compactPromptText(music) : null,
  };
}

function compileMiniMaxH3StandardPrompt(
  characters: { id: string; name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  const settingSubjectNumber = setting ? characters.length + 1 : null;
  const dialogue = input.dialogue?.trim();
  const shotPrompt = shotPromptOnly(input.prompt);
  const referencedCharacters = characters.filter((character) => (
    escapedWordPattern(character.name).test(shotPrompt) ||
    /\b(?:presenter|character|woman|man|actor|person|subject|host|guest)\b/i.test(shotPrompt)
  ));
  const usesSettingReference = Boolean(
    setting && (
      escapedWordPattern(setting.name).test(shotPrompt) ||
      /\b(?:TBN|studio|control room|broadcast facility|broadcast studio|production room)\b/i.test(shotPrompt)
    ),
  );
  const subjectDefinitions = referencedCharacters.map((character) => (
    `<Subject ${characters.indexOf(character) + 1}> is ${character.name}, whose appearance and identity are defined by the supplied reference images: ${compactPromptText(character.promptDescription)}`
  ));
  if (setting && settingSubjectNumber && usesSettingReference) {
    subjectDefinitions.push(
      `<Subject ${settingSubjectNumber}> is the referenced environment: ${compactPromptText(setting.promptDescription)}`,
    );
  }
  const selectedSpeaker = input.speakerCharacterId
    ? characters.find((character) => input.speakerCharacterId === character.id)
    : undefined;
  const primarySpeaker = selectedSpeaker
    ? `<Subject ${characters.indexOf(selectedSpeaker) + 1}>`
    : referencedCharacters[0]
    ? `<Subject ${characters.indexOf(referencedCharacters[0]) + 1}>`
    : "The on-screen speaker";
  const hasOnScreenSpeech = /\b(speaks?|talks?|says?|addresses?|looks directly into (?:the )?camera)\b/i.test(shotPrompt);
  const isVoiceover = !hasOnScreenSpeech && /\b(off[- ]screen|voice[- ]?over|narration)\b/i.test(shotPrompt);
  const hasAuthoredCamera = /\bcamera\s*:/i.test(shotPrompt);
  const hasAuthoredMotion = /\bmotion\s*:/i.test(shotPrompt);
  const spokenAction = dialogue
    ? isVoiceover
      ? `${primarySpeaker} (S1) says in an off-screen voiceover: <d>[English] ${dialogue}</d> while the corresponding on-screen character's lips remain completely closed.`
      : `${primarySpeaker} (S1) says clearly at a natural speaking rate: <d>[English] ${dialogue}</d>`
    : "";
  const characterPlacement = referencedCharacters
    .map((character) => `<Subject ${characters.indexOf(character) + 1}>`)
    .join(", ");
  const timeline = [
    "[Shot 1] Live-action, cinematic.",
    characterPlacement
      ? `${characterPlacement} ${referencedCharacters.length === 1 ? "appears" : "appear"} with ${referencedCharacters.length === 1 ? "the referenced identity" : "their referenced identities"} fully preserved.`
      : "",
    usesSettingReference && settingSubjectNumber ? `The shot takes place in <Subject ${settingSubjectNumber}>.` : "",
    spokenAction,
    input.continuityContext ? `Continuity locks for this shot: ${compactPromptText(input.continuityContext)}` : "",
    compactPromptText(shotPrompt),
    input.cameraInstructions && !hasAuthoredCamera ? `Camera: ${compactPromptText(input.cameraInstructions)}` : "",
    input.motionInstructions && !hasAuthoredMotion ? `Motion: ${compactPromptText(input.motionInstructions)}` : "",
  ].filter(Boolean).join(" ");
  const promptAudio = extractPromptAudio(shotPrompt);
  const soundscape = input.audioInstructions?.trim()
    ? compactPromptText(input.audioInstructions)
    : promptAudio.soundscape
      ? `${ensureSentenceEnding(promptAudio.soundscape)}${dialogue ? " The spoken dialogue remains clear and intelligible." : ""}`
      : dialogue
        ? "Natural room tone and subtle sounds from the visible action; the spoken dialogue remains clear and intelligible."
        : "Natural ambient sound and subtle sounds from the visible action.";
  const music = promptAudio.music ?? "N/A";
  const summarySubjects = [
    ...referencedCharacters.map((character) => `<Subject ${characters.indexOf(character) + 1}>`),
    ...(usesSettingReference && settingSubjectNumber ? [`<Subject ${settingSubjectNumber}>`] : []),
  ].join(", ");
  const retention = [
    ...referencedCharacters.map((character) => (
      `<Subject ${characters.indexOf(character) + 1}> (appears in [Shot 1]): fully_preserved - preserve the referenced identity, appearance, clothing, and recognizable features.`
    )),
    ...(usesSettingReference && settingSubjectNumber
      ? [`<Subject ${settingSubjectNumber}> (appears in [Shot 1]): fully_preserved - preserve the referenced environment, layout, lighting, and production design.`]
      : []),
  ];

  return [
    dialogue ? `exact_dialogue:\n${dialogue}` : "",
    `subject_definitions:\n${subjectDefinitions.join("\n") || "No supplied reference subject is required to appear in this shot."}`,
    `summary:\n[reference generation] Create a single-shot target video using ${summarySubjects || "the described scene"}.`,
    `retention_analysis:\n${retention.join("\n") || "No supplied subject is required to appear in this shot; prioritize the described scene."}`,
    `detailed_description:\n${timeline}`,
    `overall_soundscape:\n${soundscape}`,
    `non_diegetic_music:\n${music}`,
  ].join("\n\n");
}

function compileMiniMaxH3ReferenceVideoPrompt(
  characters: { id: string; name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  if (!input.referenceVideoKey) {
    throw new Error("Reference-video prompt compilation requires an uploaded reference video");
  }
  const settingSubjectNumber = setting ? characters.length + 1 : null;
  const dialogue = input.voiceCloningEnabled ? input.dialogue?.trim() : undefined;
  const replacesReferenceAudio = Boolean(input.referenceVideoKey && dialogue);
  const reusesReferenceAudio = Boolean(input.referenceVideoKey && !replacesReferenceAudio);
  const shotPrompt = shotPromptOnly(input.prompt);
  const visualShotPrompt = replacesReferenceAudio
    ? shotPrompt
      .replace(
        /\bclone\s+(?:the\s+)?voice\s+(?:to|and)\s+(?:just\s+|only\s+)?say\s+(?:the\s+)?exact\s+dialogue\s+provided\b[.!]?/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim()
    : shotPrompt;
  const referencedCharacters = characters.filter((character) => (
    escapedWordPattern(character.name).test(shotPrompt) ||
    /\b(?:presenter|character|woman|man|actor|person|subject|host|guest)\b/i.test(shotPrompt)
  ));
  const usesSettingReference = Boolean(
    setting && (
      escapedWordPattern(setting.name).test(shotPrompt) ||
      /\b(?:TBN|studio|control room|broadcast facility|broadcast studio|production room)\b/i.test(shotPrompt)
    ),
  );
  const subjectDefinitions = referencedCharacters.map((character) => (
    `<Subject ${characters.indexOf(character) + 1}> is ${character.name}, whose appearance and identity are defined by the supplied reference images: ${compactPromptText(character.promptDescription)}`
  ));
  if (setting && settingSubjectNumber && usesSettingReference) {
    subjectDefinitions.push(
      `<Subject ${settingSubjectNumber}> is the referenced environment: ${compactPromptText(setting.promptDescription)}`,
    );
  }
  if (input.referenceVideoKey) {
    subjectDefinitions.push(
      replacesReferenceAudio
        ? "<Video 1> is the source presenter video providing body movement, camera behavior, framing, and temporal structure. The presenter's mouth and facial speech articulation must be regenerated for the replacement dialogue."
        : "<Video 1> is the source presenter video providing the target timing, movement, camera behavior, and temporal structure.",
      replacesReferenceAudio
        ? "<Audio 1> is the synchronized source audio from <Video 1>, used only as a reference for the presenter's voice identity, tone, and speaking characteristics. Its original words must not be copied."
        : "<Audio 1> is the synchronized original audio track from <Video 1>, reused directly in the target video.",
    );
  }
  const selectedSpeaker = input.speakerCharacterId
    ? characters.find((character) => input.speakerCharacterId === character.id)
    : undefined;
  const primarySpeaker = selectedSpeaker
    ? `<Subject ${characters.indexOf(selectedSpeaker) + 1}>`
    : referencedCharacters[0]
    ? `<Subject ${characters.indexOf(referencedCharacters[0]) + 1}>`
    : input.referenceVideoKey
      ? "The presenter from <Video 1>"
      : "The on-screen speaker";
  const hasOnScreenSpeech = /\b(speaks?|talks?|says?|addresses?|looks directly into (?:the )?camera)\b/i.test(shotPrompt);
  const isVoiceover = !hasOnScreenSpeech && /\b(off[- ]screen|voice[- ]?over|narration)\b/i.test(shotPrompt);
  const hasAuthoredCamera = /\bcamera\s*:/i.test(shotPrompt);
  const hasAuthoredMotion = /\bmotion\s*:/i.test(shotPrompt);
  const spokenAction = dialogue
    ? isVoiceover
      ? `${primarySpeaker} (S1) says in an off-screen voiceover: <d>[English] ${dialogue}</d> while the corresponding on-screen character's lips remain completely closed.`
      : `${primarySpeaker} (S1) says clearly at a natural speaking rate: <d>[English] ${dialogue}</d>`
    : "";
  const characterPlacement = referencedCharacters
    .map((character) => `<Subject ${characters.indexOf(character) + 1}>`)
    .join(", ");
  const timeline = [
    "[Shot 1] Live-action, cinematic.",
    characterPlacement
      ? `${characterPlacement} ${referencedCharacters.length === 1 ? "appears" : "appear"} with ${referencedCharacters.length === 1 ? "the referenced identity" : "their referenced identities"} fully preserved.`
      : "",
    usesSettingReference && settingSubjectNumber ? `The shot takes place in <Subject ${settingSubjectNumber}>.` : "",
    input.referenceVideoKey
      ? replacesReferenceAudio
        ? "Preserve the body movement, camera behavior, framing, and overall timing of <Video 1>, but replace the original mouth movement and facial speech articulation so they synchronize precisely with the supplied dialogue."
        : "Follow the timing, movement, and temporal structure of <Video 1>."
      : "",
    replacesReferenceAudio
      ? "Clone the presenter's voice characteristics from <Audio 1>, replace the original spoken content completely, and speak only the exact dialogue supplied below."
      : "",
    spokenAction,
    input.continuityContext ? `Continuity locks for this shot: ${compactPromptText(input.continuityContext)}` : "",
    visualShotPrompt ? compactPromptText(visualShotPrompt) : "",
    input.cameraInstructions && !hasAuthoredCamera ? `Camera: ${compactPromptText(input.cameraInstructions)}` : "",
    input.motionInstructions && !hasAuthoredMotion ? `Motion: ${compactPromptText(input.motionInstructions)}` : "",
  ].filter(Boolean).join(" ");
  const promptAudio = extractPromptAudio(shotPrompt);
  const soundscape = input.audioInstructions?.trim()
    ? compactPromptText(input.audioInstructions)
    : promptAudio.soundscape
      ? `${ensureSentenceEnding(promptAudio.soundscape)}${dialogue ? " The spoken dialogue remains clear and intelligible." : ""}`
      : dialogue
        ? "Natural room tone and subtle sounds from the visible action; the spoken dialogue remains clear and intelligible."
        : "Natural ambient sound and subtle sounds from the visible action.";
  const music = promptAudio.music ?? "N/A";
  const taskTypes = replacesReferenceAudio
    ? "[reference generation + voice cloning + dialogue replacement]"
    : reusesReferenceAudio
      ? "[reference generation + audio reuse]"
      : "[reference generation]";
  const summarySubjects = [
    ...referencedCharacters.map((character) => `<Subject ${characters.indexOf(character) + 1}>`),
    ...(usesSettingReference && settingSubjectNumber ? [`<Subject ${settingSubjectNumber}>`] : []),
  ].join(", ");
  const retention = [
    ...referencedCharacters.map((character) => (
      `<Subject ${characters.indexOf(character) + 1}> (appears in [Shot 1]): fully_preserved - preserve the referenced identity, appearance, clothing, and recognizable features.`
    )),
    ...(usesSettingReference && settingSubjectNumber
      ? [`<Subject ${settingSubjectNumber}> (appears in [Shot 1]): fully_preserved - preserve the referenced environment, layout, lighting, and production design.`]
      : []),
    ...(input.referenceVideoKey
      ? [
        replacesReferenceAudio
          ? "<Video 1> (body movement, camera behavior, framing, and temporal structure): selectively_preserved - preserve the source performance except for mouth movement and facial speech articulation, which must be regenerated to lip-sync the supplied dialogue."
          : "<Video 1> (timing, movement, and temporal structure): fully_preserved - follow the source presenter's performance timing and motion.",
        replacesReferenceAudio
          ? "<Audio 1> (voice identity only): voice_preserved_content_replaced - clone the presenter's voice characteristics, discard the original spoken words, and generate only the supplied dialogue."
          : "<Audio 1>: copied - reuse the synchronized original audio signal without regenerating or rewriting it.",
      ]
      : []),
  ];
  const summaryAudio = replacesReferenceAudio
    ? " while cloning the presenter voice from <Audio 1> to speak only the supplied dialogue"
    : reusesReferenceAudio
      ? " while reusing <Audio 1>"
      : "";
  const outputSoundscape = replacesReferenceAudio
    ? `${soundscape} Do not copy or repeat the original spoken words from <Audio 1>.`
    : reusesReferenceAudio
      ? "Reuse <Audio 1> as the synchronized output audio."
      : soundscape;
  const outputMusic = reusesReferenceAudio
    ? "Reuse any music contained in <Audio 1> as part of the synchronized source audio."
    : music;

  return [
    dialogue ? `exact_dialogue:\n${dialogue}` : "",
    `subject_definitions:\n${subjectDefinitions.join("\n") || "No supplied reference subject is required to appear in this shot."}`,
    `summary:\n${taskTypes} Create a single-shot target video using ${summarySubjects || "the described scene"}${summaryAudio}.`,
    `retention_analysis:\n${retention.join("\n") || "No supplied subject is required to appear in this shot; prioritize the described scene."}`,
    `detailed_description:\n${timeline}`,
    `overall_soundscape:\n${outputSoundscape}`,
    `non_diegetic_music:\n${outputMusic}`,
  ].join("\n\n");
}

function routeMiniMaxReferenceVideoAudio(
  workflow: Record<string, unknown>,
  generateReplacementDialogue: boolean,
): void {
  type WorkflowNode = { class_type?: unknown; inputs?: Record<string, unknown> };
  const nodes = workflow as Record<string, WorkflowNode>;
  const createVideo = Object.values(nodes).find((node) => node.class_type === "CreateVideo");
  if (!createVideo?.inputs) {
    throw new Error("MiniMax H3 reference-video workflow is missing its CreateVideo output node");
  }

  const audioNode = Object.entries(nodes).find(([, node]) => (
    node.class_type === (generateReplacementDialogue ? "VAEDecodeAudio" : "GetVideoComponents")
  ));
  if (!audioNode) {
    throw new Error(
      generateReplacementDialogue
        ? "MiniMax H3 reference-video workflow cannot output replacement dialogue because it has no VAEDecodeAudio node"
        : "MiniMax H3 reference-video workflow cannot preserve source audio because it has no GetVideoComponents node",
    );
  }

  createVideo.inputs.audio = [audioNode[0], generateReplacementDialogue ? 0 : 1];
}

function compilePrompt(
  modelFamily: string,
  characters: { id: string; name: string; promptDescription: string }[],
  setting: { name: string; promptDescription: string } | undefined,
  input: GenerationRequest,
): string {
  if (modelFamily.trim().toLowerCase() !== "minimax h3") {
    return compileGenericPrompt(characters, setting, input);
  }
  return input.referenceVideoKey
    ? compileMiniMaxH3ReferenceVideoPrompt(characters, setting, input)
    : compileMiniMaxH3StandardPrompt(characters, setting, input);
}

/** Pure, mockable contract for continuity reference ordering. */
export function planContinuityReferenceSlots(
  mappings: ParameterMappings,
  approvedStillKeys: string[],
  canonicalCharacterKeys: string[],
  mandatoryReferenceImageCount = approvedStillKeys.length,
): Array<{ field: string; storageKey: string }> {
  const fields = Object.keys(mappings)
    .filter((field) => /^referenceImage\d+$/.test(field))
    .sort((left, right) => Number(left.slice(14)) - Number(right.slice(14)));
  if (approvedStillKeys.length && !mappings.referenceImage1) {
    throw new Error("This workflow lacks referenceImage1 required by the approved continuity still");
  }
  if (mandatoryReferenceImageCount > fields.length) {
    throw new Error("This workflow does not have enough reference image slots for the approved still and assigned wardrobe references");
  }
  return [...approvedStillKeys, ...canonicalCharacterKeys]
    .slice(0, fields.length)
    .map((storageKey, index) => ({ field: fields[index]!, storageKey }));
}

/** The voice snapshot, not cast order, is authoritative during local and Cloud completion. */
export function completionVoiceCharacterId(
  voiceCharacterId: string | null,
  castCharacterIds: string[],
): string | null {
  if (voiceCharacterId && !castCharacterIds.includes(voiceCharacterId)) {
    throw new Error("The saved voice speaker is not part of this generation cast");
  }
  return voiceCharacterId ?? castCharacterIds[0] ?? null;
}

export function compileLongFormPromptForTest(
  characters: { id: string; name: string; promptDescription: string }[],
  input: GenerationRequest,
): string {
  return compilePrompt("MiniMax H3", characters, undefined, input);
}

async function uploadMappedReferences(
  client: ComfyUIClient,
  mappings: ParameterMappings,
  characterIds: string[] = [],
  settingId?: string | null,
  referenceImageKeys: string[] = [],
  mandatoryReferenceImageCount?: number,
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
  const approvedStillAssets = referenceImageKeys.map((storageKey, index) => ({
    storageKey,
    originalName: `continuity-still-${index + 1}`,
    mimeType: storageKey.endsWith(".webp") ? "image/webp" : storageKey.match(/\.jpe?g$/i) ? "image/jpeg" : "image/png",
  }));
  const canonicalCharacterAssets = characterIds.flatMap((characterId) => {
    const first = (characterAssets as Array<{
      characterId: string;
      storageKey: string;
      originalName: string;
      mimeType: string;
      label?: string | null;
      angle?: string | null;
    }>).find((asset) => (
      asset.characterId === characterId
      && asset.label !== "wardrobe"
      && asset.angle !== "wardrobe"
    ));
    return first ? [first] : [];
  });
  // The reference mapping is positional. Keep approved continuity stills first;
  // canonical character references fill any remaining workflow capacity.
  const referenceAssets = new Map(
    [...approvedStillAssets, ...canonicalCharacterAssets].map((asset) => [asset.storageKey, asset]),
  );
  const fields: Array<readonly [string, { storageKey: string; originalName: string; mimeType: string }]> = [
    ...planContinuityReferenceSlots(
      mappings,
      referenceImageKeys,
      canonicalCharacterAssets.map((asset) => asset.storageKey),
      mandatoryReferenceImageCount,
    ).map(({ field, storageKey }) => [field, referenceAssets.get(storageKey)!] as const),
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

async function selectedVoiceSpeaker(jobId: string, voiceCharacterId: string | null) {
  // Both local and Cloud completion call this shared resolver. The persisted
  // explicit speaker wins over cast order, and a corrupt snapshot fails closed.
  const speakers = await db.select({
    id: charactersTable.id,
    voiceStorageKey: charactersTable.voiceStorageKey,
    voiceConsentAt: charactersTable.voiceConsentAt,
  }).from(generationCharactersTable)
    .innerJoin(charactersTable, eq(generationCharactersTable.characterId, charactersTable.id))
    .where(eq(generationCharactersTable.generationJobId, jobId))
    .orderBy(asc(generationCharactersTable.sortOrder))
  const selectedId = completionVoiceCharacterId(voiceCharacterId, speakers.map((speaker) => speaker.id));
  return speakers.find((speaker) => speaker.id === selectedId);
}

type ComfyOutputFile = {
  filename?: unknown;
  subfolder?: unknown;
  type?: unknown;
};

function chooseOutput(
  history: Record<string, unknown>,
  promptId: string,
): { filename: string; subfolder: string; type: string } | null {
  const records = Object.values(history);
  const requested = history[promptId] ?? (records.length === 1 ? records[0] : null);
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return null;
  const outputs = (requested as { outputs?: unknown }).outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  for (const output of Object.values(outputs)) {
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    for (const collectionName of ["gifs", "videos", "images"]) {
      const collection = (output as Record<string, unknown>)[collectionName];
      if (!Array.isArray(collection)) continue;
      for (const file of collection as unknown[]) {
        if (!file || typeof file !== "object" || Array.isArray(file)) continue;
        const candidate = file as ComfyOutputFile;
        if (typeof candidate.filename === "string" && candidate.filename.match(/\.(mp4|webm|mov|mkv)$/i)) {
          return {
            filename: candidate.filename,
            subfolder: typeof candidate.subfolder === "string" ? candidate.subfolder : "",
            type: typeof candidate.type === "string" ? candidate.type : "output",
          };
        }
      }
    }
  }
  return null;
}

export async function resumeActiveGenerations(): Promise<void> {
  const terminalCloudJobs = await db
    .select()
    .from(generationJobsTable)
    .where(and(
      eq(generationJobsTable.provider, "FAL"),
      inArray(generationJobsTable.status, ["COMPLETED", "FAILED", "CANCELLED"]),
    ));
  for (const job of terminalCloudJobs) {
    if (!hasFalSpendLifecycle(job.providerTaskMetadata)) continue;
    if (job.status === "COMPLETED" || latestFalStatus(job.providerTaskMetadata) === "COMPLETED") {
      await settleVideoSpendIfReserved(
        job.id,
        "estimated",
        "Cloud completion was confirmed by durable job metadata.",
      );
    } else if (
      job.providerRequestId
      || (
        job.providerTaskMetadata.submissionIntent === true
        && !["not-submitted", "rejected"].includes(
          String(job.providerTaskMetadata.submissionOutcome ?? ""),
        )
      )
    ) {
      await settleVideoSpendIfReserved(
        job.id,
        "uncertain",
        "Paid Cloud execution cannot be ruled out for this terminal job.",
      );
    } else {
      await settleVideoSpendIfReserved(
        job.id,
        "released",
        "Durable job metadata confirms the Cloud request was never submitted.",
      );
    }
  }
  const jobs = await db
    .select()
    .from(generationJobsTable)
    .where(inArray(generationJobsTable.status, ["QUEUED", "RUNNING", "DOWNLOADING"]));
  for (const job of jobs) {
    if (job.provider === "FAL" && job.providerModelId && job.providerRequestId) {
      const model = (Object.entries(falModels).find(([, id]) => id === job.providerModelId)?.[0]) as FalModel | undefined;
      if (model) {
        try {
          const endpoints = falEndpointsFromMetadata(job.providerTaskMetadata);
          void monitorFalGeneration(job.id, new FalQueueClient(model), job.providerRequestId, endpoints);
        } catch (error) {
          logger.error({ err: error, jobId: job.id }, "Cannot resume Cloud generation with invalid queue endpoints");
          const [failed] = await db.update(generationJobsTable).set({
            status: "FAILED",
            errorMessage: error instanceof Error ? cloudProviderErrorDetail(error.message) : "Invalid Cloud queue endpoints",
            failedAt: new Date(),
          }).where(and(
            eq(generationJobsTable.id, job.id),
            inArray(generationJobsTable.status, activeGenerationStatuses),
          )).returning({ id: generationJobsTable.id });
          if (failed) {
            await settleVideoSpendIfReserved(
              job.id,
              "uncertain",
              "Cloud accepted the job, but its persisted queue receipt could not be recovered.",
            );
          }
        }
      }
      continue;
    }
    if (!job.comfyPromptId || !job.comfyServerId) continue;
    const [server] = await db
      .select()
      .from(comfyServersTable)
      .where(eq(comfyServersTable.id, job.comfyServerId));
    if (!server) {
      logger.warn({ jobId: job.id, serverId: job.comfyServerId }, "Cannot resume generation: ComfyUI server is missing");
      await db.update(generationJobsTable).set({
        status: "FAILED",
        currentNode: null,
        errorMessage: "The ComfyUI server assigned to this generation no longer exists.",
        failedAt: new Date(),
      }).where(and(eq(generationJobsTable.id, job.id), inArray(generationJobsTable.status, activeGenerationStatuses)));
      continue;
    }
    void monitorGeneration(job.id, new ComfyUIClient(server), job.comfyPromptId);
  }
  const interruptedCloudJobs = await db
    .select({
      id: generationJobsTable.id,
      providerTaskMetadata: generationJobsTable.providerTaskMetadata,
    })
    .from(generationJobsTable)
    .where(and(
      eq(generationJobsTable.provider, "FAL"),
      eq(generationJobsTable.status, "UPLOADING"),
      sql`${generationJobsTable.providerRequestId} IS NULL`,
    ));
  for (const job of interruptedCloudJobs) {
    const wasSubmitted = job.providerTaskMetadata.submissionIntent === true
      && !["not-submitted", "rejected"].includes(
        String(job.providerTaskMetadata.submissionOutcome ?? ""),
      );
    await settleVideoSpendIfReserved(
      job.id,
      wasSubmitted ? "uncertain" : "released",
      wasSubmitted
        ? "Cloud submission was interrupted before its acceptance outcome could be persisted."
        : "Durable job metadata confirms the Cloud request was never submitted.",
    );
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: "Generation submission was interrupted before the provider returned a request ID.", failedAt: new Date() })
    .where(and(
      eq(generationJobsTable.status, "UPLOADING"),
      sql`${generationJobsTable.comfyPromptId} IS NULL`,
      sql`${generationJobsTable.providerRequestId} IS NULL`,
    ));
}

export async function createAndSubmitGeneration(input: GenerationRequest): Promise<GenerationJob> {
  if (input.referenceVideoKey && !input.referenceVideoKey.startsWith(`tenants/${input.tenantId}/`)) {
    const [tenant] = await db.select({ isDefault: tenantsTable.isDefault })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, input.tenantId))
      .limit(1);
    if (input.referenceVideoKey.startsWith("tenants/") || !tenant?.isDefault) {
      throw new ResourceNotFoundError("Reference video not found");
    }
  }
  if (input.referenceImageKeys?.some((key) => !key.startsWith(`tenants/${input.tenantId}/`))) {
    throw new ResourceNotFoundError("Continuity reference image not found");
  }
  const [foundCharacters, setting] = await Promise.all([
    input.characterIds?.length
      ? db.select().from(charactersTable).where(and(
        inArray(charactersTable.id, input.characterIds),
        eq(charactersTable.tenantId, input.tenantId),
      ))
      : Promise.resolve([]),
    input.settingId
      ? db.select().from(settingsTable).where(and(
        eq(settingsTable.id, input.settingId),
        eq(settingsTable.tenantId, input.tenantId),
      ))
      : Promise.resolve([]),
  ]);
  const charactersById = new Map(foundCharacters.map((character) => [character.id, character]));
  const characters = (input.characterIds ?? [])
    .map((id) => charactersById.get(id))
    .filter((character): character is typeof foundCharacters[number] => Boolean(character));
  const wantsReferenceVideo = Boolean(input.referenceVideoKey);
  assertOwnedAssetSelections({
    characterIds: input.characterIds ?? [],
    foundCharacterIds: foundCharacters.map((character) => character.id),
    settingId: input.settingId,
    settingFound: Boolean(setting[0]),
    message: "One or more selected studio assets no longer exist",
  });
  if (input.voiceCloningEnabled) {
    if (!input.dialogue?.trim()) {
      throw new Error("Voice cloning requires dialogue");
    }
    const speaker = input.speakerCharacterId
      ? characters.find((character) => character.id === input.speakerCharacterId)
      : characters[0];
    if (!speaker?.voiceStorageKey || !speaker.voiceConsentAt) {
      throw new Error("Voice cloning requires the selected speaker Character to have a consented voice sample");
    }
  }
  if ((input.provider ?? "COMFYUI") === "FAL") {
    return createAndSubmitFalGeneration(input, characters, setting[0]);
  }
  const workflows = await db
    .select()
    .from(workflowTemplatesTable)
    .where(and(eq(workflowTemplatesTable.generationMode, input.generationMode), eq(workflowTemplatesTable.active, true)))
    .orderBy(desc(workflowTemplatesTable.version));
  const inputTypeWorkflows = workflows.filter((candidate) => (
    wantsReferenceVideo
      ? Boolean(candidate.apiWorkflow && (candidate.mappings as ParameterMappings).referenceVideo)
      : Boolean(candidate.apiWorkflow && !(candidate.mappings as ParameterMappings).referenceVideo)
  ));
  if (inputTypeWorkflows.length === 0) {
    throw new Error(wantsReferenceVideo
      ? "No active workflow accepting a reference video is configured for this generation mode"
      : "No active prompt-only workflow is configured for this generation mode");
  }
  const compatibleWorkflows = inputTypeWorkflows.filter((candidate) => {
    const required = getWorkflowReferenceRequirements(candidate.apiWorkflow, candidate.mappings);
    return (!required.requiresCharacterReferences || characters.length > 0 || Boolean(input.referenceImageKeys?.length))
      && (!required.requiresSettingReference || setting.length > 0)
      && (!input.referenceImageKeys?.length || Boolean((candidate.mappings as ParameterMappings).referenceImage1))
      && (!input.mandatoryReferenceImageCount || Object.keys(candidate.mappings)
        .filter((field) => /^referenceImage\d+$/.test(field)).length >= input.mandatoryReferenceImageCount);
  });
  if (inputTypeWorkflows.length > 0 && compatibleWorkflows.length === 0) {
    throw new Error("This pipeline requires reference inputs. Choose a prompt-only pipeline or add the required references.");
  }
  if (input.referenceImageKeys?.length && !compatibleWorkflows.some((candidate) =>
    Boolean((candidate.mappings as ParameterMappings).referenceImage1),
  )) {
    throw new Error("No active workflow supports the approved continuity still reference");
  }
  const servers = await db.select().from(comfyServersTable);
  const requestedServer = input.preferredServerId
    ? servers.find((server) => server.id === input.preferredServerId)
    : undefined;
  const [activeJobs, activeImageJobs] = await Promise.all([
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
    if (job.comfyServerId) {
      activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
    }
  }
  for (const job of activeImageJobs) {
    if (job.comfyServerId) {
      activeByServer.set(job.comfyServerId, (activeByServer.get(job.comfyServerId) ?? 0) + 1);
    }
  }
  const effectiveActiveCount = (server: typeof servers[number]) =>
    Math.max(activeByServer.get(server.id) ?? 0, server.activeJobCount);
  const candidates = compatibleWorkflows.flatMap((candidate, workflowIndex) =>
    servers
      .filter((server) => (
        server.enabled &&
        server.status === "ONLINE" &&
        hasRequiredTags(server.tags, candidate.compatibleServerTags)
      ))
      .map((server) => ({ workflow: candidate, server, workflowIndex })),
  );
  const selected = candidates
    .filter(({ server }) => effectiveActiveCount(server) < (server.maxConcurrentJobs ?? 1))
    .sort((a, b) => (
      Number(a.server.id !== requestedServer?.id) - Number(b.server.id !== requestedServer?.id) ||
      effectiveActiveCount(a.server) - effectiveActiveCount(b.server) ||
      a.server.queueSize - b.server.queueSize ||
      a.server.priority - b.server.priority ||
      a.workflowIndex - b.workflowIndex
    ))[0];
  const workflow = selected?.workflow ?? compatibleWorkflows[0];
  if (!workflow?.apiWorkflow) {
    throw new Error("No active imported API workflow is configured for this generation mode");
  }
  const isLtx25Workflow = workflow.modelFamily.trim().toLowerCase() === "ltx 2.5";
  const isMiniMaxH3Workflow = workflow.modelFamily.trim().toLowerCase() === "minimax h3";
  const apiWorkflow = workflow.apiWorkflow;
  if (!apiWorkflow) {
    throw new Error("No active imported API workflow is configured for this generation mode");
  }
  const h3Geometry = isMiniMaxH3Workflow
    ? normalizeMiniMaxH3SubmissionGeometry(input)
    : null;
  if (isMiniMaxH3Workflow) {
    validateMiniMaxH3WorkflowCapabilities(
      apiWorkflow,
      workflow.mappings as ParameterMappings,
    );
  }
  const outputWidth = isLtx25Workflow
    ? normalizeLtx25OutputDimension(input.width)
    : h3Geometry?.width ?? input.width;
  const outputHeight = isLtx25Workflow
    ? normalizeLtx25OutputDimension(input.height)
    : h3Geometry?.height ?? input.height;
  if ((workflow.mappings as ParameterMappings).referenceVideo && !input.referenceVideoKey) {
    throw new Error("No active workflow without reference-video input is configured for this generation mode");
  }
  const server = selected?.server;
  if (!server) {
    const compatibleServerNames = [...new Set(candidates.map(({ server: candidate }) => candidate.displayName))];
    if (compatibleServerNames.length > 0) {
      throw new Error(`All compatible GPUs are at their safe render capacity: ${compatibleServerNames.join(", ")}.`);
    }
    throw new Error("No healthy, compatible ComfyUI server is available. Configure and test a server first.");
  }
  try {
    return await withServerSlotLock(server.id, async () => {
    const [activeJobs, activeImageJobs] = await Promise.all([
      db
        .select({ id: generationJobsTable.id })
        .from(generationJobsTable)
        .where(and(eq(generationJobsTable.comfyServerId, server.id), inArray(generationJobsTable.status, activeGenerationStatuses))),
      db
        .select({ id: imageStudioJobsTable.id })
        .from(imageStudioJobsTable)
        .where(and(eq(imageStudioJobsTable.comfyServerId, server.id), inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"]))),
    ]);
    if (Math.max(activeJobs.length + activeImageJobs.length, server.activeJobCount) >= (server.maxConcurrentJobs ?? 1)) {
      throw new Error(`${server.displayName} is at its safe render capacity.`);
    }
  const compiledPrompt = compilePrompt(workflow.modelFamily, characters, setting[0], input);
    const frameCount = h3Geometry?.frameCount ?? Math.round(input.durationSeconds * input.fps);
  const [job] = await db
    .insert(generationJobsTable)
    .values({
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId,
      title: characters[0]?.name && setting[0]?.name
        ? `${characters[0].name} — ${setting[0].name}`
        : characters[0]?.name ?? setting[0]?.name ?? workflow.modelFamily,
      status: "UPLOADING",
      workflowTemplateId: workflow.id,
      longFormShotId: input.longFormShotId ?? null,
      comfyServerId: server.id,
      prompt: input.prompt,
      compiledPrompt,
      dialogue: input.dialogue?.trim() ?? "",
      negativePrompt: input.negativePrompt ?? null,
      width: outputWidth,
      height: outputHeight,
      fps: input.fps,
      frameCount,
      durationSeconds: input.durationSeconds,
      seed: input.seedMode === "FIXED" && input.seed != null ? Math.floor(input.seed) : null,
      generationMode: input.generationMode,
      qualityPreset: input.qualityPreset,
      provider: "COMFYUI",
      voiceCloningEnabled: input.voiceCloningEnabled ?? false,
      voiceCharacterId: input.speakerCharacterId ?? null,
      referenceImageKeys: input.referenceImageKeys ?? [],
    })
    .returning();
  await input.onJobCreated?.(job);
  if (characters.length > 0) {
    const voiceFirstCharacters = [...characters].sort((left, right) =>
      Number(right.id === input.speakerCharacterId) - Number(left.id === input.speakerCharacterId),
    );
    await db.insert(generationCharactersTable).values(
      voiceFirstCharacters.map((character, index) => ({ generationJobId: job.id, characterId: character.id, sortOrder: index })),
    );
  }
  if (setting[0]) {
    await db.insert(generationSettingsTable).values({ generationJobId: job.id, settingId: setting[0].id });
  }
  try {
    const client = new ComfyUIClient(server);
    const assetParameters = await uploadMappedReferences(
      client,
      workflow.mappings as ParameterMappings,
      input.characterIds,
      input.settingId,
      input.referenceImageKeys,
      input.mandatoryReferenceImageCount,
    );
    const requiredReferences = getWorkflowReferenceRequirements(apiWorkflow, workflow.mappings);
    if (
      requiredReferences.requiresCharacterReferences &&
      !Object.keys(assetParameters).some((field) => /^referenceImage\d+$/.test(field))
    ) {
      throw new Error("This imported image-conditioned workflow needs an input image. Choose a text-to-video pipeline to render without one.");
    }
    if (
      requiredReferences.requiresSettingReference &&
      !Object.keys(assetParameters).some((field) => /^settingImage\d+$/.test(field))
    ) {
      throw new Error("Select an environment with a reference image for this pipeline.");
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
      width: outputWidth,
      height: outputHeight,
      frames: frameCount,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
      seed: input.seedMode === "FIXED" ? input.seed ?? 0 : Math.floor(Math.random() * 2_147_483_647),
      ...assetParameters,
      ...referenceVideoParameters,
    });
    if (referenceVideo && workflow.modelFamily.trim().toLowerCase() === "minimax h3") {
      routeMiniMaxReferenceVideoAudio(
        submittedWorkflow,
        Boolean(input.voiceCloningEnabled && input.dialogue?.trim()),
      );
    }
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("safe render capacity") || (input.preferredServerId && message.includes("being reserved by another render"))) {
      logger.info(
        { preferredServerId: input.preferredServerId, rejectedServer: server.displayName },
        "GPU unavailable; retrying generation on another compatible server",
      );
      return createAndSubmitGeneration({ ...input, preferredServerId: undefined });
    }
    throw error;
  }
}

async function createAndSubmitFalGeneration(
  input: GenerationRequest,
  characters: Array<typeof charactersTable.$inferSelect>,
  setting: typeof settingsTable.$inferSelect | undefined,
): Promise<GenerationJob> {
  if (!input.model || !(input.model in falModels)) {
    throw new Error("A supported Cloud model is required");
  }
  if (input.referenceVideoKey) {
    throw new Error("Cloud models support text-to-video requests only; remove the reference video");
  }
  if (!process.env.FAL_KEY?.trim()) {
    throw new FalHttpError("FAL_KEY is not configured", null, false);
  }
  const model = input.model;
  const compiledPrompt = compileGenericPrompt(characters, setting, input);
  const normalized = normalizeFalRequest(model, {
    prompt: compiledPrompt,
    negativePrompt: input.negativePrompt,
    width: input.width,
    height: input.height,
    durationSeconds: input.durationSeconds,
    fps: input.fps,
    qualityPreset: input.qualityPreset,
    seed: input.seedMode === "FIXED" ? input.seed : null,
  });
  const [job] = await db.insert(generationJobsTable).values({
    tenantId: input.tenantId,
    createdByUserId: input.createdByUserId,
    title: characters[0]?.name && setting?.name
      ? `${characters[0].name} — ${setting.name}`
      : characters[0]?.name ?? setting?.name ?? model,
    status: "UPLOADING",
    provider: "FAL",
    providerModelId: falModels[model],
    providerTaskMetadata: {
      model,
      spendLifecycleVersion: FAL_SPEND_LIFECYCLE_VERSION,
      submissionIntent: false,
      submissionOutcome: "not-submitted",
    },
    voiceCloningEnabled: input.voiceCloningEnabled ?? false,
    voiceCharacterId: input.speakerCharacterId ?? null,
    referenceImageKeys: input.referenceImageKeys ?? [],
    longFormShotId: input.longFormShotId ?? null,
    prompt: input.prompt,
    compiledPrompt,
    dialogue: input.dialogue?.trim() ?? "",
    negativePrompt: input.negativePrompt ?? null,
    width: normalized.width,
    height: normalized.height,
    fps: normalized.fps,
    frameCount: normalized.frameCount,
    durationSeconds: normalized.durationSeconds,
    seed: input.seedMode === "FIXED" && input.seed != null ? Math.floor(input.seed) : null,
    generationMode: input.generationMode,
    qualityPreset: input.qualityPreset,
  }).returning();
  await input.onJobCreated?.(job);
  if (characters.length) {
    const voiceFirstCharacters = [...characters].sort((left, right) =>
      Number(right.id === input.speakerCharacterId) - Number(left.id === input.speakerCharacterId),
    );
    await db.insert(generationCharactersTable).values(
      voiceFirstCharacters.map((character, index) => ({ generationJobId: job.id, characterId: character.id, sortOrder: index })),
    );
  }
  if (setting) {
    await db.insert(generationSettingsTable).values({ generationJobId: job.id, settingId: setting.id });
  }

  let reserved = false;
  let submissionAttempted = false;
  try {
    const modelId = falModels[model];
    const quote = await quoteVideoSpend(modelId, falSpendQuoteInput(normalized));
    await reserveSpend({
      tenantId: input.tenantId,
      userId: input.createdByUserId,
      sourceType: "video",
      sourceId: job.id,
      modelId,
      estimatedUsd: quote.estimatedUsd,
      pricingNote: quote.pricingNote,
    });
    reserved = true;
    const submissionIntentAt = new Date().toISOString();
    const [intentReady] = await db.update(generationJobsTable).set({
      providerTaskMetadata: {
        model,
        spendLifecycleVersion: FAL_SPEND_LIFECYCLE_VERSION,
        submissionIntent: true,
        submissionIntentAt,
        submissionOutcome: "unknown",
      },
    }).where(and(
      eq(generationJobsTable.id, job.id),
      eq(generationJobsTable.status, "UPLOADING"),
    )).returning({ id: generationJobsTable.id });
    if (!intentReady) {
      throw new Error("Generation was cancelled before Cloud submission");
    }
    const client = new FalQueueClient(model);
    submissionAttempted = true;
    const submitted = await client.submit(normalized.input);
    const taskMetadata = {
      model,
      spendLifecycleVersion: FAL_SPEND_LIFECYCLE_VERSION,
      submissionIntent: true,
      submissionIntentAt,
      submissionOutcome: "accepted",
      submission: submitted.metadata,
    };
    const [queued] = await db.update(generationJobsTable).set({
      status: "QUEUED",
      providerRequestId: submitted.requestId,
      providerTaskMetadata: taskMetadata,
      queuedAt: new Date(),
      currentNode: "Waiting in Cloud queue",
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING"))).returning();
    if (!queued) {
      const [current] = await db.update(generationJobsTable).set({
        providerRequestId: submitted.requestId,
        providerTaskMetadata: taskMetadata,
      }).where(eq(generationJobsTable.id, job.id)).returning();
      await client.cancel(submitted.endpoints).catch((error) => {
        logger.warn({ err: error, jobId: job.id }, "Could not cancel Cloud request after local cancellation");
      });
      await settleVideoSpendIfReserved(
        job.id,
        "uncertain",
        "Cloud accepted the job before local cancellation was observed.",
      );
      if (!current) throw new Error("Generation job disappeared after Cloud submission");
      return current;
    }
    void monitorFalGeneration(job.id, client, submitted.requestId, submitted.endpoints);
    return queued;
  } catch (error) {
    const message = error instanceof Error ? cloudProviderErrorDetail(error.message) : "Cloud submission failed";
    const definitivelyUnbilled = reserved
      && (!submissionAttempted || falSubmissionDefinitelyRejected(error));
    if (definitivelyUnbilled) {
      await db.update(generationJobsTable).set({
        providerTaskMetadata: {
          model,
          spendLifecycleVersion: FAL_SPEND_LIFECYCLE_VERSION,
          submissionIntent: submissionAttempted,
          submissionOutcome: submissionAttempted ? "rejected" : "not-submitted",
        },
      }).where(and(
        eq(generationJobsTable.id, job.id),
        sql`${generationJobsTable.providerRequestId} IS NULL`,
      ));
    }
    await db.update(generationJobsTable).set({
      status: "FAILED",
      errorMessage: message,
      failedAt: new Date(),
      ...(reserved ? {
        providerTaskMetadata: {
          model,
          spendLifecycleVersion: FAL_SPEND_LIFECYCLE_VERSION,
          submissionIntent: submissionAttempted,
          submissionOutcome: definitivelyUnbilled
            ? submissionAttempted ? "rejected" : "not-submitted"
            : "unknown",
        },
      } : {}),
    }).where(and(
      eq(generationJobsTable.id, job.id),
      eq(generationJobsTable.status, "UPLOADING"),
    ));
    if (reserved) {
      await settleVideoSpendIfReserved(
        job.id,
        definitivelyUnbilled ? "released" : "uncertain",
        definitivelyUnbilled
          ? "The Cloud request definitively did not enter paid execution."
          : "Cloud submission acceptance could not be determined.",
      );
    }
    throw error;
  }
}

async function completeFalOutput(
  jobId: string,
  client: FalQueueClient,
  requestId: string,
  endpoints: FalQueueEndpoints,
  metadata: Record<string, unknown>,
): Promise<void> {
  const result = await client.result(endpoints);
  const videoUrl = getFalVideoUrl(result);
  let response: Response;
  try {
    response = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new FalHttpError("Could not reach Cloud output storage", null, true);
  }
  if (!response.ok) {
    throw new FalHttpError(
      `Could not download Cloud output (${response.status})`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new FalHttpError("Cloud output download was interrupted", response.status, true);
  }
  let mimeType: "video/mp4" | "video/webm" = response.headers.get("content-type")?.includes("webm")
    || /\.webm(?:\?|$)/i.test(videoUrl) ? "video/webm" : "video/mp4";
  let outputName = `fal-${requestId}.${mimeType === "video/webm" ? "webm" : "mp4"}`;

  const [job] = await db.select({
    tenantId: generationJobsTable.tenantId,
    dialogue: generationJobsTable.dialogue,
    voiceCloningEnabled: generationJobsTable.voiceCloningEnabled,
    voiceCharacterId: generationJobsTable.voiceCharacterId,
    durationSeconds: generationJobsTable.durationSeconds,
    seed: generationJobsTable.seed,
  }).from(generationJobsTable).where(eq(generationJobsTable.id, jobId));
  if (!job) return;
  if (job.voiceCloningEnabled && job.dialogue.trim()) {
    const [speaker, [server]] = await Promise.all([
      selectedVoiceSpeaker(jobId, job.voiceCharacterId),
      db.select().from(comfyServersTable)
        .where(and(eq(comfyServersTable.enabled, true), eq(comfyServersTable.status, "ONLINE")))
        .orderBy(asc(comfyServersTable.priority))
        .limit(1),
    ]);
    if (!speaker?.voiceStorageKey || !speaker.voiceConsentAt) {
      throw new Error("Voice cloning could not complete because the selected speaker's consented voice sample is unavailable");
    }
    if (!server) throw new Error("Voice cloning was requested, but no online ComfyUI voice worker is available");
    await db.update(generationJobsTable).set({ currentNode: "Cloning character voice" })
      .where(eq(generationJobsTable.id, jobId));
    const speech = await generateClonedSpeech({
      client: new ComfyUIClient(server),
      dialogue: job.dialogue,
      referenceAudio: await mediaStorage.readBuffer(speaker.voiceStorageKey),
      seed: job.seed,
    });
    bytes = await muxClonedSpeech({
      video: bytes,
      videoMimeType: mimeType,
      speech,
      targetDurationSeconds: job.durationSeconds,
    });
    mimeType = "video/mp4";
    outputName = `fal-${requestId}-voiced.mp4`;
  }
  const storageKey = await mediaStorage.storeOutput(outputName, mimeType, bytes, job.tenantId);
  await db.update(generationJobsTable).set({
    status: "COMPLETED",
    outputStorageKey: storageKey,
    outputMimeType: mimeType,
    providerTaskMetadata: mergeFalMetadata(metadata, { result }),
    progress: 1,
    currentNode: null,
    errorMessage: null,
    completedAt: new Date(),
  }).where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
}

async function monitorFalGeneration(
  jobId: string,
  client: FalQueueClient,
  requestId: string,
  endpoints: FalQueueEndpoints,
): Promise<void> {
  const timeoutAt = Date.now() + generationTimeoutMs;
  let retryablePollFailures = 0;
  while (Date.now() < timeoutAt) {
    let nextPollDelayMs = 5_000;
    const [job] = await db.select({
      status: generationJobsTable.status,
      providerTaskMetadata: generationJobsTable.providerTaskMetadata,
    })
      .from(generationJobsTable).where(eq(generationJobsTable.id, jobId));
    if (!job || job.status === "CANCELLED") return;
    try {
      const status = await client.status(endpoints);
      retryablePollFailures = 0;
      const normalized = String(status.status ?? "").toUpperCase();
      if (normalized === "COMPLETED") {
        const metadata = mergeFalMetadata(job.providerTaskMetadata, { latestStatus: status });
        await db.update(generationJobsTable).set({
          providerTaskMetadata: metadata,
        }).where(eq(generationJobsTable.id, jobId));
        await settleVideoSpendIfReserved(
          jobId,
          "estimated",
          "Cloud confirmed upstream video generation completed.",
        );
        const [claimed] = await db.update(generationJobsTable).set({
          status: "DOWNLOADING",
          progress: 0.99,
          currentNode: "Retrieving Cloud output",
          providerTaskMetadata: metadata,
        }).where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
          .returning({ id: generationJobsTable.id });
        if (claimed) {
          let outputAttempts = 0;
          while (outputAttempts < 3) {
            try {
              await completeFalOutput(jobId, client, requestId, endpoints, metadata);
              return;
            } catch (error) {
              outputAttempts += 1;
              if (!(error instanceof FalHttpError && error.retryable)) {
                const message = error instanceof Error ? cloudProviderErrorDetail(error.message) : "Cloud output finalization failed";
                await db.update(generationJobsTable).set({
                  status: "FAILED", errorMessage: message, failedAt: new Date(), currentNode: null,
                }).where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
                return;
              }
              if (outputAttempts >= 3) {
                await db.update(generationJobsTable).set({
                  currentNode: "Cloud output temporarily unavailable; retrying",
                  errorMessage: null,
                }).where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
                logger.warn({ err: error, jobId }, "Cloud output remains temporarily unavailable");
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 5_000 * outputAttempts));
            }
          }
        }
        if (!claimed) return;
      }
      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(normalized)) {
        const message = `Cloud generation failed${status.error ? `: ${cloudProviderErrorDetail(status.error)}` : ""}`;
        const [failed] = await db.update(generationJobsTable).set({
          status: "FAILED", errorMessage: message, failedAt: new Date(), currentNode: null,
        }).where(and(
          eq(generationJobsTable.id, jobId),
          inArray(generationJobsTable.status, activeGenerationStatuses),
        )).returning({ id: generationJobsTable.id });
        if (failed) {
          await settleVideoSpendIfReserved(
            jobId,
            "uncertain",
            "Cloud ended the accepted request without confirming that no paid execution occurred.",
          );
        }
        return;
      }
      const running = normalized === "IN_PROGRESS";
      await db.update(generationJobsTable).set({
        status: running ? "RUNNING" : "QUEUED",
        progress: running ? 0.5 : 0.05,
        currentNode: running ? "Cloud processing" : "Waiting in Cloud queue",
        providerTaskMetadata: mergeFalMetadata(job.providerTaskMetadata, { latestStatus: status }),
        startedAt: running ? new Date() : undefined,
      }).where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
    } catch (error) {
      const message = error instanceof Error ? cloudProviderErrorDetail(error.message) : "Cloud monitor failed";
      const retryable = error instanceof FalHttpError && error.retryable;
      if (!retryable) {
        const [failed] = await db.update(generationJobsTable).set({
          status: "FAILED", errorMessage: message, failedAt: new Date(), currentNode: null,
        }).where(and(
          eq(generationJobsTable.id, jobId),
          inArray(generationJobsTable.status, activeGenerationStatuses),
        )).returning({ id: generationJobsTable.id });
        if (failed) {
          await settleVideoSpendIfReserved(
            jobId,
            "uncertain",
            "Cloud monitoring ended without confirmation that no paid execution occurred.",
          );
        }
        return;
      }
      retryablePollFailures += 1;
      nextPollDelayMs = Math.min(60_000, 5_000 * (2 ** Math.min(retryablePollFailures - 1, 4)));
      if (retryablePollFailures >= 5) {
        await db.update(generationJobsTable).set({
          currentNode: "Cloud temporarily unreachable; retrying",
          errorMessage: null,
        }).where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
      }
      logger.warn({ err: error, jobId }, "Could not poll Cloud generation");
    }
    await new Promise((resolve) => setTimeout(resolve, nextPollDelayMs));
  }
  const [timedOut] = await db.update(generationJobsTable).set({
    status: "FAILED",
    errorMessage: "Timed out while waiting for Cloud",
    failedAt: new Date(),
    currentNode: null,
  }).where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
    .returning({ id: generationJobsTable.id });
  if (timedOut) {
    await settleVideoSpendIfReserved(
      jobId,
      "uncertain",
      "Cloud polling timed out after the provider accepted the request.",
    );
  }
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
  if (job.provider === "FAL" && job.providerModelId && job.providerRequestId) {
    const model = (Object.entries(falModels).find(([, id]) => id === job.providerModelId)?.[0]) as FalModel | undefined;
    if (model) {
      try {
        await new FalQueueClient(model).cancel(falEndpointsFromMetadata(job.providerTaskMetadata));
      } catch (error) {
        logger.warn({ err: error, jobId }, "Could not confirm cancellation with Cloud");
        cancellationNote = "Cancelled in OBTV. Cloud could not be reached to confirm cancellation.";
      }
    }
  }
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
    if (job.provider === "FAL") {
      await settleVideoSpendIfReserved(
        job.id,
        "uncertain",
        "Cancellation does not confirm that Cloud performed no paid execution.",
      );
    }
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
  if (job.provider === "FAL") {
    await settleVideoSpendIfReserved(
      job.id,
      "uncertain",
      "Cancellation does not confirm that Cloud performed no paid execution.",
    );
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
  const output = chooseOutput(history, promptId);
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
    .returning({
      id: generationJobsTable.id,
      tenantId: generationJobsTable.tenantId,
      dialogue: generationJobsTable.dialogue,
      durationSeconds: generationJobsTable.durationSeconds,
      seed: generationJobsTable.seed,
      voiceCloningEnabled: generationJobsTable.voiceCloningEnabled,
      voiceCharacterId: generationJobsTable.voiceCharacterId,
    });
  if (!downloading) return false;

  try {
    let bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
    let mimeType: "video/mp4" | "video/webm" = output.filename.toLowerCase().endsWith(".webm")
      ? "video/webm"
      : "video/mp4";
    let outputName = output.filename;

    if (downloading.voiceCloningEnabled && downloading.dialogue.trim()) {
      const speaker = await selectedVoiceSpeaker(jobId, downloading.voiceCharacterId);
      if (!speaker?.voiceStorageKey || !speaker.voiceConsentAt) {
        throw new Error("Voice cloning could not complete because the selected speaker's consented voice sample is unavailable");
      }
      await db
        .update(generationJobsTable)
        .set({ currentNode: "Cloning character voice" })
        .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
      const referenceAudio = await mediaStorage.readBuffer(speaker.voiceStorageKey);
      const speech = await generateClonedSpeech({
        client,
        dialogue: downloading.dialogue,
        referenceAudio,
        seed: downloading.seed,
      });
      await db
        .update(generationJobsTable)
        .set({ currentNode: "Adding character voice" })
        .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
      bytes = await muxClonedSpeech({
        video: bytes,
        videoMimeType: mimeType,
        speech,
        targetDurationSeconds: downloading.durationSeconds,
      });
      mimeType = "video/mp4";
      outputName = output.filename.replace(/\.(webm|mp4)$/i, "-voiced.mp4");
    }

    const storageKey = await mediaStorage.storeOutput(outputName, mimeType, bytes, downloading.tenantId);
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
    try {
      await db
        .update(generationJobsTable)
        .set({
          status: allowTimedOutFailure ? "FAILED" : "RUNNING",
          currentNode: null,
          errorMessage: error instanceof Error ? error.message : "Output finalization failed",
          failedAt: allowTimedOutFailure ? new Date() : null,
        })
        .where(and(eq(generationJobsTable.id, jobId), eq(generationJobsTable.status, "DOWNLOADING")));
    } catch (statusError) {
      logger.error({ err: statusError, jobId }, "Could not restore generation status after output finalization failed");
    }
    throw error;
  }
}

export async function recoverTimedOutGeneration(jobId: string): Promise<boolean> {
  const [job] = await db
    .select()
    .from(generationJobsTable)
    .where(eq(generationJobsTable.id, jobId));
  if (!job || job.status !== "FAILED") {
    return false;
  }
  if (
    job.provider === "FAL" &&
    job.errorMessage !== null &&
    ["Timed out while waiting for Cloud", "Timed out while waiting for fal.ai"].includes(job.errorMessage) &&
    job.providerModelId &&
    job.providerRequestId
  ) {
    const model = (Object.entries(falModels).find(([, id]) => id === job.providerModelId)?.[0]) as FalModel | undefined;
    if (!model) return false;
    try {
      const client = new FalQueueClient(model);
      const endpoints = falEndpointsFromMetadata(job.providerTaskMetadata);
      const status = await client.status(endpoints);
      const normalizedStatus = String(status.status ?? "").toUpperCase();
      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(normalizedStatus)) {
        throw new FalHttpError(
          `Cloud generation failed${status.error ? `: ${cloudProviderErrorDetail(status.error)}` : ""}`,
          null,
          false,
        );
      }
      if (normalizedStatus !== "COMPLETED") return false;
      const completedMetadata = mergeFalMetadata(job.providerTaskMetadata, { latestStatus: status });
      await db.update(generationJobsTable).set({
        providerTaskMetadata: completedMetadata,
      }).where(eq(generationJobsTable.id, jobId));
      await settleVideoSpendIfReserved(
        jobId,
        "estimated",
        "Cloud confirmed upstream video generation completed during recovery.",
      );
      const [claimed] = await db.update(generationJobsTable).set({
        status: "DOWNLOADING",
        currentNode: "Recovering Cloud output",
        errorMessage: null,
        failedAt: null,
      }).where(and(
        eq(generationJobsTable.id, jobId),
        eq(generationJobsTable.status, "FAILED"),
        inArray(generationJobsTable.errorMessage, ["Timed out while waiting for Cloud", "Timed out while waiting for fal.ai"]),
      )).returning({ id: generationJobsTable.id });
      if (!claimed) return false;
      await completeFalOutput(
        jobId,
        client,
        job.providerRequestId,
        endpoints,
        completedMetadata,
      );
      return true;
    } catch (error) {
      const retryable = error instanceof FalHttpError && error.retryable;
      await db.update(generationJobsTable).set({
        status: "FAILED",
        errorMessage: retryable
          ? "Timed out while waiting for Cloud"
          : error instanceof Error ? cloudProviderErrorDetail(error.message) : "Cloud recovery failed",
        failedAt: new Date(),
        currentNode: null,
      }).where(and(
        eq(generationJobsTable.id, jobId),
        inArray(generationJobsTable.status, ["FAILED", "DOWNLOADING"]),
      ));
      logger.warn({ err: error, jobId }, "Could not recover timed-out Cloud output");
      return false;
    }
  }
  if (
    job.errorMessage !== generationTimeoutMessage ||
    !job.comfyPromptId ||
    !job.comfyServerId
  ) return false;
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
  const nodeProgress = new Map<string, number>();
  let lastProgressWriteAt = 0;
  let lastProgress = -1;
  let consecutiveMonitorErrors = 0;
  const persistProgress = (progress: number, currentNode: string | null) => {
    const normalized = Math.min(0.99, Math.max(0, progress));
    const now = Date.now();
    if (
      now - lastProgressWriteAt < 400 &&
      Math.abs(normalized - lastProgress) < 0.01 &&
      currentNode
    ) {
      return;
    }
    lastProgressWriteAt = now;
    lastProgress = normalized;
    void db
      .update(generationJobsTable)
      .set({ progress: normalized, currentNode })
      .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
      .catch((error) => logger.warn({ err: error, jobId }, "Could not persist ComfyUI progress"));
  };

  let disconnectProgress: (() => void) | null = null;
  try {
    disconnectProgress = client.connectProgress(jobId, (message) => {
      const data = message.data;
      if (!data || typeof data !== "object") return;
      const payload = data as Record<string, unknown>;
      if (typeof payload.prompt_id === "string" && payload.prompt_id !== promptId) return;

      if (message.type === "execution_start") {
        persistProgress(0, "ComfyUI processing");
        return;
      }

      if (message.type === "progress") {
        const value = typeof payload.value === "number" ? payload.value : null;
        const max = typeof payload.max === "number" ? payload.max : null;
        if (value === null || max === null || max <= 0) return;
        const node = typeof payload.node === "string" ? payload.node : "current";
        nodeProgress.set(node, Math.min(1, Math.max(0, value / max)));
        persistProgress(nodeProgress.get(node) ?? 0, typeof payload.node === "string" ? `ComfyUI node ${payload.node}` : "ComfyUI processing");
        return;
      }

      if (message.type === "progress_state" && payload.nodes && typeof payload.nodes === "object") {
        const entries = Object.entries(payload.nodes as Record<string, unknown>);
        if (!entries.length) return;
        let total = 0;
        let activeNode: string | null = null;
        for (const [nodeId, rawNode] of entries) {
          if (!rawNode || typeof rawNode !== "object") continue;
          const node = rawNode as Record<string, unknown>;
          const state = typeof node.state === "string" ? node.state : "";
          const value = typeof node.value === "number" ? node.value : 0;
          const max = typeof node.max === "number" && node.max > 0 ? node.max : 1;
          const nodeValue = state === "finished" ? 1 : Math.min(1, Math.max(0, value / max));
          total += nodeValue;
          if (state === "running") activeNode = nodeId;
        }
        const progress = total / entries.length;
        persistProgress(progress, activeNode ? `ComfyUI node ${activeNode}` : "ComfyUI processing");
        return;
      }

      if (message.type === "executing" && typeof payload.node === "string") {
        persistProgress(nodeProgress.get(payload.node) ?? 0, `ComfyUI node ${payload.node}`);
      }
    });
  } catch (error) {
    logger.warn({ err: error, jobId }, "ComfyUI progress WebSocket unavailable; using HTTP monitor");
  }

  try {
    while (Date.now() < timeoutAt) {
      try {
        const [currentJob] = await db
          .select({ status: generationJobsTable.status })
          .from(generationJobsTable)
          .where(eq(generationJobsTable.id, jobId));
        if (!currentJob || currentJob.status === "CANCELLED") return;
      } catch (error) {
        logger.warn({ err: error, jobId }, "Generation monitor could not read job state");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }

      try {
        if (await downloadCompletedOutput(jobId, client, promptId)) return;
        consecutiveMonitorErrors = 0;
      } catch (error) {
        const transientWorkerFailure = isTransientComfyUIRequestError(error);
        if (!transientWorkerFailure) {
          const message = error instanceof Error ? error.message : "Generation output processing failed";
          await db
            .update(generationJobsTable)
            .set({
              status: "FAILED",
              currentNode: null,
              errorMessage: message,
              failedAt: new Date(),
            })
            .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
          logger.error({ err: error, jobId }, "Generation output finalization failed");
          return;
        }
        consecutiveMonitorErrors += 1;
        logger.warn(
          { err: error, jobId, consecutiveMonitorErrors, maxConsecutiveMonitorErrors },
          "Generation monitor could not reach ComfyUI",
        );
        if (consecutiveMonitorErrors >= maxConsecutiveMonitorErrors) {
          const failureMessage = repeatedComfyRequestFailureMessage(error);
          await db
            .update(generationJobsTable)
            .set({
              status: "FAILED",
              currentNode: null,
              errorMessage: failureMessage,
              failedAt: new Date(),
            })
            .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
            .returning({ id: generationJobsTable.id });
          logger.error({ err: error, jobId }, failureMessage);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }

      try {
        const [running] = await db
          .update(generationJobsTable)
          .set({ status: "RUNNING", currentNode: "ComfyUI processing" })
          .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)))
          .returning({ id: generationJobsTable.id });
        if (!running) return;
      } catch (error) {
        logger.warn({ err: error, jobId }, "Generation monitor could not persist running state");
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } finally {
    disconnectProgress?.();
  }
  await db
    .update(generationJobsTable)
    .set({ status: "FAILED", errorMessage: generationTimeoutMessage, failedAt: new Date() })
    .where(and(eq(generationJobsTable.id, jobId), inArray(generationJobsTable.status, activeGenerationStatuses)));
}