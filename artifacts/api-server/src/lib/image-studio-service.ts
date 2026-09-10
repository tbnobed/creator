import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import {
  comfyServersTable,
  db,
  generationJobsTable,
  imageStudioAssetsTable,
  imageStudioJobsTable,
  pool,
  type ComfyServer,
  type ImageStudioAsset,
  type ImageStudioJob,
} from "@workspace/db";
import {
  getImageModel,
  imageModels,
  type ImageModel,
  type ImageOperation,
} from "./image-studio-models";
import {
  cancelImageTask,
  checkLocalImageModel,
  pollImageTask,
  submitImageTask,
} from "./image-studio-adapters";
import { hasRequiredTags } from "./comfy/scheduler";
import { logger } from "./logger";
import { mediaStorage } from "./storage-service";
import { quoteImageSpend } from "./spending-pricing";
import { attachSpendReceipt, reserveSpend, settleSpend } from "./spending-service";

const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const MAX_JOB_AGE_MS = 6 * 60 * 60 * 1000;
const SUBMISSION_RECEIPT_GRACE_MS = 2 * 60 * 1000;
const monitors = new Map<string, Promise<void>>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLATION_NOT_REQUESTED =
  sql`coalesce(${imageStudioJobsTable.providerTaskMetadata}->>'cancellationRequested', 'false') <> 'true'`;

export class ImageStudioRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ImageStudioRequestError";
  }
}

export type ImageJobRequest = {
  modelId: string;
  operation: ImageOperation;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  seed?: number;
  referenceAssetIds?: string[];
  maskAssetId?: string;
  cloudConfirmed?: boolean;
  requestKey?: string;
};

export type PresentedImageAsset = {
  id: string;
  name: string;
  url: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  favorite: boolean;
  collection: string;
  jobId: string | null;
  createdAt: string;
};

export type PresentedImageJob = {
  id: string;
  modelId: string;
  modelName: string;
  provider: "LOCAL" | "CLOUD";
  operation: ImageOperation;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  seed?: number;
  status: ImageStudioJob["status"];
  errorMessage: string | null;
  assets: PresentedImageAsset[];
  referenceAssetIds: string[];
  maskAssetId: string | null;
  createdAt: string;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizeCloudMessage(error: unknown, fallback = "Cloud image task failed"): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw
    .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run)[^\s"'<>]*/gi, "Cloud")
    .replace(/\bfal(?:\.ai)?\b/gi, "Cloud")
    .replace(/\bFAL_KEY\b/gi, "Cloud credentials")
    .replace(/https?:\/\/\S+/gi, "Cloud")
    .replace(/\b(?:key|token|authorization)\s*[:=]\s*\S+/gi, "credentials [redacted]")
    .slice(0, 800);
}

function publicFailure(job: ImageStudioJob, error: unknown): string {
  if (job.provider === "CLOUD") return sanitizeCloudMessage(error);
  const message = error instanceof Error ? error.message : "Local image task failed";
  return message.replace(/https?:\/\/\S+/gi, "the local worker").slice(0, 800);
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { retryable?: unknown; status?: unknown; code?: unknown };
  if (candidate.retryable === true) return true;
  if (
    typeof candidate.status === "number"
    && (candidate.status === 408 || candidate.status === 429 || candidate.status >= 500)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return /network|timeout|timed out|temporar|connection|fetch failed|socket|rate limit/.test(message);
}

function cancellationRequested(job: ImageStudioJob): boolean {
  return job.providerTaskMetadata.cancellationRequested === true;
}

function submissionOutcomeUnknownMessage(provider: "LOCAL" | "CLOUD"): string {
  return provider === "CLOUD"
    ? "Cloud submission outcome unknown; do not retry automatically. Check the Cloud account before starting another paid job."
    : "Local submission outcome unknown; do not retry automatically. Check the worker queue before starting another job.";
}

function submissionReceiptGraceRemaining(job: ImageStudioJob): number {
  const raw = job.providerTaskMetadata.submissionIntentAt;
  const intentTime = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  const startedAt = Number.isFinite(intentTime) ? intentTime : job.createdAt.getTime();
  return Math.max(0, SUBMISSION_RECEIPT_GRACE_MS - (Date.now() - startedAt));
}

const IMAGE_SPEND_LIFECYCLE_VERSION = 1;

function hasImageSpendLifecycle(job: ImageStudioJob): boolean {
  return job.provider === "CLOUD"
    && job.providerTaskMetadata.spendLifecycleVersion === IMAGE_SPEND_LIFECYCLE_VERSION;
}

async function settleImageSpend(
  job: ImageStudioJob,
  outcome: "estimated" | "released" | "uncertain",
  note?: string,
): Promise<void> {
  if (!hasImageSpendLifecycle(job)) return;
  await settleSpend("image", job.id, outcome, note);
}

async function settleImageSpendSafely(
  job: ImageStudioJob,
  outcome: "estimated" | "released" | "uncertain",
  note?: string,
): Promise<void> {
  try {
    await settleImageSpend(job, outcome, note);
  } catch (error) {
    logger.error(
      { err: error, jobId: job.id, outcome },
      "Could not settle Cloud image spend; restart reconciliation will retry",
    );
  }
}

function requestErrorStatus(error: unknown, fallback: number): number {
  if (!error || typeof error !== "object") return fallback;
  const candidate = error as { statusCode?: unknown; status?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.status === "number") return candidate.status;
  return fallback;
}

function isDefinitiveSubmissionRejection(error: unknown): boolean {
  const status = requestErrorStatus(error, 0);
  return status >= 400
    && status < 500
    && status !== 408
    && status !== 409
    && status !== 425
    && status !== 429;
}

function cloudBillingEndpoint(metadata: Record<string, unknown>): string | undefined {
  const endpoint = metadata.endpoint;
  if (typeof endpoint !== "string" || !/^[a-z0-9][a-z0-9./_-]+$/i.test(endpoint)) return undefined;
  return `https://queue.fal.run/${endpoint}`;
}

async function attachImageSpendReceiptSafely(job: ImageStudioJob): Promise<void> {
  if (!hasImageSpendLifecycle(job) || !job.providerRequestId) return;
  const endpoint = cloudBillingEndpoint(job.providerTaskMetadata);
  if (!endpoint) {
    logger.error(
      { jobId: job.id },
      "Could not attach Cloud image spend receipt because its persisted endpoint is missing",
    );
    return;
  }
  try {
    await attachSpendReceipt("image", job.id, job.providerRequestId, endpoint);
  } catch (error) {
    logger.error(
      { err: error, jobId: job.id },
      "Could not attach Cloud image spend receipt; restart reconciliation will retry",
    );
  }
}

async function attachSubmittedImageSpendReceiptSafely(
  job: ImageStudioJob,
  receipt: { requestId: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!hasImageSpendLifecycle(job)) return;
  const endpoint = cloudBillingEndpoint(receipt.metadata);
  if (!endpoint) return;
  try {
    await attachSpendReceipt("image", job.id, receipt.requestId, endpoint);
  } catch (error) {
    logger.error(
      { err: error, jobId: job.id },
      "Could not attach accepted Cloud image spend receipt; restart reconciliation will retry",
    );
  }
}

export function inspectImage(
  bytes: Buffer,
  claimedMimeType?: string,
): { mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number } {
  let mimeType: "image/png" | "image/jpeg" | "image/webp";
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    mimeType = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = "image/jpeg";
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    bytes.length >= 30
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    mimeType = "image/webp";
    const kind = bytes.toString("ascii", 12, 16);
    const dataOffset = 20;
    if (kind === "VP8X" && bytes.length >= dataOffset + 10) {
      width = 1 + bytes.readUIntLE(dataOffset + 4, 3);
      height = 1 + bytes.readUIntLE(dataOffset + 7, 3);
    } else if (
      kind === "VP8 "
      && bytes.length >= dataOffset + 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a
    ) {
      width = bytes.readUInt16LE(dataOffset + 6) & 0x3fff;
      height = bytes.readUInt16LE(dataOffset + 8) & 0x3fff;
    } else if (kind === "VP8L" && bytes.length >= dataOffset + 5 && bytes[dataOffset] === 0x2f) {
      const packed = bytes.readUInt32LE(dataOffset + 1);
      width = (packed & 0x3fff) + 1;
      height = ((packed >> 14) & 0x3fff) + 1;
    }
  } else {
    throw new ImageStudioRequestError("Upload a valid PNG, JPEG, or WebP image", 400);
  }
  if (!width || !height || width > 32768 || height > 32768) {
    throw new ImageStudioRequestError("The image has invalid dimensions", 400);
  }
  if (claimedMimeType && claimedMimeType !== mimeType) {
    throw new ImageStudioRequestError("The image content does not match its content type", 400);
  }
  return { mimeType, width, height };
}

