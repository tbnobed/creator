export type FalModel = "veo-3.1-fast" | "kling-v3-standard" | "seedance-2.0-mini" | "seedance-2.0-fast" | "seedance-2.0" | "seedance-2.5";
export type SeedanceTask = "reference" | "editing" | "extension";
export type VideoQuality = "DRAFT" | "STANDARD" | "HIGH";
export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9";
export type OutputResolution = "480p" | "720p" | "1080p" | "4k";
export const ASPECT_RATIOS: readonly AspectRatio[] = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
/** Nearest preset quality for a resolution; the backend receives both. */
export const RESOLUTION_QUALITY: Record<OutputResolution, VideoQuality> = { "480p": "DRAFT", "720p": "STANDARD", "1080p": "HIGH", "4k": "HIGH" };

type ModelCapabilities = {
  durationOptions: readonly number[];
  roles: { frames: boolean; images: boolean; videos: boolean; audio: boolean; source: boolean };
  limits: { images: number; videos: number; audio: number; total: number; source: number };
  qualities: readonly VideoQuality[];
  nativeAudio: boolean;
  tasks: readonly SeedanceTask[];
  autoDurationTasks: readonly SeedanceTask[];
  aspectRatios?: readonly AspectRatio[];
  resolutions?: readonly OutputResolution[];
};

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index);
const noRoles = { frames: false, images: false, videos: false, audio: false, source: false };
const noLimits = { images: 0, videos: 0, audio: 0, total: 0, source: 0 };
const seedance20 = {
  durationOptions: range(4, 15),
  roles: { frames: true, images: true, videos: true, audio: true, source: false },
  limits: { images: 9, videos: 3, audio: 3, total: 15, source: 0 },
  nativeAudio: true,
  tasks: ["reference"],
  autoDurationTasks: [],
  aspectRatios: ASPECT_RATIOS,
} as const;

export const VIDEO_MODEL_CAPABILITIES: Record<FalModel, ModelCapabilities> = {
  "veo-3.1-fast": { durationOptions: [4, 6, 8], roles: noRoles, limits: noLimits, qualities: [], nativeAudio: false, tasks: [], autoDurationTasks: [] },
  "kling-v3-standard": { durationOptions: [5, 10], roles: noRoles, limits: noLimits, qualities: [], nativeAudio: false, tasks: [], autoDurationTasks: [] },
  "seedance-2.0-mini": { ...seedance20, qualities: ["DRAFT", "STANDARD"], resolutions: ["480p", "720p"] },
  "seedance-2.0-fast": { ...seedance20, qualities: ["DRAFT", "STANDARD"], resolutions: ["480p", "720p"] },
  "seedance-2.0": { ...seedance20, qualities: ["DRAFT", "STANDARD", "HIGH"], resolutions: ["480p", "720p", "1080p", "4k"] },
  "seedance-2.5": {
    durationOptions: range(4, 30),
    roles: { frames: true, images: true, videos: true, audio: true, source: true },
    limits: { images: 30, videos: 10, audio: 10, total: 50, source: 1 },
    qualities: ["DRAFT", "STANDARD", "HIGH"],
    nativeAudio: true,
    tasks: ["reference", "editing", "extension"],
    autoDurationTasks: ["editing"],
    aspectRatios: ASPECT_RATIOS,
    resolutions: ["480p", "720p", "1080p"],
  },
};

export function effectiveModelDuration(model: FalModel, duration: number): number {
  const options = VIDEO_MODEL_CAPABILITIES[model].durationOptions;
  return options.reduce((best, value) => Math.abs(value - duration) < Math.abs(best - duration) ? value : best, options[0]);
}

export function activeSeedanceRoles(model: FalModel, task: SeedanceTask) {
  const roles = VIDEO_MODEL_CAPABILITIES[model].roles;
  if (task === "editing" || task === "extension") {
    // Edit/Extend: one source video plus optional image and audio references (no extra videos).
    return { frames: false, images: roles.source, videos: false, audio: roles.source, source: roles.source };
  }
  return { ...roles, source: false };
}

/** Edit and Extend inherit the source video's shape, so aspect ratio is never sent. */
export function aspectRatioIsInherited(model: FalModel, task: SeedanceTask): boolean {
  return activeSeedanceRoles(model, task).source;
}

/** Count primary cast/environment stills exactly as the provider does, not as user uploads. */
export function seedanceReferenceBudget(model: FalModel, task: SeedanceTask, input: {
  characterCount: number;
  hasSetting: boolean;
  images: number;
  videos: number;
  audio: number;
  frames: number;
  hasSource: boolean;
}) {
  const limits = VIDEO_MODEL_CAPABILITIES[model].limits;
  const sourceOnly = activeSeedanceRoles(model, task).source;
  const primaryImages = sourceOnly ? 0 : input.characterCount + Number(input.hasSetting);
  const imageCount = primaryImages + input.images;
  const total = sourceOnly ? Number(input.hasSource) + input.images + input.audio : imageCount + input.videos + input.audio + input.frames;
  return {
    primaryImages,
    imageCount,
    total,
    imageLimit: limits.images,
    totalLimit: limits.total,
    overImageLimit: imageCount > limits.images,
    overTotalLimit: total > limits.total,
    framesWithPrimary: !sourceOnly && input.frames > 0 && primaryImages > 0,
  };
}