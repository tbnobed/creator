import { and, eq, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import { db, generationJobsTable, videoLibraryStatesTable, type GenerationJob } from "@workspace/db";
import { FalHttpError, FalQueueClient, TOPAZ_VIDEO_ENDPOINT } from "./fal/client";
import { uploadFalStorageFile } from "./fal/storage";
import { monitorFalGeneration } from "./generation-service";
import { logger } from "./logger";
import { reserveSpend, settleSpend } from "./spending-service";
import { mediaStorage } from "./storage-service";
import { probeVideoMediaProperties } from "./video-media-probe";
import { planTopazUpscale, topazPayload, TopazError, type TopazTarget } from "./topaz-video";

export function assertTopazSource(job: GenerationJob | undefined) {
  if (!job) throw new TopazError(404, "Source video not found.");
  if (job.status !== "COMPLETED") throw new TopazError(409, "Only completed videos can be upscaled.");
  if (!job.outputStorageKey || !job.outputMimeType?.startsWith("video/")) {
    throw new TopazError(400, "This generation has no video output to upscale.");
  }
}

export function topazSubmissionIsUnbilled(attempted: boolean, error: unknown) {
  return !attempted || (error instanceof FalHttpError && error.status !== null
    && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status));
}

async function prepare(tenantId: string, sourceId: string, target: TopazTarget) {
  if (!process.env.FAL_KEY?.trim()) throw new TopazError(503, "Topaz requires the Cloud FAL_KEY configuration, including for local GPU videos.");
  const [source] = await db.select().from(generationJobsTable).where(and(
    eq(generationJobsTable.id, sourceId), eq(generationJobsTable.tenantId, tenantId),
    notExists(db.select({ id: videoLibraryStatesTable.id }).from(videoLibraryStatesTable).where(and(
      eq(videoLibraryStatesTable.generationJobId, sourceId),
      eq(videoLibraryStatesTable.tenantId, tenantId), isNotNull(videoLibraryStatesTable.deletedAt),
    ))),
  ));
  assertTopazSource(source);
  // The DB-owned storage key, never a client URL, is the only allowed input.
  const bytes = await mediaStorage.readBuffer(source.outputStorageKey!);
  const properties = await probeVideoMediaProperties(bytes);
  const plan = planTopazUpscale(source.id, source.outputStorageKey!, properties, target);
  return { source, bytes, plan };
}

export async function quoteTopaz(tenantId: string, sourceId: string, target: TopazTarget) {
  return (await prepare(tenantId, sourceId, target)).plan;
}

