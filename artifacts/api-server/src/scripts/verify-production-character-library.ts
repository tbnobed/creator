import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, charactersTable, characterAssetsTable, imageStudioAssetsTable, productionProjectsTable } from "@workspace/db";
import { publishProductionCharacters, reconcileProductionCharacters } from "../lib/production-character-library";
import type { ProductionState } from "../lib/production-types";

async function main() {
  const [row] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id, process.argv[2]));
  assert(row, "Provide a production with completed character and wardrobe images.");
  const state = structuredClone(row.state) as unknown as ProductionState;
  const character = state.characters.find(c => c.selectedAssetId && c.referenceSheet.length);
  assert(character);
  const outfit = state.wardrobes.find(w => w.characterId === character.id && w.assetId);
  assert(outfit);
  const id = randomUUID();
  await db.insert(charactersTable).values({
    id, tenantId: row.tenantId, createdByUserId: row.createdByUserId, name: character.name,
    dossier: { role: "Keep my role", performanceNotes: "Keep my notes", wardrobes: [{ id: randomUUID(), name: "Existing outfit", description: "Keep this" }] },
  });
  try {
    character.characterId = id;
    state.characters = [character]; state.wardrobes = [outfit]; state.publishedCharacterAssets = [];
    const [image] = await db.select().from(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.id, character.selectedAssetId!));
    await db.insert(characterAssetsTable).values({
      characterId: id, storageKey: image.storageKey, mimeType: image.mimeType,
      originalName: `${character.name}-locked-look.png`, label: "headshot", isPrimary: true,
    });
    assert.equal(await publishProductionCharacters({ ...row, tenantId: randomUUID() }, state), false, "Cross-tenant publication must fail closed");
    assert.equal(await publishProductionCharacters(row, state), true);
    const assets = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, id));
    assert.equal(assets.length, 2 + character.referenceSheet.length);
    assert.equal(assets.find(a => a.isPrimary)?.label, "other");
    const [saved] = await db.select().from(charactersTable).where(eq(charactersTable.id, id));
    assert.equal(saved.dossier.role, "Keep my role");
    assert.equal(saved.dossier.wardrobes.length, 2);
    const wardrobe = saved.dossier.wardrobes.find(w => w.id === outfit.id)!;
    assert(assets.some(a => a.id === wardrobe.referenceAssetId && a.label === "wardrobe"));
    assert.equal(await publishProductionCharacters(row, state), false);
    assert.equal((await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, id))).length, assets.length);
    // A later library deletion must not be silently undone by reconciliation.
    await db.delete(characterAssetsTable).where(eq(characterAssetsTable.id, wardrobe.referenceAssetId!));
    await db.update(charactersTable).set({ dossier: { ...saved.dossier, wardrobes: saved.dossier.wardrobes.filter(w => w.id !== outfit.id) } }).where(eq(charactersTable.id, id));
    await publishProductionCharacters(row, state);
    assert.equal((await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, id))).length, assets.length - 1);
    assert.equal((await db.select().from(charactersTable).where(eq(charactersTable.id, id)))[0].dossier.wardrobes.length, 1);
    console.log("PASS: references, wardrobe links, legacy label repair, tenant isolation, idempotence, preserved edits and deletions.");
  } finally { await db.delete(charactersTable).where(eq(charactersTable.id, id)); }
  await reconcileProductionCharacters(row.tenantId);
  console.log("Existing workspace projects reconciled without image generation.");
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
