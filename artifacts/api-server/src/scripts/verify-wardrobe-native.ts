import { db, pool, productionProjectsTable, imageStudioJobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ownedProduction, productionLock, saveProduction, stateOf } from "../lib/production-store";
import { mutateProductionAsset } from "../lib/production-assets";
import assert from "node:assert/strict";
async function main() {
  const [source] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id, process.argv[2]));
  assert(source);
  let outfitId = "";
  await productionLock(source.id, async () => {
    const row = (await ownedProduction(source.id, source.tenantId))!;
    const character = stateOf(row).characters[0];
    const state = await mutateProductionAsset(row, "add-wardrobe", {
      characterId: character.id, name: "Blue vest — reference edit",
      prompt: "Add a royal blue sleeveless fabric vest on the upper torso, from shoulders to waist, with two small front buttons. No trousers or shorts. Leave the wooden legs, arms and original face unchanged.",
      fromScene: 1, toScene: stateOf(row).story.scenes.length, modelId: "local-flux2-klein-4b",
    });
    outfitId = state.wardrobes.at(-1)!.id;
    await saveProduction(row, state);
  });
  for (let n = 0; n < 120; n++) {
    const row = (await ownedProduction(source.id, source.tenantId))!;
    const state = stateOf(row), outfit = state.wardrobes.find(w => w.id === outfitId)!;
    if (outfit.status === "FAILED") throw new Error(outfit.error);
    if (outfit.status === "READY") {
      assert(!outfit.approvedAssetId, "Generation must not auto-approve");
      const task = state.tasks.find(t => t.entityId === outfitId)!;
      const [job] = await db.select().from(imageStudioJobsTable).where(eq(imageStudioJobsTable.requestKey, `${task.id.slice(0, -2)}00`));
      assert.equal(job.providerTaskMetadata.referenceMode, "native-reference-edit");
      console.log(JSON.stringify({ outfit, metadata: { referenceMode: job.providerTaskMetadata.referenceMode }, source: state.characters[0].options.find(o => o.assetId === state.characters[0].selectedAssetId) }));
      return;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Timed out; inspect persisted job before retrying.");
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
