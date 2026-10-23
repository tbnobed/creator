import { randomUUID } from "node:crypto";
import { db, pool, productionProjectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { stateOf, saveProduction } from "../lib/production-store";
import { mutateProductionAsset } from "../lib/production-assets";
import { productionAppearance } from "../lib/production-appearance";
async function main() {
  const [source] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,"b9e7ca36-af7b-497f-bbd0-7853ccb0db9c"));
  const [wardrobeSource] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,"4b471890-7d2c-4024-8a21-91a25695a20e"));
  if (!source || !wardrobeSource || source.tenantId !== wardrobeSource.tenantId) throw new Error("Same-workspace verification fixtures missing.");
  const state=structuredClone(stateOf(source)), approved=stateOf(wardrobeSource);
  const character=approved.characters[0];
  const outfit=approved.wardrobes.filter(w=>w.characterId===character.id && w.assetId && w.approvedAssetId===w.assetId).at(-1);
  if (!outfit) throw new Error("No approved native wardrobe; do not approve one automatically.");
  state.characters=[structuredClone(character)];
  state.wardrobes=[{...outfit,fromScene:1,toScene:state.story.scenes.length}];
  state.tasks=[];state.step=4;state.publishedCharacterAssets=[];
  state.settings.videoProvider="COMFYUI";state.settings.videoConfirmed=false;
  for (const scene of state.story.scenes) {
    scene.characters=[character.name];
    productionAppearance(state,character,scene.sceneNumber);
  }
  const id=randomUUID();
  await db.insert(productionProjectsTable).values({id,tenantId:source.tenantId,createdByUserId:source.createdByUserId,
    title:"Continuity verification — approved blue vest",state:state as unknown as Record<string,unknown>});
  if (process.argv[2] === "--reviewed-prop" && process.argv[3]) {
    // Only pass a reference here after visual review; never approves source projects.
    let [fixture] = await db.select().from(productionProjectsTable).where(eq(productionProjectsTable.id,id));
    fixture=await saveProduction(fixture,await mutateProductionAsset(fixture,"set-prop-reference",{
      assetId:process.argv[3],description:"One small uniformly red wooden sphere, no holes, stripes or white patches. Diameter approximately one-sixth of Pip's standing height, as shown beside his foot in the reference. Preserve its exact appearance and relative size in both locations.",
    }));
    await saveProduction(fixture,await mutateProductionAsset(fixture,"approve-prop-reference",{assetId:process.argv[3]}));
  }
  console.log(id);
}
main().finally(()=>pool.end());