export function presentImageAsset(asset: ImageStudioAsset): PresentedImageAsset {
  return {
    id: asset.id,
    name: asset.name,
    url: `/api/media/${asset.storageKey}`,
    storageKey: asset.storageKey,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    favorite: asset.favorite,
    collection: asset.collection,
    jobId: asset.jobId,
    createdAt: asset.createdAt.toISOString(),
  };
}

function presentImageJob(
  job: ImageStudioJob,
  assets: ImageStudioAsset[],
): PresentedImageJob {
  return {
    id: job.id,
    modelId: job.modelId,
    modelName: job.modelName,
    provider: job.provider,
    operation: job.operation as ImageOperation,
    prompt: job.prompt,
    ...(job.negativePrompt ? { negativePrompt: job.negativePrompt } : {}),
    width: job.width,
    height: job.height,
    count: job.count,
    ...(job.seed == null ? {} : { seed: job.seed }),
    status: job.status,
    errorMessage: job.errorMessage,
    assets: assets.map(presentImageAsset),
    referenceAssetIds: job.referenceAssetIds,
    maskAssetId: job.maskAssetId,
    createdAt: job.createdAt.toISOString(),
  };
}

async function assetsByJobIds(jobIds: string[]): Promise<Map<string, ImageStudioAsset[]>> {
  const grouped = new Map<string, ImageStudioAsset[]>();
  if (jobIds.length === 0) return grouped;
  const assets = await db
    .select()
    .from(imageStudioAssetsTable)
    .where(inArray(imageStudioAssetsTable.jobId, jobIds))
    .orderBy(imageStudioAssetsTable.createdAt);
  for (const asset of assets) {
    if (!asset.jobId) continue;
    const list = grouped.get(asset.jobId) ?? [];
    list.push(asset);
    grouped.set(asset.jobId, list);
  }
  return grouped;
}

export async function listImageJobs(
  tenantId: string,
  limit: number,
): Promise<PresentedImageJob[]> {
  const jobs = await db
    .select()
    .from(imageStudioJobsTable)
    .where(eq(imageStudioJobsTable.tenantId, tenantId))
    .orderBy(desc(imageStudioJobsTable.createdAt))
    .limit(limit);
  const assets = await assetsByJobIds(jobs.map((job) => job.id));
  return jobs.map((job) => presentImageJob(job, assets.get(job.id) ?? []));
}

export async function getImageJob(
  tenantId: string,
  id: string,
): Promise<PresentedImageJob | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const [job] = await db
    .select()
    .from(imageStudioJobsTable)
    .where(and(eq(imageStudioJobsTable.id, id), eq(imageStudioJobsTable.tenantId, tenantId)))
    .limit(1);
  if (!job) return null;
  const assets = await db
    .select()
    .from(imageStudioAssetsTable)
    .where(and(
      eq(imageStudioAssetsTable.tenantId, tenantId),
      eq(imageStudioAssetsTable.jobId, id),
    ))
    .orderBy(imageStudioAssetsTable.createdAt);
  return presentImageJob(job, assets);
}

