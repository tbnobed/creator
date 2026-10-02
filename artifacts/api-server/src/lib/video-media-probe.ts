import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type VideoMediaProperties = {
  durationSeconds: number;
  fps?: number;
  width?: number;
  height?: number;
  audioStreams?: number;
  rotationDegrees?: number;
};

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return undefined;
  }
  const rate = numerator / denominator;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 240) return undefined;
  return rate;
}

export function parseVideoMediaProperties(probeOutput: string): VideoMediaProperties {
  let parsed: unknown;
  try {
    parsed = JSON.parse(probeOutput);
  } catch {
    throw new Error("Video metadata probe returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Video metadata probe returned invalid data");
  const output = parsed as {
    format?: { duration?: unknown };
    streams?: Array<{
      codec_type?: unknown;
      avg_frame_rate?: unknown;
      r_frame_rate?: unknown;
      width?: unknown;
      height?: unknown;
      side_data_list?: Array<{ rotation?: unknown }>;
    }>;
  };
  const duration = Number(output.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Video metadata probe did not return a valid duration");
  }
  const videoStream = output.streams?.find((stream) => stream.codec_type === "video") ?? output.streams?.[0];
  const fps = parseRate(videoStream?.avg_frame_rate) ?? parseRate(videoStream?.r_frame_rate);
  const width = Number(videoStream?.width);
  const height = Number(videoStream?.height);
  const rotation = Number(videoStream?.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0);
  return {
    durationSeconds: duration,
    ...(fps ? { fps } : {}),
    ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isSafeInteger(height) && height > 0 ? { height } : {}),
    audioStreams: output.streams?.filter((stream) => stream.codec_type === "audio").length ?? 0,
    ...(Number.isFinite(rotation) && rotation !== 0 ? { rotationDegrees: rotation } : {}),
  };
}

export function frameCountForVideo(durationSeconds: number, fps: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error("Video duration and frame rate must be finite and positive");
  }
  return Math.round(durationSeconds * fps);
}

export function measuredVideoJobMetrics(
  properties: VideoMediaProperties,
  fallbackFps: number,
): { durationSeconds: number; fps: number; frameCount: number } {
  const fps = properties.fps ?? fallbackFps;
  return {
    durationSeconds: properties.durationSeconds,
    fps,
    frameCount: frameCountForVideo(properties.durationSeconds, fps),
  };
}

export async function probeVideoMediaProperties(bytes: Buffer): Promise<VideoMediaProperties> {
  if (!bytes.length) throw new Error("The video file is empty.");
  // Uploaded MP4/MOV files may require seeking (including metadata at the end).
  // A pipe also raises EPIPE when ffprobe finishes before consuming the upload.
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-video-probe-"));
  try {
    const input = path.join(directory, "source");
    await writeFile(input, bytes);
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation",
      "-of", "json",
      "-i", input,
      ], { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") throw new Error("Video inspection is unavailable: ffprobe is not installed on the API server.");
      if (failure.killed) throw new Error("Video metadata probe timed out.");
      throw new Error("Could not read the video's metadata. The file may be damaged or unsupported; export it as MP4 (H.264) and try again.");
    }
    return parseVideoMediaProperties(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}