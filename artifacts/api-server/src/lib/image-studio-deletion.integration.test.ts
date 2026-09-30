import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import {
  db, pool, tenantsTable, usersTable, imageStudioAssetsTable, imageStudioJobsTable,
  charactersTable, longFormProjectsTable,
} from "@workspace/db";

test("Image Studio deletion preserves references and tenant boundaries", {
  skip: process.env.RUN_IMAGE_DELETION_DB_TESTS !== "true" ? "set RUN_IMAGE_DELETION_DB_TESTS=true" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "obtv-image-delete-"));
  process.env.OBTV_MEDIA_ROOT = root;
  const { mediaStorage } = await import("./storage-service");
  const { deleteImageAsset, getImageJob } = await import("./image-studio-service");
  const { default: router } = await import("../routes/image-studio");
  const { logger } = await import("./logger");
  const userId = `image-delete-test-${randomUUID()}`;
  const [owner, other] = await db.insert(tenantsTable).values([
    { name: "Image deletion fixture", slug: `image-delete-${randomUUID()}` },
    { name: "Image deletion isolation fixture", slug: `image-delete-${randomUUID()}` },
  ]).returning();
  const tenantIds = [owner.id, other.id];
  const app = express();
  app.use((req, _res, next) => {
    // Only the disposable test server bypasses authentication.
    req.context = { user: { id: userId }, tenant: { id: owner.id } } as typeof req.context;
    req.log = logger;
    next();
  });
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/image-studio/assets`;
  const bytes = Buffer.from("disposable image fixture");
  const asset = async (jobId?: string) => {
    const storageKey = await mediaStorage.storeImageStudioImage("fixture.png", "image/png", bytes, owner.id);
    const [row] = await db.insert(imageStudioAssetsTable).values({
      tenantId: owner.id, createdByUserId: userId, name: "Disposable",
      storageKey, mimeType: "image/png", width: 512, height: 512, jobId,
    }).returning();
    return row;
  };
  const job = async (overrides: Partial<typeof imageStudioJobsTable.$inferInsert> = {}) => {
    const [row] = await db.insert(imageStudioJobsTable).values({
      tenantId: owner.id, createdByUserId: userId, modelId: "fixture",
      modelName: "Fixture (never submitted)", provider: "CLOUD", operation: "generate",
      prompt: "fixture", width: 512, height: 512, count: 1, status: "COMPLETED",
      ...overrides,
    }).returning();
    return row;
  };
  try {
    await db.insert(usersTable).values({ id: userId, displayName: "Image deletion fixture" });
    const source = await asset();
    assert.equal(await deleteImageAsset(other.id, source.id), "missing");
    assert.deepEqual(await mediaStorage.readBuffer(source.storageKey), bytes);
    assert.equal(await deleteImageAsset(owner.id, source.id), "deleted");
    await assert.rejects(mediaStorage.readBuffer(source.storageKey), { code: "ENOENT" });
    assert.equal(await deleteImageAsset(owner.id, source.id), "missing");
    assert.equal(await deleteImageAsset(owner.id, "bad-id"), "missing");
    const apiSource = await asset();
    const removed = await fetch(`${url}/${apiSource.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), "");
    assert.equal((await fetch(`${url}/${apiSource.id}`, { method: "DELETE" })).status, 404);

    const completed = await job();
    const output = await asset(completed.id);
    assert.equal(await deleteImageAsset(owner.id, output.id), "deleted");
    assert.deepEqual((await getImageJob(owner.id, completed.id))?.assets, []);

    // Both active paid jobs and terminal job history keep their inputs reusable.
    for (const status of ["RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const) {
      const reference = await asset();
      const mask = await asset();
      const parent = await job({ status, referenceAssetIds: [reference.id], maskAssetId: mask.id });
      assert.equal(await deleteImageAsset(owner.id, reference.id), "referenced");
      assert.equal(await deleteImageAsset(owner.id, mask.id), "referenced");
      assert.deepEqual(await mediaStorage.readBuffer(reference.storageKey), bytes);
      await db.delete(imageStudioJobsTable).where(eq(imageStudioJobsTable.id, parent.id));
      assert.equal(await deleteImageAsset(owner.id, reference.id), "deleted");
      assert.equal(await deleteImageAsset(owner.id, mask.id), "deleted");
    }

    const wardrobe = await asset();
    const [character] = await db.insert(charactersTable).values({
      tenantId: owner.id, createdByUserId: userId, name: "Deletion fixture",
      dossier: { role: "", performanceNotes: "", wardrobes: [{
        id: randomUUID(), name: "Test", description: "", referenceAssetId: wardrobe.id,
      }] },
    }).returning();
    assert.equal(await deleteImageAsset(owner.id, wardrobe.id), "referenced");
    const blocked = await fetch(`${url}/${wardrobe.id}`, { method: "DELETE" });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json() as { error: string }).error, /still used.*wardrobe/);
    await db.delete(charactersTable).where(eq(charactersTable.id, character.id));
    assert.equal(await deleteImageAsset(owner.id, wardrobe.id), "deleted");

    const continuityAsset = await asset();
    const [project] = await db.insert(longFormProjectsTable).values({
      tenantId: owner.id, createdByUserId: userId, title: "Deletion fixture", script: "",
      targetDurationSeconds: 10, generationMode: "TEXT_TO_VIDEO",
      width: 512, height: 512, fps: 24, qualityPreset: "STANDARD",
      continuity: { enabled: true, characters: [{
        characterId: randomUUID(), appearance: "", behavior: "", voiceDescription: "", wardrobes: [{
          id: randomUUID(), name: "Test", description: "", referenceAssetId: continuityAsset.id,
        }],
      }], scenes: [] },
    }).returning();
    assert.equal(await deleteImageAsset(owner.id, continuityAsset.id), "referenced");
    assert.deepEqual(await mediaStorage.readBuffer(continuityAsset.storageKey), bytes);
    await db.delete(longFormProjectsTable).where(eq(longFormProjectsTable.id, project.id));
    assert.equal(await deleteImageAsset(owner.id, continuityAsset.id), "deleted");

    const unavailable = await asset();
    await mediaStorage.deleteImageStudioImage(unavailable.storageKey);
    assert.equal(await deleteImageAsset(owner.id, unavailable.id), "deleted", "missing bytes are idempotent");

    const cleanupFailure = await asset();
    const originalDelete = mediaStorage.deleteImageStudioImage;
    mediaStorage.deleteImageStudioImage = async () => { throw new Error("Fixture cleanup failure"); };
    try {
      assert.equal(await deleteImageAsset(owner.id, cleanupFailure.id), "deleted");
      assert.equal(await deleteImageAsset(owner.id, cleanupFailure.id), "missing");
      assert.deepEqual(await mediaStorage.readBuffer(cleanupFailure.storageKey), bytes);
    } finally {
      mediaStorage.deleteImageStudioImage = originalDelete;
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.delete(longFormProjectsTable).where(inArray(longFormProjectsTable.tenantId, tenantIds));
    await db.delete(charactersTable).where(inArray(charactersTable.tenantId, tenantIds));
    await db.delete(imageStudioAssetsTable).where(inArray(imageStudioAssetsTable.tenantId, tenantIds));
    await db.delete(imageStudioJobsTable).where(inArray(imageStudioJobsTable.tenantId, tenantIds));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
    await rm(root, { recursive: true, force: true });
    await pool.end();
  }
});