export async function listImageAssets(input: {
  tenantId: string;
  search?: string;
  favorite?: boolean;
  collection?: string;
}): Promise<PresentedImageAsset[]> {
  const conditions = [eq(imageStudioAssetsTable.tenantId, input.tenantId)];
  if (input.search) {
    const escaped = input.search.replace(/[\\%_]/g, "\\$&");
    conditions.push(ilike(imageStudioAssetsTable.name, `%${escaped}%`));
  }
  if (input.favorite !== undefined) {
    conditions.push(eq(imageStudioAssetsTable.favorite, input.favorite));
  }
  if (input.collection !== undefined) {
    conditions.push(eq(imageStudioAssetsTable.collection, input.collection));
  }
  const assets = await db
    .select()
    .from(imageStudioAssetsTable)
    .where(and(...conditions))
    .orderBy(desc(imageStudioAssetsTable.createdAt))
    .limit(500);
  return assets.map(presentImageAsset);
}

async function withServerSlotLock<T>(
  serverId: string,
  work: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`comfy-server:${serverId}`],
    );
    if (!result.rows[0]?.locked) {
      throw new ImageStudioRequestError(
        "The selected GPU is being reserved by another render. Try again shortly.",
        409,
      );
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

async function compatibleLocalServers(model: ImageModel): Promise<ComfyServer[]> {
  const servers = await db.select().from(comfyServersTable);
  return servers
    .filter((server) => (
      server.enabled
      && server.status === "ONLINE"
      && (!model.requiredTag || hasRequiredTags(server.tags, [model.requiredTag]))
    ))
    .sort((left, right) => (
      left.activeJobCount - right.activeJobCount
      || left.queueSize - right.queueSize
      || left.priority - right.priority
    ));
}

async function serverHasCapacity(server: ComfyServer): Promise<boolean> {
  const [videoJobs, imageJobs] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(generationJobsTable)
      .where(and(
        eq(generationJobsTable.comfyServerId, server.id),
        inArray(generationJobsTable.status, ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"]),
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(imageStudioJobsTable)
      .where(and(
        eq(imageStudioJobsTable.comfyServerId, server.id),
        inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
      )),
  ]);
  const reserved = (videoJobs[0]?.count ?? 0) + (imageJobs[0]?.count ?? 0);
  return Math.max(reserved, server.activeJobCount) < (server.maxConcurrentJobs ?? 1);
}

export async function listImageModels(): Promise<Array<ImageModel & {
  available: boolean;
  unavailableReason?: string;
}>> {
  const results = await Promise.all(imageModels.map(async (model) => {
    const { endpoint: _internalEndpoint, ...publicModel } = model;
    if (model.provider === "CLOUD") {
      return process.env.FAL_KEY?.trim()
        ? { ...publicModel, available: true }
        : { ...publicModel, available: false, unavailableReason: "Cloud credentials are not configured" };
    }
    const servers = await compatibleLocalServers(model);
    for (const server of servers) {
      try {
        if (await checkLocalImageModel(model.id, server)) {
          return { ...publicModel, available: true };
        }
      } catch {
        // Try another compatible local worker.
      }
    }
    return {
      ...publicModel,
      available: false,
      unavailableReason: "No compatible local image worker is currently available",
    };
  }));
  return results;
}

function validateRequest(model: ImageModel, input: ImageJobRequest): void {
  if (!model.operations.includes(input.operation)) {
    throw new ImageStudioRequestError(`${model.name} does not support ${input.operation}`, 400);
  }
  const promptOptional = input.operation === "upscale" || input.operation === "remove-background";
  if (!promptOptional && !input.prompt.trim()) {
    throw new ImageStudioRequestError("Prompt is required", 400);
  }
  if (input.requestKey && !UUID_PATTERN.test(input.requestKey)) {
    throw new ImageStudioRequestError("Request key must be a valid UUID", 400);
  }
  const dimensionPreservingTool = input.operation === "upscale" || input.operation === "remove-background";
  if (
    !Number.isSafeInteger(input.width)
    || !Number.isSafeInteger(input.height)
    || input.width < (dimensionPreservingTool ? 1 : 256)
    || input.height < (dimensionPreservingTool ? 1 : 256)
    || input.width > (dimensionPreservingTool ? 32768 : model.provider === "LOCAL" ? 2048 : 4096)
    || input.height > (dimensionPreservingTool ? 32768 : model.provider === "LOCAL" ? 2048 : 4096)
    || (!dimensionPreservingTool && input.width % 16 !== 0)
    || (!dimensionPreservingTool && input.height % 16 !== 0)
  ) {
    throw new ImageStudioRequestError(
      dimensionPreservingTool
        ? "Tool width and height must be positive whole pixel dimensions"
        : `Width and height must be whole numbers from 256 to ${model.provider === "LOCAL" ? 2048 : 4096} and divisible by 16`,
      400,
    );
  }
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > model.maxImages) {
    throw new ImageStudioRequestError(`${model.name} supports 1 to ${model.maxImages} images per job`, 400);
  }
  if (
    input.seed !== undefined
    && (!model.supportsSeed || !Number.isSafeInteger(input.seed) || input.seed < 0)
  ) {
    throw new ImageStudioRequestError(`${model.name} does not support this seed`, 400);
  }
  if (input.negativePrompt && !model.supportsNegativePrompt) {
    throw new ImageStudioRequestError(`${model.name} does not support negative prompts`, 400);
  }
  const references = input.referenceAssetIds ?? [];
  if (references.some((id) => !UUID_PATTERN.test(id)) || (input.maskAssetId && !UUID_PATTERN.test(input.maskAssetId))) {
    throw new ImageStudioRequestError("Reference and mask asset IDs must be valid IDs", 400);
  }
  if (new Set(references).size !== references.length) {
    throw new ImageStudioRequestError("Reference images must be unique", 400);
  }
  if (references.length > model.maxReferences) {
    throw new ImageStudioRequestError(`${model.name} supports at most ${model.maxReferences} reference images`, 400);
  }
  if (
    ["edit", "inpaint", "outpaint", "upscale", "remove-background"].includes(input.operation)
    && references.length === 0
  ) {
    throw new ImageStudioRequestError(`${input.operation} requires a reference image`, 400);
  }
  if (["inpaint", "outpaint"].includes(input.operation) && !input.maskAssetId) {
    throw new ImageStudioRequestError(`${input.operation} requires a mask image`, 400);
  }
  if (input.maskAssetId && !["inpaint", "outpaint"].includes(input.operation)) {
    throw new ImageStudioRequestError("A mask can only be used for inpainting or outpainting", 400);
  }
  if (model.provider === "CLOUD" && input.cloudConfirmed !== true) {
    throw new ImageStudioRequestError(
      `Confirm this paid Cloud job before submitting. Estimated cost: ${model.priceNote}`,
      402,
    );
  }
}

async function loadInputAssets(
  tenantId: string,
  input: ImageJobRequest,
): Promise<{
  references: Array<{ bytes: Buffer; mimeType: string }>;
  mask?: { bytes: Buffer; mimeType: string };
}> {
  const referenceIds = input.referenceAssetIds ?? [];
  const ids = [...new Set([...referenceIds, ...(input.maskAssetId ? [input.maskAssetId] : [])])];
  if (ids.length === 0) return { references: [] };
  const assets = await db
    .select()
    .from(imageStudioAssetsTable)
    .where(and(
      eq(imageStudioAssetsTable.tenantId, tenantId),
      inArray(imageStudioAssetsTable.id, ids),
    ));
  if (assets.length !== ids.length) {
    throw new ImageStudioRequestError("One or more image assets were not found", 404);
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (input.maskAssetId && ["inpaint", "outpaint"].includes(input.operation)) {
    const source = byId.get(referenceIds[0]!);
    const mask = byId.get(input.maskAssetId);
    if (
      !source
      || !mask
      || source.width !== mask.width
      || source.height !== mask.height
      || source.width !== input.width
      || source.height !== input.height
    ) {
      throw new ImageStudioRequestError(
        "The source, mask, and requested canvas must have matching dimensions",
        400,
      );
    }
  }
  const source = byId.get(referenceIds[0] ?? "");
  if (
    input.operation === "remove-background"
    && source
    && (source.width !== input.width || source.height !== input.height)
  ) {
    throw new ImageStudioRequestError(
      "Background removal preserves the source image pixel dimensions",
      400,
    );
  }
  if (input.operation === "upscale" && source) {
    const widthScale = input.width / source.width;
    const heightScale = input.height / source.height;
    if (
      Math.abs(widthScale - heightScale) > 0.05
      || widthScale < 1
      || heightScale < 1
      || widthScale > 8
      || heightScale > 8
    ) {
      throw new ImageStudioRequestError(
        "Upscale dimensions must preserve the source aspect ratio at a scale from 1× to 8×",
        400,
      );
    }
  }
  const read = async (id: string) => {
    const asset = byId.get(id)!;
    let bytes: Buffer;
    try {
      bytes = await mediaStorage.readBuffer(asset.storageKey);
    } catch {
      throw new ImageStudioRequestError("One or more image assets are unavailable", 400);
    }
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
      throw new ImageStudioRequestError("Reference and mask images must not exceed 12 MB each", 400);
    }
    return { bytes, mimeType: asset.mimeType };
  };
  const references = await Promise.all(referenceIds.map(read));
  const mask = input.maskAssetId ? await read(input.maskAssetId) : undefined;
  const totalBytes = [...references, ...(mask ? [mask] : [])]
    .reduce((total, asset) => total + asset.bytes.length, 0);
  if (totalBytes > 32 * 1024 * 1024) {
    throw new ImageStudioRequestError("Reference and mask images must not exceed 32 MB in total", 400);
  }
  return { references, ...(mask ? { mask } : {}) };
}

async function handleCompleted(
  job: ImageStudioJob,
  images: Array<{ bytes: Buffer; mimeType: string; name: string }>,
): Promise<boolean> {
  if (images.length === 0) throw new Error("The image provider completed without returning an image");
  const stored: Array<{
    name: string;
    storageKey: string;
    mimeType: string;
    width: number;
    height: number;
  }> = [];
  try {
    for (const [index, image] of images.slice(0, job.count).entries()) {
      const inspected = inspectImage(image.bytes, image.mimeType);
      const safeName = image.name.trim().slice(0, 255) || `${job.modelName} ${index + 1}`;
      const storageKey = await mediaStorage.storeImageStudioImage(
        safeName,
        inspected.mimeType,
        image.bytes,
        job.tenantId,
      );
      stored.push({ ...inspected, storageKey, name: safeName });
    }
    const accepted = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(imageStudioJobsTable)
        .where(eq(imageStudioJobsTable.id, job.id))
        .for("update")
        .limit(1);
      if (
        !current
        || !ACTIVE_STATUSES.includes(current.status as typeof ACTIVE_STATUSES[number])
        || cancellationRequested(current)
      ) {
        return false;
      }
      await tx.insert(imageStudioAssetsTable).values(stored.map((asset) => ({
        tenantId: job.tenantId,
        createdByUserId: job.createdByUserId,
        jobId: job.id,
        ...asset,
      })));
      await tx
        .update(imageStudioJobsTable)
        .set({ status: "COMPLETED", completedAt: new Date(), errorMessage: null })
        .where(eq(imageStudioJobsTable.id, job.id));
      return true;
    });
    if (!accepted) {
      await Promise.all(stored.map((asset) => mediaStorage.deleteImageStudioImage(asset.storageKey)));
    } else {
      await settleImageSpendSafely(
        job,
        "estimated",
        "Cloud image provider completed with billable output",
      );
    }
    return accepted;
  } catch (error) {
    await Promise.all(stored.map((asset) => mediaStorage.deleteImageStudioImage(asset.storageKey)));
    throw error;
  }
}

