import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  comfyServersTable,
  db,
  generationJobsTable,
  imageStudioJobsTable,
  longFormShotsTable,
} from "@workspace/db";

// Session locks used by submissions and this transaction lock share the same
// PostgreSQL key. Never use a different hash function for this namespace.
export const comfyServerLockKey = (serverId: string) => `comfy-server:${serverId}`;
export const liveWorker = () => isNull(comfyServersTable.deletedAt);
export const liveWorkerById = (serverId: string) =>
  and(eq(comfyServersTable.id, serverId), liveWorker());

/** Call while holding the worker lock, immediately before recording a claim. */
export async function getAssignableWorker(serverId: string) {
  const [server] = await db.select().from(comfyServersTable).where(and(
    liveWorkerById(serverId),
    eq(comfyServersTable.enabled, true),
    eq(comfyServersTable.status, "ONLINE"),
  ));
  return server;
}

export async function softDeleteWorker(serverId: string): Promise<"deleted" | "missing" | "active"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${comfyServerLockKey(serverId)}))`);
    const [server] = await tx.select({ id: comfyServersTable.id })
      .from(comfyServersTable).where(liveWorkerById(serverId));
    if (!server) return "missing";
    // Only assigned, genuinely active work blocks removal. Terminal, draft,
    // planned and historical rows (including their worker FK) are untouched.
    const generation = await tx.select({ id: generationJobsTable.id }).from(generationJobsTable).where(and(
      eq(generationJobsTable.comfyServerId, serverId),
      inArray(generationJobsTable.status, ["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"]),
    )).limit(1);
    if (generation.length) return "active";
    const image = await tx.select({ id: imageStudioJobsTable.id }).from(imageStudioJobsTable).where(and(
      eq(imageStudioJobsTable.comfyServerId, serverId),
      inArray(imageStudioJobsTable.status, ["QUEUED", "RUNNING"]),
    )).limit(1);
    if (image.length) return "active";
    const shot = await tx.select({ id: longFormShotsTable.id }).from(longFormShotsTable).where(and(
      eq(longFormShotsTable.assignedServerId, serverId),
      inArray(longFormShotsTable.status, ["QUEUED", "RENDERING"]),
    )).limit(1);
    if (shot.length) return "active";
    await tx.update(comfyServersTable)
      .set({ deletedAt: new Date(), enabled: false })
      .where(liveWorkerById(serverId));
    return "deleted";
  });
}