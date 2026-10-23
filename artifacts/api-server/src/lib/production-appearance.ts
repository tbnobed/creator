import type { ProductionCharacter, ProductionState } from "./production-types";

export function approvedProductionProp(state: ProductionState) {
  const reference=state.propReference;
  if (reference && reference.approvedAssetId !== reference.assetId) throw new Error("Review and approve the current prop reference in Create before rendering.");
  return reference;
}

/** An approved dressed portrait supersedes the undressed portrait, not its identity. */
export function productionAppearance(state: ProductionState, character: ProductionCharacter, sceneNumber: number) {
  if (!character.locked || !character.selectedAssetId) throw new Error(`Lock ${character.name}'s appearance before rendering.`);
  const outfit = state.wardrobes.filter(w => w.characterId === character.id && w.fromScene <= sceneNumber && w.toScene >= sceneNumber).at(-1);
  if (outfit && (!outfit.assetId || outfit.approvedAssetId !== outfit.assetId)) {
    throw new Error(`Review and approve ${character.name}'s ${outfit.name} in Wardrobe before rendering.`);
  }
  return {
    assetId: outfit?.assetId ?? character.selectedAssetId,
    description: `${character.name}: preserve the exact face, body proportions, material and clothing from this image. ${
      outfit ? `Approved outfit: ${outfit.name}. ${outfit.prompt}. Do not replace it with clothing from another reference.` : ""
    }${outfit?.stateFromScene !== undefined && sceneNumber >= outfit.stateFromScene ? ` Requested outfit state only: ${outfit.stateNote || ""}.` : ""}`,
  };
}
