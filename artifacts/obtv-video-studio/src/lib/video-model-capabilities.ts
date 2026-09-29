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
  /** Cast/environment stills are sent as image references (otherwise they are compiled into the prompt as text only). */
  castImagesSent: boolean;
  /** Start/end frames and independent references use different provider endpoints and cannot be combined. */
  framesExclusiveWithReferences: boolean;
  /** A start frame fixes output shape, so aspect ratio is not sent while one is attached. */
  startFrameInheritsAspect: boolean;
  /** Duration forced by the provider when independent image references are attached. */
  referenceImageDurations?: readonly number[];
  /** Provider still-image constraints surfaced beside upload controls. */
  imageConstraint?: string;
  /** Whether the MP4/MOV container choice is honoured for this model. */
  outputFormat: boolean;
  /** Structured subject elements (frontal view + extra angles), e.g. Kling `elements`. Count includes cast/environment. */
  elements?: { max: number; minAngles: number; maxAngles: number };
  /** Image references/elements (incl. cast/environment) require a start frame (Kling image-to-video). */
  referencesRequireStartFrame?: boolean;
  /** Provider prompt-adherence control (Kling `cfg_scale`). */
  guidanceScale?: { min: number; max: number; step: number; default: number };
  /** Provider accepts a negative prompt; `referenceMode` = value when independent image references are active. */
  negativePrompt: { base: boolean; referenceMode: boolean };
  /** Provider accepts a fixed seed. */
  fixedSeed: { base: boolean; referenceMode: boolean };
};

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index);
const seedance20 = {
  durationOptions: range(4, 15),
  roles: { frames: true, images: true, videos: true, audio: true, source: false },
  limits: { images: 9, videos: 3, audio: 3, total: 15, source: 0 },
  nativeAudio: true,
  tasks: ["reference"],
  autoDurationTasks: [],
  aspectRatios: ASPECT_RATIOS,
  castImagesSent: true,
  framesExclusiveWithReferences: true,
  startFrameInheritsAspect: false,
  outputFormat: true,
  negativePrompt: { base: false, referenceMode: false },
  fixedSeed: { base: false, referenceMode: false },
} as const;

export const VIDEO_MODEL_CAPABILITIES: Record<FalModel, ModelCapabilities> = {
  // fal-ai/veo3.1/fast (+ /image-to-video, /first-last-frame-to-video, /reference-to-video):
  // duration 4s|6s|8s (reference-to-video is fixed at 8s), aspect 16:9|9:16, resolution 720p|1080p|4k, generate_audio.
  // Reference images: Google documents up to 3 subject images; they cannot be combined with first/last frames.
  "veo-3.1-fast": {
    durationOptions: [4, 6, 8],
    roles: { frames: true, images: true, videos: false, audio: false, source: false },
    limits: { images: 3, videos: 0, audio: 0, total: 3, source: 0 },
    qualities: [],
    nativeAudio: true,
    tasks: [],
    autoDurationTasks: [],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p", "4k"],
    castImagesSent: true,
    framesExclusiveWithReferences: true,
    startFrameInheritsAspect: false,
    referenceImageDurations: [8],
    imageConstraint: "JPG, PNG or WebP, up to 8 MB.",
    outputFormat: false,
    // reference-to-video has no negative_prompt / seed; text, image and first-last endpoints do.
    negativePrompt: { base: true, referenceMode: false },
    fixedSeed: { base: true, referenceMode: false },
  },
  // fal-ai/kling-video/v3/standard (text-to-video / image-to-video): duration 3–15s, generate_audio,
  // aspect 16:9|9:16|1:1 for text-to-video only; image-to-video takes start_image_url (+ optional end_image_url).
  "kling-v3-standard": {
    durationOptions: range(3, 15),
    // referenceImageKeys and cast/environment stills become frontal-only elements (backend contract).
    roles: { frames: true, images: true, videos: false, audio: false, source: false },
    // One shared 4-element budget: cast/environment + reference images + structured elements.
    limits: { images: 4, videos: 0, audio: 0, total: 4, source: 0 },
    qualities: [],
    nativeAudio: true,
    tasks: [],
    autoDurationTasks: [],
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: [],
    castImagesSent: true,
    framesExclusiveWithReferences: false,
    startFrameInheritsAspect: true,
    imageConstraint: "JPG or PNG, min 300 px per side, aspect between 1:2.5 and 2.5:1, up to 50 MB.",
    outputFormat: false,
    // klingElements: frontalImageKey + optional 1–3 referenceImageKeys (OBTV contract). Cap 4 incl. cast/env + reference images.
    elements: { max: 4, minAngles: 0, maxAngles: 3 },
    referencesRequireStartFrame: true,
    guidanceScale: { min: 0, max: 1, step: 0.05, default: 0.5 },
    negativePrompt: { base: true, referenceMode: true },
    fixedSeed: { base: false, referenceMode: false },
  },
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
    castImagesSent: true,
    framesExclusiveWithReferences: true,
    startFrameInheritsAspect: false,
    outputFormat: true,
    negativePrompt: { base: false, referenceMode: false },
    fixedSeed: { base: false, referenceMode: false },
  },
};

export const isSeedanceModel = (model: FalModel) => model.startsWith("seedance");

/** True when the model accepts any uploaded media role (frames, images, videos, audio or source). */
export function modelAcceptsReferences(model: FalModel): boolean {
  return Object.values(VIDEO_MODEL_CAPABILITIES[model].roles).some(Boolean);
}

/** Durations actually offered, narrowed when attached references force a provider-fixed length. */
export function modelDurationOptions(model: FalModel, opts: { hasReferenceImages?: boolean } = {}): readonly number[] {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  return opts.hasReferenceImages && caps.referenceImageDurations ? caps.referenceImageDurations : caps.durationOptions;
}

