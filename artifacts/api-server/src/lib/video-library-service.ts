import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, generationJobsTable, videoLibraryStatesTable } from "@workspace/db";

const ACTIVE = new Set(["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"]);
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const UNDO_MS = 6000;

export class VideoLibraryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function listVideos(tenantId: string, favorite?: boolean) {
  const rows = await db.select({ job: generationJobsTable, state: videoLibraryStatesTable })
    .from(generationJobsTable)
    .leftJoin(videoLibraryStatesTable, and(
      eq(videoLibraryStatesTable.generationJobId, generationJobsTable.id),
      eq(videoLibraryStatesTable.tenantId, tenantId),
    ))
    .where(and(
      eq(generationJobsTable.tenantId, tenantId),
      isNull(videoLibraryStatesTable.deletedAt),
      favorite === undefined ? undefined : favorite
        ? eq(videoLibraryStatesTable.favorite, true)
        : or(eq(videoLibraryStatesTable.favorite, false), isNull(videoLibraryStatesTable.id)),
    ))
    .orderBy(desc(generationJobsTable.createdAt));
  return rows.map(({ job, state }) => ({
    id: job.id,
    title: job.title,
    status: job.status,
    favorite: state?.favorite ?? false,
    outputStorageKey: job.outputStorageKey,
    outputMimeType: job.outputMimeType,
    mediaUrl: job.outputStorageKey ? `/api/media/${job.outputStorageKey}` : null,
    previewUrl: job.outputStorageKey ? `/api/media-preview/${job.outputStorageKey}` : null,
    createdAt: job.createdAt.toISOString(),
  }));
}

async function validateJobs(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  ids: string[],
  terminalOnly: boolean,
) {
  const rows = await tx.select({ id: generationJobsTable.id, status: generationJobsTable.status })
    .from(generationJobsTable)
    .where(and(eq(generationJobsTable.tenantId, tenantId), inArray(generationJobsTable.id, ids)))
    .for("update");
  if (rows.length !== ids.length) throw new VideoLibraryError("Generation not found", 404);
  if (rows.some((row) => ACTIVE.has(row.status) || (terminalOnly && !TERMINAL.has(row.status)))) {
    throw new VideoLibraryError("Cancel or finish active generations before deleting them.", 409);
  }
  return rows;
}

export async function setVideoFavorites(tenantId: string, ids: string[], favorite: boolean) {
  return db.transaction(async (tx) => {
    await validateJobs(tx, tenantId, ids, false);
    for (const id of ids) {
      await tx.insert(videoLibraryStatesTable).values({ tenantId, generationJobId: id, favorite })
        .onConflictDoUpdate({
          target: videoLibraryStatesTable.generationJobId,
          set: { favorite },
          setWhere: and(eq(videoLibraryStatesTable.tenantId, tenantId), isNull(videoLibraryStatesTable.deletedAt)),
        });
    }
    const rows = await tx.select({ generationJobId: videoLibraryStatesTable.generationJobId })
      .from(videoLibraryStatesTable).where(and(
        eq(videoLibraryStatesTable.tenantId, tenantId),
        inArray(videoLibraryStatesTable.generationJobId, ids),
        isNull(videoLibraryStatesTable.deletedAt),
      ));
    if (rows.length !== ids.length) throw new VideoLibraryError("Deleted generation cannot be favorited", 409);
    return { ids, favorite };
  });
}

export async function bulkDeleteVideos(tenantId: string, ids: string[]) {
  const undoToken = randomUUID();
  const deletedAt = new Date();
  const undoExpiresAt = new Date(deletedAt.getTime() + UNDO_MS);
  return db.transaction(async (tx) => {
    await validateJobs(tx, tenantId, ids, true);
    for (const id of ids) {
      await tx.insert(videoLibraryStatesTable).values({
        tenantId, generationJobId: id, deletedAt, undoToken, undoExpiresAt,
      }).onConflictDoUpdate({
        target: videoLibraryStatesTable.generationJobId,
        set: { deletedAt, undoToken, undoExpiresAt },
        setWhere: and(eq(videoLibraryStatesTable.tenantId, tenantId), isNull(videoLibraryStatesTable.deletedAt)),
      });
    }
    const rows = await tx.select({ id: videoLibraryStatesTable.generationJobId })
      .from(videoLibraryStatesTable).where(and(
        eq(videoLibraryStatesTable.tenantId, tenantId), eq(videoLibraryStatesTable.undoToken, undoToken),
      ));
    if (rows.length !== ids.length) throw new VideoLibraryError("One or more generations are already deleted", 409);
    return { ids, undoToken, undoExpiresAt: undoExpiresAt.toISOString() };
  });
}

export async function undoBulkDelete(tenantId: string, undoToken: string) {
  return db.transaction(async (tx) => {
    const rows = await tx.update(videoLibraryStatesTable)
      .set({ deletedAt: null, undoToken: null, undoExpiresAt: null })
      .where(and(
        eq(videoLibraryStatesTable.tenantId, tenantId),
        eq(videoLibraryStatesTable.undoToken, undoToken),
        sql`${videoLibraryStatesTable.undoExpiresAt} > now()`,
      ))
      .returning({ id: videoLibraryStatesTable.generationJobId });
    if (!rows.length) throw new VideoLibraryError("Undo window expired or deletion not found", 410);
    return { ids: rows.map(({ id }) => id) };
  });
}