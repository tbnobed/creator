import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComfyUIClient } from "./comfy/client";
import { createChatterboxTurboWorkflow } from "./seed-data/chatterbox-turbo";

const VOICE_TIMEOUT_MS = 15 * 60_000;
const MAX_PROCESS_ERROR_BYTES = 8 * 1024;

type AudioOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

function chooseAudioOutput(history: Record<string, unknown>, promptId: string): AudioOutput | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const outputs = (prompt as { outputs?: Record<string, Record<string, unknown>> }).outputs;
  if (!outputs) return null;
  for (const output of Object.values(outputs)) {
    if (!Array.isArray(output.audio)) continue;
    for (const file of output.audio as Array<Record<string, unknown>>) {
      if (typeof file.filename === "string" && /\.(wav|flac|mp3|ogg)$/i.test(file.filename)) {
        return {
          filename: file.filename,
          subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
          type: typeof file.type === "string" ? file.type : "output",
        };
      }
    }
  }
  return null;
}

function historyError(history: Record<string, unknown>, promptId: string): string | null {
  const prompt = history[promptId] ?? Object.values(history)[0];
  if (!prompt || typeof prompt !== "object") return null;
  const status = (prompt as { status?: { status_str?: unknown; messages?: unknown } }).status;
  if (status?.status_str !== "error") return null;
  return `Chatterbox Turbo failed${status.messages ? `: ${JSON.stringify(status.messages).slice(0, 1200)}` : ""}`;
}

async function waitForAudio(client: ComfyUIClient, promptId: string): Promise<AudioOutput> {
  const timeoutAt = Date.now() + VOICE_TIMEOUT_MS;
  while (Date.now() < timeoutAt) {
    const history = await client.getHistory(promptId);
    const error = historyError(history, promptId);
    if (error) throw new Error(error);
    const output = chooseAudioOutput(history, promptId);
    if (output) return output;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Cloned voice generation timed out after 15 minutes");
}

export async function generateClonedSpeech(input: {
  client: ComfyUIClient;
  dialogue: string;
  referenceAudio: Buffer;
  seed?: number | null;
}): Promise<Buffer> {
  const cleanDialogue = input.dialogue.trim();
  if (!cleanDialogue) throw new Error("Exact dialogue is required for cloned speech");
  const uploaded = await input.client.uploadAudio({
    name: `obtv-voice-reference-${randomUUID()}.wav`,
    mimeType: "audio/wav",
    bytes: input.referenceAudio,
  });
  const workflow = createChatterboxTurboWorkflow({
    text: cleanDialogue,
    referenceAudioName: uploaded.name,
    seed: input.seed ?? Math.floor(Math.random() * 2_147_483_647),
  });
  const submitted = await input.client.submitWorkflow(workflow, randomUUID());
  const output = await waitForAudio(input.client, submitted.prompt_id);
  return input.client.getOutputFile(output.filename, output.subfolder, output.type);
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_PROCESS_ERROR_BYTES) {
        stderr += String(chunk).slice(0, MAX_PROCESS_ERROR_BYTES - stderr.length);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) finish(new Error(`${command} timed out`));
      else if (code === 0) finish();
      else finish(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function audioDuration(filePath: string): Promise<number> {
  const output = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], 30_000);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Generated voice audio is invalid");
  return duration;
}

export async function muxClonedSpeech(input: {
  video: Buffer;
  videoMimeType: "video/mp4" | "video/webm";
  speech: Buffer;
  targetDurationSeconds: number;
}): Promise<Buffer> {
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-voice-mux-"));
  const videoPath = path.join(directory, `input${input.videoMimeType === "video/webm" ? ".webm" : ".mp4"}`);
  const speechPath = path.join(directory, "speech.wav");
  const outputPath = path.join(directory, "output.mp4");
  await Promise.all([
    writeFile(videoPath, input.video, { flag: "wx" }),
    writeFile(speechPath, input.speech, { flag: "wx" }),
  ]);
  try {
    const generatedDuration = await audioDuration(speechPath);
    const targetDuration = Math.max(0.5, input.targetDurationSeconds);
    const speedRatio = generatedDuration / targetDuration;
    if (speedRatio > 2) {
      throw new Error("The cloned dialogue is too long for this shot. Shorten the dialogue or increase shot duration.");
    }
    const audioFilters = [
      speedRatio > 1.02 ? `atempo=${speedRatio.toFixed(5)}` : "",
      "apad",
      `atrim=0:${targetDuration.toFixed(3)}`,
    ].filter(Boolean).join(",");
    await runProcess("ffmpeg", [
      "-v", "error",
      "-i", videoPath,
      "-i", speechPath,
      "-filter_complex", `[1:a]${audioFilters}[voice]`,
      "-map", "0:v:0",
      "-map", "[voice]",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", targetDuration.toFixed(3),
      "-y", outputPath,
    ], 20 * 60_000);
    return await readFile(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}