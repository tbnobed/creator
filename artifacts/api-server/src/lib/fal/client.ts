export const falModels = {
  "veo-3.1-fast": "fal-ai/veo3.1/fast",
  "kling-v3-standard": "fal-ai/kling-video/v3/standard/text-to-video",
  "seedance-2.0-mini": "bytedance/seedance-2.0/enterprise/mini/text-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/enterprise/v2/text-to-video",
  "seedance-2.0-fast": "bytedance/seedance-2.0/enterprise/v2/fast/text-to-video",
  "seedance-2.5": "bytedance/seedance-2.5/text-to-video",
} as const;

export type FalModel = keyof typeof falModels;
export const falSeedanceReferenceModels = {
  "seedance-2.0-mini": "bytedance/seedance-2.0/enterprise/mini/reference-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/enterprise/v2/reference-to-video",
  "seedance-2.0-fast": "bytedance/seedance-2.0/enterprise/v2/fast/reference-to-video",
  "seedance-2.5": "bytedance/seedance-2.5/reference-to-video",
} as const;
export const falSeedanceImageModels = {
  "seedance-2.0-mini": "bytedance/seedance-2.0/mini/image-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/image-to-video",
  "seedance-2.0-fast": "bytedance/seedance-2.0/enterprise/v2/fast/image-to-video",
  "seedance-2.5": "bytedance/seedance-2.5/image-to-video",
} as const;

const falEndpointsByModel: Record<FalModel, readonly string[]> = {
  "veo-3.1-fast": [falModels["veo-3.1-fast"]],
  "kling-v3-standard": [falModels["kling-v3-standard"]],
  "seedance-2.0-mini": [falModels["seedance-2.0-mini"], falSeedanceReferenceModels["seedance-2.0-mini"], falSeedanceImageModels["seedance-2.0-mini"]],
  "seedance-2.0": [falModels["seedance-2.0"], falSeedanceReferenceModels["seedance-2.0"], falSeedanceImageModels["seedance-2.0"]],
  "seedance-2.0-fast": [falModels["seedance-2.0-fast"], falSeedanceReferenceModels["seedance-2.0-fast"], falSeedanceImageModels["seedance-2.0-fast"]],
  "seedance-2.5": [falModels["seedance-2.5"], falSeedanceReferenceModels["seedance-2.5"], falSeedanceImageModels["seedance-2.5"]],
};

export function falModelFromEndpoint(endpoint: string): FalModel | undefined {
  return (Object.entries(falEndpointsByModel)
    .find(([, endpoints]) => endpoints.includes(endpoint))?.[0]) as FalModel | undefined;
}

