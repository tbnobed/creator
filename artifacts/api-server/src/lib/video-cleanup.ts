import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeVideoMediaProperties, type VideoMediaProperties } from "./video-media-probe";

export const CLEANUP_ENDPOINT = "bria/video/erase/keypoints";
export const CLEANUP_FINALIZATION_ERROR = "Video cleanup output verification failed";
export const CLEANUP_ALLOWANCE_USD = 5;
export const CLEANUP_PRICING_NOTE = "A $5 local spending allowance is reserved per cleanup. This is not a provider price quote or a charge cap. Fal bills your account separately; actual charges may differ.";
export type CleanupPoint = { x: number; y: number; type: "positive" | "negative" };
export class CleanupError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export function assertCleanupSourceKey(key: string, tenantId: string) {
  if (!new RegExp(`^tenants/${tenantId}/generation-references/[a-z0-9_-]+\\.(mp4|mov)$`, "i").test(key)) {
    throw new CleanupError(400, "Select an uploaded video belonging to this workspace.");
  }
}
export function cleanupPlan(bytes: Buffer, properties: VideoMediaProperties) {
  const { durationSeconds, fps, width, height, rotationDegrees = 0 } = properties;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds >= 5) {
    throw new CleanupError(400, "Video Cleanup requires a single shot shorter than 5 seconds. Trim your clip before uploading; nothing is trimmed automatically.");
  }
  if (!width || !height || !fps || width > 4096 || height > 4096 || fps > 60.01) {
    throw new CleanupError(400, "Use a measurable video up to 4096 pixels per edge and 60 fps.");
  }
  if (rotationDegrees % 90 !== 0) throw new CleanupError(400, "Export this clip with its rotation applied before cleanup.");
  const rotated = Math.abs(rotationDegrees % 180) === 90;
  return {
    width: rotated ? height : width, height: rotated ? width : height, fps, durationSeconds,
    hasAudio: (properties.audioStreams ?? 0) > 0, audioStreams: properties.audioStreams ?? 0,
    rotationDegrees,
    estimatedUsd: CLEANUP_ALLOWANCE_USD, pricingNote: CLEANUP_PRICING_NOTE,
    sourceToken: createHash("sha256").update(bytes).update(String(CLEANUP_ALLOWANCE_USD)).digest("hex"),
  };
}
export type CleanupPlan = ReturnType<typeof cleanupPlan>;

export function cleanupPayload(videoUrl: string, points: CleanupPoint[], plan: Pick<CleanupPlan, "width" | "height">) {
  if (!points.length || points.length > 40 || !points.some((point) => point.type === "positive")
    || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || !["positive", "negative"].includes(point.type))) {
    throw new CleanupError(400, "Add at least one Remove point. Use up to 40 valid Remove or Protect points.");
  }
  return {
    video_url: videoUrl, auto_trim: false, preserve_audio: true, output_container_and_codec: "mp4_h264",
    keypoints: points.map((point) => JSON.stringify({
      x: Math.min(plan.width - 1, Math.round(point.x * plan.width)),
      y: Math.min(plan.height - 1, Math.round(point.y * plan.height)), type: point.type,
    })),
  };
}

export function validateCleanupOutput(properties: VideoMediaProperties, plan: CleanupPlan) {
  if (!properties.width || !properties.height || !properties.fps
    || Math.abs(properties.width / properties.height - plan.width / plan.height) > 0.02
    || Math.abs(properties.durationSeconds - plan.durationSeconds) > Math.max(0.15, 2 / plan.fps)) {
    throw new Error("Cleanup changed the clip timing or framing. The original is safe; the result was not accepted.");
  }
}

/** Normalize display rotation before point-based processing, never transform coordinates by guessing. */
export async function normalizeCleanupRotation(bytes: Buffer, plan: CleanupPlan): Promise<Buffer> {
  if (!plan.rotationDegrees) return bytes;
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-cleanup-rotate-"));
  try {
    const input = path.join(directory, "source");
    const output = path.join(directory, "upright.mp4");
    await writeFile(input, bytes);
    await promisify(execFile)("ffmpeg", [
      "-v", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac",
      "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart", "-y", output,
    ], { timeout: 120_000, maxBuffer: 16 * 1024 });
    const normalized = await readFile(output);
    const properties = await probeVideoMediaProperties(normalized);
    if (properties.width !== plan.width || properties.height !== plan.height || properties.rotationDegrees) {
      throw new CleanupError(400, "Could not normalize this video's orientation safely.");
    }
    return normalized;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Discard provider audio and restore all original source audio tracks. */
export async function finalizeCleanupOutput(video: Buffer, source: Buffer, plan: CleanupPlan) {
  validateCleanupOutput(await probeVideoMediaProperties(video), plan);
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-cleanup-audio-"));
  try {
    const input = path.join(directory, "cleaned.mp4"), original = path.join(directory, "source");
    const output = path.join(directory, "output.mp4");
    await Promise.all([writeFile(input, video), writeFile(original, source)]);
    await promisify(execFile)("ffmpeg", [
      "-v", "error", "-nostdin", "-i", input, "-i", original,
      "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
      "-movflags", "+faststart", "-y", output,
    ], { timeout: 120_000, maxBuffer: 16 * 1024 });
    const bytes = await readFile(output);
    const properties = await probeVideoMediaProperties(bytes);
    validateCleanupOutput(properties, plan);
    if ((properties.audioStreams ?? 0) !== plan.audioStreams) throw new Error("Original audio could not be preserved.");
    return { bytes, properties };
  } finally { await rm(directory, { recursive: true, force: true }); }
}