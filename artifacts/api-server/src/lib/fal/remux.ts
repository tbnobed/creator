import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const FAL_MOV_FINALIZATION_ERROR = "Cloud MOV output finalization failed";

export function isRecoverableFalOutputFailure(message: string | null): boolean {
  return message !== null
    && (["Timed out while waiting for Cloud", "Timed out while waiting for fal.ai"].includes(message)
      || message.startsWith(FAL_MOV_FINALIZATION_ERROR));
}

/** Container-only conversion: keep the provider's video/audio streams unchanged. */
export async function remuxMp4ToMov(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length) throw new Error("Cannot remux an empty MP4 output");
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-fal-mov-"));
  const input = path.join(directory, `${randomUUID()}.mp4`);
  const output = path.join(directory, `${randomUUID()}.mov`);
  try {
    await writeFile(input, bytes, { flag: "wx" });
    await execFileAsync("ffmpeg", [
      "-v", "error", "-nostdin", "-i", input,
      "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
      "-movflags", "+faststart", "-f", "mov", "-y", output,
    ], { timeout: 120_000, maxBuffer: 16 * 1024 });
    const converted = await readFile(output);
    if (converted.length < 12 || converted.toString("ascii", 4, 8) !== "ftyp") {
      throw new Error("ffmpeg did not create a valid MOV container");
    }
    return converted;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}