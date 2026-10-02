import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, notExists, sql } from "drizzle-orm";
import { db, generationJobsTable, videoLibraryStatesTable, type GenerationJob } from "@workspace/db";
import { FalHttpError, FalQueueClient } from "./fal/client";
import { uploadFalStorageFile } from "./fal/storage";
import { monitorFalGeneration } from "./generation-service";
import { logger } from "./logger";
import { reserveSpend, settleSpend } from "./spending-service";
import { mediaStorage } from "./storage-service";
import { probeVideoMediaProperties } from "./video-media-probe";
import {
  assertCleanupSourceKey, CLEANUP_ENDPOINT, CleanupError, cleanupPayload, cleanupPlan,
  normalizeCleanupRotation, type CleanupPoint,
} from "./video-cleanup";

export type CleanupSubmission = {
  sourceStorageKey: string; sourceToken: string; requestId: string; confirmPaid: boolean;
  points: CleanupPoint[]; cameraMode: "stationary" | "moving"; tenantId: string; userId: string;
};

async function prepare(tenantId: string, sourceStorageKey: string) {
  assertCleanupSourceKey(sourceStorageKey, tenantId);
  if (!process.env.FAL_KEY?.trim()) throw new CleanupError(503, "Video Cleanup requires the existing Cloud FAL_KEY configuration.");
  const { bytes, mimeType } = await mediaStorage.readGenerationReferenceMedia(sourceStorageKey);
  if (!["video/mp4", "video/quicktime"].includes(mimeType) || bytes.length > 200 * 1024 * 1024) {
    throw new CleanupError(400, "Upload an MP4 or MOV video smaller than 200 MB.");
  }
  const plan = cleanupPlan(bytes, await probeVideoMediaProperties(bytes));
  return { bytes, mimeType, plan };
}

export async function inspectCleanup(tenantId: string, sourceStorageKey: string) {
  const { plan } = await prepare(tenantId, sourceStorageKey);
  return { ...plan, storageKey: sourceStorageKey, mediaUrl: `/api/media/${sourceStorageKey}` };
}

export async function listCleanupJobs(tenantId: string) {
  const rows = await db.select().from(generationJobsTable).where(and(
    eq(generationJobsTable.tenantId, tenantId), eq(generationJobsTable.providerModelId, CLEANUP_ENDPOINT),
    notExists(db.select({ id: videoLibraryStatesTable.id }).from(videoLibraryStatesTable).where(and(
      eq(videoLibraryStatesTable.generationJobId, generationJobsTable.id),
      eq(videoLibraryStatesTable.tenantId, tenantId), isNotNull(videoLibraryStatesTable.deletedAt),
    ))),
  )).orderBy(desc(generationJobsTable.createdAt)).limit(100);
  return rows.map((job) => {
    const cleanup = job.providerTaskMetadata.cleanup as {
      sourceStorageKey: string; points: CleanupPoint[]; cameraMode: "stationary" | "moving";
    };
    return {
      jobId: job.id, title: job.title, status: job.status, cameraMode: cleanup.cameraMode,
      sourceMediaUrl: `/api/media/${cleanup.sourceStorageKey}`,
      outputMediaUrl: job.status === "COMPLETED" && job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
      errorMessage: job.errorMessage, currentNode: job.currentNode, points: cleanup.points,
      createdAt: job.createdAt.toISOString(),
    };
  });
}

