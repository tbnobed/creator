import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, imageStudioAssetsTable, productionProjectsTable, settingsTable, settingAssetsTable, type ProductionProjectRow } from "@workspace/db";
import type { ProductionState } from "./production-types";

export function sceneryReferenceId(placeId: string, referenceId: string) {
  const h = createHash("sha256").update(`${placeId}:${referenceId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Add library metadata only. Project IDs, assignments and media bytes stay intact. */
export async function publishProductionScenery(row: ProductionProjectRow) {
  const state = row.state as unknown as ProductionState;
  for (const place of state.places ?? []) {
    if (!place.assetId) continue;
    const refs = [place, ...place.variants].filter(ref => ref.assetId);
    await db.transaction(async tx => {
      await tx.insert(settingsTable).values({
        id: place.id, tenantId: row.tenantId, createdByUserId: row.createdByUserId,
        name: place.name, description: place.prompt, promptDescription: place.prompt,
        thumbnail: place.mediaUrl,
      }).onConflictDoNothing();
      const [owner] = await tx.select().from(settingsTable).where(and(eq(settingsTable.id, place.id), eq(settingsTable.tenantId, row.tenantId)));
      if (!owner) throw new Error("Location belongs to another workspace.");
      for (const [index, ref] of refs.entries()) {
        const [asset] = await tx.select().from(imageStudioAssetsTable).where(and(eq(imageStudioAssetsTable.id, ref.assetId!), eq(imageStudioAssetsTable.tenantId, row.tenantId)));
        if (!asset) continue;
        const existing = await tx.select({ id: settingAssetsTable.id }).from(settingAssetsTable).where(and(eq(settingAssetsTable.settingId, place.id), eq(settingAssetsTable.storageKey, asset.storageKey)));
        if (existing.length) continue;
        await tx.insert(settingAssetsTable).values({
          id: sceneryReferenceId(place.id, asset.id), settingId: place.id,
          storageKey: asset.storageKey, mimeType: asset.mimeType,
          originalName: index === 0 ? "Base" : ref.name, description: ref.prompt, sortOrder: index,
        }).onConflictDoNothing();
      }
    });
  }
}

export async function reconcileSceneryLibrary(tenantId: string) {
  const rows = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.tenantId, tenantId));
  for (const row of rows) await publishProductionScenery(row);
}

export async function sceneryUsedByProjects(tenantId: string, id: string) {
  const rows = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.tenantId, tenantId));
  return rows.some(row => ((row.state as unknown as ProductionState).places ?? []).some(place => place.id === id));
}
