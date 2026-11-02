import { randomInt, randomUUID } from "node:crypto";
import { numberIn, type OpeningCandidate, type ProductionScene, type ProductionState, type ProductionTask } from "./production-types";

/** Include legacy current images without discarding the creator's existing choice. */
export function openingHistory(scene: ProductionScene): OpeningCandidate[] {
  const history = scene.openingHistory ??= [];
  if (scene.opening && !history.some(item => item === scene.opening
    || (item.id && item.id === scene.opening?.id)
    || (item.assetId && item.assetId === scene.opening?.assetId))) history.push({ ...scene.opening });
  return history;
}

export function approveOpeningCandidate(scene: ProductionScene, assetId: unknown, sourceKey: string) {
  if(typeof assetId!=="string" || !assetId)throw new Error("Choose a completed opening image.");
  const candidate = openingHistory(scene).find(item => item.assetId === assetId && item.status === "READY" && item.sourceKey === sourceKey);
  if (!candidate) throw new Error("Choose a completed opening made with the current scene, cast, wardrobe and location inputs.");
  // A later completion must never replace a deliberate approval.
  scene.opening = { ...candidate, approvedAssetId: candidate.assetId };
}

export function queueOpeningCandidates(state: ProductionState, scene: ProductionScene, sourceKey: string, count: unknown = 1, correction = "") {
  const total=numberIn(count,"Number of openings",1,4);
  if(state.tasks.filter(t=>t.type==="opening"&&["QUEUED","RUNNING"].includes(t.status)).length+total>20)throw new Error("Up to 20 openings can be queued at once. Wait for some to finish.");
  if(correction&&!scene.opening?.assetId)throw new Error("Generate or upload an opening before correcting it.");
  const history=openingHistory(scene);
  for(let index=0;index<total;index++){
    const id=randomUUID();
    history.push({id,status:"QUEUED",sourceKey});
    state.tasks.push({id,type:"opening",entityId:String(scene.sceneNumber),index:0,status:"QUEUED",
      modelId:"local-flux2-klein-4b",openingSeed:randomInt(0,2147483647),
      ...(correction?{openingReferenceAssetId:scene.opening!.assetId,openingCorrection:correction}:{})});
    if(!scene.opening?.assetId)scene.opening={...history.at(-1)!};
  }
}

/** Rotate between polling and submissions, rather than waiting for the first job. */
export function nextProductionTask(tasks: ProductionTask[], previousId?: string) {
  const active=tasks.filter(task=>["QUEUED","RUNNING"].includes(task.status));
  if(active[0]?.type!=="opening")return active[0];
  const openings=active.filter(task=>task.type==="opening");
  const previous=openings.findIndex(task=>task.id===previousId);
  return openings[(previous+1)%openings.length];
}
