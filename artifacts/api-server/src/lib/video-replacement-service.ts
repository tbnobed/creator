import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, generationJobsTable } from "@workspace/db";
import { createAndSubmitGeneration } from "./generation-service";
import { assertGarmentKey, GarmentError } from "./garment-media";
import { mediaStorage } from "./storage-service";
import { prepareReplacementSource, replacementPrompt, validateReplacementRange } from "./video-replacement-media";
import type { PixelAnimation } from "./artwork-animation-service";

// Keep this shared with request-contract tests: the Seedance adapter rejects
// fixed seeds, even though the legacy local garment API requires a seed field.
export const replacementSampling = { seedMode: "RANDOM" } as const;

export type ReplacementSubmission = {
  pixelAnimation?: PixelAnimation;
  requestId: string; tenantId: string; userId: string;
  provider?: "LOCAL" | "FAL"; model?: "seedance-2.5" | "kling-o3-edit"; confirmPaid?: boolean;
  sourceStorageKey: string; referenceStorageKey?: string; workerId?: string;
  mode: "replace-garment" | "animate-artwork" | "replace-item";
  artworkSource?: "existing" | "upload";
  targetGarment: string; prompt: string; startSeconds: number; durationSeconds: number; seed: number;
};

export function validatePaidReplacement(input: ReplacementSubmission) {
  if (input.provider !== "FAL" || !["seedance-2.5", "kling-o3-edit"].includes(input.model ?? "") || input.mode !== "replace-item") {
    throw new GarmentError(400, "Choose a supported cloud video replacement model.");
  }
  if (input.confirmPaid !== true) throw new GarmentError(400, "Confirm paid cloud processing before submitting.");
  validateReplacementRange(input.startSeconds, input.durationSeconds, input.startSeconds + input.durationSeconds, input.model);
  if (!input.prompt.trim() || input.prompt.length > 600 || !input.targetGarment.trim() || input.targetGarment.length > 160) {
    throw new GarmentError(400, "Describe the target and the replacement you want.");
  }
  assertGarmentKey(input.sourceStorageKey, input.tenantId);
  if (input.referenceStorageKey) assertGarmentKey(input.referenceStorageKey, input.tenantId, true);
  if (input.workerId || input.artworkSource) throw new GarmentError(400, "Cloud replacement does not use local workers or artwork animation settings.");
}

export async function submitPaidReplacement(input: ReplacementSubmission) {
  validatePaidReplacement(input);
  const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, userId: undefined })).digest("hex");
  // Serialize retries across API processes. A saved job means never submit again,
  // even when a provider response or the HTTP response was lost.
  const lock = await pool.connect();
  let locked = false;
  try {
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`replacement:${input.tenantId}:${input.requestId}`]);
    locked = Boolean(result.rows[0]?.locked);
    if (!locked) throw new GarmentError(429, "This request is already being prepared. Wait for it to appear in saved jobs.");
    const [existing] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, input.requestId));
    if (existing) {
      const saved = existing.providerTaskMetadata.videoReplacement as { fingerprint?: string } | undefined;
      if (existing.tenantId !== input.tenantId || saved?.fingerprint !== fingerprint) {
        throw new GarmentError(409, "Request ID belongs to different processing.");
      }
      return { jobId: existing.id };
    }
    const original = await mediaStorage.readGenerationReferenceMedia(input.sourceStorageKey);
    if (original.bytes.length > 200 * 1024 * 1024) throw new GarmentError(400, "Use a video smaller than 200 MB.");
    const prepared = await prepareReplacementSource(original.bytes, input.startSeconds, input.durationSeconds, input.model);
    const preparedKey = await mediaStorage.storeGenerationReferenceMedia("video/mp4", prepared, input.tenantId);
    try {
      const job = await createAndSubmitGeneration({
        jobId: input.requestId, tenantId: input.tenantId, createdByUserId: input.userId,
        provider: "FAL", model: input.model!, ...(input.model === "seedance-2.5" ? {seedanceTask: "editing" as const} : {}),
        generationMode: "replace-item", prompt: replacementPrompt(input.targetGarment, input.prompt, Boolean(input.referenceStorageKey)),
        referenceVideoKeys: [preparedKey],
        referenceImageKeys: input.referenceStorageKey ? [input.referenceStorageKey] : [],
        durationSeconds: input.durationSeconds, width: 1280, height: 720, fps: 24,
        outputResolution: "720p", outputFormat: "mp4", nativeAudioEnabled: false,
        qualityPreset: "STANDARD", ...replacementSampling,
        videoReplacement: {
          fingerprint, sourceStorageKey: input.sourceStorageKey, preparedKey,
          target: input.targetGarment, startSeconds: input.startSeconds, durationSeconds: input.durationSeconds,
        },
      });
      return { jobId: job.id };
    } catch (error) {
      // Keep a durably saved request discoverable, including rejected/uncertain
      // provider submissions. The caller must not accidentally create a retry.
      const [saved] = await db.select({ id: generationJobsTable.id }).from(generationJobsTable)
        .where(eq(generationJobsTable.id, input.requestId));
      if (saved) return { jobId: saved.id };
      throw error;
    }
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`replacement:${input.tenantId}:${input.requestId}`]);
    lock.release();
  }
}
