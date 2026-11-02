import { createHash } from "node:crypto";
import { productionAppearance,approvedProductionProp } from "./production-appearance";
import { requireProductionScenery } from "./production-scenery";
import type { ProductionState,ProductionScene } from "./production-types";
import { resolveOpeningCast } from "./production-cast";
import type { NativeComposition } from "./image-native-composition";
import { openingIdentity, openingSubjectAction } from "./production-opening-prompts";
export function openingInputs(state:ProductionState,scene:ProductionScene) {
  const cast=resolveOpeningCast(state,scene);
  const {reference}=requireProductionScenery(state,scene);
  const prop=approvedProductionProp(state);
  const ids=[reference.assetId!,...cast.map(c=>productionAppearance(state,c,scene.sceneNumber).assetId),...(prop?[prop.assetId]:[])];
  const style = cast.some(c => /\b3d|animated|animation\b/i.test(c.description)) ? "3D animated film frame" : "cinematic photograph";
  const action = scene.shots?.[0]?.prompt || scene.action;
  const castInstruction = cast.length
    ? `Exactly ${cast.length} character${cast.length===1?"":"s"}, each appearing ONCE, from image${cast.length===1?"":"s"} ${cast.map((_,i)=>i+2).join(", ")}. ${cast.map((character, index) => `Image ${index + 2} is ${character.name}'s identity reference only. ${character.name}: ${openingIdentity(character.description)}. Preserve this reference's exact species, anatomy, face, body proportions, materials and clothes.`).join(" ")} Each character retains its own distinct identity and features from its assigned image. Do not copy the character reference's plain background.`
    : "Use the location reference and the subjects described in the scene.";
  const prompt=`One ${style} at the location shown in image 1. Keep image 1's environment, layout, scenery and lighting as the entire background. Preserve the visible surroundings as shown in that reference. ${castInstruction} ${prop ? `Exactly ONE recurring prop from image ${ids.length}: ${prop.description}.` : ""} No duplicates, no miniatures, no collage. Scene: ${action}. ${cast.map(c=>productionAppearance(state,c,scene.sceneNumber).description).join(" ")}`;
  const backgroundPrompt = `One ${style}. Preserve the location, geography, layout and lighting of image 1 as the complete setting. Scenery only in the background region. ${prop ? `One recurring prop from image 2: ${prop.description}.` : ""}`;
  const slot = state.settings.width / Math.max(1, cast.length);
  const composition: NativeComposition | undefined = cast.length > 1 ? {
    version: 2, backgroundPrompt,
    backgroundReferenceIndexes: [0, ...(prop ? [ids.length - 1] : [])],
    subjects: cast.map((character, index) => ({
      name: character.name, referenceIndex: index + 1,
      x: Math.floor((index * slot + slot * .06) / 16) * 16,
      y: Math.floor(state.settings.height * .06 / 16) * 16,
      width: Math.floor(slot * .88 / 16) * 16,
      height: Math.floor(state.settings.height * .9 / 16) * 16,
      prompt: `One ${style} at the exact location in image 1. Image 1 is a cropped part of the setting. Preserve its background, viewpoint, scale and lighting. Exactly one subject: ${character.name}, from image 2. ${openingIdentity(character.description)}. ${productionAppearance(state,character,scene.sceneNumber).description} Preserve this subject's own exact species, anatomy, face and clothing. Center this one subject in the crop, with its entire silhouette inside the frame and clear space around all edges. Use the setting's lighting and scenery rather than the portrait backdrop. Action: ${openingSubjectAction(action,character.name,cast.map(c=>c.name))}`,
    })),
  } : undefined;
  const sourceKey=createHash("sha256").update(JSON.stringify({ids,prompt,composition,location:scene.location,timeOfDay:scene.timeOfDay,identities:cast.map(c=>c.selectedAssetId),width:state.settings.width,height:state.settings.height})).digest("hex");
  return {ids,prompt,sourceKey,composition};
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
