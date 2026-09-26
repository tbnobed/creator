import { spawn } from "node:child_process";

export type VideoMediaProperties = {
  durationSeconds: number;
  fps?: number;
  width?: number;
  height?: number;
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
  return {
    durationSeconds: duration,
    ...(fps ? { fps } : {}),
    ...(Number.isSafeInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isSafeInteger(height) && height > 0 ? { height } : {}),
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

export function probeVideoMediaProperties(bytes: Buffer): Promise<VideoMediaProperties> {
  return new Promise<VideoMediaProperties>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate",
      "-of", "json",
      "-i", "pipe:0",
    ]);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Video metadata probe timed out"));
    }, 15_000);
    const finish = (error?: Error, properties?: VideoMediaProperties) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(properties!);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => finish(new Error("Could not start video metadata probe")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim() ? "Video metadata probe failed" : "Video metadata probe did not complete"));
        return;
      }
      try {
        finish(undefined, parseVideoMediaProperties(stdout));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Video metadata probe failed"));
      }
    });
    child.stdin.on("error", () => finish(new Error("Could not provide video bytes to metadata probe")));
    child.stdin.end(bytes);
  });
}