async function assignedServer(job: ImageStudioJob): Promise<ComfyServer | undefined> {
  return job.comfyServerId
    ? (await db
      .select()
      .from(comfyServersTable)
      .where(eq(comfyServersTable.id, job.comfyServerId))
      .limit(1))[0]
    : undefined;
}

async function attemptRequestedCancellation(jobId: string): Promise<"retry" | "terminal"> {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`image-studio-cancel:${jobId}`],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return "retry";

    const [job] = await db
      .select()
      .from(imageStudioJobsTable)
      .where(eq(imageStudioJobsTable.id, jobId))
      .limit(1);
    if (!job || TERMINAL_STATUSES.includes(job.status as typeof TERMINAL_STATUSES[number])) {
      return "terminal";
    }
    if (!cancellationRequested(job)) return "terminal";
    if (!job.providerRequestId) {
      if (
        hasImageSpendLifecycle(job)
        && job.providerTaskMetadata.submissionIntent !== true
      ) {
        await db
          .update(imageStudioJobsTable)
          .set({ status: "FAILED", errorMessage: "Cloud image task was not submitted" })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ));
        await settleImageSpendSafely(
          job,
          "released",
          "Cloud image request was definitively not submitted",
        );
        return "terminal";
      }
      if (submissionReceiptGraceRemaining(job) > 0) return "retry";
      await db
        .update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: submissionOutcomeUnknownMessage(job.provider),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        ));
      await settleImageSpendSafely(
        job,
        "uncertain",
        "Cloud image submission or cancellation outcome could not be confirmed",
      );
      return "terminal";
    }
    const server = await assignedServer(job);
    if (job.provider === "LOCAL" && !server) {
      await db
        .update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: "Cancellation could not be confirmed because the assigned local worker is no longer configured",
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        ));
      await settleImageSpendSafely(
        job,
        "uncertain",
        "Cloud image cancellation could not be confirmed after provider acceptance",
      );
      return "terminal";
    }
    try {
      await cancelImageTask({
        provider: job.provider,
        requestId: job.providerRequestId,
        metadata: job.providerTaskMetadata,
        ...(server ? { server } : {}),
      });
    } catch (error) {
      const message = `Cancellation requested; ${publicFailure(job, error)}`;
      if (isRetryable(error)) {
        await db
          .update(imageStudioJobsTable)
          .set({ errorMessage: `${message}. Retrying safely.`.slice(0, 800) })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ));
        return "retry";
      }
      await db
        .update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: `${message}. Cancellation could not be confirmed.`.slice(0, 800),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        ));
      await settleImageSpendSafely(
        job,
        "uncertain",
        "Cloud image cancellation could not be confirmed after provider acceptance",
      );
      return "terminal";
    }
    await db
      .update(imageStudioJobsTable)
      .set({
        status: "CANCELLED",
        errorMessage: null,
        providerTaskMetadata: {
          ...job.providerTaskMetadata,
          cancellationRequested: true,
          cancellationConfirmedAt: new Date().toISOString(),
        },
      })
      .where(and(
        eq(imageStudioJobsTable.id, job.id),
        inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        sql`${imageStudioJobsTable.providerTaskMetadata}->>'cancellationRequested' = 'true'`,
      ));
    await settleImageSpendSafely(
      job,
      "uncertain",
      "Cloud cancellation acknowledgement does not prove the accepted task was unbillable",
    );
    return "terminal";
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [`image-studio-cancel:${jobId}`])
        .catch((error) => logger.error({ err: error, jobId }, "Could not release image cancellation lock"));
    }
    client.release();
  }
}

