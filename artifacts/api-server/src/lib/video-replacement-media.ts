import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GarmentError } from "./garment-media";
import { probeVideoMediaProperties } from "./video-media-probe";

const execute = promisify(execFile);

export function validateReplacementRange(start: number, duration: number, sourceDuration: number, model = "seedance-2.5") {
  if (!Number.isFinite(start) || !Number.isFinite(duration) || !Number.isFinite(sourceDuration) || start < 0
    || duration < (model === "kling-o3-edit" ? 3 : 4) || duration > 15 || start + duration > sourceDuration + .001) {
    throw new GarmentError(400, model === "kling-o3-edit" ? "Select a 3–15 second window entirely inside the source video." : "Select a 4–15 second window entirely inside the source video. Seedance editing requires at least 4 seconds.");
  }
}

export function replacementPrompt(target: string, instruction: string, reference: boolean) {
  return `Edit @Video1. Target to replace: ${target.trim()}.\n${instruction.trim()}\n`
    + (reference ? "Use @Image1 as the visual reference for the replacement.\n" : "")
    + "Keep the camera motion, scene, lighting, and all non-target subjects unchanged. "
    + "Track the replacement consistently throughout the source video, including movement and occlusion. "
    + "Preserve the source action and timing. Do not add cuts.";
}

export async function prepareReplacementSource(bytes: Buffer, start: number, duration: number, model = "seedance-2.5") {
  const props = await probeVideoMediaProperties(bytes);
  if (model === "kling-o3-edit" && (!props.width || !props.height || Math.min(props.width, props.height) < 720 || Math.max(props.width, props.height) > 3840)) {
    throw new GarmentError(400, "Kling O3 requires source video sides of 720–3840 pixels. Resize the source before submitting.");
  }
  validateReplacementRange(start, duration, props.durationSeconds, model);
  if (!props.width || !props.height || Math.min(props.width, props.height) < 300
    || Math.max(props.width, props.height) > 4096
    || props.width / props.height < .4 || props.width / props.height > 2.5) {
    throw new GarmentError(400, "Cloud editing needs video sides of 300–4096 pixels and an aspect ratio between 0.4 and 2.5.");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "obtv-replacement-"));
  try {
    const input = path.join(dir, "input"), output = path.join(dir, "clip.mp4");
    await writeFile(input, bytes);
    await execute("ffmpeg", [
      "-v", "error", "-nostdin", "-ss", String(start), "-i", input, "-t", String(duration),
      "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1",
      "-vf", "fps=24,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", output,
    ], { timeout: 120_000, maxBuffer: 8192 });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Replace generated audio with the selected source's audio, never synthetic speech.
 * Provider-selected video duration remains unchanged for accurate cost accounting.
 */
export async function preserveReplacementAudio(video: Buffer, source: Buffer) {
  const outputProps = await probeVideoMediaProperties(video);
  if (!Number.isFinite(outputProps.durationSeconds) || outputProps.durationSeconds <= 0) {
    throw new Error("Cloud replacement has no measurable video duration.");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "obtv-replacement-audio-"));
  try {
    const generated = path.join(dir, "generated.mp4"), original = path.join(dir, "source.mp4");
    const result = path.join(dir, "result.mp4");
    await Promise.all([writeFile(generated, video), writeFile(original, source)]);
    await execute("ffmpeg", [
      "-v", "error", "-nostdin", "-i", generated, "-i", original,
      "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac",
      "-t", String(outputProps.durationSeconds), "-map_metadata", "-1",
      "-movflags", "+faststart", "-y", result,
    ], { timeout: 120_000, maxBuffer: 8192 });
    return await readFile(result);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
