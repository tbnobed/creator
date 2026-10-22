import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, productionProjectsTable, imageStudioAssetsTable, imageStudioJobsTable, settingsTable, settingAssetsTable, type ProductionProjectRow } from "@workspace/db";
import { emptyProduction } from "./production-types";
import { publishProductionScenery, publishLocationImageResults, sceneryReferenceId } from "./scenery-library";
import { mutateProductionAsset } from "./production-assets";
import { deleteImageAsset } from "./image-studio-service";

test("library reference identifiers are stable and scoped to each location", () => {
  assert.equal(sceneryReferenceId("a", "b"), sceneryReferenceId("a", "b"));
  assert.notEqual(sceneryReferenceId("a", "b"), sceneryReferenceId("c", "b"));
});

test("completed location jobs attach after the dialog is gone, once and tenant-scoped", { skip: process.env.RUN_SCENERY_DB_TEST !== "1" }, async () => {
  const [owner] = await db.select({ tenantId: productionProjectsTable.tenantId, createdByUserId: productionProjectsTable.createdByUserId }).from(productionProjectsTable).limit(1);
  assert.ok(owner);
  const settingId = randomUUID(), jobId = randomUUID(), assetId = randomUUID();
  try {
    await db.insert(settingsTable).values({ id: settingId, ...owner, name: "Location durability test", description: "", promptDescription: "Night" });
    await db.insert(imageStudioJobsTable).values({
      id: jobId, ...owner, settingId, settingReferenceName: "Night",
      modelId: "local-flux2-klein-4b", modelName: "Test", provider: "LOCAL", operation: "generate",
      prompt: "Night", width: 32, height: 32, count: 1, status: "RUNNING",
    });
    await db.insert(imageStudioAssetsTable).values({ id: assetId, ...owner, jobId, name: "test.png",
      storageKey: `tenants/${owner.tenantId}/test/${assetId}.png`, mimeType: "image/png", width: 32, height: 32 });
    await publishLocationImageResults(owner.tenantId, settingId);
    assert.equal((await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, settingId))).length, 0);
    await db.update(imageStudioJobsTable).set({ status: "COMPLETED" }).where(eq(imageStudioJobsTable.id, jobId));
    assert.equal(await deleteImageAsset(owner.tenantId, assetId), "referenced", "destination must protect output before library reconciliation");
    await publishLocationImageResults(randomUUID(), settingId);
    assert.equal((await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, settingId))).length, 0);
    await publishLocationImageResults(owner.tenantId, settingId);
    await publishLocationImageResults(owner.tenantId, settingId);
    const refs = await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, settingId));
    assert.equal(refs.length, 1); assert.equal(refs[0].originalName, "Night");
    assert.equal(await deleteImageAsset(owner.tenantId, assetId), "referenced", "shared location media must survive gallery deletion");
    const [location] = await db.select().from(settingsTable).where(eq(settingsTable.id, settingId));
    assert.match(location.thumbnail!, /test\//);
  } finally {
    await db.delete(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.id, assetId));
    await db.delete(imageStudioJobsTable).where(eq(imageStudioJobsTable.id, jobId));
    await db.delete(settingsTable).where(eq(settingsTable.id, settingId));
  }
});

test("project scenery publishes once, reuses image metadata, imports variants, and rejects foreign tenants", { skip: process.env.RUN_SCENERY_DB_TEST !== "1" }, async () => {
  const [owner] = await db.select({ tenantId: productionProjectsTable.tenantId, createdByUserId: productionProjectsTable.createdByUserId }).from(productionProjectsTable).limit(1);
  assert.ok(owner, "Needs an existing development project owner");
  const placeId = randomUUID(), baseId = randomUUID(), variantId = randomUUID();
  const state = emptyProduction();
  state.places.push({ id: placeId, name: "Scenery test fixture", prompt: "Night room", seed: 123, status: "READY", assetId: baseId,
    mediaUrl: `/api/media/tenants/${owner.tenantId}/test/base.png`,
    variants: [{ id: randomUUID(), name: "Dawn", prompt: "Same room at dawn", status: "READY", assetId: variantId, mediaUrl: `/api/media/tenants/${owner.tenantId}/test/dawn.png` }] });
  const row = { id: randomUUID(), ...owner, state } as unknown as ProductionProjectRow;
  try {
    await db.insert(imageStudioAssetsTable).values([baseId, variantId].map(id => ({
      id, ...owner, name: "scenery-test.png", storageKey: `tenants/${owner.tenantId}/test/${id}.png`, mimeType: "image/png", width: 32, height: 32, byteSize: 32,
    })));
    await publishProductionScenery(row);
    await publishProductionScenery(row);
    const refs = await db.select().from(settingAssetsTable).where(eq(settingAssetsTable.settingId, placeId));
    assert.equal(refs.length, 2);
    assert.ok(refs.some(ref => ref.originalName === "Dawn"));
    const target = { ...row, state: emptyProduction() } as unknown as ProductionProjectRow;
    const imported = await mutateProductionAsset(target, "import-place", { settingId: placeId });
    assert.equal(imported.places[0].assetId, baseId);
    assert.equal(imported.places[0].variants[0].assetId, variantId);
    assert.equal(imported.places[0].variants[0].name, "Dawn");
    assert.equal(imported.tasks.length, 0);
    await mutateProductionAsset(target, "import-place", { settingId: placeId });
    assert.equal(imported.places.length, 1);
    await assert.rejects(mutateProductionAsset({ ...target, tenantId: randomUUID(), state: emptyProduction() } as unknown as ProductionProjectRow, "import-place", { settingId: placeId }), /not found in this workspace/);
    await mutateProductionAsset(target, "remove-place", { placeId });
    assert.equal((await db.select().from(settingsTable).where(eq(settingsTable.id, placeId))).length, 1);
  } finally {
    await db.delete(settingsTable).where(eq(settingsTable.id, placeId));
    await db.delete(imageStudioAssetsTable).where(inArray(imageStudioAssetsTable.id, [baseId, variantId]));
  }
});