async function monitor(jobId: string): Promise<void> {
  let failures = 0;
  while (true) {
    const [job] = await db
      .select()
      .from(imageStudioJobsTable)
      .where(eq(imageStudioJobsTable.id, jobId))
      .limit(1);
    if (!job || TERMINAL_STATUSES.includes(job.status as typeof TERMINAL_STATUSES[number])) return;
    if (!job.providerRequestId) {
      if (
        hasImageSpendLifecycle(job)
        && job.providerTaskMetadata.submissionIntent !== true
      ) {
        await db
          .update(imageStudioJobsTable)
          .set({ status: "FAILED", errorMessage: "Cloud image task was not submitted" })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ));
        await settleImageSpendSafely(
          job,
          "released",
          "Cloud image request was definitively not submitted",
        );
        return;
      }
      const graceRemaining = submissionReceiptGraceRemaining(job);
      if (graceRemaining > 0) {
        await sleep(Math.min(2_000, graceRemaining));
        continue;
      }
      await db
        .update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: submissionOutcomeUnknownMessage(job.provider),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        ));
      await settleImageSpendSafely(
        job,
        "uncertain",
        "Cloud image submission outcome could not be confirmed",
      );
      return;
    }
    if (cancellationRequested(job)) {
      const cancellation = await attemptRequestedCancellation(job.id);
      if (cancellation === "terminal") return;
      failures += 1;
      await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
      continue;
    }
    const server = await assignedServer(job);
    if (job.provider === "LOCAL" && !server) {
      const [failed] = await db
        .update(imageStudioJobsTable)
        .set({ status: "FAILED", errorMessage: "The assigned local image worker is no longer configured" })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          CANCELLATION_NOT_REQUESTED,
        ))
        .returning({ id: imageStudioJobsTable.id });
      if (failed) return;
      continue;
    }
    try {
      const result = await pollImageTask({
        provider: job.provider,
        requestId: job.providerRequestId,
        metadata: job.providerTaskMetadata,
        ...(server ? { server } : {}),
      });
      failures = 0;
      if (result.status === "COMPLETED") {
        if (await handleCompleted(job, result.images ?? [])) return;
        continue;
      }
      await db
        .update(imageStudioJobsTable)
        .set({
          status: result.status,
          ...(result.status === "RUNNING" && !job.startedAt ? { startedAt: new Date() } : {}),
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          CANCELLATION_NOT_REQUESTED,
        ));
      await sleep(result.status === "QUEUED" ? 2_000 : 1_500);
    } catch (error) {
      failures += 1;
      const expired = Date.now() - job.createdAt.getTime() > MAX_JOB_AGE_MS;
      if (!isRetryable(error) || expired) {
        const [failed] = await db
          .update(imageStudioJobsTable)
          .set({
            status: "FAILED",
            errorMessage: expired && job.provider === "CLOUD"
              ? "Cloud image monitoring timed out; provider billing outcome remains uncertain"
              : publicFailure(job, error),
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
            CANCELLATION_NOT_REQUESTED,
          ))
          .returning({ id: imageStudioJobsTable.id });
        if (failed) {
          await settleImageSpendSafely(
            job,
            "uncertain",
            "Cloud image provider result or finalization could not be confirmed",
          );
          return;
        }
        continue;
      }
      logger.warn(
        { jobId: job.id, provider: job.provider, failures, expired },
        "Image task monitoring request will be retried",
      );
      await sleep(expired ? 60_000 : Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
    }
  }
}

