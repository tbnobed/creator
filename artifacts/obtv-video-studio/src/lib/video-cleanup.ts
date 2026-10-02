// Pure helpers for the Video Cleanup workflow. No React, no DOM globals beyond optional storage.

export type CleanupPointType = "positive" | "negative";
export type CleanupPoint = { x: number; y: number; type: CleanupPointType };
export type CameraMode = "stationary" | "moving";

export const MAX_CLEANUP_SECONDS = 5;
export const MAX_CLEANUP_BYTES = 200 * 1024 * 1024;
export const MAX_CLEANUP_POINTS = 40;
export const CLEANUP_MIME_TYPES = ["video/mp4", "video/quicktime"];

export type Rect = { left: number; top: number; width: number; height: number };

/** Rendered media box for an object-contain element, relative to the element box (letterbox excluded). */
export function containedMediaRect(boxWidth: number, boxHeight: number, mediaWidth: number, mediaHeight: number): Rect | null {
  if (!(boxWidth > 0 && boxHeight > 0 && mediaWidth > 0 && mediaHeight > 0)) return null;
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return { left: Math.max(0, (boxWidth - width) / 2), top: Math.max(0, (boxHeight - height) / 2), width, height };
}

/** Converts a pointer offset inside the element box into normalized media coordinates; null when on the letterbox. */
export function clientToNormalized(offsetX: number, offsetY: number, rect: Rect): { x: number; y: number } | null {
  const x = (offsetX - rect.left) / rect.width;
  const y = (offsetY - rect.top) / rect.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: round4(x), y: round4(y) };
}

/** Normalized point to a pixel position inside the element box, for drawing markers. */
export function normalizedToBox(point: { x: number; y: number }, rect: Rect): { left: number; top: number } {
  return { left: rect.left + point.x * rect.width, top: rect.top + point.y * rect.height };
}

function round4(value: number) {
  return Math.round(value * 10000) / 10000;
}

export function validateCleanupFile(file: { type: string; size: number }): string | null {
  if (!CLEANUP_MIME_TYPES.includes(file.type)) return "Use an MP4 or MOV clip.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_CLEANUP_BYTES) return "Clip is larger than 200 MB.";
  return null;
}

export function durationProblem(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Could not measure the clip duration.";
  if (seconds >= MAX_CLEANUP_SECONDS) return `Clip is ${seconds.toFixed(2)}s. Bria Video Eraser needs clips under ${MAX_CLEANUP_SECONDS} seconds. Trim it in your editor first; nothing is trimmed automatically.`;
  return null;
}

/** Fingerprint of everything the paid confirmation covers. Changing it requires a new confirmation and request ID. */
export function selectionFingerprint(sourceToken: string, cameraMode: CameraMode, points: CleanupPoint[]): string {
  return JSON.stringify([sourceToken, cameraMode, points.map((p) => [p.x, p.y, p.type])]);
}

export type SubmitPhase = "editing" | "sending" | "uncertain" | "accepted";

export type CleanupDraftSource = {
  storageKey: string;
  mediaUrl: string;
  sourceToken: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  hasAudio: boolean;
  estimatedUsd: number;
  pricingNote: string;
};

export type CleanupDraft = {
  version: 1;
  source: CleanupDraftSource | null;
  cameraMode: CameraMode;
  points: CleanupPoint[];
  requestId: string | null;
  requestFingerprint: string | null;
  phase: SubmitPhase;
  jobId: string | null;
};

export function emptyDraft(): CleanupDraft {
  return { version: 1, source: null, cameraMode: "stationary", points: [], requestId: null, requestFingerprint: null, phase: "editing", jobId: null };
}

export function draftStorageKey(userId: string | null | undefined, tenantId: string | null | undefined): string | null {
  if (!userId || !tenantId) return null;
  return `obtv.videoCleanupDraft.${tenantId}.${userId}`;
}

function isPoint(value: unknown): value is CleanupPoint {
  const p = value as CleanupPoint;
  return Boolean(p) && typeof p.x === "number" && typeof p.y === "number" && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && (p.type === "positive" || p.type === "negative");
}

export function parseDraft(raw: string | null): CleanupDraft {
  if (!raw) return emptyDraft();
  try {
    const d = JSON.parse(raw) as Partial<CleanupDraft>;
    if (d.version !== 1) return emptyDraft();
    const s = d.source as CleanupDraftSource | null | undefined;
    const source = s && typeof s.storageKey === "string" && typeof s.sourceToken === "string" && typeof s.mediaUrl === "string"
      && typeof s.width === "number" && typeof s.height === "number" ? s : null;
    const phase: SubmitPhase = d.phase === "uncertain" || d.phase === "accepted" ? d.phase : d.phase === "sending" ? "uncertain" : "editing";
    return {
      version: 1,
      source,
      cameraMode: d.cameraMode === "moving" ? "moving" : "stationary",
      points: Array.isArray(d.points) ? d.points.filter(isPoint).slice(0, MAX_CLEANUP_POINTS) : [],
      requestId: typeof d.requestId === "string" ? d.requestId : null,
      requestFingerprint: typeof d.requestFingerprint === "string" ? d.requestFingerprint : null,
      // A reload mid-send means we do not know whether the server accepted it.
      phase: source ? phase : "editing",
      jobId: typeof d.jobId === "string" ? d.jobId : null,
    };
  } catch {
    return emptyDraft();
  }
}

/**
 * Returns the request ID to use for a submit attempt. The same ID is reused while the
 * confirmed selection is unchanged (safe transport retry); a changed selection gets a new ID.
 */
export function requestIdForAttempt(draft: CleanupDraft, fingerprint: string, makeId: () => string): { requestId: string; isRetry: boolean } {
  if (draft.requestId && draft.requestFingerprint === fingerprint && draft.phase !== "accepted") {
    return { requestId: draft.requestId, isRetry: true };
  }
  return { requestId: makeId(), isRetry: false };
}

/** Whether edits are allowed: never while a send is in flight or its outcome is unknown. */
export function selectionLocked(phase: SubmitPhase): boolean {
  return phase === "sending" || phase === "uncertain";
}

export function normalizeStatus(status: string): "queued" | "running" | "completed" | "failed" | "cancelled" {
  const s = status.toLowerCase();
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "running" || s === "downloading" || s === "uploading") return "running";
  return "queued";
}

/** True when an error certainly means the server rejected the request (no job created). */
export function isDefiniteRejection(status: number | undefined): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

/** jobId always equals the submitted requestId; find the server job for an uncertain attempt. */
export function findJobForRequest<T extends { jobId: string }>(jobs: readonly T[] | undefined, requestId: string | null): T | null {
  if (!requestId || !jobs) return null;
  return jobs.find((job) => job.jobId === requestId) ?? null;
}

/** Resolves an uncertain/sending draft to accepted when history shows the job exists. Keeps the stable request ID. */
export function resolveDraftFromHistory(draft: CleanupDraft, jobs: readonly { jobId: string }[] | undefined): CleanupDraft {
  if (draft.phase !== "uncertain" && draft.phase !== "sending") return draft;
  const job = findJobForRequest(jobs, draft.requestId);
  return job ? { ...draft, phase: "accepted", jobId: job.jobId } : draft;
}
