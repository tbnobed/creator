import type { ProductionScene, ProductionState } from "./production-types";
const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Explicit IDs win. Never guess which differently named room the creator meant. */
export function resolveProductionScenery(state: ProductionState, scene: ProductionScene) {
  const assigned = state.settings.sceneReferences?.[String(scene.sceneNumber)];
  const matches = assigned
    ? state.places.filter(p => p.id === assigned.placeId)
    : state.places.filter(p => normalized(p.name) === normalized(scene.location));
  if (matches.length !== 1) return undefined;
  const place = matches[0];
  const variants = assigned
    ? (assigned.variantId ? place.variants.filter(v => v.id === assigned.variantId) : [])
    : place.variants.filter(v => normalized(v.name) === normalized(scene.timeOfDay));
  if (variants.length > 1 || (assigned?.variantId && !variants.length)) return undefined;
  return { place, reference: variants[0] ?? place };
}
export function requireProductionScenery(state: ProductionState, scene: ProductionScene) {
  const selected = resolveProductionScenery(state, scene);
  if (!selected?.reference.assetId) throw new Error(`Scene ${scene.sceneNumber} (${scene.location}) needs a ready scenery reference. Assign an existing place or variant under “Scene scenery” in Create, or generate it in Places.`);
  return selected;
}
