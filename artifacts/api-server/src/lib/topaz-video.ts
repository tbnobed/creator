import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeVideoMediaProperties, type VideoMediaProperties } from "./video-media-probe";

export type TopazTarget = "1080p" | "4k";
export class TopazError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export type TopazPlan = {
  sourceId: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  durationSeconds: number;
  fps: number;
  hasAudio: boolean;
  audioStreams: number;
  targetResolution: TopazTarget;
  upscaleFactor: number;
  estimatedUsd: number;
  pricingNote: string;
  quoteToken: string;
};

/** A conservative local rate card, not provider billing or a live price lookup. */
export function planTopazUpscale(
  sourceId: string, sourceKey: string, properties: VideoMediaProperties, targetResolution: TopazTarget,
): TopazPlan {
  const { width, height, fps, durationSeconds } = properties;
  if (!width || !height || !fps || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TopazError(400, "Cannot upscale: the source video dimensions, duration and frame rate must be measurable.");
  }
  if (fps > 60.01 || durationSeconds > 600) {
    throw new TopazError(400, "Topaz upscaling currently supports clips up to 10 minutes and 60 fps.");
  }
  if (targetResolution !== "1080p" && targetResolution !== "4k") throw new TopazError(400, "Unsupported upscale target.");
  const short = targetResolution === "1080p" ? 1080 : 2160;
  const long = targetResolution === "1080p" ? 1920 : 3840;
  // Fit inside the oriented delivery frame, preserving wide/square/portrait aspect.
  const upscaleFactor = Math.min(short / Math.min(width, height), long / Math.max(width, height));
  if (upscaleFactor <= 1) throw new TopazError(400, "Choose a target larger than the source. Topaz will not downscale this video.");
  const targetWidth = Math.round(width * upscaleFactor / 2) * 2;
  const targetHeight = Math.round(height * upscaleFactor / 2) * 2;
  // Charge the high-frame-rate tier conservatively for everything above 30 fps.
  const rate = (targetResolution === "1080p" ? 0.02 : 0.08) * (fps > 30.01 ? 2 : 1);
  const estimatedUsd = Math.ceil(Math.ceil(durationSeconds) * rate * 1_000_000) / 1_000_000;
  const audioStreams = properties.audioStreams ?? 0;
  const plan = {
    sourceId, sourceWidth: width, sourceHeight: height, targetWidth, targetHeight,
    durationSeconds, fps, hasAudio: audioStreams > 0, audioStreams, targetResolution, upscaleFactor,
    estimatedUsd,
    pricingNote: `Local Topaz Proteus estimate: $${rate.toFixed(2)}/output second; duration rounded up${fps > 30.01 ? "; high-frame-rate allowance applied" : ""}. Not a provider invoice.`,
  };
  return { ...plan, quoteToken: createHash("sha256").update(JSON.stringify({ sourceKey, ...plan })).digest("hex") };
}

export function topazPayload(videoUrl: string, plan: TopazPlan) {
  return { video_url: videoUrl, model: "Proteus", upscale_factor: plan.upscaleFactor, H264_output: true };
}

export function validateTopazOutput(properties: VideoMediaProperties, plan: TopazPlan) {
  if (properties.width !== plan.targetWidth || properties.height !== plan.targetHeight) {
    throw new Error(`Topaz returned ${properties.width ?? "unknown"}×${properties.height ?? "unknown"} instead of ${plan.targetWidth}×${plan.targetHeight}. The original was preserved.`);
  }
  if (!properties.fps || Math.abs(properties.fps - plan.fps) > 0.02) {
    throw new Error("Topaz changed the frame rate. The original was preserved.");
  }
  if (Math.abs(properties.durationSeconds - plan.durationSeconds) > Math.max(0.15, 2 / plan.fps)) {
    throw new Error("Topaz changed the video timing. The original was preserved.");
  }
}

/** Always use the source audio, never invented/provider-replaced audio. Video is stream copied. */
export async function finalizeTopazOutput(video: Buffer, source: Buffer, plan: TopazPlan) {
  validateTopazOutput(await probeVideoMediaProperties(video), plan);
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-topaz-"));
  try {
    const input = path.join(directory, "enhanced.mp4");
    const original = path.join(directory, "original");
    const output = path.join(directory, "output.mp4");
    await Promise.all([writeFile(input, video), writeFile(original, source)]);
    await promisify(execFile)("ffmpeg", [
      "-v", "error", "-nostdin", "-i", input, "-i", original,
      "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", "-y", output,
    ], { timeout: 300_000, maxBuffer: 16 * 1024 });
    const bytes = await readFile(output);
    const properties = await probeVideoMediaProperties(bytes);
    validateTopazOutput(properties, plan);
    if ((properties.audioStreams ?? 0) !== plan.audioStreams) {
      throw new Error("Topaz audio preservation failed. The original was preserved.");
    }
    return { bytes, properties };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}