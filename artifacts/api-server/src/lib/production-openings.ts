import { createHash } from "node:crypto";
import { productionAppearance,approvedProductionProp } from "./production-appearance";
import { requireProductionScenery } from "./production-scenery";
import type { ProductionState,ProductionScene } from "./production-types";
import { resolveProductionCast } from "./production-cast";
export function openingInputs(state:ProductionState,scene:ProductionScene) {
  const cast=resolveProductionCast(state,scene);
  const {reference}=requireProductionScenery(state,scene);
  const prop=approvedProductionProp(state);
  const ids=[reference.assetId!,...cast.map(c=>productionAppearance(state,c,scene.sceneNumber).assetId),...(prop?[prop.assetId]:[])];
  const castInstruction = cast.length
    ? `Exactly ${cast.length} character${cast.length===1?"":"s"}, each appearing ONCE, from image${cast.length===1?"":"s"} ${cast.map((_,i)=>i+2).join(", ")}. Preserve their exact faces, bodies, materials and clothes. Do not copy the character reference's plain background.`
    : "Use the location reference and the subjects described in the scene.";
  const prompt=`One cinematic photograph at the location shown in image 1. Keep image 1's environment, layout, scenery and lighting as the entire background. Preserve the visible surroundings as shown in that reference. ${castInstruction} ${prop ? `Exactly ONE recurring prop from image ${ids.length}: ${prop.description}.` : ""} No duplicates, no miniatures, no collage. Scene: ${scene.shots?.[0]?.prompt || scene.action}. ${cast.map(c=>productionAppearance(state,c,scene.sceneNumber).description).join(" ")}`;
  const sourceKey=createHash("sha256").update(JSON.stringify({ids,prompt,location:scene.location,timeOfDay:scene.timeOfDay,identities:cast.map(c=>c.selectedAssetId),width:state.settings.width,height:state.settings.height})).digest("hex");
  return {ids,prompt,sourceKey};
}
export function openingCorrectionPrompt(correction: string): string {
  return `Edit this single complete scene image. Preserve its exact cast, faces, materials, outfits, props, location, scenery, lighting and camera except for this requested correction: ${correction}. Do not duplicate characters or objects.`;
}
export function requireOpening(state:ProductionState,scene:ProductionScene) {
  const inputs=openingInputs(state,scene);
  const opening=scene.opening;
  if(!opening?.assetId || opening.approvedAssetId!==opening.assetId || opening.sourceKey!==inputs.sourceKey) {
    throw new Error(`Review and approve the current opening image for Scene ${scene.sceneNumber} (${scene.title}) in Create before rendering. It must contain the cast, outfits, props and location together.`);
  }
  return opening;
}
