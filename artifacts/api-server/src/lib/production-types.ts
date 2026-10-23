export type ProductionImage = { assetId: string; mediaUrl: string; label?: string };
export type ProductionScene = {
  sceneNumber: number; title: string; location: string; timeOfDay: string;
  characters: string[]; action: string; dialogue: string;
  durationSeconds?: number;
  shots?: { prompt: string; dialogue: string; durationSeconds: number }[];
};
export type ProductionCharacter = {
  id: string; characterId?: string; name: string; description: string; seed: number;
  workflowId?: string; options: ProductionImage[]; selectedAssetId?: string;
  locked: boolean; referenceSheet: ProductionImage[]; status: string; error?: string;
};
export type ProductionWardrobe = {
  id: string; characterId: string; name: string; prompt: string;
  fromScene: number; toScene: number; stateFromScene?: number; stateNote?: string;
  assetId?: string; mediaUrl?: string; status: string; error?: string;
};
export type ProductionVariant = {
  id: string; name: string; prompt: string; assetId?: string; mediaUrl?: string; status: string; error?: string;
};
export type ProductionPlace = ProductionVariant & { seed: number; variants: ProductionVariant[] };
export type ProductionTask = {
  id: string; type: "story" | "portraits" | "sheet" | "wardrobe" | "place" | "variant";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  entityId?: string; placeId?: string; jobId?: string; index: number; error?: string;
  modelId?: string; cloudConfirmed?: boolean; storyModel?: string;
  storySourceKey?: string;
};
export type ProductionState = {
  publishedCharacterAssets?: string[];
  step: number;
  storyCancelTaskId?: string | null;
  story: { summary: string; script: string; targetMinutes: number; sourceMode?: "summary" | "script";
    scriptName?: string; scriptStorageKey?: string; draftStatus?: string; error?: string; scenes: ProductionScene[];
    progress?: { stage: string; model: string; target: string; startedAt: string; active: boolean; gpuVerified?: boolean } };
  characters: ProductionCharacter[];
  wardrobes: ProductionWardrobe[];
  places: ProductionPlace[];
  // Stable scene-to-place links; names remain editable display text.
  // A null entry opts back into an unambiguous exact-name match.
  settings: { sceneReferences?: Record<string, { placeId: string; variantId?: string } | null>; generationMode: string; width: number; height: number; fps: 24 | 25 | 30; shotDurationSeconds: number; qualityPreset: "DRAFT" | "STANDARD" | "HIGH"; imageModels?: Record<string, string>; storyModel?: string; videoProvider?: "COMFYUI" | "FAL"; videoModel?: string; videoConfirmed?: boolean };
  tasks: ProductionTask[];
  review: { status: "NOT_IMPLEMENTED"; issues: { id: string; shotId?: string; sceneNumber?: number; timecode?: string; description: string; correction?: string }[] };
};
export function emptyProduction(): ProductionState {
  return {
    step: 0, story: { summary: "", script: "", targetMinutes: 3, scenes: [] },
    characters: [], wardrobes: [], places: [], tasks: [],
    settings: { generationMode: "", width: 1280, height: 720, fps: 24, shotDurationSeconds: 8, qualityPreset: "STANDARD" },
    review: { status: "NOT_IMPLEMENTED", issues: [] },
  };
}
export function text(value: unknown, name: string, max = 4000, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? "non-empty and " : ""}at most ${max} characters.`);
  return value.trim();
}
export function numberIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}
export function validateScenes(value: unknown): ProductionScene[] {
  if (!Array.isArray(value) || !value.length || value.length > 180) throw new Error("Provide between 1 and 180 scenes.");
  return value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid scene.");
    const s = raw as Record<string, unknown>;
    if (!Array.isArray(s.characters) || s.characters.length > 9) throw new Error("Each scene supports at most nine characters.");
    return {
      sceneNumber: i + 1, title: text(s.title, "Scene title", 180),
      location: text(s.location, "Location", 180), timeOfDay: text(s.timeOfDay, "Time of day", 100),
      characters: s.characters.map(c => text(c, "Character name", 180)),
      action: text(s.action, "Scene action", 20000), dialogue: text(s.dialogue ?? "", "Dialogue", 20000, false),
      ...(s.durationSeconds !== undefined ? { durationSeconds: numberIn(s.durationSeconds, "Scene duration", 2, 5400) } : {}),
    };
  });
}
