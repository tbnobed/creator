import { createHash } from "node:crypto";
import { productionAppearance,approvedProductionProp } from "./production-appearance";
import { requireProductionScenery } from "./production-scenery";
import type { ProductionState,ProductionScene } from "./production-types";
export function openingInputs(state:ProductionState,scene:ProductionScene) {
  const cast=state.characters.filter(c=>scene.characters.some(n=>n.toLowerCase()===c.name.toLowerCase()));
  const {reference}=requireProductionScenery(state,scene);
  const prop=approvedProductionProp(state);
  const ids=[reference.assetId!,...cast.map(c=>productionAppearance(state,c,scene.sceneNumber).assetId),...(prop?[prop.assetId]:[])];
  const prompt=`One cinematic photograph inside the room in image 1. Keep image 1's room, architecture and lighting as the entire background. Exactly ${cast.length} character${cast.length===1?"":"s"}, each appearing ONCE, from image${cast.length===1?"":"s"} ${cast.map((_,i)=>i+2).join(", ")}. Preserve their exact faces, bodies, materials and clothes. ${prop ? `Exactly ONE recurring prop from image ${ids.length}: ${prop.description}.` : ""} No duplicates, no miniatures, no collage. Do not copy the character reference's plain background. Scene: ${scene.shots?.[0]?.prompt || scene.action}. ${cast.map(c=>productionAppearance(state,c,scene.sceneNumber).description).join(" ")}`;
  const sourceKey=createHash("sha256").update(JSON.stringify({ids,prompt,location:scene.location,timeOfDay:scene.timeOfDay,identities:cast.map(c=>c.selectedAssetId),width:state.settings.width,height:state.settings.height})).digest("hex");
  return {ids,prompt,sourceKey};
}
export function requireOpening(state:ProductionState,scene:ProductionScene) {
  const inputs=openingInputs(state,scene);
  const opening=scene.opening;
  if(!opening?.assetId || opening.approvedAssetId!==opening.assetId || opening.sourceKey!==inputs.sourceKey) {
    throw new Error(`Review and approve the current opening image for Scene ${scene.sceneNumber} (${scene.title}) in Create before rendering. It must contain the cast, outfits, props and location together.`);
  }
  return opening;
}