export async function submitCleanup(input: CleanupSubmission): Promise<GenerationJob> {
  if (input.confirmPaid !== true) throw new CleanupError(400, "Confirm paid cloud processing before submitting.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new CleanupError(400, "A stable UUID request ID is required.");
  }
  assertCleanupSourceKey(input.sourceStorageKey, input.tenantId);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    source: input.sourceStorageKey, token: input.sourceToken, points: input.points, cameraMode: input.cameraMode,
  })).digest("hex");
  const findExisting = async () => {
    const [job] = await db.select().from(generationJobsTable).where(and(
      eq(generationJobsTable.id, input.requestId), eq(generationJobsTable.tenantId, input.tenantId),
    ));
    if (job && (job.providerModelId !== CLEANUP_ENDPOINT || job.providerTaskMetadata.cleanupFingerprint !== fingerprint)) {
      throw new CleanupError(409, "This request ID belongs to different processing. Restore that request or start a new edit.");
    }
    return job;
  };
  const existing = await findExisting();
  if (existing) return existing;
  const { bytes, mimeType, plan } = await prepare(input.tenantId, input.sourceStorageKey);
  if (plan.sourceToken !== input.sourceToken) throw new CleanupError(409, "The source or spending allowance changed. Inspect the clip again before confirming.");
  cleanupPayload("https://example.invalid/validation-only", input.points, plan);
  const metadata = {
    operation: "video-cleanup", model: "video-cleanup", cleanupFingerprint: fingerprint,
    cleanup: { ...plan, sourceStorageKey: input.sourceStorageKey, points: input.points, cameraMode: input.cameraMode },
    spendLifecycleVersion: 1, submissionIntent: false, submissionOutcome: "not-submitted",
  };
  const [job] = await db.insert(generationJobsTable).values({
    id: input.requestId, tenantId: input.tenantId, createdByUserId: input.userId,
    title: `Video Cleanup — ${input.cameraMode === "moving" ? "Moving" : "Stationary"} camera`,
    status: "UPLOADING", provider: "FAL", providerModelId: CLEANUP_ENDPOINT,
    providerTaskMetadata: metadata, prompt: "Remove marked objects while protecting the marked foreground.",
    compiledPrompt: "Point-guided video object removal", dialogue: "",
    width: plan.width, height: plan.height, fps: Math.round(plan.fps),
    frameCount: Math.round(plan.durationSeconds * plan.fps), durationSeconds: plan.durationSeconds,
    generationMode: "video-cleanup", qualityPreset: "STANDARD", currentNode: "Preparing Video Cleanup",
  }).onConflictDoNothing().returning();
  if (!job) {
    const duplicate = await findExisting();
    if (duplicate) return duplicate;
    throw new CleanupError(409, "Request ID unavailable. No new cleanup was submitted.");
  }
  let reserved = false, attempted = false;
  let receipt: Awaited<ReturnType<FalQueueClient["submit"]>> | undefined;
  try {
    await reserveSpend({
      tenantId: input.tenantId, userId: input.userId, sourceType: "video", sourceId: job.id,
      modelId: CLEANUP_ENDPOINT, estimatedUsd: plan.estimatedUsd, pricingNote: plan.pricingNote,
    });
    reserved = true;
    const normalized = await normalizeCleanupRotation(bytes, plan);
    const videoUrl = await uploadFalStorageFile(normalized, plan.rotationDegrees ? "video/mp4" : mimeType,
      `cleanup-source-${job.id}.${plan.rotationDegrees || mimeType === "video/mp4" ? "mp4" : "mov"}`, process.env.FAL_KEY!.trim());
    const [intent] = await db.update(generationJobsTable).set({
      providerTaskMetadata: { ...metadata, submissionIntent: true, submissionOutcome: "unknown", submissionIntentAt: new Date().toISOString() },
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING"))).returning();
    if (!intent) throw new CleanupError(409, "Cleanup was cancelled before submission.");
    const client = new FalQueueClient("video-cleanup");
    attempted = true;
    receipt = await client.submit(cleanupPayload(videoUrl, input.points, plan));
    const accepted = { ...intent.providerTaskMetadata, submissionOutcome: "accepted", submission: receipt.metadata };
    const [queued] = await db.update(generationJobsTable).set({
      status: "QUEUED", queuedAt: new Date(), currentNode: "Waiting for object removal",
      providerRequestId: receipt.requestId, providerTaskMetadata: accepted,
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING"))).returning();
    if (!queued) {
      const [cancelled] = await db.update(generationJobsTable).set({
        providerRequestId: receipt.requestId, providerTaskMetadata: { ...accepted, cancellationRequested: true },
      }).where(eq(generationJobsTable.id, job.id)).returning();
      await client.cancel(receipt.endpoints).catch((error) => logger.warn({ err: error, jobId: job.id }, "Cleanup cancellation needs recovery"));
      await settleSpend("video", job.id, "uncertain", "Cleanup accepted before local cancellation.");
      return cancelled;
    }
    void monitorFalGeneration(job.id, client, receipt.requestId, receipt.endpoints)
      .catch((error) => logger.error({ err: error, jobId: job.id }, "Cleanup monitoring interrupted; durable receipt retained"));
    return queued;
  } catch (error) {
    const unbilled = !attempted || (error instanceof FalHttpError && error.status !== null
      && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status));
    const message = receipt ? "Timed out while waiting for Cloud" : unbilled
      ? (error instanceof Error ? error.message : "Cleanup preparation failed")
      : "Cleanup submission outcome is unknown. Do not submit a new job: processing may have been charged. Your original is safe.";
    await db.update(generationJobsTable).set({
      status: "FAILED", failedAt: new Date(), currentNode: null, errorMessage: message,
      ...(receipt ? { providerRequestId: receipt.requestId } : {}),
      providerTaskMetadata: {
        ...metadata, submissionIntent: attempted,
        submissionOutcome: receipt ? "accepted" : unbilled ? "not-submitted" : "unknown",
        ...(receipt ? { submission: receipt.metadata } : {}),
      },
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING")));
    if (reserved) await settleSpend("video", job.id, unbilled ? "released" : "uncertain",
      unbilled ? "Cleanup did not enter paid processing." : "Cleanup acceptance uncertain; local allowance remains held.");
    // Return the durable job so a transport retry cannot be mistaken for new paid work.
    const failed = await findExisting();
    if (failed) return failed;
    throw new CleanupError(400, message);
  }
}