export function selectFalGenerationEndpoint(
  model: FalModel,
  references: {
    hasStartFrame?: boolean;
    hasEndFrame?: boolean;
    imageCount?: number;
    videoCount?: number;
    audioCount?: number;
    task?: "reference" | "editing" | "extension";
  } = {},
): string {
  const imageCount = references.imageCount ?? 0;
  const videoCount = references.videoCount ?? 0;
  const audioCount = references.audioCount ?? 0;
  const hasFrames = Boolean(references.hasStartFrame || references.hasEndFrame);
  const hasLists = imageCount + videoCount + audioCount > 0;
  if (references.hasEndFrame && !references.hasStartFrame) {
    throw new FalHttpError("An end frame requires a start frame", null, false);
  }
  if (model === "seedance-2.5") {
    if (imageCount > 30 || videoCount > 10 || audioCount > 10 || imageCount + videoCount + audioCount + Number(references.hasStartFrame) + Number(references.hasEndFrame) > 50) {
      throw new FalHttpError("Seedance 2.5 accepts at most 30 image, 10 video, 10 audio, and 50 total references", null, false);
    }
    if (audioCount > 0 && imageCount + videoCount === 0) {
      throw new FalHttpError("Seedance audio references require at least one image or video reference", null, false);
    }
    if (references.task === "editing" || references.task === "extension") {
      if (videoCount !== 1 || hasFrames) {
        throw new FalHttpError("Seedance editing and extension require exactly one source video and cannot use start/end frames", null, false);
      }
    }
    if (references.task === "reference" && hasFrames) {
      throw new FalHttpError("Seedance reference tasks cannot be combined with start/end frame guidance", null, false);
    }
    if (hasFrames && hasLists) {
      throw new FalHttpError("Seedance 2.5 frame guidance and multimodal reference lists use different endpoints; choose one mode", null, false);
    }
    if (references.task === "reference" && !hasLists && !hasFrames) {
      return falModels[model];
    }
    if (references.task && !hasLists) {
      throw new FalHttpError("Seedance editing and extension require exactly one source video", null, false);
    }
    if (hasFrames) return falSeedanceImageModels[model];
    return hasLists ? falSeedanceReferenceModels[model] : falModels[model];
  }
  if (model === "seedance-2.0" || model === "seedance-2.0-mini" || model === "seedance-2.0-fast") {
    if (references.task && references.task !== "reference") {
      throw new FalHttpError("Seedance editing and extension tasks are available only on Seedance 2.5", null, false);
    }
    if (imageCount > 9 || videoCount > 3 || audioCount > 3) {
      throw new FalHttpError("Seedance 2.0 accepts at most 9 images, 3 videos, and 3 audio references", null, false);
    }
    if (audioCount > 0 && imageCount + videoCount === 0) {
      throw new FalHttpError("Seedance audio references require at least one image or video reference", null, false);
    }
    if (hasFrames && hasLists) {
      throw new FalHttpError("Seedance 2.0 start/end frames and image-reference lists use different endpoints; choose one mode", null, false);
    }
    if (hasFrames) return falSeedanceImageModels[model];
    return hasLists ? falSeedanceReferenceModels[model] : falModels[model];
  }
  if (hasFrames || hasLists || references.task) {
    throw new FalHttpError("Reference media and frame guidance are supported only by Seedance", null, false);
  }
  return falModels[model];
}

export type FalReferenceMediaStats = {
  images?: Array<{ sizeBytes: number }>;
  videos?: Array<{
    sizeBytes: number;
    durationSeconds: number;
    width?: number;
    height?: number;
    fps?: number;
  }>;
  audios?: Array<{ sizeBytes: number; durationSeconds: number }>;
};

const MiB = 1024 * 1024;

