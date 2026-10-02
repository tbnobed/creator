import type { GarmentJob, GarmentJobStatus, GarmentSource, GarmentWorker } from "./types";

export const PROOF_MAX_SECONDS = 3;
export const PROOF_MIN_SECONDS = 0.5;
export const PROOF_WIDTH = 512;
export const PROOF_HEIGHT = 288;
export const PROOF_FPS = 16;
export const MAX_PROMPT_CHARS = 600;
export const MAX_TARGET_CHARS = 160;
export const ACCEPTED_UPLOAD = "video/mp4,video/quicktime,.mp4,.mov";

const round = (n: number) => Math.round(n * 100) / 100;

export function isActiveJob(job: GarmentJob | null | undefined): boolean {
  if (!job) return false;
  const active: GarmentJobStatus[] = ["queued", "running"];
  return active.includes(job.status);
}

export function rangeProblem(start: number, duration: number, sourceDuration: number | null | undefined): string | null {
  if (sourceDuration == null || !Number.isFinite(sourceDuration) || sourceDuration <= 0) return "Source duration is unknown.";
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return "Range must be numbers.";
  if (start < 0) return "Start cannot be negative.";
  if (duration < PROOF_MIN_SECONDS) return `Range must be at least ${PROOF_MIN_SECONDS}s.`;
  if (duration > PROOF_MAX_SECONDS + 1e-6) return `Proof runs are capped at ${PROOF_MAX_SECONDS}s.`;
  if (start + duration > sourceDuration + 1e-3) return `Range ends at ${round(start + duration)}s but the source is ${round(sourceDuration)}s.`;
  return null;
}

/** Default range: first min(3s, source) seconds. */
export function defaultRange(sourceDuration: number): { start: number; duration: number } {
  return { start: 0, duration: round(Math.max(0, Math.min(PROOF_MAX_SECONDS, sourceDuration))) };
}

/** Clamp a start so the window stays inside the source. */
export function clampStart(start: number, duration: number, sourceDuration: number): number {
  return round(Math.min(Math.max(0, start), Math.max(0, sourceDuration - duration)));
}

export function fileProblem(file: { name: string; type: string }): string | null {
  const okType = file.type === "video/mp4" || file.type === "video/quicktime";
  const okExt = /\.(mp4|mov)$/i.test(file.name);
  return okType || okExt ? null : "Use an MP4 or MOV file.";
}

export function workerProblem(worker: GarmentWorker | undefined): string | null {
  if (!worker) return "Select a GPU worker.";
  if (!worker.ready) return `${worker.name} is not ready${worker.reason ? `: ${worker.reason}` : "."}`;
  if (worker.busy) return `${worker.name} is busy with another job.`;
  return null;
}

export function submitBlocker(input: {
  source: GarmentSource | null;
  worker: GarmentWorker | undefined;
  prompt: string;
  targetGarment?: string;
  start: number;
  duration: number;
  job: GarmentJob | null;
  loading?: boolean;
  mode?: "replace-garment" | "animate-artwork";
  hasReference?: boolean;
  artworkSource?: "existing" | "upload";
}): string | null {
  if (input.loading) return "Waiting for the current request to finish.";
  if (isActiveJob(input.job)) return "A job is already running. Cancel it or wait for it to finish.";
  if (!input.source) return "Upload a source clip first.";
  const w = workerProblem(input.worker);
  if (w) return w;
  const t = (input.targetGarment ?? "").trim();
  if (!t) return "Name the garment to edit, e.g. jacket worn by the person on the left.";
  if (t.length > MAX_TARGET_CHARS) return `Target garment is over ${MAX_TARGET_CHARS} characters.`;
  const p = input.prompt.trim();
  if (!p) return input.mode === "animate-artwork" ? "Describe how the artwork should move." : "Describe the garment.";
  if (input.mode === "replace-garment" && !input.hasReference) return "Add a reference image of the garment. Replacement requires one.";
  if (input.mode === "animate-artwork" && input.artworkSource === "upload" && !input.hasReference) return "Upload the artwork image to animate, or switch to the artwork already on the garment.";
  if (p.length > MAX_PROMPT_CHARS) return `Prompt is over ${MAX_PROMPT_CHARS} characters.`;
  return rangeProblem(input.start, input.duration, input.source.durationSeconds);
}

/** Whether the uploaded reference image is part of the request. */
export function usesReference(mode: "replace-garment" | "animate-artwork", artworkSource: "existing" | "upload"): boolean {
  return mode === "replace-garment" || artworkSource === "upload";
}
