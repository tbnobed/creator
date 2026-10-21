// Local contract for ProductionProject.state. Backend owns tasks/statuses.
export type TargetMinutes = number;
export type QualityPreset = "DRAFT" | "STANDARD" | "HIGH";

export interface SceneShot { prompt: string; dialogue: string; durationSeconds: number }
export interface Scene {
  sceneNumber: number; title: string; location: string; timeOfDay: string;
  characters: string[]; action: string; dialogue: string; shots?: SceneShot[];
  durationSeconds?: number;
}
export interface Story {
  summary: string; script: string; targetMinutes: TargetMinutes; scriptName?: string;
  sourceMode?: "summary" | "script";
  draftStatus?: string; error?: string; scenes: Scene[];
  progress?: { stage: string; model: string; target: string; startedAt: string; active: boolean; gpuVerified?: boolean };
}
export interface MediaRef { assetId: string; mediaUrl: string; label?: string }
export interface ProductionCharacter {
  id: string; characterId?: string; name: string; description: string; seed: number; workflowId?: string;
  options: { assetId: string; mediaUrl: string }[]; selectedAssetId?: string; locked: boolean;
  referenceSheet: MediaRef[]; status: string; error?: string;
}
export interface Wardrobe {
  id: string; characterId: string; name: string; prompt: string; fromScene: number; toScene: number;
  stateFromScene?: number; stateNote?: string; assetId?: string; mediaUrl?: string; status: string; error?: string;
}
export interface PlaceVariant { id: string; name: string; prompt: string; assetId?: string; mediaUrl?: string; status: string; error?: string }
export interface Place {
  id: string; name: string; prompt: string; seed: number; assetId?: string; mediaUrl?: string;
  variants: PlaceVariant[]; status: string; error?: string;
}
export type ImageModelKey = "characters" | "referenceSheet" | "wardrobe" | "places" | "variants";
export interface ProductionSettings {
  sceneReferences?: Record<string, { placeId: string; variantId?: string } | null>;
  imageModels?: Partial<Record<ImageModelKey, string>>;
  /** "local" or "openai:<model-id>" */
  storyModel?: string;
  videoProvider?: "COMFYUI" | "FAL";
  videoModel?: string;
  generationMode: string; width: number; height: number; fps: 24 | 25 | 30;
  shotDurationSeconds: number; qualityPreset: QualityPreset;
}
export interface ProductionTask { id: string; type: string; status: string; error?: string; cloudConfirmed?: boolean; modelId?: string; provider?: string }
export const taskIsPaid = (t: ProductionTask) => !!t.cloudConfirmed || ["CLOUD", "FAL", "OPENAI"].includes((t.provider ?? "").toUpperCase()) || /^(openai:|cloud)/.test(t.modelId ?? "");
export interface ReviewIssue { id: string; shotId?: string; sceneNumber?: number; timecode?: string; description: string; correction?: string }
export interface ProductionState {
  storyCancelTaskId?: string;
  step: number; story: Story; characters: ProductionCharacter[]; wardrobes: Wardrobe[]; places: Place[];
  settings: ProductionSettings; tasks: ProductionTask[];
  review: { status: string; issues: ReviewIssue[] };
}

export const STEPS = ["Story", "Characters", "Wardrobe", "Places", "Create", "Review"] as const;

export const DEFAULT_SETTINGS: ProductionSettings = {
  generationMode: "", width: 1280, height: 720, fps: 24, shotDurationSeconds: 5, qualityPreset: "STANDARD",
};

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function normalizeState(raw: Record<string, unknown> | null | undefined): ProductionState {
  const r = (raw ?? {}) as Record<string, any>;
  const s = r.story ?? {};
  const tm = Number.isInteger(s.targetMinutes) && s.targetMinutes >= 1 && s.targetMinutes <= 90 ? s.targetMinutes : 3;
  return {
    storyCancelTaskId: typeof r.storyCancelTaskId === "string" ? r.storyCancelTaskId : undefined,
    step: Math.min(5, Math.max(0, Number(r.step) || 0)),
    story: {
      summary: s.summary ?? "", script: s.script ?? "", targetMinutes: tm, scriptName: s.scriptName,
      sourceMode: s.sourceMode ?? (s.script?.trim() ? "script" : "summary"),
      draftStatus: s.draftStatus, error: s.error, scenes: arr<Scene>(s.scenes),
      progress: s.progress && typeof s.progress.stage === "string" && typeof s.progress.model === "string" && typeof s.progress.target === "string" ? s.progress : undefined,
    },
    characters: arr<ProductionCharacter>(r.characters).map((c) => ({ ...c, options: arr(c.options), referenceSheet: arr(c.referenceSheet) })),
    wardrobes: arr<Wardrobe>(r.wardrobes),
    places: arr<Place>(r.places).map((p) => ({ ...p, variants: arr(p.variants) })),
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
    tasks: arr<ProductionTask>(r.tasks),
    review: { status: r.review?.status ?? "NOT_IMPLEMENTED", issues: arr<ReviewIssue>(r.review?.issues) },
  };
}

const PENDING = new Set(["PENDING", "QUEUED", "RUNNING", "GENERATING", "IN_PROGRESS", "PROCESSING"]);
export const isPending = (status?: string) => !!status && PENDING.has(status.toUpperCase());
export const isFailed = (status?: string) => !!status && ["FAILED", "ERROR"].includes(status.toUpperCase());

export function needsPolling(state: ProductionState): boolean {
  return (
    isPending(state.story.draftStatus) ||
    state.tasks.some((t) => isPending(t.status)) ||
    state.characters.some((c) => isPending(c.status)) ||
    state.wardrobes.some((w) => isPending(w.status)) ||
    state.places.some((p) => isPending(p.status) || p.variants.some((v) => isPending(v.status)))
  );
}

export function errorMessage(err: unknown): string {
  const e = err as { message?: string; data?: { error?: string; message?: string } } | null;
  return e?.data?.error || e?.data?.message || e?.message || "Something went wrong.";
}
export const isConflict = (err: unknown) => (err as { status?: number } | null)?.status === 409;