export async function submitTopaz(input: {
  tenantId: string; userId: string; sourceId: string; targetResolution: TopazTarget; quoteToken: string; requestId: string;
}): Promise<GenerationJob> {
  const findExisting = async () => {
    const [existing] = await db.select().from(generationJobsTable).where(and(
      eq(generationJobsTable.id, input.requestId), eq(generationJobsTable.tenantId, input.tenantId),
    ));
    if (!existing) return undefined;
    if (existing.parentGenerationId !== input.sourceId || existing.providerModelId !== TOPAZ_VIDEO_ENDPOINT
      || existing.providerTaskMetadata.topazQuoteToken !== input.quoteToken
      || (existing.providerTaskMetadata.topaz as { targetResolution?: unknown } | undefined)?.targetResolution !== input.targetResolution) {
      throw new TopazError(409, "This request ID already belongs to another operation.");
    }
    return existing;
  };
  const existing = await findExisting();
  if (existing) return existing; // Includes unknown submissions: NEVER submit them again.
  const { source, bytes, plan } = await prepare(input.tenantId, input.sourceId, input.targetResolution);
  if (plan.quoteToken !== input.quoteToken) throw new TopazError(409, "The source or estimate changed. Review a new quote before confirming.");
  const metadata = {
    operation: "topaz-upscale", model: "topaz-upscale",
    topaz: { ...plan, sourceStorageKey: source.outputStorageKey },
    topazQuoteToken: plan.quoteToken,
    spendLifecycleVersion: 1, submissionIntent: false, submissionOutcome: "not-submitted",
  };
  const { job, created } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`topaz:${input.tenantId}:${source.id}:${plan.quoteToken}`}, 0))`);
    const [pending] = await tx.select().from(generationJobsTable).where(and(
      eq(generationJobsTable.tenantId, input.tenantId),
      eq(generationJobsTable.parentGenerationId, source.id),
      eq(generationJobsTable.providerModelId, TOPAZ_VIDEO_ENDPOINT),
      sql`${generationJobsTable.providerTaskMetadata}->>'topazQuoteToken' = ${plan.quoteToken}`,
      // Reuse a completed rendition too: a lost acknowledgement of a coalesced
      // request must not create another paid copy after the first one finishes.
      or(inArray(generationJobsTable.status, ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING", "COMPLETED"]),
        isNotNull(generationJobsTable.providerRequestId),
        sql`${generationJobsTable.providerTaskMetadata}->>'submissionOutcome' = 'unknown'`),
    ));
    if (pending) return { job: pending, created: false };
    const [inserted] = await tx.insert(generationJobsTable).values({
    id: input.requestId, tenantId: input.tenantId, createdByUserId: input.userId,
    parentGenerationId: source.id,
    title: `${source.title.slice(0, 120)} — Topaz ${plan.targetWidth}×${plan.targetHeight} (upscaled from ${plan.sourceWidth}×${plan.sourceHeight})`,
    status: "UPLOADING", provider: "FAL", providerModelId: TOPAZ_VIDEO_ENDPOINT,
    providerTaskMetadata: metadata, prompt: source.prompt, compiledPrompt: source.compiledPrompt,
    dialogue: "", width: plan.targetWidth, height: plan.targetHeight, fps: Math.round(plan.fps),
    frameCount: Math.round(plan.durationSeconds * plan.fps), durationSeconds: plan.durationSeconds,
    generationMode: source.generationMode, qualityPreset: source.qualityPreset,
    currentNode: "Preparing optional Topaz upscale",
    }).onConflictDoNothing().returning();
    return { job: inserted, created: Boolean(inserted) };
  });
  if (!job) {
    const duplicate = await findExisting();
    if (duplicate) return duplicate;
    throw new TopazError(409, "Request ID unavailable. No new processing was submitted.");
  }
  if (!created) return job;
  let reserved = false;
  let attempted = false;
  try {
    await reserveSpend({
      tenantId: input.tenantId, userId: input.userId, sourceType: "video", sourceId: job.id,
      modelId: TOPAZ_VIDEO_ENDPOINT, estimatedUsd: plan.estimatedUsd, pricingNote: plan.pricingNote,
    });
    reserved = true;
    const videoUrl = await uploadFalStorageFile(bytes, source.outputMimeType!, `topaz-source-${source.id}`, process.env.FAL_KEY!.trim());
    const [intent] = await db.update(generationJobsTable).set({
      providerTaskMetadata: { ...metadata, submissionIntent: true, submissionOutcome: "unknown", submissionIntentAt: new Date().toISOString() },
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING"))).returning();
    if (!intent) throw new TopazError(409, "Upscale was cancelled before submission.");
    const client = new FalQueueClient("topaz-upscale");
    attempted = true;
    const submitted = await client.submit(topazPayload(videoUrl, plan));
    const accepted = { ...intent.providerTaskMetadata, submissionOutcome: "accepted", submission: submitted.metadata };
    const [queued] = await db.update(generationJobsTable).set({
      status: "QUEUED", queuedAt: new Date(), currentNode: "Waiting for Topaz",
      providerRequestId: submitted.requestId, providerTaskMetadata: accepted,
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING"))).returning();
    if (!queued) {
      const [cancelled] = await db.update(generationJobsTable).set({
        providerRequestId: submitted.requestId, providerTaskMetadata: { ...accepted, cancellationRequested: true },
      }).where(eq(generationJobsTable.id, job.id)).returning();
      await client.cancel(submitted.endpoints).catch((error) => logger.warn({ err: error, jobId: job.id }, "Topaz cancellation will need recovery"));
      await settleSpend("video", job.id, "uncertain", "Topaz accepted processing before local cancellation.");
      return cancelled;
    }
    void monitorFalGeneration(job.id, client, submitted.requestId, submitted.endpoints)
      .catch((error) => logger.error({ err: error, jobId: job.id }, "Topaz monitor interrupted; receipt retained for recovery"));
    return queued;
  } catch (error) {
    const unbilled = topazSubmissionIsUnbilled(attempted, error);
    await db.update(generationJobsTable).set({
      status: "FAILED", failedAt: new Date(), currentNode: null,
      errorMessage: unbilled ? (error instanceof Error ? error.message : "Topaz preparation failed")
        : "Topaz submission outcome is unknown. Do not submit again: processing may have been charged. The original is safe.",
      providerTaskMetadata: { ...metadata, submissionIntent: attempted, submissionOutcome: unbilled ? (attempted ? "rejected" : "not-submitted") : "unknown" },
    }).where(and(eq(generationJobsTable.id, job.id), eq(generationJobsTable.status, "UPLOADING")));
    if (reserved) await settleSpend("video", job.id, unbilled ? "released" : "uncertain",
      unbilled ? "Topaz did not enter paid processing." : "Topaz acceptance is unknown; estimate remains held.");
    throw error;
  }
}