export function effectiveModelDuration(model: FalModel, duration: number, opts: { hasReferenceImages?: boolean } = {}): number {
  const options = modelDurationOptions(model, opts);
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
    framesWithPrimary: !sourceOnly && VIDEO_MODEL_CAPABILITIES[model].framesExclusiveWithReferences && input.frames > 0 && primaryImages > 0,
  };
}
type MediaRef = { storageKey: string };
export type CloudReferenceMedia = {
  start: MediaRef | null;
  end: MediaRef | null;
  source: MediaRef | null;
  images: MediaRef[];
  videos: MediaRef[];
  audio: MediaRef[];
  elements?: { frontal: MediaRef; angles: MediaRef[] }[];
};

/**
 * Reference keys to submit for the selected model/task. Only roles the model
 * actually accepts are included, so media kept in a draft from another model
 * is never sent after switching.
 */
export function cloudReferencePayload(model: FalModel, task: SeedanceTask, media: CloudReferenceMedia) {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  const effectiveTask: SeedanceTask = caps.tasks.includes(task) ? task : "reference";
  const roles = activeSeedanceRoles(model, effectiveTask);
  const keys = (items: MediaRef[]) => items.length ? items.map((item) => item.storageKey) : undefined;
  if (roles.source) {
    if (!media.source) return {};
    return {
      referenceVideoKeys: [media.source.storageKey],
      referenceImageKeys: roles.images ? keys(media.images) : undefined,
      referenceAudioKeys: roles.audio ? keys(media.audio) : undefined,
    };
  }
  const start = roles.frames ? media.start : null;
  const imagesNeedStart = caps.referencesRequireStartFrame && !start;
  const elements = caps.elements && start
    ? (media.elements ?? []).filter((element) => element.angles.length >= caps.elements!.minAngles).map((element) => ({
      frontalImageKey: element.frontal.storageKey,
      ...(element.angles.length ? { referenceImageKeys: element.angles.slice(0, caps.elements!.maxAngles).map((angle) => angle.storageKey) } : {}),
    }))
    : [];
  const end = roles.frames && start ? media.end : null;
  const framesActive = Boolean(start);
  const extrasBlocked = framesActive && caps.framesExclusiveWithReferences;
  return {
    startFrameKey: start?.storageKey,
    endFrameKey: end?.storageKey,
    referenceImageKeys: roles.images && !extrasBlocked && !imagesNeedStart ? keys(media.images) : undefined,
    referenceVideoKeys: roles.videos && !extrasBlocked ? keys(media.videos) : undefined,
    referenceAudioKeys: roles.audio && !extrasBlocked ? keys(media.audio) : undefined,
    klingElements: elements.length ? elements : undefined,
  };
}

/** Media attached in the draft that the selected model/task will not receive. */
export function inactiveReferenceRoles(model: FalModel, task: SeedanceTask, media: CloudReferenceMedia): string[] {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  const roles = activeSeedanceRoles(model, caps.tasks.includes(task) ? task : "reference");
  const out: string[] = [];
  if ((media.start || media.end) && !roles.frames) out.push("start/end frames");
  if (media.source && !roles.source) out.push("source video");
  if (media.images.length && !roles.images) out.push("reference images");
  if (media.videos.length && !roles.videos) out.push("reference videos");
  if (media.audio.length && !roles.audio) out.push("reference audio");
  if (media.elements?.length && !caps.elements) out.push("Kling elements");
  return out;
}

/** Output options that the selected model can honour, for a given reference state. */
export function cloudOutputOptions(model: FalModel, opts: { hasStartFrame: boolean; hasReferenceImages: boolean; task: SeedanceTask }) {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  const aspectInherited = aspectRatioIsInherited(model, caps.tasks.includes(opts.task) ? opts.task : "reference")
    || (caps.startFrameInheritsAspect && opts.hasStartFrame);
  return {
    aspectRatios: caps.aspectRatios ?? [],
    aspectInherited,
    resolutions: caps.resolutions ?? [],
    durations: modelDurationOptions(model, { hasReferenceImages: opts.hasReferenceImages }),
    nativeAudio: caps.nativeAudio,
    outputFormat: caps.outputFormat,
  };
}

/** Which optional prompt controls the provider accepts for the active reference mode. */
export function cloudPromptControls(model: FalModel, opts: { referenceImagesActive: boolean }) {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  const key = opts.referenceImagesActive ? "referenceMode" : "base";
  return { negativePrompt: caps.negativePrompt[key], fixedSeed: caps.fixedSeed[key], guidanceScale: caps.guidanceScale ?? null };
}

/** Kling element validation: start frame, element count incl. cast/environment, and 1–3 angles each. */
export function elementProblems(model: FalModel, media: CloudReferenceMedia, primaryImages: number): string | null {
  const caps = VIDEO_MODEL_CAPABILITIES[model];
  if (!caps.elements) return null;
  const elements = media.elements ?? [];
  const total = elements.length + primaryImages + media.images.length;
  if ((elements.length || primaryImages || media.images.length) && caps.referencesRequireStartFrame && !media.start) {
    return "Kling elements, reference images and selected cast/environment need a start frame. Add one, or clear them to render from text.";
  }
  if (total > caps.elements.max) return `Kling accepts at most ${caps.elements.max} elements across cast, environment, reference images and structured elements (${total} selected).`;
  const overfull = elements.findIndex((element) => element.angles.length > caps.elements!.maxAngles);
  if (overfull >= 0) return `Each element accepts at most ${caps.elements.maxAngles} extra angles.`;
  return null;
}
