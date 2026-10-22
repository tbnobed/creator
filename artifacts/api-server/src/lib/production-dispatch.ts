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

export function productionDispatchBlock(shots: { status: string; outputStorageKey?: string | null; sceneNumber: number; shotNumber: number }[]) {
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
