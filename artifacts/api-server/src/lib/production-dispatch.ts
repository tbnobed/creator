import { mediaStorage } from "./storage-service";

/** Bridge an already tenant-owned approved image into the frame-input contract. */
export async function registerProductionFrame(
  key: string,
  mimeType: string,
  tenantId: string,
  storage = mediaStorage,
) {
  if (!key.startsWith(`tenants/${tenantId}/`) || !mimeType.startsWith("image/")) {
    throw new Error("The production frame must be an image owned by this workspace.");
  }
  return storage.storeGenerationReferenceMedia(mimeType, await storage.readBuffer(key), tenantId);
}

type SceneShot = { status: string; outputStorageKey?: string | null; sceneNumber: number; shotNumber: number };

/** One frontier per scene; never use another scene's output as a dependency. */
export function readyProductionShots<T extends SceneShot>(shots: T[]): T[] {
  const ordered = [...shots].sort((a, b) => a.sceneNumber - b.sceneNumber || a.shotNumber - b.shotNumber);
  const blocked = new Set<number>();
  return ordered.filter(shot => {
    if (blocked.has(shot.sceneNumber)) return false;
    if (shot.status === "COMPLETED" && shot.outputStorageKey) return false;
    blocked.add(shot.sceneNumber);
    return shot.status === "PLANNED";
  });
}

export function previousProductionShot<T extends SceneShot>(shot: T, shots: T[]): T | undefined {
  return shots.filter(candidate => candidate.sceneNumber === shot.sceneNumber && candidate.shotNumber < shot.shotNumber)
    .sort((a, b) => b.shotNumber - a.shotNumber)[0];
}

export function productionDispatchBlock(shots: SceneShot[]) {
  if (readyProductionShots(shots).length) return null;
  if (shots.some(shot => ["QUEUED", "RENDERING"].includes(shot.status))) {
    return { failed: false, message: "Waiting for the previous shot's completed output before continuing." };
  }
  const first = shots.find(shot => shot.status !== "COMPLETED");
  if (first && ["FAILED", "CANCELLED"].includes(first.status)) {
    return { failed: true, message: `Scene ${first.sceneNumber}, shot ${first.shotNumber} needs a retry. Later shots are waiting for its final frame.` };
  }
  const next = shots.findIndex(shot => shot.status === "PLANNED");
  if (next > 0 && (shots[next - 1].status !== "COMPLETED" || !shots[next - 1].outputStorageKey)) {
    return { failed: false, message: "Waiting for the previous shot's completed output before continuing." };
  }
  return null;
}
