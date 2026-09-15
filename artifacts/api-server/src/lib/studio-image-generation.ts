import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  characterAssetsTable,
  charactersTable,
  comfyServersTable,
  db,
  generationJobsTable,
  imageStudioJobsTable,
  pool,
  settingAssetsTable,
  settingsTable,
  type ImageStudioJob,
  type ComfyServer,
} from "@workspace/db";
import {
  ComfyUIClient,
  ComfyUIRequestError,
  isTransientComfyUIRequestError,
} from "./comfy/client";
import { selectServer } from "./comfy/scheduler";
import { createFlux2KleinWorkflow, type Flux2AssetKind } from "./seed-data/flux2-klein";
import { mediaStorage } from "./storage-service";
import { logger } from "./logger";
import {
  cancelImageTask,
  inspectLocalImageCapability,
  pollImageTask,
  submitImageTask,
  type NativeReferenceResizeMode,
  type ImageTaskResult,
} from "./image-studio-adapters";
import {
  invalidateCharacterDossier,
  isCharacterAssetLabel,
  normalizeDossier,
  type CharacterAssetLabel,
} from "./character-dossier-service";
import { getImageModel, type ImageModel } from "./image-studio-models";
import { quoteImageSpend } from "./spending-pricing";
import { reserveSpend, settleSpend } from "./spending-service";

const REQUIRED_TAGS = ["flux2-klein"];
const GENERATION_TIMEOUT_MS = 5 * 60_000;
const CHARACTER_GENERATION_MAX_AGE_MS = 72 * 60 * 60_000;
const CHARACTER_SUBMISSION_PREPARATION_MAX_AGE_MS = 2 * 60_000;
const reservedServers = new Set<string>();
const ACTIVE_VIDEO_STATUSES = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const ACTIVE_IMAGE_STATUSES = ["QUEUED", "RUNNING"] as const;
const CHARACTER_ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;
const CHARACTER_TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const characterMonitors = new Map<string, Promise<void>>();
const characterProgressObservers = new Map<string, { stop: () => void }>();
const CHARACTER_PROGRESS_PERSIST_INTERVAL_MS = 500;
const CHARACTER_PROGRESS_RECONNECT_DELAY_MS = 2_000;
export const CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE =
  "The image worker submission is still being reconciled. No duplicate render will be submitted.";
export const CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE =
  "Cloud image submission status could not be confirmed. No duplicate render was submitted.";
export const CHARACTER_WORKER_FAILURE_MESSAGE =
  "The image worker reported that the character image could not be generated.";
export const CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE =
  "The selected character reference image is unavailable. Select or upload another source image.";
export const CHARACTER_WORKER_COMPONENTS_UNAVAILABLE_MESSAGE =
  "The selected image worker is missing required FLUX.2 Klein nodes or model files.";
export const CHARACTER_WORKER_CAPABILITY_CHECK_MESSAGE =
  "The selected image worker could not be checked before submission. The job will retry preparation without submitting a render.";
export const CHARACTER_NATIVE_REFERENCE_MODE = "native-reference-edit" as const;
export const CHARACTER_TEXT_GENERATION_MODE = "text-to-image" as const;
export const CHARACTER_CLOUD_REFERENCE_MODE = "cloud-reference-edit" as const;
export const CHARACTER_LOCAL_MODEL_ID = "local-flux2-klein-4b" as const;
export const CHARACTER_CLOUD_MODEL_ID = "cloud-nano-banana-pro" as const;
const CHARACTER_CLOUD_SPEND_LIFECYCLE_VERSION = 1;

export type CharacterCloudSettlementJob = Pick<
  ImageStudioJob,
  "id" | "provider" | "providerTaskMetadata" | "providerRequestId" | "status"
>;
export type CharacterCloudSettlementDependencies = {
  settle?: typeof settleSpend;
  persist?: (jobId: string, patch: Record<string, unknown>) => Promise<void>;
};

async function settleCharacterCloudSpend(
  job: CharacterCloudSettlementJob,
  outcome: "estimated" | "released" | "uncertain",
  note: string,
  dependencies: CharacterCloudSettlementDependencies = {},
): Promise<boolean> {
  if (
    job.provider !== "CLOUD"
    || job.providerTaskMetadata.spendLifecycleVersion !== CHARACTER_CLOUD_SPEND_LIFECYCLE_VERSION
  ) {
    return true;
  }
  const settle = dependencies.settle ?? settleSpend;
  const persist = dependencies.persist ?? (async (jobId: string, patch: Record<string, unknown>) => {
    await db.update(imageStudioJobsTable)
      .set({
        providerTaskMetadata: characterMetadataMergeSql(patch),
      })
      .where(eq(imageStudioJobsTable.id, jobId));
  });
  try {
    await settle("image", job.id, outcome, note);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && (error as { statusCode?: unknown }).statusCode === 404
    ) {
      try {
        await persist(job.id, {
          spendSettlementPending: false,
          spendSettlementOutcome: outcome,
          spendSettlementNote: note,
          spendSettledAt: new Date().toISOString(),
          spendSettlementNoReservation: true,
        });
      } catch (persistError) {
        logger.error(
          { err: persistError, jobId: job.id, outcome },
          "Could not persist missing Cloud character spend reservation",
        );
      }
      return true;
    }
    try {
      await persist(job.id, {
        spendSettlementPending: true,
        spendSettlementOutcome: outcome,
        spendSettlementNote: note,
        spendSettlementLastError: error instanceof Error ? error.message.slice(0, 500) : "Unknown settlement error",
      });
    } catch (persistError) {
      logger.error(
        { err: persistError, jobId: job.id, outcome },
        "Could not persist pending Cloud character image settlement",
      );
    }
    logger.error({ err: error, jobId: job.id, outcome }, "Could not settle Cloud character image spend");
    return false;
  }
  try {
    await persist(job.id, {
      spendSettlementPending: false,
      spendSettlementOutcome: outcome,
      spendSettlementNote: note,
      spendSettledAt: new Date().toISOString(),
    });
  } catch (error) {
    // The spend settlement itself succeeded. A later reconciliation pass will
    // repeat the idempotent settlement if this completion marker was lost.
    logger.error({ err: error, jobId: job.id, outcome }, "Could not persist Cloud character settlement completion");
  }
  return true;
}

export async function reconcileCharacterCloudSettlements(
  jobs: CharacterCloudSettlementJob[],
  dependencies: CharacterCloudSettlementDependencies = {},
): Promise<void> {
  for (const job of jobs) {
    if (
      job.provider !== "CLOUD"
      || job.providerTaskMetadata.spendLifecycleVersion !== CHARACTER_CLOUD_SPEND_LIFECYCLE_VERSION
      || typeof job.providerTaskMetadata.spendSettledAt === "string"
    ) {
      continue;
    }
    const pendingOutcome = job.providerTaskMetadata.spendSettlementPending === true
      && (
        job.providerTaskMetadata.spendSettlementOutcome === "estimated"
        || job.providerTaskMetadata.spendSettlementOutcome === "released"
        || job.providerTaskMetadata.spendSettlementOutcome === "uncertain"
      )
      ? job.providerTaskMetadata.spendSettlementOutcome
      : undefined;
    const outcome = pendingOutcome ?? (job.status === "COMPLETED" || job.providerTaskMetadata.finalizedAt
      ? "estimated"
      : job.providerRequestId
        || job.providerTaskMetadata.submissionPromptAttempted === true
        || job.providerTaskMetadata.submissionOutcomeUnknown === true
        ? "uncertain"
        : "released");
    await settleCharacterCloudSpend(
      job,
      outcome,
      `Character Cloud settlement reconciliation: ${outcome}`,
      dependencies,
    );
  }
}

export type CharacterSubmissionFailureOutcome = "RETRY_PREPARATION" | "UNCERTAIN" | "FAILED";
export type CharacterPreparationFailureKind =
  | "SOURCE_UNAVAILABLE"
  | "WORKER_COMPONENTS_UNAVAILABLE"
  | "WORKER_CAPABILITY_CHECK"
  | "WORKER_REFERENCE_UPLOAD"
  | "INVALID_REQUEST"
  | "PREPARATION_CLAIM_LOST"
  | "UNKNOWN";

type ImageOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

export class StudioImageGenerationUnavailableError extends Error {}

export class CharacterImageGenerationConflictError extends Error {}

export type PresentedCharacterImageGeneration = {
  id: string;
  modelId: string;
  modelName: string;
  provider: "LOCAL" | "CLOUD";
  status: ImageStudioJob["status"];
  prompt: string;
  referenceLabel: CharacterAssetLabel | null;
  referenceAssetId: string | null;
  referenceUsed: boolean;
  sourceReference: {
    assetId: string;
    mediaUrl: string;
    label: CharacterAssetLabel;
  } | null;
  seed: number | null;
  serverName: string | null;
  mediaUrl: string | null;
  assetId: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  progress: number | null;
  progressStage: CharacterProgressStage;
  progressStep: number | null;
  progressTotalSteps: number | null;
  progressUpdatedAt: string | null;
  startedAt: string | null;
};

export type CharacterProgressStage = "preparing" | "rendering" | "saving";

export type CharacterProgressPatch = {
  progress?: number | null;
  progressStage?: CharacterProgressStage;
  progressStep?: number | null;
  progressTotalSteps?: number | null;
  progressUpdatedAt?: string | null;
};

export type CharacterProgressState = {
  progress: number | null;
  progressStage: CharacterProgressStage;
  progressStep: number | null;
  progressTotalSteps: number | null;
  progressUpdatedAt: string | null;
};

type CharacterProgressNodeMetadata = {
  sampler?: unknown;
  saving?: unknown;
};

function numericProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function numericProgressStep(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function progressTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function characterProgressState(metadata: Record<string, unknown>): CharacterProgressState {
  const stage = metadata.progressStage;
  return {
    progress: numericProgress(metadata.progress),
    progressStage: stage === "rendering" || stage === "saving" ? stage : "preparing",
    progressStep: numericProgressStep(metadata.progressStep),
    progressTotalSteps: numericProgressStep(metadata.progressTotalSteps),
    progressUpdatedAt: progressTimestamp(metadata.progressUpdatedAt),
  };
}

/**
 * Pure JSON merge used by both tests and the durable SQL merge path. Progress
 * fields are deliberately top-level provider metadata so old submission
 * markers and provider receipts remain untouched when a sampler event lands.
 */
export function mergeCharacterProgressMetadata(
  metadata: Record<string, unknown>,
  patch: CharacterProgressPatch,
): Record<string, unknown> {
  return {
    ...metadata,
    ...(patch.progress === undefined ? {} : { progress: patch.progress }),
    ...(patch.progressStage === undefined ? {} : { progressStage: patch.progressStage }),
    ...(patch.progressStep === undefined ? {} : { progressStep: patch.progressStep }),
    ...(patch.progressTotalSteps === undefined ? {} : { progressTotalSteps: patch.progressTotalSteps }),
    ...(patch.progressUpdatedAt === undefined ? {} : { progressUpdatedAt: patch.progressUpdatedAt }),
  };
}

function nodeIds(metadata: Record<string, unknown>, kind: keyof CharacterProgressNodeMetadata): Set<string> {
  const nodes = metadata.progressNodes;
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return new Set();
  const values = (nodes as CharacterProgressNodeMetadata)[kind];
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is string => typeof value === "string"));
}

export function characterProgressStageForNode(
  node: string,
  metadata: Record<string, unknown> = {},
): CharacterProgressStage {
  if (
    nodeIds(metadata, "saving").has(node)
    || node === "13"
    || node === "10"
    || /save(?:image|preview)?/i.test(node)
  ) return "saving";
  if (nodeIds(metadata, "sampler").has(node) || /sampler/i.test(node)) return "rendering";
  return "preparing";
}

