import { and, eq } from "drizzle-orm";
import { db, charactersTable, characterAssetsTable, imageStudioAssetsTable, productionProjectsTable, type ProductionProjectRow } from "@workspace/db";
import { sceneryReferenceId } from "./scenery-library";
import { normalizeDossier } from "./character-dossier-service";
import { ownedProduction, productionLock, saveProduction } from "./production-store";
import type { ProductionState } from "./production-types";

/** Publish once per project reference; subsequent library edits/deletions win. */
export async function publishProductionCharacters(row: ProductionProjectRow, state: ProductionState) {
  const published = new Set(state.publishedCharacterAssets ?? []);
  const before = published.size;
  for (const character of state.characters) {
    if (!character.characterId) continue;
    const refs = [
      ...(character.selectedAssetId ? [{ assetId: character.selectedAssetId, label: "other", primary: true, name: "Selected look" }] : []),
      ...character.referenceSheet.map(r => ({ ...r, label: "other", primary: false, name: `Reference view — ${r.label ?? "unspecified"} (review framing)` })),
      ...state.wardrobes.filter(w => w.characterId === character.id && w.assetId).map(w => ({
        assetId: w.assetId!, label: "wardrobe", primary: false, name: w.name, outfit: w,
      })),
    ];
    for (const ref of refs) {
      const key = `${character.characterId}:${ref.assetId}:${ref.label}`;
      if (published.has(key)) continue;
      const applied = await db.transaction(async tx => {
        const [owner] = await tx.select().from(charactersTable).where(and(
          eq(charactersTable.id, character.characterId!), eq(charactersTable.tenantId, row.tenantId),
        )).for("update");
        if (!owner) return false;
        const [image] = await tx.select().from(imageStudioAssetsTable).where(and(
          eq(imageStudioAssetsTable.id, ref.assetId), eq(imageStudioAssetsTable.tenantId, row.tenantId),
        ));
        if (!image) return false;
        const [existing] = await tx.select().from(characterAssetsTable).where(and(
          eq(characterAssetsTable.characterId, owner.id), eq(characterAssetsTable.storageKey, image.storageKey),
        ));
        const assetId = existing?.id ?? sceneryReferenceId(owner.id, image.id);
        let changed = !existing;
        if (!existing) {
          await tx.insert(characterAssetsTable).values({
            id: assetId, characterId: owner.id, storageKey: image.storageKey,
            originalName: ref.name, mimeType: image.mimeType, label: ref.label,
            isPrimary: ref.primary && character.locked, description: character.description,
          }).onConflictDoNothing();
        } else if (ref.primary && existing.originalName === `${character.name}-locked-look.png` && existing.label === "headshot") {
          // Repair only the recognizable legacy hardcoded label, not user labels.
          await tx.update(characterAssetsTable).set({ label: "other", originalName: "Selected look" }).where(eq(characterAssetsTable.id, assetId));
          changed = true;
        }
        const dossier = normalizeDossier(owner.dossier);
        if ("outfit" in ref && ref.outfit) {
          if (!dossier.wardrobes.some(w => w.id === ref.outfit.id)) {
            dossier.wardrobes.push({ id: ref.outfit.id, name: ref.outfit.name, description: ref.outfit.prompt, referenceAssetId: assetId });
            changed = true;
          }
        }
        if (changed) await tx.update(charactersTable).set({
          dossier, dossierRevision: owner.dossierRevision + 1,
          dossierStatus: "DRAFT", dossierApprovedAt: null,
        }).where(eq(charactersTable.id, owner.id));
        return true;
      });
      if (applied) published.add(key);
    }
  }
  state.publishedCharacterAssets = [...published];
  return before !== published.size;
}

export async function reconcileProductionCharacters(tenantId: string) {
  const projects = await db.select({ id: productionProjectsTable.id }).from(productionProjectsTable)
    .where(eq(productionProjectsTable.tenantId, tenantId));
  for (const project of projects) await productionLock(project.id, async () => {
    const row = await ownedProduction(project.id, tenantId);
    if (!row) return;
    const state = row.state as unknown as ProductionState;
    if (await publishProductionCharacters(row, state)) await saveProduction(row, state);
  });
}