export function validateFalReferenceMediaLimits(model: FalModel, stats: FalReferenceMediaStats): void {
  const images = stats.images ?? [];
  const videos = stats.videos ?? [];
  const audios = stats.audios ?? [];
  const assertSize = (size: number, maximum: number, description: string) => {
    if (!Number.isSafeInteger(size) || size <= 0 || size > maximum) {
      throw new FalHttpError(`${description} exceeds the provider's supported file size`, null, false);
    }
  };
  const assertDuration = (duration: number, minimum: number, maximum: number, description: string) => {
    if (!Number.isFinite(duration) || duration < minimum || duration > maximum) {
      throw new FalHttpError(`${description} duration is outside the provider's supported range`, null, false);
    }
  };
  const assertVideoGeometry = (
    video: NonNullable<FalReferenceMediaStats["videos"]>[number],
    modelName: string,
    dimensions: { minimum: number; maximum: number; maximumPixels?: number },
  ) => {
    const { width, height, fps } = video;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width! < dimensions.minimum
      || height! < dimensions.minimum
      || width! > dimensions.maximum
      || height! > dimensions.maximum
      || (dimensions.maximumPixels !== undefined && width! * height! > dimensions.maximumPixels)
    ) {
      throw new FalHttpError(`${modelName} reference video dimensions are outside the provider's supported range`, null, false);
    }
    if (!Number.isFinite(fps) || fps! < 24 || fps! > 60) {
      throw new FalHttpError(`${modelName} reference video frame rate must be between 24 and 60 FPS`, null, false);
    }
  };
  for (const image of images) assertSize(image.sizeBytes, 30 * MiB, "Reference image");
  for (const audio of audios) assertSize(audio.sizeBytes, 15 * MiB, "Reference audio");

  if (model === "seedance-2.0" || model === "seedance-2.0-mini" || model === "seedance-2.0-fast") {
    const videoBytes = videos.reduce((total, video) => total + video.sizeBytes, 0);
    if (videoBytes >= 50 * MiB) throw new FalHttpError("Seedance 2.0 reference videos must total less than 50 MB", null, false);
    for (const video of videos) {
      if (!Number.isSafeInteger(video.sizeBytes) || video.sizeBytes <= 0) {
        throw new FalHttpError("Reference video size is invalid", null, false);
      }
    }
    if (videos.length) {
      for (const video of videos) {
        // Fal describes Seedance 2.0 references as approximately 480p
        // (640x640) through 720p (834x1112); enforce those bounds in either orientation.
        assertVideoGeometry(video, "Seedance 2.0", {
          minimum: 640,
          maximum: 1112,
          maximumPixels: 834 * 1112,
        });
        assertDuration(video.durationSeconds, 0.001, 15, "Seedance 2.0 reference video");
      }
      const duration = videos.reduce((total, video) => total + video.durationSeconds, 0);
      if (duration < 2 || duration > 15) {
        throw new FalHttpError("Seedance 2.0 reference videos must have a combined duration from 2 to 15 seconds", null, false);
      }
    }
    if (audios.length) {
      for (const audio of audios) assertDuration(audio.durationSeconds, 0.001, 15, "Seedance 2.0 reference audio");
      const duration = audios.reduce((total, audio) => total + audio.durationSeconds, 0);
      if (duration > 15) throw new FalHttpError("Seedance 2.0 reference audio must total no more than 15 seconds", null, false);
    }
    return;
  }

  if (model === "seedance-2.5") {
    for (const video of videos) {
      assertSize(video.sizeBytes, 200 * MiB, "Seedance 2.5 reference video");
      assertVideoGeometry(video, "Seedance 2.5", { minimum: 300, maximum: 6000 });
      const aspectRatio = video.width! / video.height!;
      if (aspectRatio < 0.4 || aspectRatio > 2.5) {
        throw new FalHttpError("Seedance 2.5 reference video aspect ratio must be between 0.4 and 2.5", null, false);
      }
      assertDuration(video.durationSeconds, 1.8, 30.2, "Seedance 2.5 reference video");
    }
    if (videos.reduce((total, video) => total + video.durationSeconds, 0) > 30.2) {
      throw new FalHttpError("Seedance 2.5 reference videos must total no more than 30.2 seconds", null, false);
    }
    for (const audio of audios) assertDuration(audio.durationSeconds, 1.8, 30.2, "Seedance 2.5 reference audio");
    if (audios.reduce((total, audio) => total + audio.durationSeconds, 0) > 30.2) {
      throw new FalHttpError("Seedance 2.5 reference audio must total no more than 30.2 seconds", null, false);
    }
  }
}

export function applyFalSeedanceTask(
  input: Record<string, unknown>,
  model: FalModel,
  endpoint: string,
  task?: "reference" | "editing" | "extension",
): void {
  if (model === "seedance-2.5" && endpoint === falSeedanceReferenceModels[model]) {
    input.task = task ?? "reference";
  }
}
export type FalQueueEndpoints = { statusUrl: string; responseUrl: string; cancelUrl: string };
export type FalQueueStatus = {
  status?: string;
  queue_position?: number;
  logs?: Array<{ message?: string }>;
  error?: unknown;
  [key: string]: unknown;
};

export class FalHttpError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "FalHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

function sanitizeCloudDetail(value: unknown): string {
  return String(value)
    .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run|media)[^\s"'<>]*/gi, "Cloud")
    .replace(/\bfal(?:\.ai)?\b/gi, "Cloud");
}

function apiKey(): string {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new FalHttpError("FAL_KEY is not configured", null, false);
  return key;
}

export function validateFalQueueUrl(value: unknown, field = "queue URL"): string {
  if (typeof value !== "string") throw new FalHttpError(`Cloud did not return a valid ${field}`, null, false);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FalHttpError(`Cloud returned an invalid ${field}`, null, false);
  }
  if (url.protocol !== "https:" || url.hostname !== "queue.fal.run" || url.username || url.password) {
    throw new FalHttpError(`Cloud returned an untrusted ${field}`, null, false);
  }
  return url.toString();
}

