import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, generationJobsTable, imageStudioAssetsTable, tenantsTable, usersTable, videoLibraryStatesTable } from "@workspace/db";

test("video library enforces tenant boundaries, terminal-only deletion, undo expiry, and reference MIME roles", {
  skip: process.env.RUN_VIDEO_LIBRARY_DB_TESTS !== "true" ? "set RUN_VIDEO_LIBRARY_DB_TESTS=true" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "obtv-video-library-"));
  process.env.OBTV_MEDIA_ROOT = root;
  const { mediaStorage } = await import("./storage-service");
  const { bulkDeleteVideos, listVideos, setVideoFavorites, undoBulkDelete } = await import("./video-library-service");
  const { importReference, listReferenceLibrary } = await import("./reference-library-service");
  const userId = `library-test-${randomUUID()}`;
  const [owner, other] = await db.insert(tenantsTable).values([
    { name: "Video library test A", slug: `library-a-${randomUUID()}` },
    { name: "Video library test B", slug: `library-b-${randomUUID()}` },
  ]).returning();
  try {
    await db.insert(usersTable).values({ id: userId, displayName: "Video library fixture" });
    const job = (tenantId: string, status: string) => ({
      tenantId, createdByUserId: userId, title: status, status, prompt: "fixture",
      compiledPrompt: "fixture", width: 512, height: 512, fps: 24, frameCount: 48,
      durationSeconds: 2, generationMode: "TEXT_TO_VIDEO", qualityPreset: "STANDARD",
    });
    const [completed, active, foreign] = await db.insert(generationJobsTable).values([
      job(owner.id, "COMPLETED"), job(owner.id, "RUNNING"), job(other.id, "COMPLETED"),
    ]).returning();
    const videoKey = await mediaStorage.storeOutput("fixture.mp4", "video/mp4", Buffer.from("0000ftypisom"), owner.id);
    await db.update(generationJobsTable).set({ outputStorageKey: videoKey, outputMimeType: "video/mp4" })
      .where(eq(generationJobsTable.id, completed.id));
    await assert.rejects(setVideoFavorites(owner.id, [foreign.id], true), (e: any) => e.status === 404);
    await assert.rejects(bulkDeleteVideos(owner.id, [completed.id, active.id]), (e: any) => e.status === 409);
    assert.equal((await listVideos(owner.id)).length, 2);
    await setVideoFavorites(owner.id, [completed.id], true);
    assert.deepEqual((await listVideos(owner.id, true)).map((i) => i.id), [completed.id]);
    assert.equal((await listVideos(owner.id)).find((i) => i.id === completed.id)?.outputMimeType, "video/mp4");
    assert.equal((await importReference(owner.id, "generation", completed.id, "referenceVideo")).mimeType, "video/mp4");
    const deletion = await bulkDeleteVideos(owner.id, [completed.id]);
    assert.equal((await listVideos(owner.id)).some((i) => i.id === completed.id), false);
    await assert.rejects(importReference(owner.id, "generation", completed.id), (e: any) => e.status === 404);
    assert.deepEqual((await undoBulkDelete(owner.id, deletion.undoToken)).ids, [completed.id]);
    const second = await bulkDeleteVideos(owner.id, [completed.id]);
    await assert.rejects(undoBulkDelete(other.id, second.undoToken), (e: any) => e.status === 410);
    await db.update(videoLibraryStatesTable).set({ undoExpiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(videoLibraryStatesTable.tenantId, owner.id), eq(videoLibraryStatesTable.generationJobId, completed.id)));
    await assert.rejects(undoBulkDelete(owner.id, second.undoToken), (e: any) => e.status === 410);

    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture")]);
    const sourceKey = await mediaStorage.storeGenerationReferenceMedia("image/png", png, owner.id);
    const sourceId = path.basename(sourceKey);
    assert.equal((await listReferenceLibrary(other.id)).some((i) => i.sourceId === sourceId), false);
    assert.equal((await listReferenceLibrary(owner.id, "image", "firstFrame")).some((i) => i.sourceId === sourceId), true);
    assert.equal((await listReferenceLibrary(owner.id, "video", "referenceVideo")).some((i) => i.sourceId === sourceId), false);
    await assert.rejects(importReference(other.id, "upload", sourceId), (e: any) => e.status === 404);
    await assert.rejects(importReference(owner.id, "upload", sourceId, "referenceVideo"), (e: any) => e.status === 415);
    const imported = await importReference(owner.id, "upload", sourceId, "firstFrame");
    assert.notEqual(imported.storageKey, sourceKey);
    assert.deepEqual((await mediaStorage.readGenerationReferenceMedia(imported.storageKey)).bytes, png);

    // Listing is capped at 500 per asset category; an older item still imports by ID.
    const [oldAsset] = await db.insert(imageStudioAssetsTable).values({
      tenantId: owner.id, createdByUserId: userId, name: "old image", storageKey: sourceKey,
      mimeType: "image/png", width: 100, height: 100, createdAt: new Date("2020-01-01"),
    }).returning();
    await db.insert(imageStudioAssetsTable).values(Array.from({ length: 500 }, (_, i) => ({
      tenantId: owner.id, createdByUserId: userId, name: `new image ${i}`, storageKey: sourceKey,
      mimeType: "image/png", width: 100, height: 100,
    })));
    assert.equal((await listReferenceLibrary(owner.id)).some((i) => i.sourceId === oldAsset.id), false);
    const oldImport = await importReference(owner.id, "imageAsset", oldAsset.id, "referenceImage");
    assert.deepEqual((await mediaStorage.readGenerationReferenceMedia(oldImport.storageKey)).bytes, png);
    await assert.rejects(importReference(other.id, "imageAsset", oldAsset.id), (e: any) => e.status === 404);
  } finally {
    await db.delete(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.tenantId, owner.id));
    await db.delete(videoLibraryStatesTable).where(eq(videoLibraryStatesTable.tenantId, owner.id));
    await db.delete(generationJobsTable).where(eq(generationJobsTable.tenantId, owner.id));
    await db.delete(generationJobsTable).where(eq(generationJobsTable.tenantId, other.id));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, owner.id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, other.id));
    await rm(root, { recursive: true, force: true });
  }
});