function isCharacterSamplerNode(node: string, metadata: Record<string, unknown>): boolean {
  const samplerNodes = nodeIds(metadata, "sampler");
  if (samplerNodes.size > 0) return samplerNodes.has(node);
  // Character jobs use the Flux2 custom sampler node 11. Keep this fallback
  // for receipts written before progressNodes was added.
  if (node === "11" || node === "8") return true;
  // Comfy's progress event is emitted by sampler implementations. If a
  // future character workflow has no persisted node map yet, accepting a
  // non-empty progress node still reports the sampler value/max truthfully.
  return node.length > 0 && !nodeIds(metadata, "saving").has(node);
}

function characterProgressMessageData(message: Record<string, unknown>): Record<string, unknown> | null {
  const data = message.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

/**
 * Convert one Comfy progress message into a durable patch. The prompt check
 * is strict: a missing or different prompt_id cannot update this character
 * job, even when another prompt shares the same client marker.
 */
export function characterProgressFromComfyMessage(
  message: Record<string, unknown>,
  promptId: string,
  metadata: Record<string, unknown> = {},
): CharacterProgressPatch | null {
  const data = characterProgressMessageData(message);
  if (!data || data.prompt_id !== promptId) return null;
  const type = message.type;
  if (type === "execution_start") {
    return { progressStage: "preparing" };
  }
  if (type === "executing") {
    if (data.node === null) return { progressStage: "saving" };
    const node = typeof data.node === "string"
      ? data.node
      : typeof data.node === "number"
        ? String(data.node)
        : null;
    if (!node) return null;
    return { progressStage: characterProgressStageForNode(node, metadata) };
  }
  if (type !== "progress") return null;
  const node = typeof data.node === "string"
    ? data.node
    : typeof data.node === "number"
      ? String(data.node)
      : "";
  const value = numericProgressStep(data.value);
  const max = numericProgressStep(data.max);
  if (value === null || max === null || max <= 0 || !isCharacterSamplerNode(node, metadata)) {
    return null;
  }
  return {
    // This is the current sampler percentage, not a fabricated whole-workflow
    // average. Multiple sampler nodes simply replace the current sampler
    // reading with the event for the node Comfy is reporting.
    progress: Math.min(1, Math.max(0, value / max)),
    progressStage: "rendering",
    progressStep: value,
    progressTotalSteps: max,
  };
}

export type CharacterReferenceSnapshot = {
  assetId: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  label: CharacterAssetLabel;
  capturedAt: string;
};

const CHARACTER_WIDTH = 768;
const CHARACTER_HEIGHT = 1024;
const CHARACTER_DEFAULT_DENOISE = 0.65;
type CharacterDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type CharacterDbExecutor = typeof db | CharacterDbTransaction;

function characterReferenceSnapshot(value: unknown): CharacterReferenceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as Partial<CharacterReferenceSnapshot>;
  if (
    typeof reference.assetId !== "string"
    || typeof reference.storageKey !== "string"
    || typeof reference.originalName !== "string"
    || typeof reference.mimeType !== "string"
    || typeof reference.capturedAt !== "string"
    || ![
      "headshot",
      "profile",
      "three-quarter",
      "full-body",
      "expression",
      "wardrobe",
      "other",
    ].includes(reference.label ?? "")
  ) {
    return null;
  }
  return reference as CharacterReferenceSnapshot;
}

function mediaStorageKeyFromUrl(value: string | null): string | null {
  if (!value) return null;
  const prefix = "/api/media/";
  const pathname = value.startsWith(prefix)
    ? value
    : (() => {
      try {
        return new URL(value).pathname;
      } catch {
        return "";
      }
    })();
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join("/");
}

type CharacterReferenceCandidate = {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  label: string;
  isPrimary: boolean;
  createdAt: Date;
};

/**
 * Resolve a character source once, before the durable job is inserted. The
 * explicit asset wins; otherwise an intentional primary marker, the current
 * thumbnail, and finally the oldest non-wardrobe image are used in that order.
 * A missing explicit source is an error rather than permission to silently
 * switch to text-only generation.
 */
export function chooseCharacterReferenceAsset(
  assets: CharacterReferenceCandidate[],
  characterThumbnail: string | null,
  explicitAssetId?: string,
): CharacterReferenceCandidate | null {
  if (explicitAssetId !== undefined) {
    const explicit = assets.find((asset) => asset.id === explicitAssetId);
    if (!explicit) throw new Error("Character reference asset not found");
    return explicit;
  }
  const nonWardrobe = assets.filter((asset) => asset.label !== "wardrobe");
  return nonWardrobe.find((asset) => asset.isPrimary)
    ?? nonWardrobe.find((asset) => asset.storageKey === mediaStorageKeyFromUrl(characterThumbnail))
    ?? [...nonWardrobe].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0]
    ?? null;
}

function sourceReferenceForJob(job: ImageStudioJob): CharacterReferenceSnapshot | null {
  return characterReferenceSnapshot(job.providerTaskMetadata.sourceReference);
}