async function falRequest(urlValue: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const url = validateFalQueueUrl(urlValue);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Key ${apiKey()}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new FalHttpError("Cloud network request failed", null, true);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new FalHttpError("Cloud response download failed", response.status, true);
  }
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = body && typeof body === "object"
      ? (body as { detail?: unknown; message?: unknown }).detail ?? (body as { message?: unknown }).message
      : undefined;
    throw new FalHttpError(
      `Cloud request failed (${response.status})${detail ? `: ${sanitizeCloudDetail(detail)}` : ""}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

export type AspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9";
function aspectRatio(width: number, height: number): AspectRatio {
  const ratio = width / height;
  const ratios: Record<AspectRatio, number> = { "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "3:4": 3 / 4, "9:16": 9 / 16, "21:9": 21 / 9 };
  return (Object.keys(ratios) as AspectRatio[]).reduce((best, next) =>
    Math.abs(Math.log(ratio / ratios[next])) < Math.abs(Math.log(ratio / ratios[best])) ? next : best, "16:9");
}

export function falVideoDimensions(aspect: AspectRatio, resolution: "480p" | "720p" | "1080p" | "4k") {
  const short = resolution === "480p" ? 480 : resolution === "1080p" ? 1080 : resolution === "4k" ? 2160 : 720;
  const [w, h] = aspect.split(":").map(Number);
  return w >= h
    ? { width: Math.round(short * w / h / 2) * 2, height: short }
    : { width: short, height: Math.round(short * h / w / 2) * 2 };
}

export type NormalizedFalRequest = {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frameCount: number;
  input: Record<string, unknown>;
};

export function normalizeFalRequest(
  model: FalModel,
  request: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    durationSeconds: number;
    fps: number;
    qualityPreset: string;
    aspectRatio?: AspectRatio;
    outputResolution?: "480p" | "720p" | "1080p" | "4k";
    seed?: number | null;
    nativeAudioEnabled?: boolean;
    dialogue?: string;
      startFrameUrl?: string;
      endFrameUrl?: string;
      seedanceTask?: "reference" | "editing" | "extension";
  },
): NormalizedFalRequest {
  const inferredAspect = aspectRatio(request.width, request.height);
  const aspect = model.startsWith("seedance")
    ? request.aspectRatio ?? inferredAspect
    : request.width / request.height > 1.2 ? "16:9"
      : request.width / request.height < 0.83 ? "9:16" : "1:1";
  const requestedRatio = request.width / request.height;
  const veoAspectIsSupported = Math.abs(requestedRatio - 16 / 9) / (16 / 9) <= 0.05
    || Math.abs(requestedRatio - 9 / 16) / (9 / 16) <= 0.05;
  if (model === "veo-3.1-fast" && !veoAspectIsSupported) {
    throw new FalHttpError("Veo 3.1 Fast supports only 16:9 or 9:16 output", null, false);
  }
  if (!model.startsWith("seedance") && (request.aspectRatio || request.outputResolution)) {
    throw new FalHttpError("Aspect ratio and output resolution selection are supported only by Seedance", null, false);
  }
  const common = { prompt: request.prompt, aspect_ratio: aspect };
  let durationSeconds: number;
  let resolution: "480p" | "720p" | "1080p" | "4k" = "720p";
  let input: Record<string, unknown>;
  if (model === "veo-3.1-fast") {
    durationSeconds = [4, 6, 8].reduce((best, value) => (
      Math.abs(value - request.durationSeconds) < Math.abs(best - request.durationSeconds) ? value : best
    ), 8);
    resolution = request.qualityPreset === "HIGH" ? "1080p" : "720p";
    input = {
      ...common,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(request.seed != null ? { seed: Math.floor(request.seed) } : {}),
      duration: `${durationSeconds}s`,
      resolution,
      generate_audio: false,
    };
  } else if (model === "kling-v3-standard") {
    durationSeconds = request.durationSeconds <= 5 ? 5 : 10;
    input = {
      ...common,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      duration: String(durationSeconds),
      generate_audio: false,
    };
  } else {
    const automaticEditDuration = model === "seedance-2.5" && request.seedanceTask === "editing";
    durationSeconds = automaticEditDuration
      ? 30
      : model === "seedance-2.5"
      ? Math.max(4, Math.min(30, Math.round(request.durationSeconds)))
      : Math.max(4, Math.min(15, Math.round(request.durationSeconds)));
    resolution = request.outputResolution ?? (model === "seedance-2.0-mini" || model === "seedance-2.0-fast"
      ? request.qualityPreset === "DRAFT" ? "480p" : "720p"
      : request.qualityPreset === "DRAFT" ? "480p" : request.qualityPreset === "HIGH" ? "1080p" : "720p");
    if (resolution === "4k" && model !== "seedance-2.0") {
      throw new FalHttpError("4k output is supported only by Seedance 2.0 standard", null, false);
    }
    if (resolution === "1080p" && (model === "seedance-2.0-mini" || model === "seedance-2.0-fast")) {
      throw new FalHttpError("This Seedance tier supports 480p and 720p only", null, false);
    }
    if (model === "seedance-2.5" && ["editing", "extension"].includes(request.seedanceTask ?? "") && request.aspectRatio) {
      throw new FalHttpError("Seedance editing and extension choose the source video's aspect ratio automatically", null, false);
    }
    input = {
      ...common,
      ...(model === "seedance-2.5" && ["editing", "extension"].includes(request.seedanceTask ?? "") ? { aspect_ratio: "auto" } : {}),
      duration: automaticEditDuration ? "auto" : String(durationSeconds),
      resolution,
      generate_audio: request.nativeAudioEnabled ?? Boolean(request.dialogue?.trim()),
    };
    if (request.startFrameUrl || request.endFrameUrl) {
      if (!model.startsWith("seedance")) {
        throw new FalHttpError("Start and end frames are supported only by Seedance image-to-video endpoints", null, false);
      }
      if (!request.startFrameUrl) {
        throw new FalHttpError("An end frame requires a start frame", null, false);
      }
      input.image_url = request.startFrameUrl;
      if (request.endFrameUrl) input.end_image_url = request.endFrameUrl;
    }
  }
  const effective = falVideoDimensions(aspect, resolution);
  const fps = 24;
  return {
    ...effective,
    fps,
    durationSeconds,
    frameCount: Math.round(durationSeconds * fps),
    input,
  };
}

export class FalQueueClient {
  readonly model: FalModel;

  constructor(model: FalModel) {
    this.model = model;
  }

  async submit(input: Record<string, unknown>, endpoint: string = falModels[this.model]): Promise<{
    requestId: string;
    endpoints: FalQueueEndpoints;
    metadata: Record<string, unknown>;
  }> {
    if (!falEndpointsByModel[this.model].includes(endpoint)) {
      throw new FalHttpError("Unsupported Cloud model endpoint", null, false);
    }
    const body = await falRequest(`https://queue.fal.run/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (typeof body.request_id !== "string" || !body.request_id) {
      throw new FalHttpError("Cloud did not return a request ID", null, false);
    }
    const endpoints = {
      statusUrl: validateFalQueueUrl(body.status_url, "status URL"),
      responseUrl: validateFalQueueUrl(body.response_url, "response URL"),
      cancelUrl: validateFalQueueUrl(body.cancel_url, "cancel URL"),
    };
    return { requestId: body.request_id, endpoints, metadata: body };
  }

  async status(endpoints: FalQueueEndpoints): Promise<FalQueueStatus> {
    return falRequest(endpoints.statusUrl) as Promise<FalQueueStatus>;
  }

  async result(endpoints: FalQueueEndpoints): Promise<Record<string, unknown>> {
    return falRequest(endpoints.responseUrl);
  }

  async cancel(endpoints: FalQueueEndpoints): Promise<void> {
    await falRequest(endpoints.cancelUrl, { method: "PUT", body: "{}" });
  }
}

function findVideoUrl(value: unknown, key = ""): string | null {
  if (typeof value === "string" && /^https:\/\//.test(value) && (
    /\.(mp4|webm)(?:\?|$)/i.test(value) || /video|url/i.test(key)
  )) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item, key);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const found = findVideoUrl(child, childKey);
      if (found) return found;
    }
  }
  return null;
}

export function getFalVideoUrl(result: Record<string, unknown>): string {
  const url = findVideoUrl(result);
  if (!url) throw new FalHttpError("Cloud completed without a video output", null, false);
  return url;
}
