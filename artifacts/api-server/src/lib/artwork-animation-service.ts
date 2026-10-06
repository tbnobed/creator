import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool, generationJobsTable } from "@workspace/db";
import { assertGarmentKey, checkGarmentRuntime, garmentScript, GarmentError } from "./garment-media";
import { mediaStorage } from "./storage-service";
import { probeVideoMediaProperties } from "./video-media-probe";
import type { ReplacementSubmission } from "./video-replacement-service";
import { logger } from "./logger";

export type ArtworkPoint = { x: number; y: number };
export type PixelAnimation = {
  polygon: ArtworkPoint[]; pivot: ArtworkPoint; angleDegrees: number;
  cyclesPerSecond: number; inkThreshold: number; protectedPolygons?: ArtworkPoint[][];
  cleanPlateStorageKey?: string;
};
type Request = ReplacementSubmission & { pixelAnimation: PixelAnimation };
const execute = promisify(execFile);
const active = ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"];
const runs = new Map<string, AbortController>();
const whereActive = (id: string) => and(eq(generationJobsTable.id, id), inArray(generationJobsTable.status, active));
export const isPixelAnimation = (metadata: Record<string, unknown>) => metadata.artworkRenderer === "source-pixel-v1";

function area(points: ArtworkPoint[]) {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i+1)%points.length];
    return sum+p.x*next.y-next.x*p.y;
  }, 0))/2;
}
export function validatePixelAnimation(input: Request) {
  if (input.provider !== "LOCAL" || input.mode !== "animate-artwork" || input.model || input.confirmPaid
      || input.artworkSource !== "existing" || input.referenceStorageKey || input.workerId) {
    throw new GarmentError(400, "Preserve artwork uses existing source pixels locally, without a cloud model or worker.");
  }
  if (!Number.isFinite(input.startSeconds) || input.startSeconds < 0 ||
      !Number.isFinite(input.durationSeconds) || input.durationSeconds < .5 || input.durationSeconds > 5) {
    throw new GarmentError(400, "Select a source window from 0.5 to 5 seconds.");
  }
  const s = input.pixelAnimation;
  const point = (p: ArtworkPoint) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  const polygon = (p: ArtworkPoint[]) => Array.isArray(p) && p.length >= 3 && p.length <= 128 && p.every(point) && area(p) > .00002 && area(p) <= .2;
  if (!s || !polygon(s.polygon) || !point(s.pivot) || !Number.isFinite(s.angleDegrees) ||
      Math.abs(s.angleDegrees) < 1 || Math.abs(s.angleDegrees) > 35 ||
      !Number.isFinite(s.cyclesPerSecond) || s.cyclesPerSecond < .2 || s.cyclesPerSecond > 2 ||
      !Number.isFinite(s.inkThreshold) || s.inkThreshold < 5 || s.inkThreshold > 100 ||
      (s.protectedPolygons && (!Array.isArray(s.protectedPolygons) || s.protectedPolygons.length > 8 || !s.protectedPolygons.every(polygon)))) {
    throw new GarmentError(400, "Choose a valid moving-part outline (up to 20% of the frame), pivot, angle and motion speed.");
  }
  assertGarmentKey(input.sourceStorageKey, input.tenantId);
  if (s.cleanPlateStorageKey) assertGarmentKey(s.cleanPlateStorageKey, input.tenantId, true);
}

export async function reuseArtworkSource(tenantId: string, id: string) {
  const [job] = await db.select().from(generationJobsTable).where(and(eq(generationJobsTable.id, id), eq(generationJobsTable.tenantId, tenantId)));
  if (!job || job.status !== "COMPLETED" || !job.outputStorageKey) throw new GarmentError(404, "Completed workspace video not found.");
  const bytes = await mediaStorage.readBuffer(job.outputStorageKey);
  if (bytes.length > 200*1024*1024) throw new GarmentError(400, "Choose a completed clip smaller than 200 MB.");
  const p = await probeVideoMediaProperties(bytes);
  if (!p.width || !p.height || p.durationSeconds < .5) throw new GarmentError(400, "The saved result is not an editable video.");
  const sourceStorageKey = await mediaStorage.storeGenerationReferenceMedia("video/mp4", bytes, tenantId);
  return { sourceStorageKey, mediaUrl: `/api/media/${sourceStorageKey}`, durationSeconds: p.durationSeconds, width: p.width, height: p.height };
}

