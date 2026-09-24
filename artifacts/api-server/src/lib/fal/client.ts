export const falModels = {
  "veo-3.1-fast": "fal-ai/veo3.1/fast",
  "kling-v3-standard": "fal-ai/kling-video/v3/standard/text-to-video",
  "seedance-2.0-mini": "bytedance/seedance-2.0/enterprise/mini/text-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/enterprise/v2/text-to-video",
} as const;

export type FalModel = keyof typeof falModels;
export const falSeedanceReferenceModels = {
  "seedance-2.0-mini": "bytedance/seedance-2.0/enterprise/mini/reference-to-video",
  "seedance-2.0": "bytedance/seedance-2.0/enterprise/v2/reference-to-video",
} as const;

export function falModelFromEndpoint(endpoint: string): FalModel | undefined {
  return ([...Object.entries(falModels), ...Object.entries(falSeedanceReferenceModels)]
    .find(([, value]) => value === endpoint)?.[0]) as FalModel | undefined;
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
    .replace(/(?:https?:\/\/)?(?:[\w-]+\.)*fal\.(?:ai|run)[^\s"'<>]*/gi, "Cloud")
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

type AspectRatio = "16:9" | "9:16" | "1:1";
function aspectRatio(width: number, height: number): AspectRatio {
  const ratio = width / height;
  if (ratio > 1.2) return "16:9";
  if (ratio < 0.83) return "9:16";
  return "1:1";
}

function dimensions(aspect: AspectRatio, resolution: "480p" | "720p" | "1080p") {
  const short = resolution === "480p" ? 480 : resolution === "1080p" ? 1080 : 720;
  if (aspect === "1:1") return { width: short, height: short };
  const long = Math.round(short * 16 / 9 / 2) * 2;
  return aspect === "16:9" ? { width: long, height: short } : { width: short, height: long };
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
    seed?: number | null;
    nativeAudioEnabled?: boolean;
    dialogue?: string;
  },
): NormalizedFalRequest {
  const aspect = aspectRatio(request.width, request.height);
  const requestedRatio = request.width / request.height;
  const veoAspectIsSupported = Math.abs(requestedRatio - 16 / 9) / (16 / 9) <= 0.05
    || Math.abs(requestedRatio - 9 / 16) / (9 / 16) <= 0.05;
  if (model === "veo-3.1-fast" && !veoAspectIsSupported) {
    throw new FalHttpError("Veo 3.1 Fast supports only 16:9 or 9:16 output", null, false);
  }
  const common = { prompt: request.prompt, aspect_ratio: aspect };
  let durationSeconds: number;
  let resolution: "480p" | "720p" | "1080p" = "720p";
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
    durationSeconds = Math.max(4, Math.min(15, Math.round(request.durationSeconds)));
    resolution = model === "seedance-2.0-mini"
      ? request.qualityPreset === "DRAFT" ? "480p" : "720p"
      : request.qualityPreset === "DRAFT" ? "480p" : request.qualityPreset === "HIGH" ? "1080p" : "720p";
    input = {
      ...common,
      duration: String(durationSeconds),
      resolution,
      generate_audio: request.nativeAudioEnabled ?? Boolean(request.dialogue?.trim()),
    };
  }
  const effective = dimensions(aspect, resolution);
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
    if (endpoint !== falModels[this.model] && endpoint !== falSeedanceReferenceModels[this.model as keyof typeof falSeedanceReferenceModels]) {
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
