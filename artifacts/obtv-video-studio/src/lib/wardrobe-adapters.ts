// Adapters from library (dossier) and production outfit records to one presentation shape.
// Semantics stay separate: library outfits are reusable presets; production outfits cover scene ranges.

export type OutfitMediaState = "READY" | "PENDING" | "FAILED" | "EMPTY";
export interface OutfitView {
  id: string; name: string; description?: string; mediaUrl?: string; mediaState: OutfitMediaState; error?: string;
  sceneRange?: { from: number; to: number }; stateChange?: { note: string; fromScene?: number }; approval?: "approved" | "pending";
}

const PENDING = ["QUEUED", "RUNNING", "PENDING", "ACTIVE", "UPLOADING", "DOWNLOADING"];
export function mediaStateOf(status: string | undefined, mediaUrl?: string | null): OutfitMediaState {
  if (mediaUrl) return "READY";
  const s = (status ?? "").toUpperCase();
  if (PENDING.includes(s)) return "PENDING";
  if (s === "FAILED" || s === "ERROR") return "FAILED";
  return "EMPTY";
}

export function outfitFromProduction(w: { id: string; name: string; prompt?: string; mediaUrl?: string | null; status?: string; error?: string | null; fromScene: number; toScene: number; stateNote?: string | null; stateFromScene?: number | null }): OutfitView {
  return {
    id: w.id, name: w.name, description: w.prompt, mediaUrl: w.mediaUrl ?? undefined, mediaState: mediaStateOf(w.status, w.mediaUrl),
    error: w.error ?? undefined, sceneRange: { from: w.fromScene, to: w.toScene },
    stateChange: w.stateNote ? { note: w.stateNote, fromScene: w.stateFromScene ?? undefined } : undefined,
  };
}

export function outfitFromLibrary(o: { id: string; name?: string; description?: string; referenceAssetId?: string | null }, mediaUrlFor?: (assetId: string) => string | undefined): OutfitView {
  const mediaUrl = o.referenceAssetId ? mediaUrlFor?.(o.referenceAssetId) : undefined;
  return { id: o.id, name: o.name || "Untitled outfit", description: o.description, mediaUrl, mediaState: mediaUrl ? "READY" : "EMPTY", approval: o.referenceAssetId ? "approved" : undefined };
}

export function sceneRangeLabel(r: { from: number; to: number }): string {
  return r.to !== r.from ? `Scenes ${r.from}–${r.to}` : `Scene ${r.from}`;
}