export async function submitPixelAnimation(input: Request) {
  validatePixelAnimation(input);
  const fingerprint = createHash("sha256").update(JSON.stringify({...input, userId: undefined})).digest("hex");
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock(hashtext('artwork-cpu-admission'))");
    const existing = await lock.query("SELECT id, tenant_id, provider_task_metadata FROM obtv_generation_jobs WHERE id=$1", [input.requestId]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.tenant_id !== input.tenantId || row.provider_task_metadata.fingerprint !== fingerprint) throw new GarmentError(409, "Request ID belongs to different processing.");
      await lock.query("COMMIT");
      return {jobId: row.id as string};
    }
    const busy = await db.select({id: generationJobsTable.id}).from(generationJobsTable).where(and(
      inArray(generationJobsTable.status, active), sql`${generationJobsTable.providerTaskMetadata}->>'artworkRenderer' = 'source-pixel-v1'`,
    )).limit(1);
    if (busy.length) throw new GarmentError(409, "An artwork preview is already rendering. Wait for it to finish before submitting another.");
    await checkGarmentRuntime();
    garmentScript("artwork-animation.py");
    const raw = await mediaStorage.readGenerationReferenceMedia(input.sourceStorageKey);
    if (raw.bytes.length > 200*1024*1024) throw new GarmentError(400, "Use a source smaller than 200 MB.");
    const p = await probeVideoMediaProperties(raw.bytes);
    if (!p.width || !p.height || Math.max(p.width,p.height) > 4096 || !Number.isFinite(p.durationSeconds) || input.startSeconds+input.durationSeconds > p.durationSeconds+.001) {
      throw new GarmentError(400, "The selected window must fit inside a measurable source up to 4096 pixels.");
    }
    await db.insert(generationJobsTable).values({
      id: input.requestId, tenantId: input.tenantId, createdByUserId: input.userId,
      title: `Preserve artwork · ${input.targetGarment}`, status: "QUEUED", provider: "COMFYUI",
      providerModelId: "garment-studio", prompt: input.prompt, compiledPrompt: input.prompt,
      generationMode: "animate-artwork", qualityPreset: "DRAFT", width: p.width, height: p.height,
      fps: 24, frameCount: Math.round(input.durationSeconds*24), durationSeconds: input.durationSeconds, seed: 0,
      currentNode: "Preparing original artwork",
      providerTaskMetadata: {operation: "garment-studio", artworkRenderer: "source-pixel-v1", fingerprint, request: input, sourceStorageKey: input.sourceStorageKey},
    });
    await lock.query("COMMIT");
  } catch (error) {
    await lock.query("ROLLBACK");
    throw error;
  } finally { lock.release(); }
  startPixelAnimation(input.requestId);
  return {jobId: input.requestId};
}

export function cancelPixelAnimation(id: string) { runs.get(id)?.abort(); }

export function startPixelAnimation(id: string) {
  if (runs.has(id)) return;
  const controller = new AbortController();
  runs.set(id, controller);
  void run(id, controller.signal).catch(async error => {
    logger.error({err: error, jobId: id}, "Artwork animation failed");
    const stderr = typeof error?.stderr === "string" ? error.stderr.match(/ValueError: (.+)/)?.[1] : undefined;
    await db.update(generationJobsTable).set({
      status: "FAILED", failedAt: new Date(), currentNode: null,
      errorMessage: stderr ?? (error instanceof GarmentError ? error.message : "Artwork render failed or timed out. Adjust the selection or shorten the window; no paid request was made."),
    }).where(whereActive(id));
  }).finally(() => runs.delete(id));
}