function startMonitor(jobId: string): void {
  if (monitors.has(jobId)) return;
  const task = monitor(jobId)
    .catch((error) => logger.error({ err: error, jobId }, "Image task monitor stopped unexpectedly"))
    .finally(() => monitors.delete(jobId));
  monitors.set(jobId, task);
}

export async function createImageJob(input: {
  tenantId: string;
  userId: string;
  request: ImageJobRequest;
}): Promise<PresentedImageJob> {
  const model = getImageModel(input.request.modelId);
  if (!model) throw new ImageStudioRequestError("Image model not found", 400);
  validateRequest(model, input.request);
  if (
    model.provider === "CLOUD"
    && (!input.tenantId.trim() || !input.userId.trim())
  ) {
    throw new ImageStudioRequestError("A signed-in workspace member is required for Cloud image jobs", 401);
  }
  if (input.request.requestKey) {
    const [existing] = await db
      .select()
      .from(imageStudioJobsTable)
      .where(and(
        eq(imageStudioJobsTable.tenantId, input.tenantId),
        eq(imageStudioJobsTable.requestKey, input.request.requestKey),
      ))
      .limit(1);
    if (existing) {
      if (
        hasImageSpendLifecycle(existing)
        && existing.providerTaskMetadata.submissionIntent !== true
        && ACTIVE_STATUSES.includes(existing.status as typeof ACTIVE_STATUSES[number])
      ) {
        throw new ImageStudioRequestError(
          "The matching Cloud image request is still reserving spend; retry shortly",
          409,
        );
      }
      if (
        existing.providerRequestId
        && ACTIVE_STATUSES.includes(existing.status as typeof ACTIVE_STATUSES[number])
      ) {
        startMonitor(existing.id);
      }
      return (await getImageJob(input.tenantId, existing.id))!;
    }
  }
  if (model.provider === "CLOUD" && !process.env.FAL_KEY?.trim()) {
    throw new ImageStudioRequestError("Cloud credentials are not configured", 503);
  }
  const loadedAssets = await loadInputAssets(input.tenantId, input.request);
  const spendQuote = model.provider === "CLOUD"
    ? await quoteImageSpend(model.id, {
      width: input.request.width,
      height: input.request.height,
      count: input.request.count,
      operation: input.request.operation,
      referenceCount: input.request.referenceAssetIds?.length ?? 0,
    })
    : undefined;
  let server: ComfyServer | undefined;
  if (model.provider === "LOCAL") {
    const candidates = await compatibleLocalServers(model);
    for (const candidate of candidates) {
      try {
        if (await serverHasCapacity(candidate) && await checkLocalImageModel(model.id, candidate)) {
          server = candidate;
          break;
        }
      } catch {
        // A different compatible worker may still be healthy and have the model installed.
      }
    }
    if (!server) {
      throw new ImageStudioRequestError(
        "All compatible local GPUs are at safe render capacity or unavailable",
        409,
      );
    }
  }

  const submit = async (): Promise<ImageStudioJob> => {
    if (server && !(await serverHasCapacity(server))) {
      throw new ImageStudioRequestError(`${server.displayName} is at safe render capacity`, 409);
    }
    const [insertedJob] = await db
      .insert(imageStudioJobsTable)
      .values({
        tenantId: input.tenantId,
        createdByUserId: input.userId,
        requestKey: input.request.requestKey ?? null,
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        operation: input.request.operation,
        prompt: input.request.prompt.trim(),
        negativePrompt: input.request.negativePrompt?.trim() || null,
        width: input.request.width,
        height: input.request.height,
        count: input.request.count,
        seed: input.request.seed ?? null,
        referenceAssetIds: input.request.referenceAssetIds ?? [],
        maskAssetId: input.request.maskAssetId ?? null,
        status: "QUEUED",
        comfyServerId: server?.id ?? null,
        providerTaskMetadata: model.provider === "CLOUD"
          ? {
            spendLifecycleVersion: IMAGE_SPEND_LIFECYCLE_VERSION,
            estimatedUsd: spendQuote!.estimatedUsd,
            pricingNote: spendQuote!.pricingNote,
            submissionIntent: false,
            cancellationRequested: false,
          }
          : {
            submissionIntent: true,
            submissionIntentAt: new Date().toISOString(),
            cancellationRequested: false,
          },
      })
      .onConflictDoNothing({
        target: [imageStudioJobsTable.tenantId, imageStudioJobsTable.requestKey],
      })
      .returning();
    if (!insertedJob) {
      const [existing] = await db
        .select()
        .from(imageStudioJobsTable)
        .where(and(
          eq(imageStudioJobsTable.tenantId, input.tenantId),
          eq(imageStudioJobsTable.requestKey, input.request.requestKey!),
        ))
        .limit(1);
      if (!existing) {
        throw new ImageStudioRequestError("The idempotent image request could not be resolved", 409);
      }
      return existing;
    }
    let job = insertedJob;
    if (model.provider === "CLOUD") {
      try {
        await reserveSpend({
          tenantId: input.tenantId,
          userId: input.userId,
          sourceType: "image",
          sourceId: job.id,
          modelId: model.id,
          estimatedUsd: spendQuote!.estimatedUsd,
          pricingNote: spendQuote!.pricingNote,
        });
        const [ready] = await db
          .update(imageStudioJobsTable)
          .set({
            providerTaskMetadata: {
              ...job.providerTaskMetadata,
              submissionIntent: true,
              submissionIntentAt: new Date().toISOString(),
              spendReserved: true,
            },
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ))
          .returning();
        if (!ready) {
          await settleImageSpendSafely(
            job,
            "released",
            "Cloud image request became inactive before provider submission",
          );
          throw new ImageStudioRequestError("The image task was cancelled before submission", 409);
        }
        job = ready;
      } catch (error) {
        await db
          .update(imageStudioJobsTable)
          .set({
            status: "FAILED",
            errorMessage: sanitizeCloudMessage(error, "Cloud image spend could not be reserved"),
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ));
        await settleImageSpendSafely(
          job,
          "released",
          "Cloud image request was not submitted to the provider",
        );
        if (error instanceof ImageStudioRequestError) throw error;
        throw new ImageStudioRequestError(
          sanitizeCloudMessage(error, "Cloud image spend could not be reserved"),
          requestErrorStatus(error, 503),
        );
      }
    }
    let providerAccepted = false;
    let submittedReceipt: Awaited<ReturnType<typeof submitImageTask>> | undefined;
    try {
      const submitted = await submitImageTask({
        modelId: model.id,
        operation: input.request.operation,
        prompt: input.request.prompt.trim(),
        negativePrompt: input.request.negativePrompt?.trim(),
        width: input.request.width,
        height: input.request.height,
        seed: input.request.seed,
        count: input.request.count,
        referenceImages: loadedAssets.references,
        mask: loadedAssets.mask,
        ...(server ? { server } : {}),
        clientId: job.id,
      });
      providerAccepted = true;
      submittedReceipt = submitted;
      const accepted = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(imageStudioJobsTable)
          .where(eq(imageStudioJobsTable.id, job.id))
          .for("update")
          .limit(1);
        if (!current || !ACTIVE_STATUSES.includes(current.status as typeof ACTIVE_STATUSES[number])) {
          return undefined;
        }
        const [updated] = await tx
          .update(imageStudioJobsTable)
          .set({
            provider: submitted.provider,
            providerRequestId: submitted.requestId,
            providerTaskMetadata: {
              ...current.providerTaskMetadata,
              ...submitted.metadata,
              submissionAcceptedAt: new Date().toISOString(),
            },
            submittedAt: new Date(),
          })
          .where(and(
            eq(imageStudioJobsTable.id, job.id),
            inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
          ))
          .returning();
        return updated;
      });
      if (!accepted) {
        await cancelImageTask({
          provider: submitted.provider,
          requestId: submitted.requestId,
          metadata: submitted.metadata,
          ...(server ? { server } : {}),
        }).catch(() => undefined);
        throw new ImageStudioRequestError("The image task was cancelled during submission", 409);
      }
      await attachImageSpendReceiptSafely(accepted);
      return accepted;
    } catch (error) {
      const outcomeUnknown = job.provider === "CLOUD"
        ? providerAccepted || !isDefinitiveSubmissionRejection(error)
        : isRetryable(error);
      const failureMessage = outcomeUnknown
        ? submissionOutcomeUnknownMessage(job.provider)
        : publicFailure(job, error);
      if (submittedReceipt) {
        await attachSubmittedImageSpendReceiptSafely(job, submittedReceipt);
      }
      const [latest] = providerAccepted
        ? await db
          .select()
          .from(imageStudioJobsTable)
          .where(eq(imageStudioJobsTable.id, job.id))
          .limit(1)
        : [];
      const [failedJob] = await db
        .update(imageStudioJobsTable)
        .set({
          status: "FAILED",
          errorMessage: failureMessage,
          ...(submittedReceipt ? {
            provider: submittedReceipt.provider,
            providerRequestId: submittedReceipt.requestId,
            submittedAt: latest?.submittedAt ?? new Date(),
          } : {}),
          providerTaskMetadata: {
            ...(latest?.providerTaskMetadata ?? job.providerTaskMetadata),
            ...(submittedReceipt?.metadata ?? {}),
            submissionOutcomeUnknown: outcomeUnknown,
            submissionFailedAt: new Date().toISOString(),
          },
        })
        .where(and(
          eq(imageStudioJobsTable.id, job.id),
          inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
        ))
        .returning();
      if (failedJob) await attachImageSpendReceiptSafely(failedJob);
      await settleImageSpendSafely(
        job,
        outcomeUnknown ? "uncertain" : "released",
        outcomeUnknown
          ? "Cloud image submission acceptance or receipt persistence could not be confirmed"
          : "Cloud image provider definitively rejected the request before acceptance",
      );
      if (error instanceof ImageStudioRequestError) throw error;
      throw new ImageStudioRequestError(
        failureMessage,
        outcomeUnknown ? 503 : 502,
      );
    }
  };

  const job = server ? await withServerSlotLock(server.id, submit) : await submit();
  if (
    job.providerRequestId
    && ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])
  ) {
    startMonitor(job.id);
  }
  return (await getImageJob(input.tenantId, job.id))!;
}

