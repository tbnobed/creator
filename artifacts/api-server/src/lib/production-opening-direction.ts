import { text, type ProductionState, type ProductionScene } from "./production-types";

/** Review actual saved direction, without interpreting names or inventing anatomy. */
export function reviewOpeningDirection(state: ProductionState, scene: ProductionScene, payload: Record<string, unknown>) {
  const current = scene.shots?.[0]?.prompt || scene.action;
  if (payload.expectedDirection !== current) {
    throw new Error("Review the current opening direction before generating. It may have changed in another session.");
  }
  const direction = text(payload.direction, "Opening direction", 20000);
  if (direction === current) return;
  if (state.tasks.some(t => t.type === "opening" && t.entityId === String(scene.sceneNumber)
    && ["QUEUED", "RUNNING"].includes(t.status))) {
    throw new Error("Wait for this scene's queued openings to finish before changing its direction.");
  }
  if (scene.shots?.length) scene.shots[0].prompt = direction;
  else scene.action = direction;
  // Keep previous images, but never approve them against changed direction.
  for (const candidate of [...(scene.openingHistory ?? []), ...(scene.opening ? [scene.opening] : [])]) {
    candidate.status = "STALE";
    delete candidate.approvedAssetId;
  }
}