async function run(id: string, signal: AbortSignal) {
  const lock = await pool.connect();
  let dir: string | undefined;
  let owned = false;
  let cpuOwned = false;
  try {
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`artwork-render:${id}`]);
    owned = result.rows[0]?.locked === true;
    if (!owned) return;
    const cpu = await lock.query("SELECT pg_try_advisory_lock(hashtext('artwork-cpu-render')) AS locked");
    cpuOwned = cpu.rows[0]?.locked === true;
    if (!cpuOwned) throw new GarmentError(409, "The artwork renderer is still finishing another preview. Wait a moment before retrying.");
    const [job] = await db.select().from(generationJobsTable).where(whereActive(id));
    if (!job || !isPixelAnimation(job.providerTaskMetadata)) return;
    const input = job.providerTaskMetadata.request as Request;
    validatePixelAnimation(input);
    dir = await mkdtemp(path.join(tmpdir(), "obtv-artwork-"));
    const source = path.join(dir, "source"), prepared = path.join(dir, "prepared.mp4"), output = path.join(dir, "output.mp4");
    const raw = await mediaStorage.readGenerationReferenceMedia(input.sourceStorageKey);
    await writeFile(source, raw.bytes);
    await db.update(generationJobsTable).set({status: "RUNNING", startedAt: new Date(), currentNode: "Preparing selected window"}).where(whereActive(id));
    await execute("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", String(input.startSeconds), "-i", source,
      "-t", String(input.durationSeconds), "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
      "-c:v", "libx264", "-crf", "17", "-c:a", "aac", "-movflags", "+faststart", prepared],
    {timeout: 120_000, maxBuffer: 8192, signal});
    const preparedBytes = await readFile(prepared);
    const preparedKey = await mediaStorage.storeGenerationReferenceMedia("video/mp4", preparedBytes, input.tenantId);
    await db.update(generationJobsTable).set({currentNode: "Tracking fabric and animating original pixels",
      providerTaskMetadata: {...job.providerTaskMetadata, preparedKey},
    }).where(whereActive(id));
    const config = path.join(dir, "config.json");
    await writeFile(config, JSON.stringify(input.pixelAnimation));
    const args = [garmentScript("artwork-animation.py"), "--source", prepared, "--output", output, "--config", config];
    if (input.pixelAnimation.cleanPlateStorageKey) {
      const plate = await mediaStorage.readGenerationReferenceMedia(input.pixelAnimation.cleanPlateStorageKey);
      const file = path.join(dir, "plate.png");
      await writeFile(file, plate.bytes);
      args.push("--plate", file);
    }
    await execute("python", args, {timeout: 300_000, maxBuffer: 8192, signal});
    signal.throwIfAborted();
    const [state] = await db.select({status: generationJobsTable.status}).from(generationJobsTable).where(eq(generationJobsTable.id,id));
    if (!state || !active.includes(state.status)) return;
    const bytes = await readFile(output);
    const [before, after] = await Promise.all([probeVideoMediaProperties(preparedBytes), probeVideoMediaProperties(bytes)]);
    if (before.width !== after.width || before.height !== after.height || Math.abs(before.durationSeconds-after.durationSeconds) > .1 ||
        (before.audioStreams??0) !== (after.audioStreams??0)) throw new GarmentError(500, "Artwork output failed timing, size or audio verification.");
    const outputStorageKey = await mediaStorage.storeOutput(`artwork-${id}.mp4`, "video/mp4", bytes, input.tenantId);
    const verification = JSON.parse(await readFile(path.join(dir, "output.json"), "utf8"));
    await db.update(generationJobsTable).set({
      status: "COMPLETED", completedAt: new Date(), outputStorageKey, currentNode: null,
      width: after.width, height: after.height, fps: 24, frameCount: verification.frames, durationSeconds: after.durationSeconds,
      providerTaskMetadata: {...job.providerTaskMetadata, preparedKey, verification},
    }).where(whereActive(id));
  } finally {
    if (dir) await rm(dir, {recursive: true, force: true});
    if (cpuOwned) await lock.query("SELECT pg_advisory_unlock(hashtext('artwork-cpu-render'))");
    if (owned) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`artwork-render:${id}`]);
    lock.release();
  }
}
