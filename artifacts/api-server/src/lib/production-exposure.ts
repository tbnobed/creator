import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export const productionExposureLock = "Exposure continuity: use the approved complete scene composition and scenery reference as the fixed lighting baseline, not a progressively darker reinterpretation of the previous frame. Keep exposure, white balance, midtone brightness and shadow detail stable throughout this shot and across continuations. No fade to black, vignette buildup or gradual dimming unless explicitly requested in this shot's action. The previous frame fixes the exact starting image; it does not request an additional decrease in exposure.";

export function requestsExposureChange(action: string): boolean {
  return /\b(?:fade(?:s|d| out)? to black|blackout|lights? (?:go(?:es)? out|dim(?:s)?|turn(?:s)? off)|(?:switch|turn)(?:es|s|ed)? (?:off (?:the )?lights?|(?:the )?lights? off)|darken(?:s|ing)? gradually|gradually (?:dim|darken)|(?:beam|light|lamp)[^.!?\n]{0,60}\b(?:dies|goes dark|goes out|fades out))\b/i.test(action);
}

/** Conservative cascade stop, not automatic grading: never change a continuity frame. */
export function hasSevereExposureDrift(anchor: number, first: number, last: number): boolean {
  if (![anchor, first, last].every(n => Number.isFinite(n) && n >= 0 && n <= 255)) {
    throw new Error("Could not measure production exposure reliably.");
  }
  // Do not amplify noise in an intentionally near-black reference.
  return anchor >= 32 && first >= 16 && last < anchor * 0.55 && last < first * 0.85;
}

export async function meanFrameBrightness(file: string): Promise<number> {
  const { stdout } = await exec("ffmpeg", [
    "-v", "error", "-i", file, "-frames:v", "1",
    "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer", timeout: 60000, maxBuffer: 1024 * 1024 });
  if (stdout.length !== 4096) throw new Error("Could not decode the frame for exposure verification.");
  return stdout.reduce((sum, value) => sum + value, 0) / stdout.length;
}
