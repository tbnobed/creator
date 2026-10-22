import {
  createLocationImageJob,
  removeLocationReference,
  renameLocationReference as renameRef,
  type LocationImageJobInput,
} from "@workspace/api-client-react";

/** Thin adapters over the generated library-location endpoints (async jobs; never the legacy generate-image path). */
export function startLocationImageJob(settingId: string, data: LocationImageJobInput) {
  return createLocationImageJob(settingId, data);
}

export function renameLocationReference(settingId: string, referenceId: string, name: string) {
  return renameRef(settingId, referenceId, { name });
}

export function deleteLocationReference(settingId: string, referenceId: string) {
  return removeLocationReference(settingId, referenceId);
}

export function newRequestKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