function deterministicCharacterSeed(reference: CharacterReferenceSnapshot): number {
  // FNV-1a keeps the default seed stable for the canonical source without
  // making any claim that a seed guarantees identity preservation.
  let hash = 2_166_136_261;
  for (const character of `${reference.assetId}:${reference.storageKey}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 2_147_483_647;
}

function submissionPreparationIsStale(metadata: Record<string, unknown>): boolean {
  const startedAt = metadata.submissionPreparationStartedAt;
  if (typeof startedAt !== "string") return true;
  const timestamp = Date.parse(startedAt);
  return !Number.isFinite(timestamp)
    || Date.now() - timestamp >= CHARACTER_SUBMISSION_PREPARATION_MAX_AGE_MS;
}

export function createCharacterSubmissionMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    submissionIntent: false,
    submissionPromptAttempted: false,
  };
}

export function reserveCharacterSubmissionMetadata(
  metadata: Record<string, unknown>,
  submissionIntentAt = new Date().toISOString(),
): Record<string, unknown> {
  return {
    ...metadata,
    submissionIntent: true,
    submissionIntentAt,
    spendReserved: true,
    // New jobs already carry an explicit false marker from
    // createCharacterSubmissionMetadata. Preserve an absent marker for
    // legacy jobs so this transition cannot weaken their conservative guard.
    ...(metadata.submissionPromptAttempted === undefined
      ? {}
      : { submissionPromptAttempted: metadata.submissionPromptAttempted === true }),
  };
}

function submissionPromptWasAttempted(metadata: Record<string, unknown>): boolean {
  // Jobs created by the pre-adapter implementation had no phase marker. Keep
  // those jobs on the conservative reconciliation path after a restart.
  return metadata.submissionPromptAttempted === true
    || (
      metadata.submissionIntent === true
      && metadata.submissionPromptAttempted === undefined
    );
}

export function characterCloudSubmissionNeedsReconciliation(job: Pick<
  ImageStudioJob,
  "provider" | "providerRequestId" | "providerTaskMetadata"
>): boolean {
  return job.provider === "CLOUD"
    && !job.providerRequestId
    && job.providerTaskMetadata.submissionIntent === true
    && submissionPromptWasAttempted(job.providerTaskMetadata);
}

export function characterSubmissionFailureOutcome(
  error: unknown,
  promptAttempted: boolean,
): CharacterSubmissionFailureOutcome {
  const retryable = isTransientComfyUIRequestError(error)
    || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true);
  if (!promptAttempted) return retryable ? "RETRY_PREPARATION" : "FAILED";
  const comfyError = error instanceof ComfyUIRequestError;
  return (
    (comfyError && ((isTransientComfyUIRequestError(error))
      || (error as ComfyUIRequestError).kind === "invalid-response"))
    || retryable
    || /submission|prompt ID/i.test(error instanceof Error ? error.message : "")
  )
    ? "UNCERTAIN"
    : "FAILED";
}

export function characterCloudSubmissionFailureOutcome(error: unknown): "UNCERTAIN" | "RELEASED" {
  const status = typeof error === "object"
    && error !== null
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
  // A response with no trustworthy receipt is ambiguous after the provider
  // prompt. Only an explicit non-timeout 4xx rejection proves non-billing.
  return status !== undefined
    && status >= 400
    && status < 500
    && status !== 408
    ? "RELEASED"
    : "UNCERTAIN";
}

function characterPreparationErrorMessage(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "object"
      && error !== null
      && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, "the image worker")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export function characterPreparationFailureDetails(error: unknown): {
  kind: CharacterPreparationFailureKind;
  message: string;
  retryable: boolean;
} {
  const raw = characterPreparationErrorMessage(error);
  const retryable = isTransientComfyUIRequestError(error)
    || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true);
  if (
    /character reference snapshot is unavailable|reference image(?: file)?(?: is)? unavailable|enoent|no such file or directory/i.test(raw)
  ) {
    return {
      kind: "SOURCE_UNAVAILABLE",
      message: CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE,
      retryable: false,
    };
  }
  if (
    /is unavailable on .*required files:/i.test(raw)
    || /native reference editing is unavailable on/i.test(raw)
    || /native reference resize capability is unavailable on/i.test(raw)
  ) {
    return {
      kind: "WORKER_COMPONENTS_UNAVAILABLE",
      message: CHARACTER_WORKER_COMPONENTS_UNAVAILABLE_MESSAGE,
      retryable: false,
    };
  }
  if (
    /could not inspect local worker|capability check|capability data|local worker .* currently unavailable/i.test(raw)
  ) {
    return {
      kind: "WORKER_CAPABILITY_CHECK",
      message: retryable ? CHARACTER_WORKER_CAPABILITY_CHECK_MESSAGE : CHARACTER_WORKER_FAILURE_MESSAGE,
      retryable,
    };
  }
  if (/reference image upload|uploaded image name/i.test(raw)) {
    return {
      kind: "WORKER_REFERENCE_UPLOAD",
      message: retryable
        ? CHARACTER_WORKER_CAPABILITY_CHECK_MESSAGE
        : "The selected image worker rejected the character reference upload.",
      retryable,
    };
  }
  if (/submission preparation claim was lost/i.test(raw)) {
    return {
      kind: "PREPARATION_CLAIM_LOST",
      message: "Character image preparation was claimed by another request. It will not submit a duplicate render.",
      retryable: false,
    };
  }
  if (/must be|requires|does not support|enter an image prompt|unknown image model/i.test(raw)) {
    return {
      kind: "INVALID_REQUEST",
      message: raw || "Character image preparation could not validate the request.",
      retryable: false,
    };
  }
  return {
    kind: "UNKNOWN",
    message: raw || CHARACTER_WORKER_FAILURE_MESSAGE,
    retryable,
  };
}

async function activeDatabaseJobsByServer(): Promise<Map<string, number>> {
  const [videoJobs, imageJobs] = await Promise.all([
    db
      .select({ serverId: generationJobsTable.comfyServerId })
      .from(generationJobsTable)
      .where(inArray(generationJobsTable.status, ACTIVE_VIDEO_STATUSES)),
    db
      .select({ serverId: imageStudioJobsTable.comfyServerId })
      .from(imageStudioJobsTable)
      .where(inArray(imageStudioJobsTable.status, ACTIVE_IMAGE_STATUSES)),
  ]);
  const counts = new Map<string, number>();
  for (const job of [...videoJobs, ...imageJobs]) {
    if (job.serverId) counts.set(job.serverId, (counts.get(job.serverId) ?? 0) + 1);
  }
  return counts;
}

export async function selectCharacterWorker(
  servers: ComfyServer[],
  needsNativeReference: boolean,
  capabilityInspector: typeof inspectLocalImageCapability = inspectLocalImageCapability,
): Promise<{ server: ComfyServer; nativeReferenceResizeMode?: NativeReferenceResizeMode } | null> {
  // Kept as a local selection path so a character reference can never be
  // assigned to a merely healthy FLUX-tagged worker. The explicit capability
  // check is the important contract.
  const candidates = servers
    .filter((server) => (
      server.enabled
      && server.status === "ONLINE"
      && server.activeJobCount < (server.maxConcurrentJobs ?? 1)
      && server.tags.some((tag) => tag.trim().toLowerCase() === "flux2-klein")
    ))
    .sort((left, right) => (
      left.queueSize - right.queueSize
      || left.activeJobCount - right.activeJobCount
      || left.priority - right.priority
      || left.id.localeCompare(right.id)
    ));
  if (!needsNativeReference) {
    return candidates[0] ? { server: candidates[0] } : null;
  }
  for (const candidate of candidates) {
    try {
      const capability = await capabilityInspector(
        "local-flux2-klein-4b",
        candidate,
        { referenceMode: CHARACTER_NATIVE_REFERENCE_MODE },
      );
      if (capability?.nativeReferenceResizeMode) {
        return {
          server: candidate,
          nativeReferenceResizeMode: capability.nativeReferenceResizeMode,
        };
      }
    } catch (error) {
      logger.warn(
        { err: error, serverId: candidate.id, serverName: candidate.displayName },
        "Character native-reference capability check skipped a worker",
      );
    }
  }
  return null;
}

async function acquireServerLock(serverId: string): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`comfy-server:${serverId}`],
    );
    if (!result.rows[0]?.locked) {
      throw new StudioImageGenerationUnavailableError(
        "The selected GPU is being reserved by another render. Try again shortly.",
      );
    }
    return async () => {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`comfy-server:${serverId}`]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

export function buildPrompt(
  kind: Flux2AssetKind,
  entity: { name: string; description: string; promptDescription: string },
  requestedPrompt?: string,
  referenceLabel?: CharacterAssetLabel,
  identity?: { role: string; performanceNotes: string },
): string {
  const subject = requestedPrompt?.trim() || entity.promptDescription.trim() || entity.description.trim();
  if (!subject) throw new Error("Add an image prompt before generating.");
  if (kind === "character") {
    const shotView = (() => {
      switch (referenceLabel) {
        case "headshot":
          return "Headshot framing, front-facing view.";
        case "profile":
          return "Full 90-degree side profile; exactly one eye visible.";
        case "three-quarter":
          return "45-degree three-quarter view.";
        case "full-body":
          return "Full-body framing, front-facing stance.";
        case "expression":
          return "Head-and-shoulders expression study, front-facing view.";
        case "wardrobe":
          return "Full-length, head-to-toe outfit/costume continuity reference of one person wearing the clothing; feet and shoes fully visible. Wardrobe means clothing worn by the person, not a closet, room, cupboard, clothing rack, hangers, garment display, or extra garments; use a plain uncluttered backdrop with no background props unless the explicit prompt requests an actual closet or other environment.";
        default:
          return "";
      }
    })();
    return [
      "Production character reference image for film and video continuity.",
      `Character: ${entity.name}.`,
      "When an original reference is supplied, depict the same person as that original.",
      "Preserve the original person's face, hair, skin tone, and wardrobe.",
      shotView,
      subject,
      entity.description.trim(),
      identity?.role?.trim() ? `Role: ${identity.role.trim()}.` : "",
      identity?.performanceNotes?.trim() ? `Performance notes: ${identity.performanceNotes.trim()}.` : "",
      "One character only, clean uncluttered studio background, realistic anatomy, natural skin and fabric detail, cinematic soft lighting, sharp focus, no typography, no watermark.",
    ].filter(Boolean).join(" ");
  }
  return [
    "Production environment reference image for film and video continuity.",
    `Location: ${entity.name}.`,
    subject,
    entity.description.trim(),
    "Wide establishing composition, environment only, no people, coherent architecture and geography, cinematic natural lighting, photoreal materials, deep detail, sharp focus, no typography, no watermark.",
  ].filter(Boolean).join(" ");
}

export function buildNativeReferenceEditPrompt(
  requestedPrompt?: string,
  referenceLabel?: CharacterAssetLabel,
): string {
  const viewInstruction = (() => {
    switch (referenceLabel) {
      case "headshot":
        return "Requested view: headshot, front-facing.";
      case "profile":
        return "Requested view: strict 90-degree left-facing side profile; exactly one eye visible; nose and chin silhouette; far eye hidden; shoulders side-on.";
      case "three-quarter":
        return "Requested view: explicit 45-degree three-quarter view.";
      case "full-body":
        return "Requested view: full-body framing, preserving the source pose unless the additional instruction says otherwise.";
      case "expression":
        return "Requested view: head-and-shoulders expression framing.";
      case "wardrobe":
        return "Requested wardrobe view: full-length, head-to-toe outfit/costume continuity reference of the same person wearing the referenced outfit; feet and shoes fully visible. Retain the original identity and all visible outfit details unless the explicit additional edit requests an outfit change. Wardrobe means clothing worn by the person, not a closet, room, cupboard, clothing rack, hangers, garment display, or extra garments. Retain a plain/source backdrop with no background props unless the explicit additional edit requests an actual closet or other environment.";
      default:
        return "Requested view: preserve the source framing.";
    }
  })();
  const additionalInstruction = requestedPrompt?.trim();
  return [
    "Image edit instruction: use the original visual reference as authoritative.",
    "Keep the same unchanged subject; apply the requested view change and only the explicit additional user edit below.",
    "Preserve the original face, hair texture, hair length, hair part, skin details, visible clothing fabric, neckline, and jewelry.",
    viewInstruction,
    "Do not introduce props, equipment, new clothing, or a new background scene unless the explicit additional edit requests it; retain the source background visually without copying the exact pixels.",
    additionalInstruction ? `Additional user edit instruction: ${additionalInstruction}` : "",
  ].filter(Boolean).join(" ");
}

function chooseImageOutput(history: Record<string, unknown>, promptId: string): ImageOutput | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const outputs = (prompt as { outputs?: Record<string, Record<string, unknown>> }).outputs;
  if (!outputs) return null;
  for (const output of Object.values(outputs)) {
    if (!Array.isArray(output.images)) continue;
    for (const file of output.images as Array<Record<string, unknown>>) {
      if (typeof file.filename === "string" && /\.(png|jpe?g|webp)$/i.test(file.filename)) {
        return {
          filename: file.filename,
          subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
          type: typeof file.type === "string" ? file.type : "output",
        };
      }
    }
  }
  return null;
}

export function characterHistoryError(history: Record<string, unknown>, promptId: string): string | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const status = (prompt as { status?: { status_str?: unknown; messages?: unknown } }).status;
  if (status?.status_str !== "error") return null;
  logger.error(
    { promptId, workerMessages: status.messages },
    "ComfyUI reported a character/image generation failure",
  );
  return CHARACTER_WORKER_FAILURE_MESSAGE;
}

async function waitForImage(client: ComfyUIClient, promptId: string): Promise<ImageOutput> {
  const timeoutAt = Date.now() + GENERATION_TIMEOUT_MS;
  while (Date.now() < timeoutAt) {
    const history = await client.getHistory(promptId);
    const error = characterHistoryError(history, promptId);
    if (error) throw new Error(error);
    const output = chooseImageOutput(history, promptId);
    if (output) return output;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Image generation timed out after 5 minutes.");
}

function imageMimeType(filename: string): "image/jpeg" | "image/png" | "image/webp" {
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  return "image/png";
}

export async function generateStudioImage(input: {
  kind: Flux2AssetKind;
  entityId: string;
  tenantId: string;
  prompt?: string;
  seed?: number;
  referenceLabel?: CharacterAssetLabel;
}): Promise<{ ok: true; assetId: string; mediaUrl: string; serverName: string; seed: number }> {
  const [entity] = input.kind === "character"
    ? await db.select().from(charactersTable).where(and(eq(charactersTable.id, input.entityId), eq(charactersTable.tenantId, input.tenantId)))
    : await db.select().from(settingsTable).where(and(eq(settingsTable.id, input.entityId), eq(settingsTable.tenantId, input.tenantId)));
  if (!entity) throw new Error(`${input.kind === "character" ? "Character" : "Setting"} not found`);

  const activeByServer = await activeDatabaseJobsByServer();
  const servers = (await db.select().from(comfyServersTable))
    .map((server) => ({
      ...server,
      activeJobCount: Math.max(server.activeJobCount, activeByServer.get(server.id) ?? 0),
    }))
    .filter((server) => !reservedServers.has(server.id));
  const server = selectServer(servers, REQUIRED_TAGS);
  if (!server) {
    throw new StudioImageGenerationUnavailableError(
      "No FLUX.2 Klein worker is currently available. Check GPU status or wait for the active render to finish.",
    );
  }

  reservedServers.add(server.id);
  let releaseServerLock: (() => Promise<void>) | undefined;
  try {
    releaseServerLock = await acquireServerLock(server.id);
    const currentActive = await activeDatabaseJobsByServer();
    if (
      Math.max(server.activeJobCount, currentActive.get(server.id) ?? 0)
      >= (server.maxConcurrentJobs ?? 1)
    ) {
      throw new StudioImageGenerationUnavailableError(
        `${server.displayName} is at its safe render capacity.`,
      );
    }
    const seed = input.seed === undefined
      ? Math.floor(Math.random() * 2_147_483_647)
      : Math.floor(input.seed);
    const characterDossier = input.kind === "character"
      ? normalizeDossier((entity as { dossier?: unknown }).dossier)
      : undefined;
    const prompt = buildPrompt(
      input.kind,
      entity,
      input.prompt,
      input.referenceLabel,
      characterDossier,
    );
    const client = new ComfyUIClient(server);
    const workflow = createFlux2KleinWorkflow({ kind: input.kind, prompt, seed });
    const promptId = randomUUID();
    const submitted = await client.submitWorkflow(workflow, promptId);
    const output = await waitForImage(client, submitted.prompt_id);
    const bytes = await client.getOutputFile(output.filename, output.subfolder, output.type);
    const mimeType = imageMimeType(output.filename);
    const storageKey = await mediaStorage.storeImage(output.filename, mimeType, bytes, input.kind === "character" ? "characters" : "settings", input.tenantId);
    const mediaUrl = `/api/media/${storageKey}`;

    if (input.kind === "character") {
      try {
        const asset = await db.transaction(async (tx) => {
          const [created] = await tx.insert(characterAssetsTable).values({
            characterId: entity.id,
            storageKey,
            originalName: output.filename.slice(0, 255),
            mimeType,
            angle: input.referenceLabel ?? "AI generated reference",
            label: input.referenceLabel ?? "other",
            isPrimary: !entity.thumbnail && input.referenceLabel !== "wardrobe",
            description: prompt.slice(0, 500),
          }).returning();
          await invalidateCharacterDossier(input.tenantId, entity.id, tx);
          if (!entity.thumbnail && input.referenceLabel !== "wardrobe") {
            await tx.update(characterAssetsTable)
              .set({ isPrimary: false })
              .where(eq(characterAssetsTable.characterId, entity.id));
            await tx.update(characterAssetsTable)
              .set({ isPrimary: true })
              .where(eq(characterAssetsTable.id, created.id));
            await tx.update(charactersTable).set({ thumbnail: mediaUrl }).where(eq(charactersTable.id, entity.id));
          }
          return created;
        });
        return { ok: true, assetId: asset.id, mediaUrl, serverName: server.displayName, seed };
      } catch (error) {
        await mediaStorage.deleteOutput(storageKey).catch(() => undefined);
        throw error;
      }
    }

    const [asset] = await db.insert(settingAssetsTable).values({
      settingId: entity.id,
      storageKey,
      originalName: output.filename.slice(0, 255),
      mimeType,
      description: prompt.slice(0, 500),
    }).returning();
    if (!entity.thumbnail) {
      await db.update(settingsTable).set({ thumbnail: mediaUrl }).where(eq(settingsTable.id, entity.id));
    }
    return { ok: true, assetId: asset.id, mediaUrl, serverName: server.displayName, seed };
  } finally {
    await releaseServerLock?.();
    reservedServers.delete(server.id);
  }
}

function characterGenerationError(error: unknown): string {
  if (error instanceof ComfyUIRequestError) return CHARACTER_WORKER_FAILURE_MESSAGE;
  const raw = error instanceof Error ? error.message : "Character image generation failed";
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, "the image worker")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800) || "Character image generation failed";
}

function characterGenerationResponse(
  job: ImageStudioJob,
  serverName?: string | null,
): PresentedCharacterImageGeneration {
  const referenceLabel = job.referenceLabel && [
    "headshot",
    "profile",
    "three-quarter",
    "full-body",
    "expression",
    "wardrobe",
    "other",
  ].includes(job.referenceLabel)
    ? job.referenceLabel as CharacterAssetLabel
    : null;
  const sourceReference = sourceReferenceForJob(job);
  const referenceUsed = job.providerTaskMetadata.referenceUsed === true || Boolean(sourceReference);
  const progress = characterProgressState(job.providerTaskMetadata);
  const errorMessage = job.provider === "CLOUD"
    && job.status === "FAILED"
    && job.errorMessage === CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE
    ? CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE
    : job.errorMessage;
  return {
    id: job.id,
    modelId: job.modelId,
    modelName: job.modelName,
    provider: job.provider,
    status: job.status,
    prompt: job.prompt,
    referenceLabel,
    referenceAssetId: sourceReference?.assetId ?? null,
    referenceUsed,
    sourceReference: sourceReference
      ? {
        assetId: sourceReference.assetId,
        mediaUrl: `/api/media/${sourceReference.storageKey}`,
        label: sourceReference.label,
      }
      : null,
    seed: job.seed,
    serverName: serverName ?? null,
    mediaUrl: job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
    assetId: typeof job.providerTaskMetadata.characterAssetId === "string"
      ? job.providerTaskMetadata.characterAssetId
      : null,
    errorMessage,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    progress: job.status === "COMPLETED" ? 1 : progress.progress,
    progressStage: job.status === "COMPLETED" ? "saving" : progress.progressStage,
    progressStep: progress.progressStep,
    progressTotalSteps: progress.progressTotalSteps,
    progressUpdatedAt: progress.progressUpdatedAt,
    startedAt: job.startedAt?.toISOString() ?? null,
  };
}

async function characterImageJobServer(job: ImageStudioJob) {
  if (!job.comfyServerId) return undefined;
  const [server] = await db
    .select()
    .from(comfyServersTable)
    .where(eq(comfyServersTable.id, job.comfyServerId))
    .limit(1);
  return server;
}

async function getCharacterImageJob(jobId: string): Promise<ImageStudioJob | undefined> {
  const [job] = await db
    .select()
    .from(imageStudioJobsTable)
    .where(eq(imageStudioJobsTable.id, jobId))
    .limit(1);
  return job;
}

function characterMetadataMergeSql(patch: Record<string, unknown>) {
  return sql`${imageStudioJobsTable.providerTaskMetadata} || ${JSON.stringify(patch)}::jsonb`;
}

export type CharacterReceiptWriter = (
  fallback: boolean,
  patch: {
    status: "RUNNING";
    provider: "LOCAL" | "CLOUD";
    providerRequestId: string;
    submittedAt: Date;
    metadata: Record<string, unknown>;
  },
) => Promise<ImageStudioJob | undefined>;

function characterReceiptPatch(submitted: Awaited<ReturnType<typeof submitImageTask>>) {
  return {
    status: "RUNNING" as const,
    provider: submitted.provider,
    providerRequestId: submitted.requestId,
    submittedAt: new Date(),
    metadata: submitted.metadata,
  } as const;
}

const defaultCharacterReceiptWriter: (
  jobId: string,
  fallback: boolean,
  patch: ReturnType<typeof characterReceiptPatch>,
) => Promise<ImageStudioJob | undefined> = async (jobId, fallback, receipt) => {
  const [updated] = await db.update(imageStudioJobsTable)
    .set({
      provider: receipt.provider,
      providerRequestId: receipt.providerRequestId,
      status: receipt.status,
      startedAt: receipt.submittedAt,
      submittedAt: receipt.submittedAt,
      errorMessage: null,
      providerTaskMetadata: characterMetadataMergeSql({
        ...receipt.metadata,
        submissionAcceptedAt: receipt.submittedAt.toISOString(),
        ...(fallback ? { submissionReceiptRecoveredAt: receipt.submittedAt.toISOString() } : {}),
      }),
    })
    .where(and(
      eq(imageStudioJobsTable.id, jobId),
      inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
      isNull(imageStudioJobsTable.providerRequestId),
    ))
    .returning();
  return updated;
};

export async function persistCharacterProviderReceipt(
  jobId: string,
  submitted: Awaited<ReturnType<typeof submitImageTask>>,
  writer?: CharacterReceiptWriter,
): Promise<ImageStudioJob | undefined> {
  const patch = characterReceiptPatch(submitted);
  const write = writer
    ? (fallback: boolean, receipt: typeof patch) => writer(fallback, receipt)
    : (fallback: boolean, receipt: typeof patch) => defaultCharacterReceiptWriter(jobId, fallback, receipt);
  try {
    return await write(false, patch);
  } catch (firstError) {
    logger.warn({ err: firstError, jobId }, "Character provider receipt write failed; retrying guarded receipt persistence");
    try {
      return await write(true, patch);
    } catch (fallbackError) {
      logger.error(
        { err: fallbackError, jobId, providerRequestId: submitted.requestId },
        "Character provider receipt fallback write failed",
      );
      throw fallbackError;
    }
  }
}

export async function persistCharacterAcceptedReceiptRecovery(
  jobId: string,
  submitted: Awaited<ReturnType<typeof submitImageTask>>,
  writer?: CharacterReceiptWriter,
): Promise<ImageStudioJob | undefined> {
  const patch = characterReceiptPatch(submitted);
  return writer
    ? writer(true, patch)
    : defaultCharacterReceiptWriter(jobId, true, patch);
}

export type CharacterCloudUncertainWriter = (patch: {
  status: "FAILED";
  errorMessage: string;
  providerTaskMetadata: Record<string, unknown>;
}) => Promise<void>;

export async function markCharacterCloudSubmissionUncertain(
  jobId: string,
  currentMetadata: Record<string, unknown>,
  writer?: CharacterCloudUncertainWriter,
): Promise<void> {
  const providerTaskMetadata = {
    ...currentMetadata,
    submissionOutcomeUnknown: true,
    submissionUncertainAt: new Date().toISOString(),
  };
  const patch = {
    status: "FAILED" as const,
    errorMessage: CHARACTER_CLOUD_SUBMISSION_UNCERTAIN_MESSAGE,
    providerTaskMetadata,
  };
  if (writer) {
    await writer(patch);
    return;
  }
  await db.update(imageStudioJobsTable)
    .set({
      status: patch.status,
      errorMessage: patch.errorMessage,
      providerTaskMetadata: characterMetadataMergeSql({
        submissionOutcomeUnknown: true,
        submissionUncertainAt: providerTaskMetadata.submissionUncertainAt,
      }),
    })
    .where(and(
      eq(imageStudioJobsTable.id, jobId),
      inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
      isNull(imageStudioJobsTable.providerRequestId),
    ));
}

export type CharacterProgressObserverInput = {
  clientId: string;
  promptId: string;
  metadata: Record<string, unknown>;
  connectProgress: (
    clientId: string,
    onMessage: (message: Record<string, unknown>) => void,
    onDisconnect: () => void,
  ) => () => void;
  isActive: () => Promise<boolean>;
  persist: (patch: CharacterProgressPatch) => Promise<void> | void;
  markRunning: () => Promise<void> | void;
  reconnectDelayMs?: number;
  persistIntervalMs?: number;
  onStopped?: () => void;
};

export type CharacterProgressObserver = {
  stop: () => void;
};

/**
 * Own the Comfy progress socket independently from the HTTP monitor. It is
 * intentionally dependency-injected so tests can provide a mock WebSocket
 * without rendering, uploading, cancelling, or restarting a worker.
 */
export function createCharacterProgressObserver(
  input: CharacterProgressObserverInput,
): CharacterProgressObserver {
  let stopped = false;
  let disconnect: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let latestMetadata = input.metadata;
  let latestState = characterProgressState(latestMetadata);
  let lastPersistAt = 0;
  let pendingPatch: CharacterProgressPatch | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnectDuringConnect = false;

  const persistPatch = (patch: CharacterProgressPatch) => {
    if (stopped) return;
    const stageChanged = patch.progressStage !== undefined && patch.progressStage !== latestState.progressStage;
    const timestamped = {
      ...patch,
      progressUpdatedAt: new Date().toISOString(),
    };
    latestMetadata = mergeCharacterProgressMetadata(latestMetadata, timestamped);
    latestState = {
      ...latestState,
      ...timestamped,
      progress: timestamped.progress === undefined ? latestState.progress : timestamped.progress,
      progressStage: timestamped.progressStage ?? latestState.progressStage,
      progressStep: timestamped.progressStep === undefined ? latestState.progressStep : timestamped.progressStep,
      progressTotalSteps: timestamped.progressTotalSteps === undefined
        ? latestState.progressTotalSteps
        : timestamped.progressTotalSteps,
      progressUpdatedAt: timestamped.progressUpdatedAt,
    };
    const persistIntervalMs = input.persistIntervalMs ?? CHARACTER_PROGRESS_PERSIST_INTERVAL_MS;
    const shouldPersist = stageChanged || Date.now() - lastPersistAt >= persistIntervalMs;
    if (shouldPersist) {
      lastPersistAt = Date.now();
      void Promise.resolve(input.persist(timestamped)).catch((error: unknown) => {
        logger.warn({ err: error, jobId: input.clientId }, "Could not persist character image progress");
      });
      return;
    }
    pendingPatch = timestamped;
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const queued = pendingPatch;
      pendingPatch = null;
      if (queued && !stopped) {
        lastPersistAt = Date.now();
        void Promise.resolve(input.persist(queued)).catch((error: unknown) => {
          logger.warn({ err: error, jobId: input.clientId }, "Could not persist character image progress");
        });
      }
    }, Math.max(0, persistIntervalMs - (Date.now() - lastPersistAt)));
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pendingTimer) clearTimeout(pendingTimer);
    reconnectTimer = null;
    pendingTimer = null;
    pendingPatch = null;
    const disposer = disconnect;
    disconnect = null;
    try {
      disposer?.();
    } catch (error) {
      logger.warn({ err: error, jobId: input.clientId }, "Could not close character image progress WebSocket");
    } finally {
      input.onStopped?.();
    }
  };

  const reconnect = (delayMs: number) => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attach();
    }, delayMs);
  };

  const handleDisconnect = () => {
    const disposer = disconnect;
    disconnect = null;
    if (disposer) {
      try {
        disposer();
      } catch (error) {
        logger.warn({ err: error, jobId: input.clientId }, "Could not close character image progress WebSocket");
      }
    } else {
      // A synchronous mock/provider callback can fire before connectProgress
      // returns its disposer. Close it immediately after the call returns.
      disconnectDuringConnect = true;
    }
    if (stopped) return;
    void Promise.resolve(input.markRunning()).catch((error: unknown) => {
      logger.warn({ err: error, jobId: input.clientId }, "Could not preserve running character image status");
    });
    reconnect(input.reconnectDelayMs ?? CHARACTER_PROGRESS_RECONNECT_DELAY_MS);
  };

  const handleMessage = (message: Record<string, unknown>) => {
    if (stopped) return;
    const patch = characterProgressFromComfyMessage(
      message,
      input.promptId,
      latestMetadata,
    );
    if (!patch) return;
    persistPatch(patch);
  };

  async function attach(): Promise<void> {
    if (stopped) return;
    try {
      const active = await input.isActive();
      if (stopped) return;
      if (!active) {
        stop();
        return;
      }
    } catch (error) {
      if (stopped) return;
      logger.warn({ err: error, jobId: input.clientId }, "Could not verify active character image progress observer");
      reconnect(input.reconnectDelayMs ?? CHARACTER_PROGRESS_RECONNECT_DELAY_MS);
      return;
    }
    try {
      disconnectDuringConnect = false;
      const disposer = input.connectProgress(input.clientId, handleMessage, handleDisconnect);
      disconnect = disposer;
      if (stopped || disconnectDuringConnect) {
        disconnect = null;
        disposer();
      }
    } catch (error) {
      logger.warn({ err: error, jobId: input.clientId }, "Character image progress WebSocket unavailable");
      if (stopped) return;
      await Promise.resolve(input.markRunning()).catch(() => undefined);
      if (stopped) return;
      reconnect(input.reconnectDelayMs ?? CHARACTER_PROGRESS_RECONNECT_DELAY_MS);
    }
  }

  void attach();
  return { stop };
}

function stopCharacterProgressObserver(jobId: string): void {
  const observer = characterProgressObservers.get(jobId);
  if (!observer) return;
  characterProgressObservers.delete(jobId);
  observer.stop();
}

function startCharacterProgressObserver(
  job: ImageStudioJob,
  server: NonNullable<Awaited<ReturnType<typeof characterImageJobServer>>>,
): void {
  if (!job.providerRequestId || characterProgressObservers.has(job.id)) return;
  const promptId = job.providerRequestId;
  const observer = createCharacterProgressObserver({
    clientId: job.id,
    promptId,
    metadata: job.providerTaskMetadata,
    connectProgress: (clientId, onMessage, onDisconnect) => (
      new ComfyUIClient(server).connectProgress(clientId, onMessage, onDisconnect)
    ),
    isActive: async () => {
      const current = await getCharacterImageJob(job.id);
      return Boolean(
        current
        && current.providerRequestId === promptId
        && CHARACTER_ACTIVE_STATUSES.includes(current.status as typeof CHARACTER_ACTIVE_STATUSES[number]),
      );
    },
    persist: async (patch) => {
      await db.update(imageStudioJobsTable)
        .set({ providerTaskMetadata: characterMetadataMergeSql(patch) })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          eq(imageStudioJobsTable.providerRequestId, promptId),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
    },
    markRunning: async () => {
      await db.update(imageStudioJobsTable)
        .set({ status: "RUNNING" })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          eq(imageStudioJobsTable.providerRequestId, promptId),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
    },
    onStopped: () => {
      if (characterProgressObservers.get(job.id)?.stop === observer.stop) {
        characterProgressObservers.delete(job.id);
      }
    },
  });
  characterProgressObservers.set(job.id, observer);
}

async function finalizeCharacterImageJob(
  job: ImageStudioJob,
  output: ImageOutput | undefined,
  bytes?: Buffer,
  outputName?: string,
): Promise<void> {
  if (!job.characterId) throw new Error("Character image job has no character target");
  const outputFilename = outputName ?? output?.filename ?? "character-output.png";
  let storageKey = job.outputStorageKey;
  let mimeType = job.outputMimeType as "image/jpeg" | "image/png" | "image/webp" | null;
  let storedHere = false;
  if (storageKey) {
    try {
      await mediaStorage.readBuffer(storageKey);
    } catch {
      // A local media volume may have been replaced between restarts. Keep the
      // durable provider prompt and replace only the missing local copy.
      await db.update(imageStudioJobsTable)
        .set({ outputStorageKey: null, outputMimeType: null })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
      storageKey = null;
      mimeType = null;
    }
  }
  if (!storageKey) {
    const outputBytes = bytes ?? await (async () => {
      if (!output) throw new Error("Generated image output descriptor is unavailable");
      const server = await characterImageJobServer(job);
      if (!server) throw new Error("The assigned image worker is no longer configured");
      return new ComfyUIClient(server).getOutputFile(output.filename, output.subfolder, output.type);
    })();
    mimeType = imageMimeType(outputFilename);
    storageKey = await mediaStorage.storeImage(
      outputFilename,
      mimeType,
      outputBytes,
      "characters",
      job.tenantId,
    );
    storedHere = true;
    const [persisted] = await db
      .update(imageStudioJobsTable)
      .set({ outputStorageKey: storageKey, outputMimeType: mimeType })
      .where(and(
        eq(imageStudioJobsTable.id, job.id),
        inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        isNull(imageStudioJobsTable.outputStorageKey),
      ))
      .returning();
    if (!persisted) {
      const latest = await getCharacterImageJob(job.id);
      if (latest?.outputStorageKey) {
        await mediaStorage.deleteOutput(storageKey).catch(() => undefined);
        storageKey = latest.outputStorageKey;
        mimeType = latest.outputMimeType as "image/jpeg" | "image/png" | "image/webp" | null;
        storedHere = false;
      }
    }
  }
  if (!storageKey || !mimeType) throw new Error("Generated image output is unavailable");

  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(imageStudioJobsTable)
        .where(eq(imageStudioJobsTable.id, job.id))
        .for("update")
        .limit(1);
      if (!current || !CHARACTER_ACTIVE_STATUSES.includes(current.status as typeof CHARACTER_ACTIVE_STATUSES[number])) {
        return;
      }
      const [character] = await tx
        .select()
        .from(charactersTable)
        .where(and(
          eq(charactersTable.id, current.characterId!),
          eq(charactersTable.tenantId, current.tenantId),
        ))
        .for("update")
        .limit(1);
      if (!character) {
        await tx
          .update(imageStudioJobsTable)
          .set({ status: "FAILED", errorMessage: "Character was deleted before image finalization" })
          .where(eq(imageStudioJobsTable.id, current.id));
        return;
      }
      const [existingAsset] = await tx
        .select({ id: characterAssetsTable.id })
        .from(characterAssetsTable)
        .where(and(
          eq(characterAssetsTable.characterId, character.id),
          eq(characterAssetsTable.storageKey, storageKey!),
        ))
        .limit(1);
      const existingCharacterAssets = await tx
        .select({
          id: characterAssetsTable.id,
          storageKey: characterAssetsTable.storageKey,
          label: characterAssetsTable.label,
          isPrimary: characterAssetsTable.isPrimary,
        })
        .from(characterAssetsTable)
        .where(eq(characterAssetsTable.characterId, character.id));
      const sourceReference = sourceReferenceForJob(current);
      const hasExistingNonWardrobe = existingCharacterAssets.some((asset) => asset.label !== "wardrobe");
      const shouldBecomePrimary = !sourceReference
        && !hasExistingNonWardrobe
        && !character.thumbnail
        && current.referenceLabel !== "wardrobe";
      let assetId = existingAsset?.id;
      if (!assetId) {
        const [created] = await tx.insert(characterAssetsTable).values({
          characterId: character.id,
          storageKey: storageKey!,
          originalName: outputFilename.slice(0, 255),
          mimeType,
          angle: current.referenceLabel ?? "AI generated reference",
          label: current.referenceLabel ?? "other",
          isPrimary: shouldBecomePrimary,
          description: current.prompt.slice(0, 500),
        }).returning({ id: characterAssetsTable.id });
        assetId = created?.id;
        if (!assetId) throw new Error("Generated image asset could not be created");
        if (shouldBecomePrimary) {
          await tx.update(characterAssetsTable)
            .set({ isPrimary: false })
            .where(eq(characterAssetsTable.characterId, character.id));
          await tx.update(characterAssetsTable)
            .set({ isPrimary: true })
            .where(eq(characterAssetsTable.id, assetId));
          await tx.update(charactersTable)
            .set({ thumbnail: `/api/media/${storageKey}` })
            .where(eq(charactersTable.id, character.id));
        }
      }
      await invalidateCharacterDossier(current.tenantId, character.id, tx);
      await tx.update(imageStudioJobsTable)
        .set({
          status: "COMPLETED",
          outputStorageKey: storageKey,
          outputMimeType: mimeType,
          completedAt: new Date(),
          errorMessage: null,
          providerTaskMetadata: {
            ...current.providerTaskMetadata,
            characterAssetId: assetId,
            finalizedAt: new Date().toISOString(),
            progress: 1,
            progressStage: "saving",
            progressStep: typeof current.providerTaskMetadata.progressTotalSteps === "number"
              ? current.providerTaskMetadata.progressTotalSteps
              : current.providerTaskMetadata.progressStep ?? null,
            progressUpdatedAt: new Date().toISOString(),
          },
        })
        .where(and(
          eq(imageStudioJobsTable.id, current.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
    });
  } catch (error) {
    if (storedHere) await mediaStorage.deleteOutput(storageKey).catch(() => undefined);
    throw error;
  }
}

function containsComfyClientMarker(value: unknown, marker: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsComfyClientMarker(item, marker));
  }
  const object = value as Record<string, unknown>;
  if (object.client_id === marker || object.clientId === marker) return true;
  return ["extra_data", "extra", "metadata"].some((key) => (
    containsComfyClientMarker(object[key], marker)
  ));
}

export function findCharacterComfyClientPromptId(items: unknown[], marker: string): string | undefined {
  for (const item of items) {
    if (!Array.isArray(item)) continue;
    const promptId = item[1];
    if (typeof promptId === "string" && containsComfyClientMarker(item, marker)) {
      return promptId;
    }
  }
  return undefined;
}

export function findCharacterComfyHistoryPromptId(history: Record<string, unknown>, marker: string): string | undefined {
  for (const [promptId, entry] of Object.entries(history)) {
    if (!entry || typeof entry !== "object") continue;
    if (containsComfyClientMarker((entry as Record<string, unknown>).prompt, marker)) {
      return promptId;
    }
  }
  return undefined;
}

async function adoptRecoveredCharacterSubmission(
  job: ImageStudioJob,
  promptId: string,
): Promise<boolean> {
  const [adopted] = await db
    .update(imageStudioJobsTable)
    .set({
      providerRequestId: promptId,
      status: "RUNNING",
      submittedAt: job.submittedAt ?? new Date(),
      startedAt: job.startedAt ?? new Date(),
      errorMessage: null,
      providerTaskMetadata: {
        ...job.providerTaskMetadata,
        submissionRecoveredAt: new Date().toISOString(),
      },
    })
    .where(and(
      eq(imageStudioJobsTable.id, job.id),
      inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
      isNull(imageStudioJobsTable.providerRequestId),
      sql`${imageStudioJobsTable.providerTaskMetadata}->>'submissionIntent' = 'true'`,
      sql`(
        ${imageStudioJobsTable.providerTaskMetadata}->>'submissionPromptAttempted' = 'true'
        OR ${imageStudioJobsTable.providerTaskMetadata}->>'submissionPromptAttempted' IS NULL
      )`,
    ))
    .returning({ id: imageStudioJobsTable.id });
  return Boolean(adopted);
}

async function reconcileCharacterSubmission(
  job: ImageStudioJob,
  server: NonNullable<Awaited<ReturnType<typeof characterImageJobServer>>>,
): Promise<boolean> {
  const client = new ComfyUIClient(server);
  try {
    const queue = await client.getQueue();
    const queuePromptId = findCharacterComfyClientPromptId(
      [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])],
      job.id,
    );
    if (queuePromptId && await adoptRecoveredCharacterSubmission(job, queuePromptId)) {
      return true;
    }
    const history = await client.getHistory();
    const historyPromptId = findCharacterComfyHistoryPromptId(history, job.id);
    if (historyPromptId && await adoptRecoveredCharacterSubmission(job, historyPromptId)) {
      return true;
    }
  } catch (error) {
    if (isTransientComfyUIRequestError(error)) {
      logger.warn({ jobId: job.id }, "Character image submission reconciliation will be retried");
    } else {
      logger.error({ err: error, jobId: job.id }, "Character image submission reconciliation failed");
    }
  }
  return false;
}

export type CharacterSubmissionAttemptState = {
  promptWasAttempted: boolean;
  attemptedMetadata: Record<string, unknown>;
};

export async function submitCharacterTaskOnce(
  submit: (
    beforeProviderSubmit: () => Promise<void>,
  ) => Promise<Awaited<ReturnType<typeof submitImageTask>>>,
  markPromptAttempted: () => Promise<Record<string, unknown>>,
  state: CharacterSubmissionAttemptState,
): Promise<Awaited<ReturnType<typeof submitImageTask>>> {
  return submit(async () => {
    const metadata = await markPromptAttempted();
    state.promptWasAttempted = true;
    state.attemptedMetadata = metadata;
  });
}

async function submitCharacterImageJob(job: ImageStudioJob): Promise<void> {
  if (job.provider === "CLOUD" && job.providerTaskMetadata.spendReserved !== true) {
    const estimatedUsd = job.providerTaskMetadata.estimatedUsd;
    const pricingNote = job.providerTaskMetadata.pricingNote;
    if (typeof estimatedUsd !== "number" || typeof pricingNote !== "string") {
      await db.update(imageStudioJobsTable)
        .set({ status: "FAILED", errorMessage: "Cloud character image spend estimate is unavailable" })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
      await settleCharacterCloudSpend(
        job,
        "released",
        "Cloud character image spend estimate was unavailable before submission",
      );
      return;
    }
    try {
      await reserveSpend({
        tenantId: job.tenantId,
        userId: job.createdByUserId,
        sourceType: "image",
        sourceId: job.id,
        modelId: job.modelId,
        estimatedUsd,
        pricingNote,
      });
      await db.update(imageStudioJobsTable)
        .set({
          providerTaskMetadata: reserveCharacterSubmissionMetadata(job.providerTaskMetadata),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          sql`coalesce(${imageStudioJobsTable.providerTaskMetadata}->>'spendReserved', 'false') <> 'true'`,
        ));
      const [refreshed] = await db
        .select()
        .from(imageStudioJobsTable)
        .where(eq(imageStudioJobsTable.id, job.id))
        .limit(1);
      if (refreshed) job = refreshed;
    } catch (error) {
      await db.update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: error instanceof Error ? error.message : "Cloud image spend could not be reserved",
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
      await settleCharacterCloudSpend(
        job,
        "released",
        "Cloud character image spend was not reserved",
      );
      return;
    }
  }
  const server = await characterImageJobServer(job);
  const hasSubmissionIntent = job.providerTaskMetadata.submissionIntent === true;
  const promptAttempted = submissionPromptWasAttempted(job.providerTaskMetadata);
  const preparationInProgress = hasSubmissionIntent && !promptAttempted;
  const preparationStale = submissionPreparationIsStale(job.providerTaskMetadata);
  if (!server && job.provider !== "CLOUD") {
    if (hasSubmissionIntent && (promptAttempted || !preparationInProgress)) {
      await db.update(imageStudioJobsTable)
        .set({ errorMessage: CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          isNull(imageStudioJobsTable.providerRequestId),
        ));
      return;
    }
    if (preparationInProgress && !preparationStale) return;
    await db.update(imageStudioJobsTable)
      .set({ status: "FAILED", errorMessage: "The assigned image worker is no longer configured" })
      .where(and(
        eq(imageStudioJobsTable.id, job.id),
        inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
      ));
    return;
  }
  if (characterCloudSubmissionNeedsReconciliation(job)) {
    try {
      await markCharacterCloudSubmissionUncertain(job.id, job.providerTaskMetadata);
    } finally {
      await settleCharacterCloudSpend(
        job,
        "uncertain",
        "Cloud character image submission outcome could not be confirmed",
      );
    }
    return;
  }
  if (hasSubmissionIntent && promptAttempted) {
    if (!server) return;
    await reconcileCharacterSubmission(job, server);
    return;
  }
  // Another process may be doing capability discovery or uploading a source.
  // Do not start a second preparation pass until its short lease expires.
  // Preparation itself is safe to retry; only the prompt-attempt marker below
  // makes a submission eligible for reconciliation.
  if (preparationInProgress && !preparationStale) return;
  const preparationStartedAt = new Date().toISOString();
  const preparationClaimId = randomUUID();
  const preparationStaleBefore = new Date(
    Date.now() - CHARACTER_SUBMISSION_PREPARATION_MAX_AGE_MS,
  ).toISOString();
  const [intent] = await db.update(imageStudioJobsTable)
    .set({
      providerTaskMetadata: {
        ...job.providerTaskMetadata,
        submissionIntent: true,
        submissionPromptAttempted: false,
        submissionPreparationStartedAt: preparationStartedAt,
        submissionPreparationClaimId: preparationClaimId,
      },
    })
    .where(and(
      eq(imageStudioJobsTable.id, job.id),
      inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
      isNull(imageStudioJobsTable.providerRequestId),
      sql`(
        ${imageStudioJobsTable.providerTaskMetadata}->>'submissionIntent' = 'false'
        OR (
          ${imageStudioJobsTable.providerTaskMetadata}->>'submissionIntent' = 'true'
          AND COALESCE(${imageStudioJobsTable.providerTaskMetadata}->>'submissionPromptAttempted', 'false') = 'false'
          AND (
            ${imageStudioJobsTable.providerTaskMetadata}->>'submissionPreparationStartedAt' IS NULL
            OR ${imageStudioJobsTable.providerTaskMetadata}->>'submissionPreparationStartedAt' < ${preparationStaleBefore}
          )
        )
      )`,
    ))
    .returning();
  if (!intent) return;
  let submitted: Awaited<ReturnType<typeof submitImageTask>>;
  let promptWasAttempted = false;
  let attemptedMetadata = intent.providerTaskMetadata;
  const attemptState: CharacterSubmissionAttemptState = {
    promptWasAttempted: false,
    attemptedMetadata: intent.providerTaskMetadata,
  };
  let sourceReference: CharacterReferenceSnapshot | null = null;
  try {
    sourceReference = sourceReferenceForJob(job);
    if (job.providerTaskMetadata.referenceUsed === true && !sourceReference) {
      throw new Error("The durable character reference snapshot is unavailable");
    }
    let sourceBytes: Buffer | undefined;
    if (sourceReference) {
      try {
        sourceBytes = await mediaStorage.readBuffer(sourceReference.storageKey);
      } catch (error) {
        const unavailable = new Error(CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE, { cause: error });
        unavailable.name = "CharacterReferenceUnavailableError";
        throw unavailable;
      }
    }
    const nativeReferenceEdit = job.providerTaskMetadata.referenceMode === CHARACTER_NATIVE_REFERENCE_MODE;
    const characterModel = getImageModel(job.modelId);
    if (
      !characterModel
      || ![CHARACTER_LOCAL_MODEL_ID, CHARACTER_CLOUD_MODEL_ID].includes(job.modelId as typeof CHARACTER_LOCAL_MODEL_ID | typeof CHARACTER_CLOUD_MODEL_ID)
      || characterModel.provider !== job.provider
    ) {
      throw new Error("The durable character model is not an approved image model.");
    }
    const nativeResizeMode = job.providerTaskMetadata.nativeReferenceResizeMode;
    if (nativeReferenceEdit && !sourceReference) {
      throw new Error("Native character reference mode requires a durable source snapshot");
    }
    if (
      nativeReferenceEdit
      && nativeResizeMode !== "total-pixels"
      && nativeResizeMode !== "fixed-width"
    ) {
      throw new Error("Native character reference resize mode is missing from the durable snapshot");
    }
    const referenceImages = sourceReference
      ? [{ bytes: sourceBytes!, mimeType: sourceReference.mimeType }]
      : [];
    submitted = await submitCharacterTaskOnce(
      (beforeProviderSubmit) => submitImageTask({
        modelId: job.modelId,
        operation: sourceReference ? "edit" : "generate",
        prompt: job.prompt,
        width: job.width,
        height: job.height,
        seed: job.seed ?? 0,
        count: job.count,
        ...(nativeReferenceEdit
          ? {
            referenceImages,
            referenceMode: CHARACTER_NATIVE_REFERENCE_MODE,
            nativeReferenceResizeMode: nativeResizeMode as NativeReferenceResizeMode,
          }
          : sourceReference
          ? {
            referenceImages,
            ...(job.provider === "LOCAL"
              ? {
                denoiseStrength: typeof job.providerTaskMetadata.denoiseStrength === "number"
                  ? job.providerTaskMetadata.denoiseStrength
                  : CHARACTER_DEFAULT_DENOISE,
              }
              : {}),
          }
          : { referenceImages: [] }),
        ...(server ? { server } : {}),
        clientId: job.id,
        beforeProviderSubmit,
      }),
      async () => {
        const metadata = {
          ...intent.providerTaskMetadata,
          submissionPromptAttempted: true,
          submissionPromptAttemptedAt: new Date().toISOString(),
        };
        const [marked] = await db.update(imageStudioJobsTable)
          .set({ providerTaskMetadata: metadata })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
            isNull(imageStudioJobsTable.providerRequestId),
            sql`${imageStudioJobsTable.providerTaskMetadata}->>'submissionIntent' = 'true'`,
            sql`${imageStudioJobsTable.providerTaskMetadata}->>'submissionPromptAttempted' = 'false'`,
            sql`${imageStudioJobsTable.providerTaskMetadata}->>'submissionPreparationClaimId' = ${preparationClaimId}`,
          ))
          .returning();
        if (!marked) {
          throw new Error("The character image submission preparation claim was lost");
        }
        return marked.providerTaskMetadata;
      },
      attemptState,
    );
    promptWasAttempted = attemptState.promptWasAttempted;
    attemptedMetadata = attemptState.attemptedMetadata;
  } catch (error) {
    promptWasAttempted = attemptState.promptWasAttempted;
    attemptedMetadata = attemptState.attemptedMetadata;
    if (!promptWasAttempted) {
      const failure = characterPreparationFailureDetails(error);
      const outcome = characterSubmissionFailureOutcome(error, false);
      const retryable = outcome === "RETRY_PREPARATION";
      logger.error(
        {
          err: error,
          jobId: job.id,
          serverId: server?.id ?? null,
          serverName: server?.displayName ?? null,
          phase: "submission-preparation",
          failureKind: failure.kind,
          retryable,
          referenceUsed: Boolean(sourceReference),
          referenceAssetId: sourceReference?.assetId ?? job.referenceAssetIds[0] ?? null,
        },
        "Character image submission preparation failed before provider prompt",
      );
      try {
        await db.update(imageStudioJobsTable)
          .set({
            ...(retryable
              ? { errorMessage: null }
              : {
                status: "FAILED" as const,
                errorMessage: failure.message,
              }),
            providerTaskMetadata: {
              ...intent.providerTaskMetadata,
              submissionIntent: false,
              submissionPromptAttempted: false,
              submissionPreparationFailedAt: new Date().toISOString(),
              submissionPreparationFailureKind: failure.kind,
            },
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
            isNull(imageStudioJobsTable.providerRequestId),
            sql`${imageStudioJobsTable.providerTaskMetadata}->>'submissionPreparationClaimId' = ${preparationClaimId}`,
          ));
      } finally {
        if (job.provider === "CLOUD" && !retryable) {
          await settleCharacterCloudSpend(
            job,
            "released",
            "Cloud character image preparation was definitively rejected",
          );
        }
      }
      return;
    }
    const uncertain = job.provider === "CLOUD"
      ? characterCloudSubmissionFailureOutcome(error) === "UNCERTAIN"
      : characterSubmissionFailureOutcome(error, true) === "UNCERTAIN";
    if (job.provider === "CLOUD" && uncertain) {
      try {
        await markCharacterCloudSubmissionUncertain(job.id, attemptedMetadata);
      } finally {
        await settleCharacterCloudSpend(
          job,
          "uncertain",
          "Cloud character image submission outcome could not be confirmed",
        );
      }
      return;
    }
    try {
      await db.update(imageStudioJobsTable)
        .set({
          status: "FAILED" as const,
          errorMessage: CHARACTER_WORKER_FAILURE_MESSAGE,
          providerTaskMetadata: {
            ...attemptedMetadata,
            submissionFailedAt: new Date().toISOString(),
          },
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          isNull(imageStudioJobsTable.providerRequestId),
        ));
    } finally {
      if (job.provider === "CLOUD") {
        await settleCharacterCloudSpend(
          job,
          "released",
          "Cloud provider definitively rejected the character image request",
        );
      }
    }
    return;
  }
  if (!submitted.requestId) {
    try {
      await db.update(imageStudioJobsTable)
        .set({
          errorMessage: CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE,
          providerTaskMetadata: {
            ...attemptedMetadata,
            submissionOutcomeUnknown: true,
            submissionUncertainAt: new Date().toISOString(),
          },
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          isNull(imageStudioJobsTable.providerRequestId),
        ));
    } finally {
      if (job.provider === "CLOUD") {
        await settleCharacterCloudSpend(
          job,
          "uncertain",
          "Cloud character image submission returned no provider receipt",
        );
      }
    }
    return;
  }
  try {
    const accepted = await persistCharacterProviderReceipt(job.id, submitted);
    if (!accepted) {
      if (job.provider === "CLOUD") {
        throw new Error("Cloud provider receipt was accepted but could not be persisted; submission remains uncertain");
      }
      await cancelImageTask({
        provider: submitted.provider,
        requestId: submitted.requestId,
        metadata: submitted.metadata,
        ...(server ? { server } : {}),
      }).catch(() => undefined);
    }
  } catch (error) {
    logger.error(
      { err: error, jobId: job.id, promptId: submitted.requestId },
      "Could not persist accepted character image submission; guarded receipt recovery will retry",
    );
    if (job.provider === "CLOUD") {
      try {
        const recovered = await persistCharacterAcceptedReceiptRecovery(job.id, submitted);
        if (!recovered) {
          logger.warn(
            { jobId: job.id, promptId: submitted.requestId },
            "Accepted Cloud receipt recovery found no active job row; no duplicate submission will be attempted",
          );
        }
      } catch (persistError) {
        logger.error(
          { err: persistError, jobId: job.id, promptId: submitted.requestId },
          "Could not persist accepted Cloud receipt recovery; no duplicate submission will be attempted",
        );
      }
    }
  }
}

async function monitorCharacterImageJobLoop(jobId: string): Promise<void> {
  let failures = 0;
  while (true) {
    const job = await getCharacterImageJob(jobId);
    if (!job || !job.characterId || !CHARACTER_ACTIVE_STATUSES.includes(job.status as typeof CHARACTER_ACTIVE_STATUSES[number])) return;
    const submissionUncertain = characterCloudSubmissionNeedsReconciliation(job);
    if (!submissionUncertain && Date.now() - job.createdAt.getTime() > CHARACTER_GENERATION_MAX_AGE_MS) {
      try {
        await db.update(imageStudioJobsTable)
          .set({
            status: "FAILED",
            errorMessage: "Image worker monitoring exceeded the recovery window",
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          ));
      } finally {
        if (job.provider === "CLOUD") {
          await settleCharacterCloudSpend(
            job,
            job.providerRequestId ? "uncertain" : "released",
            job.providerRequestId
              ? "Cloud character image recovery window expired after provider acceptance"
              : "Cloud character image recovery window expired before provider submission",
          );
        }
      }
      return;
    }
    if (!job.providerRequestId) {
      await submitCharacterImageJob(job);
      const submitted = await getCharacterImageJob(jobId);
      if (!submitted || submitted.status === "FAILED") return;
      if (!submitted.providerRequestId) {
        if (submissionPromptWasAttempted(submitted.providerTaskMetadata)) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      continue;
    }
    if (job.provider === "CLOUD") {
      try {
        const result = await pollImageTask({
          provider: "CLOUD",
          requestId: job.providerRequestId,
          metadata: job.providerTaskMetadata,
        });
        if (result.status === "COMPLETED" && result.images?.[0]) {
          await finalizeCharacterImageJob(
            job,
            undefined,
            result.images[0].bytes,
            result.images[0].name,
          );
          const finalized = await getCharacterImageJob(job.id);
          if (finalized?.status === "COMPLETED") {
            await settleCharacterCloudSpend(finalized, "estimated", "Cloud character image completed");
          } else if (finalized?.status === "FAILED") {
            await settleCharacterCloudSpend(
              finalized,
              "uncertain",
              "Cloud character output was accepted but finalization failed",
            );
          }
          return;
        }
        failures = 0;
        await db.update(imageStudioJobsTable)
          .set({
            status: result.status === "QUEUED" ? "QUEUED" : "RUNNING",
            ...(job.startedAt ? {} : { startedAt: new Date() }),
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          ));
        await new Promise((resolve) => setTimeout(resolve, result.status === "QUEUED" ? 2_000 : 1_500));
      } catch (error) {
        failures += 1;
        const expired = !submissionUncertain
          && Date.now() - job.createdAt.getTime() > CHARACTER_GENERATION_MAX_AGE_MS;
        const retryable = (typeof error === "object" && error !== null
          && (error as { retryable?: unknown }).retryable === true)
          || /network|timeout|timed out|temporar|connection|socket|fetch failed/i.test(
            error instanceof Error ? error.message : "",
          );
        if (expired || !retryable) {
          try {
            await db.update(imageStudioJobsTable)
              .set({
                status: "FAILED",
                errorMessage: expired
                  ? "Cloud image monitoring exceeded the recovery window"
                  : characterGenerationError(error),
              })
              .where(and(
                eq(imageStudioJobsTable.id, job.id),
                inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
              ));
          } finally {
            await settleCharacterCloudSpend(
              job,
              "uncertain",
              "Cloud character image result could not be confirmed",
            );
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
      }
      continue;
    }
    const server = await characterImageJobServer(job);
    if (!server) {
      await db.update(imageStudioJobsTable)
        .set({
          errorMessage: job.providerRequestId
            ? "The assigned image worker is temporarily unavailable; the accepted render remains reserved."
            : CHARACTER_SUBMISSION_UNCERTAIN_MESSAGE,
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
      return;
    }
    // The progress socket is best-effort and independent of HTTP polling. It
    // attaches to the accepted prompt only; no prompt is ever submitted here.
    startCharacterProgressObserver(job, server);
    try {
      let result: ImageTaskResult;
      if (typeof job.providerTaskMetadata.serverId === "string") {
        result = await pollImageTask({
          provider: "LOCAL",
          requestId: job.providerRequestId,
          metadata: job.providerTaskMetadata,
          server,
        });
      } else {
        // Keep already-queued jobs from before the img2img adapter available
        // through restart. New durable jobs always use ImageTask metadata.
        const history = await new ComfyUIClient(server).getHistory(job.providerRequestId);
        const error = characterHistoryError(history, job.providerRequestId);
        if (error) throw new Error(error);
        const output = chooseImageOutput(history, job.providerRequestId);
        result = output
          ? {
            status: "COMPLETED",
            images: [{
              bytes: await new ComfyUIClient(server).getOutputFile(
                output.filename,
                output.subfolder,
                output.type,
              ),
              mimeType: imageMimeType(output.filename),
              name: output.filename,
            }],
          }
          : { status: "RUNNING" };
      }
      if (result.status === "COMPLETED" && result.images?.[0]) {
        await finalizeCharacterImageJob(
          job,
          undefined,
          result.images[0].bytes,
          result.images[0].name,
        );
        return;
      }
      failures = 0;
      await db.update(imageStudioJobsTable)
        .set({
          status: result.status === "QUEUED" ? "QUEUED" : "RUNNING",
          ...(job.startedAt ? {} : { startedAt: new Date() }),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        ));
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } catch (error) {
      failures += 1;
      const expired = !submissionUncertain
        && Date.now() - job.createdAt.getTime() > CHARACTER_GENERATION_MAX_AGE_MS;
      const transient = isTransientComfyUIRequestError(error)
        || (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true)
        || /network|timeout|timed out|temporar|connection|socket|fetch failed/i.test(
          error instanceof Error ? error.message : "",
        );
      if (expired || !transient) {
        await db.update(imageStudioJobsTable)
          .set({
            status: "FAILED",
            errorMessage: expired
              ? "Image worker monitoring exceeded the recovery window"
              : characterGenerationError(error),
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          ));
        return;
      }
      logger.warn({ jobId, failures }, "Character image worker request will be retried");
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
    }
  }
}

async function monitorCharacterImageJob(jobId: string): Promise<void> {
  try {
    await monitorCharacterImageJobLoop(jobId);
  } finally {
    // A terminal poll/finalization, restart timeout, or unexpected monitor
    // error must release the socket and any reconnect timer.
    stopCharacterProgressObserver(jobId);
  }
}

function startCharacterImageMonitor(jobId: string): void {
  if (characterMonitors.has(jobId)) return;
  const task = monitorCharacterImageJob(jobId)
    .catch((error) => logger.error({ err: error, jobId }, "Character image monitor stopped unexpectedly"))
    .finally(() => characterMonitors.delete(jobId));
  characterMonitors.set(jobId, task);
}

async function resolveCharacterReference(input: {
  characterId: string;
  tenantId: string;
  referenceAssetId?: string;
}, executor: CharacterDbExecutor = db): Promise<{
  candidate: CharacterReferenceCandidate | null;
  snapshot: CharacterReferenceSnapshot | null;
}> {
  const [character] = await executor
    .select({
      id: charactersTable.id,
      thumbnail: charactersTable.thumbnail,
    })
    .from(charactersTable)
    .where(and(
      eq(charactersTable.id, input.characterId),
      eq(charactersTable.tenantId, input.tenantId),
    ));
  if (!character) throw new Error("Character not found");
  const assets = await executor
    .select({
      id: characterAssetsTable.id,
      storageKey: characterAssetsTable.storageKey,
      originalName: characterAssetsTable.originalName,
      mimeType: characterAssetsTable.mimeType,
      label: characterAssetsTable.label,
      isPrimary: characterAssetsTable.isPrimary,
      createdAt: characterAssetsTable.createdAt,
    })
    .from(characterAssetsTable)
    .where(eq(characterAssetsTable.characterId, input.characterId))
    .orderBy(asc(characterAssetsTable.createdAt));
  const candidate = chooseCharacterReferenceAsset(
    assets,
    character.thumbnail,
    input.referenceAssetId,
  );
  if (!candidate) return { candidate: null, snapshot: null };
  // Read the source before the job is acknowledged. This makes a queued job
  // fail closed when the selected uploaded bytes are unavailable, instead of
  // falling back to a new identity render.
  await mediaStorage.readBuffer(candidate.storageKey);
  return {
    candidate,
    snapshot: {
      assetId: candidate.id,
      storageKey: candidate.storageKey,
      originalName: candidate.originalName,
      mimeType: candidate.mimeType,
      label: isCharacterAssetLabel(candidate.label) ? candidate.label : "other",
      capturedAt: new Date().toISOString(),
    },
  };
}

export function resolveCharacterModel(modelId?: string): ImageModel {
  const selectedId = modelId ?? CHARACTER_LOCAL_MODEL_ID;
  if (selectedId !== CHARACTER_LOCAL_MODEL_ID && selectedId !== CHARACTER_CLOUD_MODEL_ID) {
    throw new Error("Character generation supports FLUX.2 klein 4B or explicit Nano Banana Pro.");
  }
  const model = getImageModel(selectedId);
  if (!model || !model.operations.includes("edit")) {
    throw new Error(`Character model ${selectedId} does not support reference editing.`);
  }
  return model;
}

export function validateCharacterModelSelection(
  modelId?: string,
  cloudConfirmed?: boolean,
): ImageModel {
  const model = resolveCharacterModel(modelId);
  if (model.provider === "CLOUD" && cloudConfirmed !== true) {
    throw new Error(`Confirm this paid Cloud job before submitting. Estimated cost: ${model.priceNote}`);
  }
  return model;
}

export async function createCharacterImageJob(input: {
  characterId: string;
  tenantId: string;
  userId: string;
  modelId?: string;
  cloudConfirmed?: boolean;
  prompt?: string;
  seed?: number;
  referenceLabel?: CharacterAssetLabel;
  referenceAssetId?: string;
  denoiseStrength?: number;
  allowNewIdentity?: boolean;
  requestKey?: string;
}): Promise<PresentedCharacterImageGeneration> {
  const model = validateCharacterModelSelection(input.modelId, input.cloudConfirmed);
  const cloudModel = model.provider === "CLOUD";
  const [entity] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, input.characterId),
    eq(charactersTable.tenantId, input.tenantId),
  ));
  if (!entity) throw new Error("Character not found");
  const dossier = normalizeDossier(entity.dossier);
  if (
    input.denoiseStrength !== undefined
    && (
      !Number.isFinite(input.denoiseStrength)
      || input.denoiseStrength < 0.05
      || input.denoiseStrength > 1
    )
  ) {
    throw new Error("Denoise strength must be a number from 0.05 to 1");
  }
  const requestKey = input.requestKey ?? randomUUID();
  const existingByKey = await db.select().from(imageStudioJobsTable).where(and(
    eq(imageStudioJobsTable.tenantId, input.tenantId),
    eq(imageStudioJobsTable.requestKey, requestKey),
  )).limit(1);
  if (existingByKey[0]) {
    const existing = existingByKey[0];
    if (existing.characterId !== input.characterId) {
      throw new CharacterImageGenerationConflictError("This request key is already used by another image task");
    }
    const server = await characterImageJobServer(existing);
    if (CHARACTER_ACTIVE_STATUSES.includes(existing.status as typeof CHARACTER_ACTIVE_STATUSES[number])) {
      startCharacterImageMonitor(existing.id);
    }
    return characterGenerationResponse(existing, server?.displayName);
  }
  if (cloudModel && !process.env.FAL_KEY?.trim()) {
    throw new Error("Cloud credentials are not configured.");
  }
  const [activeExisting] = await db
    .select()
    .from(imageStudioJobsTable)
    .where(and(
      eq(imageStudioJobsTable.tenantId, input.tenantId),
      eq(imageStudioJobsTable.characterId, input.characterId),
      inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
    ))
    .limit(1);
  if (activeExisting) {
    throw new CharacterImageGenerationConflictError(
      "A character image is already queued or running. Wait for it to finish before starting another.",
    );
  }
  // Resolve once before worker selection so a reference job can only be
  // assigned to a worker that has the native edit graph. The transaction
  // below resolves again under the character row lock before snapshotting.
  const preflightReference = await resolveCharacterReference({
    characterId: input.characterId,
    tenantId: input.tenantId,
    referenceAssetId: input.referenceAssetId,
  });
  const prompt = preflightReference.snapshot
    ? buildNativeReferenceEditPrompt(
      input.prompt,
      input.referenceLabel ?? preflightReference.snapshot.label,
    )
    : buildPrompt(
      "character",
      entity,
      input.prompt,
      input.referenceLabel,
      dossier,
    );
  const nativeReferenceMode = Boolean(preflightReference.snapshot);
  const spendQuote = cloudModel
    ? await quoteImageSpend(model.id, {
      width: CHARACTER_WIDTH,
      height: CHARACTER_HEIGHT,
      count: 1,
      operation: preflightReference.snapshot ? "edit" : "generate",
      referenceCount: preflightReference.snapshot ? 1 : 0,
    })
    : undefined;
  const activeByServer = cloudModel ? new Map<string, number>() : await activeDatabaseJobsByServer();
  const selectedWorker = cloudModel
    ? null
    : await selectCharacterWorker(
      (await db.select().from(comfyServersTable))
        .map((candidate) => ({
          ...candidate,
          activeJobCount: Math.max(candidate.activeJobCount, activeByServer.get(candidate.id) ?? 0),
        }))
        .filter((candidate) => !reservedServers.has(candidate.id)),
      Boolean(preflightReference.snapshot),
    );
  const server = selectedWorker?.server;
  const nativeReferenceResizeMode = selectedWorker?.nativeReferenceResizeMode;
  if (!server && !cloudModel) {
    throw new StudioImageGenerationUnavailableError(
      preflightReference.snapshot
        ? "No FLUX.2 Klein worker with native ReferenceLatent editing is currently available."
        : "No FLUX.2 Klein worker is currently available. Check GPU status or wait for the active render to finish.",
    );
  }

  if (server) reservedServers.add(server.id);
  let releaseServerLock: (() => Promise<void>) | undefined;
  let reference: Awaited<ReturnType<typeof resolveCharacterReference>> | undefined;
  try {
    if (server) {
      releaseServerLock = await acquireServerLock(server.id);
      const currentActive = await activeDatabaseJobsByServer();
      if (
        Math.max(server.activeJobCount, currentActive.get(server.id) ?? 0)
        >= (server.maxConcurrentJobs ?? 1)
      ) {
        throw new StudioImageGenerationUnavailableError(
          `${server.displayName} is at its safe render capacity.`,
        );
      }
    }
    let result:
      | { kind: "missing" }
      | { kind: "active" | "created"; job: ImageStudioJob };
    try {
      result = await db.transaction(async (tx) => {
        const [lockedCharacter] = await tx.select({ id: charactersTable.id })
          .from(charactersTable)
          .where(and(
            eq(charactersTable.id, input.characterId),
            eq(charactersTable.tenantId, input.tenantId),
          ))
          .for("update");
        if (!lockedCharacter) return { kind: "missing" as const };
        const [active] = await tx.select().from(imageStudioJobsTable).where(and(
          eq(imageStudioJobsTable.tenantId, input.tenantId),
          eq(imageStudioJobsTable.characterId, input.characterId),
          inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
        )).limit(1);
        if (active) return { kind: "active" as const, job: active };
        reference = await resolveCharacterReference({
          characterId: input.characterId,
          tenantId: input.tenantId,
          referenceAssetId: input.referenceAssetId,
        }, tx);
        if (nativeReferenceMode !== Boolean(reference.snapshot)) {
          throw new Error(
            nativeReferenceMode
              ? CHARACTER_REFERENCE_UNAVAILABLE_MESSAGE
              : "A character reference became available after worker preparation; retry the request.",
          );
        }
        if (input.denoiseStrength !== undefined && !reference.snapshot) {
          throw new Error("Denoise strength requires a character reference asset");
        }
        if (!reference.snapshot && input.allowNewIdentity === false) {
          throw new Error("A character reference asset is required unless new identity generation is enabled");
        }
        const seed = input.seed === undefined
          ? reference.snapshot
            ? deterministicCharacterSeed(reference.snapshot)
            : Math.floor(Math.random() * 2_147_483_647)
          : Math.floor(input.seed);
        const [created] = await tx.insert(imageStudioJobsTable).values({
          tenantId: input.tenantId,
          createdByUserId: input.userId,
          requestKey,
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          operation: reference.snapshot ? "edit" : "generate",
          prompt,
          width: CHARACTER_WIDTH,
          height: CHARACTER_HEIGHT,
          count: 1,
          seed,
          referenceAssetIds: reference.snapshot ? [reference.snapshot.assetId] : [],
          maskAssetId: null,
          characterId: input.characterId,
          referenceLabel: input.referenceLabel ?? null,
          status: "QUEUED",
          comfyServerId: server?.id ?? null,
          providerTaskMetadata: createCharacterSubmissionMetadata({
            workflow: "OBTV_Character",
            cancellationRequested: false,
            referenceUsed: Boolean(reference.snapshot),
            referenceMode: reference.snapshot
              ? (cloudModel ? CHARACTER_CLOUD_REFERENCE_MODE : CHARACTER_NATIVE_REFERENCE_MODE)
              : CHARACTER_TEXT_GENERATION_MODE,
            ...(reference.snapshot && nativeReferenceResizeMode
              ? { nativeReferenceResizeMode }
              : {}),
            ...(cloudModel && spendQuote
              ? {
                spendLifecycleVersion: CHARACTER_CLOUD_SPEND_LIFECYCLE_VERSION,
                estimatedUsd: spendQuote.estimatedUsd,
                pricingNote: spendQuote.pricingNote,
                cancellationRequested: false,
              }
              : {}),
            progress: null,
            progressStage: "preparing",
            progressStep: null,
            progressTotalSteps: null,
            progressUpdatedAt: null,
            ...(reference.snapshot ? { sourceReference: reference.snapshot } : {}),
            ...(reference.snapshot && !nativeReferenceResizeMode && !cloudModel
              ? { denoiseStrength: input.denoiseStrength ?? CHARACTER_DEFAULT_DENOISE }
              : {}),
          }),
        }).returning();
        return created ? { kind: "created" as const, job: created } : { kind: "missing" as const };
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "23505") throw error;
      const [existing] = await db.select().from(imageStudioJobsTable).where(and(
        eq(imageStudioJobsTable.tenantId, input.tenantId),
        eq(imageStudioJobsTable.requestKey, requestKey),
      )).limit(1);
      if (!existing || existing.characterId !== input.characterId) throw error;
      const existingServer = await characterImageJobServer(existing);
      if (CHARACTER_ACTIVE_STATUSES.includes(existing.status as typeof CHARACTER_ACTIVE_STATUSES[number])) {
        startCharacterImageMonitor(existing.id);
      }
      return characterGenerationResponse(existing, existingServer?.displayName);
    }
    if (result.kind === "missing") throw new Error("Character not found");
    if (result.kind === "active") {
      throw new CharacterImageGenerationConflictError(
        "A character image is already queued or running. Wait for it to finish before starting another.",
      );
    }
    if (cloudModel && spendQuote) {
      try {
        await reserveSpend({
          tenantId: input.tenantId,
          userId: input.userId,
          sourceType: "image",
          sourceId: result.job.id,
          modelId: model.id,
          estimatedUsd: spendQuote.estimatedUsd,
          pricingNote: spendQuote.pricingNote,
        });
        const [reserved] = await db.update(imageStudioJobsTable)
          .set({
            providerTaskMetadata: reserveCharacterSubmissionMetadata(result.job.providerTaskMetadata),
          })
          .where(and(
            eq(imageStudioJobsTable.id, result.job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          ))
          .returning();
        if (!reserved) throw new Error("The Cloud character image task was cancelled before submission");
      } catch (error) {
        await db.update(imageStudioJobsTable)
          .set({
            status: "FAILED",
            errorMessage: error instanceof Error ? error.message : "Cloud image spend could not be reserved",
          })
          .where(and(
            eq(imageStudioJobsTable.id, result.job.id),
            inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
          ));
        await settleCharacterCloudSpend(
          result.job,
          "released",
          "Cloud character image request was not submitted",
        );
        throw error;
      }
    }
    startCharacterImageMonitor(result.job.id);
     return characterGenerationResponse(result.job, server?.displayName);
  } finally {
    await releaseServerLock?.();
    if (server) reservedServers.delete(server.id);
  }
}

export async function resumeCharacterImageJobs(): Promise<void> {
  // Character jobs are marked at insert time; this also keeps shared Image
  // Studio monitors from ever adopting a character attachment job.
  const jobs = await db.select().from(imageStudioJobsTable).where(
    inArray(imageStudioJobsTable.status, [...CHARACTER_ACTIVE_STATUSES]),
  );
  const characterJobs = jobs.filter((job) => Boolean(job.characterId));
  for (const job of characterJobs) startCharacterImageMonitor(job.id);
  const terminalCloudCharacterJobs = await db.select().from(imageStudioJobsTable).where(and(
    eq(imageStudioJobsTable.provider, "CLOUD"),
    isNotNull(imageStudioJobsTable.characterId),
    inArray(imageStudioJobsTable.status, [...CHARACTER_TERMINAL_STATUSES]),
  ));
  await reconcileCharacterCloudSettlements(terminalCloudCharacterJobs);
  if (characterJobs.length > 0) {
    logger.info({ count: characterJobs.length }, "Resumed durable character image monitors");
  }
}