export async function cancelImageJob(
  tenantId: string,
  id: string,
): Promise<PresentedImageJob | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const job = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(imageStudioJobsTable)
      .where(and(eq(imageStudioJobsTable.id, id), eq(imageStudioJobsTable.tenantId, tenantId)))
      .for("update")
      .limit(1);
    if (!current || !ACTIVE_STATUSES.includes(current.status as typeof ACTIVE_STATUSES[number])) {
      return current;
    }
    const [requested] = await tx
      .update(imageStudioJobsTable)
      .set({
        providerTaskMetadata: {
          ...current.providerTaskMetadata,
          cancellationRequested: true,
          cancellationRequestedAt: (
            typeof current.providerTaskMetadata.cancellationRequestedAt === "string"
              ? current.providerTaskMetadata.cancellationRequestedAt
              : new Date().toISOString()
          ),
        },
      })
      .where(and(
        eq(imageStudioJobsTable.id, current.id),
        inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
      ))
      .returning();
    return requested ?? current;
  });
  if (!job) return null;
  if (ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) {
    const cancellation = await attemptRequestedCancellation(job.id);
    if (cancellation === "retry") startMonitor(job.id);
  }
  return getImageJob(tenantId, id);
}

export async function deleteImageJob(tenantId: string, id: string): Promise<"deleted" | "active" | "missing"> {
  if (!UUID_PATTERN.test(id)) return "missing";
  const [job] = await db
    .select()
    .from(imageStudioJobsTable)
    .where(and(eq(imageStudioJobsTable.id, id), eq(imageStudioJobsTable.tenantId, tenantId)))
    .limit(1);
  if (!job) return "missing";
  if (ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number])) return "active";
  await db
    .delete(imageStudioJobsTable)
    .where(and(eq(imageStudioJobsTable.id, id), eq(imageStudioJobsTable.tenantId, tenantId)));
  return "deleted";
}

