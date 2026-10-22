import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, productionProjectsTable, imageStudioAssetsTable, settingsTable, settingAssetsTable, type ProductionProjectRow } from "@workspace/db";
import { emptyProduction } from "./production-types";
import { publishProductionScenery, sceneryReferenceId } from "./scenery-library";
import { mutateProductionAsset } from "./production-assets";

test("library reference identifiers are stable and scoped to each location", () => {
  assert.equal(sceneryReferenceId("a", "b"), sceneryReferenceId("a", "b"));
  assert.notEqual(sceneryReferenceId("a", "b"), sceneryReferenceId("c", "b"));
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