export async function createUploadedAsset(input: {
  tenantId: string;
  userId: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<PresentedImageAsset> {
  const inspected = inspectImage(input.bytes, input.mimeType);
  const name = input.name.trim().slice(0, 255) || `Upload ${new Date().toISOString()}`;
  const storageKey = await mediaStorage.storeImageStudioImage(
    name,
    inspected.mimeType,
    input.bytes,
    input.tenantId,
  );
  try {
    const [asset] = await db
      .insert(imageStudioAssetsTable)
      .values({
        tenantId: input.tenantId,
        createdByUserId: input.userId,
        name,
        storageKey,
        ...inspected,
      })
      .returning();
    return presentImageAsset(asset);
  } catch (error) {
    await mediaStorage.deleteImageStudioImage(storageKey);
    throw error;
  }
}

export async function updateImageAsset(input: {
  tenantId: string;
  id: string;
  favorite?: boolean;
  collection?: string;
  name?: string;
}): Promise<PresentedImageAsset | null> {
  if (!UUID_PATTERN.test(input.id)) return null;
  const [asset] = await db
    .update(imageStudioAssetsTable)
    .set({
      ...(input.favorite === undefined ? {} : { favorite: input.favorite }),
      ...(input.collection === undefined ? {} : { collection: input.collection.trim() }),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    })
    .where(and(
      eq(imageStudioAssetsTable.id, input.id),
      eq(imageStudioAssetsTable.tenantId, input.tenantId),
    ))
    .returning();
  return asset ? presentImageAsset(asset) : null;
}

export async function deleteImageAsset(
  tenantId: string,
  id: string,
): Promise<"deleted" | "referenced" | "missing"> {
  if (!UUID_PATTERN.test(id)) return "missing";
  const [asset] = await db
    .select()
    .from(imageStudioAssetsTable)
    .where(and(eq(imageStudioAssetsTable.id, id), eq(imageStudioAssetsTable.tenantId, tenantId)))
    .limit(1);
  if (!asset) return "missing";
  const [reference] = await db
    .select({ id: imageStudioJobsTable.id })
    .from(imageStudioJobsTable)
    .where(and(
      eq(imageStudioJobsTable.tenantId, tenantId),
      or(
        eq(imageStudioJobsTable.maskAssetId, id),
        sql`${id} = ANY(${imageStudioJobsTable.referenceAssetIds})`,
      ),
    ))
    .limit(1);
  if (reference) return "referenced";
  const [deleted] = await db
    .delete(imageStudioAssetsTable)
    .where(and(
      eq(imageStudioAssetsTable.id, id),
      eq(imageStudioAssetsTable.tenantId, tenantId),
    ))
    .returning();
  if (!deleted) return "missing";
  await mediaStorage.deleteImageStudioImage(deleted.storageKey);
  return "deleted";
}

export async function resumeImageStudioJobs(): Promise<void> {
  const jobs = await db
    .select()
    .from(imageStudioJobsTable)
    .where(or(
      inArray(imageStudioJobsTable.status, [...ACTIVE_STATUSES]),
      eq(imageStudioJobsTable.provider, "CLOUD"),
    ));
  const active = jobs.filter((job) =>
    ACTIVE_STATUSES.includes(job.status as typeof ACTIVE_STATUSES[number]));
  for (const job of jobs) {
    await attachImageSpendReceiptSafely(job);
  }
  for (const job of active) startMonitor(job.id);
  for (const job of jobs) {
    if (!hasImageSpendLifecycle(job) || active.includes(job)) continue;
    if (job.status === "COMPLETED") {
      await settleImageSpendSafely(
        job,
        "estimated",
        "Restart reconciliation found completed Cloud image output",
      );
    } else if (job.status === "FAILED" && job.providerTaskMetadata.submissionIntent !== true) {
      await settleImageSpendSafely(
        job,
        "released",
        "Restart reconciliation confirmed the Cloud image request was not submitted",
      );
    } else if (job.status === "FAILED" || job.status === "CANCELLED") {
      await settleImageSpendSafely(
        job,
        "uncertain",
        "Restart reconciliation could not prove the accepted Cloud task was unbillable",
      );
    }
  }
  if (active.length > 0) logger.info({ count: active.length }, "Resumed durable image task monitors");
}