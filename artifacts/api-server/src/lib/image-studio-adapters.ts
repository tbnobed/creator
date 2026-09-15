import { randomUUID } from "node:crypto";
import type { ComfyServer } from "@workspace/db";
import {
  assertTrustedComfyUrl,
  ComfyUIClient,
  ComfyUIRequestError,
  isTransientComfyUIRequestError,
} from "./comfy/client";
import { createFlux2KleinWorkflow } from "./seed-data/flux2-klein";
import {
  getImageModel,
  type ImageModel,
  type ImageOperation,
} from "./image-studio-models";

// Stable backend/jobs contract: do not change these exports without coordinating with the routes owner.
export type ImageTaskInput = {
  modelId: string;
  operation: ImageOperation;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed?: number;
  count: number;
  denoiseStrength?: number;
  referenceImages: Array<{ bytes: Buffer; mimeType: string }>;
  /**
   * Reference conditioning is deliberately opt-in. Ordinary Image Studio
   * edits continue to use the model's latent img2img path; character jobs
   * snapshot this mode before they enter the durable queue.
   */
  referenceMode?: "latent-img2img" | "native-reference-edit";
  /**
   * Native FLUX.2 Klein reference editing snapshots the resize capability
   * selected during worker preparation. It is not a user-facing setting.
   */
  nativeReferenceResizeMode?: "total-pixels" | "fixed-width";
  mask?: { bytes: Buffer; mimeType: string };
  server?: ComfyServer;
  clientId: string;
  /**
   * Called after local preparation (capability checks, validation, and
   * reference upload) and immediately before the /prompt request. Durable
   * callers use this boundary to record that an actual provider submission
   * may now be in flight.
   */
  beforeProviderSubmit?: () => Promise<void>;
};

export type ImageTask = {
  provider: "LOCAL" | "CLOUD";
  requestId: string;
  metadata: Record<string, unknown>;
  server?: ComfyServer;
};

export type ImageTaskResult = {
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  images?: Array<{ bytes: Buffer; mimeType: string; name: string }>;
};

export class ImageTaskError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    retryable: boolean,
    options?: ErrorOptions & { status?: number },
  ) {
    super(message, options);
    this.name = "ImageTaskError";
    this.retryable = retryable;
    this.status = options?.status;
  }
}

type ApiWorkflow = Record<string, {
  class_type: string;
  inputs: Record<string, unknown>;
}>;

type CloudEndpoints = {
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
};

type OutputDescriptor = {
  filename: string;
  subfolder: string;
  type: string;
};

type LocalRequirement = {
  nodeClasses: string[];
  files: Array<{ nodeClass: "UNETLoader" | "CLIPLoader" | "VAELoader"; name: string }>;
};

export type NativeReferenceResizeMode = "total-pixels" | "fixed-width";

export type LocalImageCapability = {
  nativeReferenceResizeMode?: NativeReferenceResizeMode;
};

const MAX_PROMPT_LENGTH = 50_000;
const MAX_INPUT_FILE_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_INFO_BYTES = 24 * 1024 * 1024;
const CLOUD_REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_TASK_VISIBILITY_GRACE_MS = 20_000;
const ALLOWED_INPUT_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const DEFAULT_DENOISE_STRENGTH = 0.65;
const MIN_DENOISE_STRENGTH = 0.05;
const MAX_DENOISE_STRENGTH = 1;

const localRequirements: Record<string, LocalRequirement> = {
  "local-flux2-klein-4b": {
    nodeClasses: [
      "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
      "EmptyFlux2LatentImage", "Flux2Scheduler", "KSamplerSelect", "CFGGuider", "RandomNoise",
      "SamplerCustomAdvanced", "LoadImage", "ImageScale", "VAEEncode", "RepeatLatentBatch",
      "SplitSigmas", "VAEDecode", "SaveImage",
    ],
    files: [
      { nodeClass: "UNETLoader", name: "flux-2-klein-4b.safetensors" },
      { nodeClass: "CLIPLoader", name: "qwen_3_4b.safetensors" },
      { nodeClass: "VAELoader", name: "flux2-vae.safetensors" },
    ],
  },
  "local-qwen-image-2512": {
    nodeClasses: [
      "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ModelSamplingAuraFlow",
      "EmptySD3LatentImage", "KSampler", "LoadImage", "ImageScale", "VAEEncode", "RepeatLatentBatch",
      "VAEDecode", "SaveImage",
    ],
    files: [
      { nodeClass: "UNETLoader", name: "qwen_image_2512_fp8_e4m3fn.safetensors" },
      { nodeClass: "CLIPLoader", name: "qwen_2.5_vl_7b_fp8_scaled.safetensors" },
      { nodeClass: "VAELoader", name: "qwen_image_vae.safetensors" },
    ],
  },
  "local-z-image-turbo": {
    nodeClasses: [
      "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
      "ModelSamplingAuraFlow", "EmptySD3LatentImage", "KSampler", "LoadImage", "ImageScale",
      "VAEEncode", "RepeatLatentBatch", "VAEDecode", "SaveImage",
    ],
    files: [
      { nodeClass: "UNETLoader", name: "z_image_turbo_bf16.safetensors" },
      { nodeClass: "CLIPLoader", name: "qwen_3_4b.safetensors" },
      { nodeClass: "VAELoader", name: "ae.safetensors" },
    ],
  },
};

// This is intentionally separate from the legacy FLUX.2 img2img requirement.
// Native reference editing does not use RepeatLatentBatch or SplitSigmas, and
// accepting either of those as a proxy for ReferenceLatent would silently
// change the character-generation mode.
const nativeReferenceRequirements: LocalRequirement = {
  nodeClasses: [
    "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
    "EmptyFlux2LatentImage", "Flux2Scheduler", "KSamplerSelect", "CFGGuider", "RandomNoise",
    "SamplerCustomAdvanced", "LoadImage",
    "VAEEncode", "ReferenceLatent", "VAEDecode", "SaveImage",
  ],
  files: [
    { nodeClass: "UNETLoader", name: "flux-2-klein-4b.safetensors" },
    { nodeClass: "CLIPLoader", name: "qwen_3_4b.safetensors" },
    { nodeClass: "VAELoader", name: "flux2-vae.safetensors" },
  ],
};

const cloudEndpointByOperation: Record<string, Partial<Record<ImageOperation, string>>> = {
  "cloud-nano-banana-2": {
    generate: "fal-ai/nano-banana-2",
    edit: "fal-ai/nano-banana-2/edit",
  },
  "cloud-nano-banana-pro": {
    generate: "fal-ai/nano-banana-pro",
    edit: "fal-ai/nano-banana-pro/edit",
  },
  "cloud-gpt-image-2": {
    generate: "openai/gpt-image-2",
    edit: "openai/gpt-image-2/edit",
    inpaint: "openai/gpt-image-2/edit",
  },
  "cloud-flux2-pro": { generate: "fal-ai/flux-2-pro" },
  "cloud-seedream-5-lite": {
    generate: "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  },
  "cloud-ideogram-v3": { generate: "fal-ai/ideogram/v3" },
  "cloud-recraft-v3-raster": { generate: "fal-ai/recraft/v3/text-to-image" },
  "cloud-qwen-inpaint": {
    inpaint: "fal-ai/qwen-image-edit/inpaint",
    outpaint: "fal-ai/qwen-image-edit/inpaint",
  },
  "cloud-esrgan-upscale": { upscale: "fal-ai/esrgan" },
  "cloud-remove-background": { "remove-background": "fal-ai/imageutils/rembg" },
};

function cloudApiKey(): string {
  const key = process.env.FAL_KEY?.trim();
  if (!key) throw new ImageTaskError("Cloud image generation is not configured.", false);
  return key;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function hasTransientSystemCause(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  if (typeof candidate.code === "string" && [
    "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH",
    "EPIPE", "ETIMEDOUT",
  ].includes(candidate.code)) return true;
  return candidate.cause !== undefined && candidate.cause !== error
    ? hasTransientSystemCause(candidate.cause)
    : false;
}

function fromComfyError(error: unknown, fallback: string): ImageTaskError {
  if (error instanceof ImageTaskError) return error;
  if (error instanceof ComfyUIRequestError) {
    return new ImageTaskError(
      error.message,
      isTransientComfyUIRequestError(error) || hasTransientSystemCause(error),
      { cause: error, ...(error.status === undefined ? {} : { status: error.status }) },
    );
  }
  return new ImageTaskError(fallback, hasTransientSystemCause(error), { cause: error });
}

function validateDimensions(
  width: number,
  height: number,
  provider: "LOCAL" | "CLOUD",
  operation: ImageOperation,
): void {
  if (operation === "upscale" || operation === "remove-background") {
    if (
      !Number.isInteger(width)
      || !Number.isInteger(height)
      || width < 1
      || height < 1
      || width > 32768
      || height > 32768
    ) {
      throw new Error("Tool width and height must be positive whole pixel dimensions.");
    }
    return;
  }
  const max = provider === "LOCAL" ? 2048 : 4096;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || height < 256) {
    throw new Error("Image width and height must be whole numbers of at least 256 pixels.");
  }
  if (width > max || height > max) {
    throw new Error(`${provider === "LOCAL" ? "Local" : "Cloud"} images are limited to ${max} pixels per side.`);
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("Image width and height must both be divisible by 16.");
  }
}

function validateRasterFile(file: { bytes: Buffer; mimeType: string }, label: string): void {
  if (!ALLOWED_INPUT_MIME_TYPES.has(file.mimeType)) {
    throw new Error(`${label} must be a PNG, JPEG, or WebP raster image.`);
  }
  if (file.bytes.length === 0 || file.bytes.length > MAX_INPUT_FILE_BYTES) {
    throw new Error(`${label} must be between 1 byte and 12 MB.`);
  }
  if (!rasterDimensions(file)) {
    throw new Error(`${label} content does not match a supported raster image.`);
  }
}

function validateInput(input: ImageTaskInput, model: ImageModel): void {
  if (!model.operations.includes(input.operation)) {
    throw new Error(`${model.name} does not support ${input.operation}.`);
  }
  validateDimensions(input.width, input.height, model.provider, input.operation);
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > model.maxImages) {
    throw new Error(`${model.name} supports between 1 and ${model.maxImages} output images.`);
  }
  if (input.referenceImages.length > model.maxReferences) {
    throw new Error(`${model.name} accepts at most ${model.maxReferences} reference images.`);
  }
  if (
    input.referenceMode === "native-reference-edit"
    && (
      model.id !== "local-flux2-klein-4b"
      || model.provider !== "LOCAL"
      || input.operation !== "edit"
      || input.referenceImages.length !== 1
    )
  ) {
    throw new Error("Native FLUX.2 Klein reference editing requires exactly one local source image.");
  }
  const prompt = input.prompt.trim();
  const promptIsOptional = input.operation === "upscale" || input.operation === "remove-background";
  if (!promptIsOptional && !prompt) throw new Error("Enter an image prompt.");
  if (input.prompt.length > MAX_PROMPT_LENGTH || (input.negativePrompt?.length ?? 0) > MAX_PROMPT_LENGTH) {
    throw new Error("Image prompts are limited to 50,000 characters.");
  }
  if (input.seed !== undefined && (!model.supportsSeed || !Number.isSafeInteger(input.seed) || input.seed < 0)) {
    throw new Error(`${model.name} does not accept this seed.`);
  }
  if (input.denoiseStrength !== undefined) {
    if (
      model.provider !== "LOCAL"
      || !Number.isFinite(input.denoiseStrength)
      || input.denoiseStrength < MIN_DENOISE_STRENGTH
      || input.denoiseStrength > MAX_DENOISE_STRENGTH
    ) {
      throw new Error(
        model.provider === "LOCAL"
          ? "Denoise strength must be a number from 0.05 to 1."
          : "Denoise strength is only supported for local image models.",
      );
    }
    if (input.referenceImages.length === 0) {
      throw new Error("Denoise strength requires a reference image.");
    }
  }
  if (input.negativePrompt?.trim() && !model.supportsNegativePrompt) {
    throw new Error(`${model.name} does not support a negative prompt.`);
  }
  for (const [index, reference] of input.referenceImages.entries()) {
    validateRasterFile(reference, `Reference image ${index + 1}`);
  }
  if (input.mask) validateRasterFile(input.mask, "Mask");
  const totalBytes = [...input.referenceImages, ...(input.mask ? [input.mask] : [])]
    .reduce((total, file) => total + file.bytes.length, 0);
  if (totalBytes > MAX_INPUT_TOTAL_BYTES) throw new Error("Image inputs are limited to 32 MB in total.");
  if (model.id === "cloud-ideogram-v3") {
    const styleReferenceBytes = input.referenceImages.reduce((total, file) => total + file.bytes.length, 0);
    if (styleReferenceBytes > 10 * 1024 * 1024) {
      throw new Error("Ideogram style references are limited to 10 MB in total.");
    }
  }

  const sourceRequired = ["edit", "inpaint", "outpaint", "upscale", "remove-background"]
    .includes(input.operation);
  if (sourceRequired && input.referenceImages.length === 0) {
    throw new Error(`${input.operation} requires a source image.`);
  }
  if ((input.operation === "inpaint" || input.operation === "outpaint") && !input.mask) {
    throw new Error(`${input.operation} requires a mask and a source image.`);
  }
  if ((input.operation === "inpaint" || input.operation === "outpaint") && input.mask) {
    const sourceSize = rasterDimensions(input.referenceImages[0]);
    const maskSize = rasterDimensions(input.mask);
    if (!sourceSize || !maskSize || sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height) {
      throw new Error("The mask and source image must have identical pixel dimensions.");
    }
  }
  if (input.operation === "edit" && input.mask) {
    throw new Error("Choose inpaint when supplying a mask.");
  }
  if (!model.operations.includes("inpaint") && input.mask) {
    throw new Error(`${model.name} does not support mask-guided editing.`);
  }
  if (model.provider === "LOCAL" && input.mask) {
    throw new Error(`${model.name} does not support mask-guided local editing.`);
  }
}

async function readBounded(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ImageTaskError(`${label} exceeds the download limit.`, false);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ImageTaskError(`${label} exceeds the download limit.`, false);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ImageTaskError) throw error;
    throw new ImageTaskError(`${label} download was interrupted.`, true, { cause: error });
  }
  return Buffer.concat(chunks, total);
}

async function fetchObjectInfo(
  server: ComfyServer,
  requiredNodeClasses: string[],
): Promise<Record<string, unknown>> {
  let baseUrl: URL;
  try {
    baseUrl = await assertTrustedComfyUrl(server.apiBaseUrl);
  } catch (error) {
    throw new ImageTaskError(
      "Local worker connection is not trusted.",
      hasTransientSystemCause(error),
      { cause: error },
    );
  }
  const entries = await Promise.all(requiredNodeClasses.map(async (nodeClass) => {
    const target = new URL(`/object_info/${encodeURIComponent(nodeClass)}`, baseUrl);
    let response: Response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new ImageTaskError(
        `Could not inspect local worker ${server.displayName}.`,
        true,
        { cause: error },
      );
    }
    // ComfyUI returns 404 for a missing node on this targeted endpoint. Keep
    // that node absent so the model check fails closed with the stable
    // "required components unavailable" error instead of treating a missing
    // optional capability as a worker transport failure.
    if (response.status === 404) return [nodeClass, undefined] as const;
    if (!response.ok) {
      throw new ImageTaskError(
        `Local worker capability check returned HTTP ${response.status}.`,
        isRetryableStatus(response.status),
        { status: response.status },
      );
    }
    const bytes = await readBounded(response, MAX_OBJECT_INFO_BYTES, "Local worker capability data");
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const record = parsed as Record<string, unknown>;
      return [nodeClass, record[nodeClass]] as const;
    } catch (error) {
      throw new ImageTaskError("Local worker returned invalid capability data.", false, { cause: error });
    }
  }));
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((child) => containsExactString(child, expected));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((child) => containsExactString(child, expected));
  }
  return false;
}

function nodeInputSchemaInSection(
  nodeInfo: unknown,
  section: "required" | "optional",
  name: string,
): unknown {
  if (!nodeInfo || typeof nodeInfo !== "object" || Array.isArray(nodeInfo)) return undefined;
  const input = (nodeInfo as Record<string, unknown>).input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = (input as Record<string, unknown>)[section];
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return undefined;
  return (entries as Record<string, unknown>)[name];
}

function nodeInputSchema(
  nodeInfo: unknown,
  name: string,
): unknown {
  return nodeInputSchemaInSection(nodeInfo, "required", name)
    ?? nodeInputSchemaInSection(nodeInfo, "optional", name);
}

function hasNodeInputSchema(nodeInfo: unknown, name: string): boolean {
  return nodeInputSchema(nodeInfo, name) !== undefined;
}

function nodeInputTypeIs(nodeInfo: unknown, name: string, expected: string): boolean {
  const schema = nodeInputSchema(nodeInfo, name);
  return Array.isArray(schema) && schema[0] === expected;
}

function nodeComboSchemaIsValid(nodeInfo: unknown, name: string): boolean {
  const schema = nodeInputSchema(nodeInfo, name);
  if (!Array.isArray(schema)) return false;
  if (schema[0] === "COMBO") {
    const options = schema[1];
    const optionValues = options
      && typeof options === "object"
      && !Array.isArray(options)
      ? (options as Record<string, unknown>).options
      : undefined;
    return Boolean(
      Array.isArray(optionValues) && optionValues.length > 0,
    );
  }
  return Array.isArray(schema[0])
    && schema[0].length > 0
    && schema[0].every((option: unknown) => typeof option === "string");
}

function nativeReferenceSchemaIsValid(nodeInfo: unknown): boolean {
  const conditioning = nodeInputSchemaInSection(nodeInfo, "required", "conditioning");
  const latent = nodeInputSchema(nodeInfo, "latent");
  return (
    Array.isArray(conditioning)
    && conditioning[0] === "CONDITIONING"
    && Array.isArray(latent)
    && latent[0] === "LATENT"
  );
}

function integerSchemaAllowsZero(schema: unknown): boolean {
  if (!Array.isArray(schema) || schema[0] !== "INT") return false;
  const options = schema[1];
  const minimum = options && typeof options === "object" && !Array.isArray(options)
    ? (options as Record<string, unknown>).min
    : undefined;
  return Boolean(
    typeof minimum === "number" && minimum <= 0,
  );
}

function nativeReferenceResizeMode(
  objectInfo: Record<string, unknown>,
): NativeReferenceResizeMode | null {
  const totalPixels = objectInfo.ImageScaleToTotalPixels;
  if (
    totalPixels
    && nodeInputTypeIs(totalPixels, "image", "IMAGE")
    && nodeComboSchemaIsValid(totalPixels, "upscale_method")
    && nodeInputTypeIs(totalPixels, "megapixels", "FLOAT")
    && nodeInputTypeIs(totalPixels, "resolution_steps", "INT")
  ) {
    return "total-pixels";
  }

  const imageScale = objectInfo.ImageScale;
  if (
    imageScale
    && nodeInputTypeIs(imageScale, "image", "IMAGE")
    && nodeComboSchemaIsValid(imageScale, "upscale_method")
    && nodeInputTypeIs(imageScale, "width", "INT")
    && integerSchemaAllowsZero(nodeInputSchema(imageScale, "height"))
    && hasNodeInputSchema(imageScale, "crop")
  ) {
    return "fixed-width";
  }
  return null;
}

async function inspectLocalImageModel(
  modelId: string,
  server: ComfyServer,
  options: { referenceMode?: ImageTaskInput["referenceMode"] } = {},
): Promise<LocalImageCapability | null> {
  const model = getImageModel(modelId);
  const nativeReference = options.referenceMode === "native-reference-edit";
  const requirements = nativeReference && modelId === "local-flux2-klein-4b"
    ? nativeReferenceRequirements
    : localRequirements[modelId];
  if (!model || model.provider !== "LOCAL" || !requirements || !model.requiredTag) return null;
  const hasTag = server.tags.some((tag) => tag.trim().toLowerCase() === model.requiredTag?.toLowerCase());
  if (!hasTag) return null;
  if (!server.enabled || server.status !== "ONLINE") {
    throw new ImageTaskError(
      `Local worker ${server.displayName} is currently unavailable.`,
      true,
    );
  }
  const capabilityNodeClasses = nativeReference
    ? [...requirements.nodeClasses, "ImageScaleToTotalPixels", "ImageScale"]
    : requirements.nodeClasses;
  const objectInfo = await fetchObjectInfo(server, capabilityNodeClasses);
  if (!requirements.nodeClasses.every((nodeClass) => nodeClass in objectInfo)) return null;
  if (!requirements.files.every(({ nodeClass, name }) => containsExactString(objectInfo[nodeClass], name))) {
    return null;
  }
  if (!nativeReference) return {};
  if (!nativeReferenceSchemaIsValid(objectInfo.ReferenceLatent)) return null;
  const resizeMode = nativeReferenceResizeMode(objectInfo);
  return resizeMode ? { nativeReferenceResizeMode: resizeMode } : null;
}

export async function inspectLocalImageCapability(
  modelId: string,
  server: ComfyServer,
  options: { referenceMode?: ImageTaskInput["referenceMode"] } = {},
): Promise<LocalImageCapability | null> {
  return inspectLocalImageModel(modelId, server, options);
}

export async function checkLocalImageModel(
  modelId: string,
  server: ComfyServer,
  options: { referenceMode?: ImageTaskInput["referenceMode"] } = {},
): Promise<boolean> {
  return Boolean(await inspectLocalImageModel(modelId, server, options));
}

function localInstallHint(modelId: string): string {
  const requirements = localRequirements[modelId];
  if (!requirements) return "";
  return requirements.files.map(({ name }) => name).join(", ");
}

function effectiveDenoiseStrength(input: ImageTaskInput): number | undefined {
  if (input.referenceImages.length === 0 || input.referenceMode === "native-reference-edit") return undefined;
  return input.denoiseStrength ?? DEFAULT_DENOISE_STRENGTH;
}

function createFlux2KleinNativeReferenceWorkflow(
  input: ImageTaskInput,
  seed: number,
  referenceImageName: string,
  resizeMode: NativeReferenceResizeMode,
): ApiWorkflow {
  // This graph is the flattened API equivalent of Comfy's official
  // image_flux2_klein_image_edit_4b_distilled template. ReferenceLatent is
  // conditioning, not the sampler's latent_image. The sampler always starts
  // from a fresh target-sized EmptyFlux2LatentImage and the complete
  // four-transition Flux2Scheduler.
  const workflow: ApiWorkflow = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "flux-2-klein-4b.safetensors",
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_3_4b.safetensors",
        type: "flux2",
        device: "default",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: { vae_name: "flux2-vae.safetensors" },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: input.prompt.trim(), clip: ["2", 0] },
    },
    "5": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["4", 0] },
    },
    "6": {
      class_type: "EmptyFlux2LatentImage",
      inputs: {
        width: input.width,
        height: input.height,
        batch_size: input.count,
      },
    },
    "7": {
      class_type: "Flux2Scheduler",
      inputs: {
        steps: 4,
        width: input.width,
        height: input.height,
      },
    },
    "8": {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: "euler" },
    },
    "9": {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed },
    },
    "10": {
      class_type: "VAEEncode",
      inputs: {
        pixels: ["15", 0],
        vae: ["3", 0],
      },
    },
    // The official graph applies ReferenceLatent to both positive and
    // zeroed-negative conditioning before CFGGuider.
    "11": {
      class_type: "ReferenceLatent",
      inputs: {
        conditioning: ["4", 0],
        latent: ["10", 0],
      },
    },
    "12": {
      class_type: "ReferenceLatent",
      inputs: {
        conditioning: ["5", 0],
        latent: ["10", 0],
      },
    },
    "13": {
      class_type: "CFGGuider",
      inputs: {
        model: ["1", 0],
        positive: ["11", 0],
        negative: ["12", 0],
        cfg: 1,
      },
    },
    "14": {
      class_type: "LoadImage",
      inputs: { image: referenceImageName },
    },
    "15": resizeMode === "total-pixels"
      ? {
        class_type: "ImageScaleToTotalPixels",
        inputs: {
          image: ["14", 0],
          upscale_method: "nearest-exact",
          megapixels: 1,
          resolution_steps: 1,
        },
      }
      : {
        class_type: "ImageScale",
        inputs: {
          image: ["14", 0],
          upscale_method: "nearest-exact",
          width: 1024,
          height: 0,
          crop: "disabled",
        },
      },
    "16": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["9", 0],
        guider: ["13", 0],
        sampler: ["8", 0],
        sigmas: ["7", 0],
        latent_image: ["6", 0],
      },
    },
    "17": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["16", 0],
        vae: ["3", 0],
      },
    },
    "18": {
      class_type: "SaveImage",
      inputs: {
        images: ["17", 0],
        filename_prefix: "image-studio/flux2-klein-character-reference",
      },
    },
  };
  return workflow;
}

function createQwenImage2512Workflow(
  input: ImageTaskInput,
  seed: number,
  referenceImageName?: string,
): ApiWorkflow {
  const negative = input.negativePrompt?.trim() || "";
  const hasReference = referenceImageName !== undefined;
  const workflow: ApiWorkflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: input.prompt.trim(), clip: ["2", 0] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["2", 0] } },
    "7": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: input.count } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed, steps: 50, cfg: 4, sampler_name: "euler", scheduler: "simple",
        denoise: effectiveDenoiseStrength(input) ?? 1,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "image-studio/qwen-2512" } },
  };
  if (hasReference) {
    workflow["11"] = { class_type: "LoadImage", inputs: { image: referenceImageName } };
    workflow["12"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["11", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "center",
      },
    };
    workflow["13"] = { class_type: "VAEEncode", inputs: { pixels: ["12", 0], vae: ["3", 0] } };
    workflow["14"] = {
      class_type: "RepeatLatentBatch",
      inputs: { samples: ["13", 0], amount: input.count },
    };
    workflow["8"].inputs.latent_image = ["14", 0];
  }
  return workflow;
}

function createZImageTurboWorkflow(
  input: ImageTaskInput,
  seed: number,
  referenceImageName?: string,
): ApiWorkflow {
  const hasReference = referenceImageName !== undefined;
  const workflow: ApiWorkflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: input.prompt.trim(), clip: ["2", 0] } },
    "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    "7": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: input.count } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed, steps: 8, cfg: 1, sampler_name: "res_multistep", scheduler: "simple",
        denoise: effectiveDenoiseStrength(input) ?? 1,
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "image-studio/z-image-turbo" } },
  };
  if (hasReference) {
    workflow["11"] = { class_type: "LoadImage", inputs: { image: referenceImageName } };
    workflow["12"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["11", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "center",
      },
    };
    workflow["13"] = { class_type: "VAEEncode", inputs: { pixels: ["12", 0], vae: ["3", 0] } };
    workflow["14"] = {
      class_type: "RepeatLatentBatch",
      inputs: { samples: ["13", 0], amount: input.count },
    };
    workflow["8"].inputs.latent_image = ["14", 0];
  }
  return workflow;
}

function createLocalWorkflow(input: ImageTaskInput, seed: number, referenceImageName?: string): ApiWorkflow {
  if (input.modelId === "local-qwen-image-2512") {
    return createQwenImage2512Workflow(input, seed, referenceImageName);
  }
  if (input.modelId === "local-z-image-turbo") {
    return createZImageTurboWorkflow(input, seed, referenceImageName);
  }
  if (input.modelId === "local-flux2-klein-4b") {
    if (input.referenceMode === "native-reference-edit" && referenceImageName === undefined) {
      throw new ImageTaskError("Native FLUX.2 Klein reference editing requires a source image.", false);
    }
    if (
      input.referenceMode === "native-reference-edit"
      && referenceImageName !== undefined
      && input.nativeReferenceResizeMode !== undefined
    ) {
      return createFlux2KleinNativeReferenceWorkflow(
        input,
        seed,
        referenceImageName,
        input.nativeReferenceResizeMode,
      );
    }
    const workflow = createFlux2KleinWorkflow({
      kind: "setting",
      prompt: input.prompt.trim(),
      seed,
    });
    workflow["6"].inputs.width = input.width;
    workflow["6"].inputs.height = input.height;
    workflow["6"].inputs.batch_size = input.count;
    workflow["7"].inputs.width = input.width;
    workflow["7"].inputs.height = input.height;
    workflow["13"].inputs.filename_prefix = "image-studio/flux2-klein-4b";
    if (referenceImageName !== undefined) {
      workflow["14"] = { class_type: "LoadImage", inputs: { image: referenceImageName } };
      workflow["15"] = {
        class_type: "ImageScale",
        inputs: {
          image: ["14", 0],
          upscale_method: "lanczos",
          width: input.width,
          height: input.height,
          crop: "center",
        },
      };
      workflow["16"] = { class_type: "VAEEncode", inputs: { pixels: ["15", 0], vae: ["3", 0] } };
      const originalSteps = Number(workflow["7"].inputs.steps);
      const denoise = effectiveDenoiseStrength(input) ?? 1;
      const expandedSteps = Math.max(originalSteps, Math.floor(originalSteps / denoise));
      workflow["7"].inputs.steps = expandedSteps;
      workflow["17"] = {
        class_type: "SplitSigmas",
        inputs: { sigmas: ["7", 0], step: expandedSteps - originalSteps },
      };
      workflow["18"] = {
        class_type: "RepeatLatentBatch",
        inputs: { samples: ["16", 0], amount: input.count },
      };
      // Flux2Scheduler emits the dimension-shifted sigma schedule used by the
      // custom sampler. Expanding the schedule before splitting avoids
      // SplitSigmasDenoise rounding short schedules down to zero transitions.
      // SplitSigmas's second output starts at the denoise offset and keeps the
      // original number of sampling transitions.
      workflow["11"].inputs.sigmas = ["17", 1];
      workflow["11"].inputs.latent_image = ["18", 0];
    }
    return workflow;
  }
  throw new ImageTaskError("Unknown local image model.", false);
}

function referenceImageExtension(mimeType: string): "png" | "jpg" | "webp" {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

async function uploadLocalReference(
  server: ComfyServer,
  reference: { bytes: Buffer; mimeType: string },
): Promise<string> {
  try {
    const uploaded = await new ComfyUIClient(server).uploadImage({
      name: `image-studio-reference-${randomUUID()}.${referenceImageExtension(reference.mimeType)}`,
      mimeType: reference.mimeType,
      bytes: reference.bytes,
    });
    if (typeof uploaded.name !== "string" || !uploaded.name.trim()) {
      throw new ImageTaskError("Local worker did not return an uploaded image name.", false);
    }
    return uploaded.name;
  } catch (error) {
    throw fromComfyError(error, "Local worker reference image upload failed.");
  }
}

function asDataUri(file: { bytes: Buffer; mimeType: string }): string {
  return `data:${file.mimeType};base64,${file.bytes.toString("base64")}`;
}

const ratioValues: Record<string, number> = {
  "21:9": 21 / 9, "16:9": 16 / 9, "3:2": 3 / 2, "4:3": 4 / 3, "5:4": 5 / 4,
  "1:1": 1, "4:5": 4 / 5, "3:4": 3 / 4, "2:3": 2 / 3, "9:16": 9 / 16,
  "4:1": 4, "1:4": 1 / 4, "8:1": 8, "1:8": 1 / 8,
};

function closestAspectRatio(width: number, height: number, allowed: string[]): string {
  const target = width / height;
  const candidates = allowed.filter((ratio) => ratio in ratioValues);
  const closest = candidates.reduce((best, ratio) => (
    Math.abs(Math.log(target / ratioValues[ratio])) < Math.abs(Math.log(target / ratioValues[best]))
      ? ratio
      : best
  ), candidates[0] ?? "1:1");
  if (Math.abs(target - ratioValues[closest]) / ratioValues[closest] > 0.01) {
    throw new Error("Image dimensions must match one of the model's supported aspect ratios.");
  }
  return closest;
}

function googleResolution(modelId: string, width: number, height: number): "0.5K" | "1K" | "2K" | "4K" {
  const longest = Math.max(width, height);
  if (modelId === "cloud-nano-banana-2" && longest <= 768) return "0.5K";
  if (longest <= 1280) return "1K";
  if (longest <= 2560) return "2K";
  return "4K";
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += length + 2;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  }
  if (chunk === "VP8 " && bytes.length >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  return null;
}

function rasterDimensions(file: { bytes: Buffer; mimeType: string }): { width: number; height: number } | null {
  if (file.mimeType === "image/png") return readPngDimensions(file.bytes);
  if (file.mimeType === "image/jpeg") return readJpegDimensions(file.bytes);
  if (file.mimeType === "image/webp") return readWebpDimensions(file.bytes);
  return null;
}

function buildCloudInput(input: ImageTaskInput, model: ImageModel): Record<string, unknown> {
  const references = input.referenceImages.map(asDataUri);
  const maskUrl = input.mask ? asDataUri(input.mask) : undefined;
  const imageSize = { width: input.width, height: input.height };
  const commonSeed = input.seed === undefined ? {} : { seed: input.seed };
  if (input.modelId === "cloud-nano-banana-2" || input.modelId === "cloud-nano-banana-pro") {
    return {
      prompt: input.prompt.trim(),
      num_images: input.count,
      aspect_ratio: closestAspectRatio(input.width, input.height, model.aspectRatios),
      resolution: googleResolution(input.modelId, input.width, input.height),
      output_format: "png",
      ...commonSeed,
      ...(input.operation === "edit" ? { image_urls: references } : {}),
    };
  }
  if (input.modelId === "cloud-gpt-image-2") {
    return {
      prompt: input.prompt.trim(),
      num_images: input.count,
      image_size: imageSize,
      output_format: "png",
      quality: "high",
      ...(input.operation === "generate" ? {} : { image_urls: references }),
      ...(input.operation === "inpaint" ? { mask_url: maskUrl } : {}),
    };
  }
  if (input.modelId === "cloud-flux2-pro") {
    return { prompt: input.prompt.trim(), image_size: imageSize, output_format: "png", ...commonSeed };
  }
  if (input.modelId === "cloud-seedream-5-lite") {
    return { prompt: input.prompt.trim(), image_size: imageSize, num_images: input.count, max_images: 1 };
  }
  if (input.modelId === "cloud-ideogram-v3") {
    return {
      prompt: input.prompt.trim(),
      image_size: imageSize,
      num_images: input.count,
      rendering_speed: "BALANCED",
      style: "AUTO",
      ...(input.negativePrompt?.trim() ? { negative_prompt: input.negativePrompt.trim() } : {}),
      ...commonSeed,
      ...(references.length ? { image_urls: references } : {}),
    };
  }
  if (input.modelId === "cloud-recraft-v3-raster") {
    return { prompt: input.prompt.trim(), image_size: imageSize, style: "realistic_image" };
  }
  if (input.modelId === "cloud-qwen-inpaint") {
    return {
      prompt: input.prompt.trim(),
      image_url: references[0],
      mask_url: maskUrl,
      image_size: imageSize,
      num_images: input.count,
      output_format: "png",
      ...(input.negativePrompt?.trim() ? { negative_prompt: input.negativePrompt.trim() } : {}),
      ...commonSeed,
    };
  }
  if (input.modelId === "cloud-esrgan-upscale") {
    const source = input.referenceImages[0];
    const dimensions = rasterDimensions(source);
    if (!dimensions) throw new Error("Could not read the source image dimensions.");
    const widthScale = input.width / dimensions.width;
    const heightScale = input.height / dimensions.height;
    if (Math.abs(widthScale - heightScale) > 0.05) {
      throw new Error("Upscale output dimensions must preserve the source image aspect ratio.");
    }
    const scale = (widthScale + heightScale) / 2;
    if (scale < 1 || scale > 8) throw new Error("Upscale output must be between 1× and 8× the source size.");
    return { image_url: references[0], scale, output_format: "png" };
  }
  if (input.modelId === "cloud-remove-background") {
    const dimensions = rasterDimensions(input.referenceImages[0]);
    if (!dimensions || dimensions.width !== input.width || dimensions.height !== input.height) {
      throw new Error("Background removal preserves the source pixel dimensions.");
    }
    return { image_url: references[0], crop_to_bbox: false };
  }
  throw new ImageTaskError("Unknown Cloud image model.", false);
}

function validateCloudQueueUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new ImageTaskError(`Cloud did not return a valid ${label}.`, false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ImageTaskError(`Cloud returned an invalid ${label}.`, false, { cause: error });
  }
  if (url.protocol !== "https:" || url.hostname !== "queue.fal.run" || url.username || url.password) {
    throw new ImageTaskError(`Cloud returned an untrusted ${label}.`, false);
  }
  return value;
}

async function cloudJsonRequest(urlValue: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const url = validateCloudQueueUrl(urlValue, "queue URL");
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Key ${cloudApiKey()}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new ImageTaskError("Cloud image request could not reach the provider.", true, { cause: error });
  }
  if (!response.ok) {
    throw new ImageTaskError(
      `Cloud image request returned HTTP ${response.status}.`,
      isRetryableStatus(response.status),
      { status: response.status },
    );
  }
  const bytes = await readBounded(response, 2 * 1024 * 1024, "Cloud response");
  if (bytes.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ImageTaskError("Cloud returned an invalid response.", false, { cause: error });
  }
}

async function submitCloud(endpoint: string, input: Record<string, unknown>): Promise<{
  requestId: string;
  endpoints: CloudEndpoints;
}> {
  if (!/^[a-z0-9][a-z0-9./_-]+$/i.test(endpoint)) {
    throw new ImageTaskError("Cloud endpoint is invalid.", false);
  }
  const body = await cloudJsonRequest(`https://queue.fal.run/${endpoint}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (typeof body.request_id !== "string" || !body.request_id) {
    throw new ImageTaskError("Cloud did not return a request ID.", false);
  }
  return {
    requestId: body.request_id,
    endpoints: {
      statusUrl: validateCloudQueueUrl(body.status_url, "status URL"),
      responseUrl: validateCloudQueueUrl(body.response_url, "response URL"),
      cancelUrl: validateCloudQueueUrl(body.cancel_url, "cancel URL"),
    },
  };
}

function endpointsFromMetadata(metadata: Record<string, unknown>): CloudEndpoints {
  return {
    statusUrl: validateCloudQueueUrl(metadata.statusUrl, "status URL"),
    responseUrl: validateCloudQueueUrl(metadata.responseUrl, "response URL"),
    cancelUrl: validateCloudQueueUrl(metadata.cancelUrl, "cancel URL"),
  };
}

function outputUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ImageTaskError("Cloud completed without a valid raster output.", false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ImageTaskError("Cloud returned an invalid raster output URL.", false, { cause: error });
  }
  const falMedia = url.hostname === "fal.media" || url.hostname.endsWith(".fal.media");
  const googleMedia = url.hostname === "storage.googleapis.com" && url.pathname.startsWith("/falserverless/");
  if (url.protocol !== "https:" || url.username || url.password || (!falMedia && !googleMedia)) {
    throw new ImageTaskError("Cloud returned an untrusted raster output URL.", false);
  }
  return url.toString();
}

function outputItems(result: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(result.images)) {
    return result.images.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    ));
  }
  if (result.image && typeof result.image === "object" && !Array.isArray(result.image)) {
    return [result.image as Record<string, unknown>];
  }
  throw new ImageTaskError("Cloud completed without a raster output.", false);
}

function safeOutputName(value: unknown, index: number, mimeType: string): string {
  const supplied = typeof value === "string" ? value.split(/[\\/]/).pop() : undefined;
  if (supplied && /^[a-z0-9_. -]{1,180}$/i.test(supplied)) return supplied;
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
  return `cloud-image-${index + 1}.${extension}`;
}

function normalizeOutputMime(value: unknown, response: Response): "image/png" | "image/jpeg" | "image/webp" {
  const header = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const candidate = typeof value === "string" ? value.toLowerCase() : header;
  if (candidate === "image/jpeg" || candidate === "image/webp" || candidate === "image/png") return candidate;
  throw new ImageTaskError("Cloud returned a non-raster output.", false);
}

async function downloadCloudOutputs(result: Record<string, unknown>): Promise<ImageTaskResult["images"]> {
  const items = outputItems(result);
  return Promise.all(items.map(async (item, index) => {
    const url = outputUrl(item.url);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new ImageTaskError("Cloud raster output download failed.", true, { cause: error });
    }
    if (!response.ok) {
      throw new ImageTaskError(
        `Cloud raster output download returned HTTP ${response.status}.`,
        isRetryableStatus(response.status),
        { status: response.status },
      );
    }
    const mimeType = normalizeOutputMime(item.content_type, response);
    const bytes = await readBounded(response, MAX_OUTPUT_BYTES, "Cloud raster output");
    return { bytes, mimeType, name: safeOutputName(item.file_name, index, mimeType) };
  }));
}

function queueContains(queue: unknown[] | undefined, promptId: string): boolean {
  return Boolean(queue?.some((entry) => containsExactString(entry, promptId)));
}

function localHistoryEntry(history: Record<string, unknown>, promptId: string): Record<string, unknown> | null {
  const entry = history[promptId];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
}

function localHistoryError(entry: Record<string, unknown> | null): string | null {
  const status = entry?.status;
  if (!status || typeof status !== "object") return null;
  const record = status as Record<string, unknown>;
  return record.status_str === "error" ? "Local image generation failed on the selected worker." : null;
}

function localHistoryIsComplete(entry: Record<string, unknown> | null): boolean {
  const status = entry?.status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  const record = status as Record<string, unknown>;
  return record.completed === true || record.status_str === "success";
}

function localOutputDescriptors(entry: Record<string, unknown> | null): OutputDescriptor[] {
  if (!entry?.outputs || typeof entry.outputs !== "object" || Array.isArray(entry.outputs)) return [];
  const descriptors: OutputDescriptor[] = [];
  for (const output of Object.values(entry.outputs as Record<string, unknown>)) {
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    const images = (output as Record<string, unknown>).images;
    if (!Array.isArray(images)) continue;
    for (const item of images) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const file = item as Record<string, unknown>;
      if (typeof file.filename !== "string" || !/\.(png|jpe?g|webp)$/i.test(file.filename)) continue;
      descriptors.push({
        filename: file.filename,
        subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
        type: typeof file.type === "string" ? file.type : "output",
      });
    }
  }
  return descriptors;
}

function localMimeType(filename: string): "image/png" | "image/jpeg" | "image/webp" {
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "image/png";
}

async function downloadLocalOutput(server: ComfyServer, output: OutputDescriptor): Promise<Buffer> {
  let baseUrl: URL;
  try {
    baseUrl = await assertTrustedComfyUrl(server.apiBaseUrl);
  } catch (error) {
    throw new ImageTaskError(
      "Local worker connection is not trusted.",
      hasTransientSystemCause(error),
      { cause: error },
    );
  }
  const target = new URL("/view", baseUrl);
  target.searchParams.set("filename", output.filename);
  target.searchParams.set("subfolder", output.subfolder);
  target.searchParams.set("type", output.type);
  let response: Response;
  try {
    response = await fetch(target, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new ImageTaskError("Local raster output download failed.", true, { cause: error });
  }
  if (!response.ok) {
    throw new ImageTaskError(
      `Local raster output download returned HTTP ${response.status}.`,
      isRetryableStatus(response.status),
      { status: response.status },
    );
  }
  return readBounded(response, MAX_OUTPUT_BYTES, "Local raster output");
}

function requireTaskServer(task: ImageTask): ComfyServer {
  if (!task.server) {
    throw new ImageTaskError("Local image task is missing its worker connection.", false);
  }
  if (task.metadata.serverId !== task.server.id) {
    throw new ImageTaskError("Local image task worker does not match the submitted worker.", false);
  }
  return task.server;
}

function localSubmittedAt(metadata: Record<string, unknown>): number {
  const value = metadata.submittedAt;
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new ImageTaskError("Local image task metadata is missing its submission timestamp.", false);
  }
  return timestamp;
}

export async function submitImageTask(input: ImageTaskInput): Promise<{
  provider: "LOCAL" | "CLOUD";
  requestId: string;
  metadata: Record<string, unknown>;
}> {
  const model = getImageModel(input.modelId);
  if (!model) throw new ImageTaskError("Unknown image model.", false);
  validateInput(input, model);

  if (model.provider === "LOCAL") {
    if (!input.server) {
      throw new ImageTaskError("Choose a local worker for this image model.", false);
    }
    const capability = await inspectLocalImageModel(model.id, input.server, {
      ...(input.referenceMode === "native-reference-edit"
        ? { referenceMode: "native-reference-edit" as const }
        : {}),
    });
    if (!capability) {
      throw new ImageTaskError(
        input.referenceMode === "native-reference-edit"
          ? `${model.name} native reference editing is unavailable on ${input.server.displayName}. Required ReferenceLatent and verified resize nodes plus files: ${localInstallHint(model.id)}.`
          : `${model.name} is unavailable on ${input.server.displayName}. Required files: ${localInstallHint(model.id)}.`,
        false,
      );
    }
    const nativeReferenceResizeMode = input.referenceMode === "native-reference-edit"
      ? capability.nativeReferenceResizeMode
      : undefined;
    if (input.referenceMode === "native-reference-edit" && !nativeReferenceResizeMode) {
      throw new ImageTaskError(
        `${model.name} native reference resize capability is unavailable on ${input.server.displayName}.`,
        false,
      );
    }
    if (
      input.referenceMode === "native-reference-edit"
      && input.nativeReferenceResizeMode !== undefined
      && input.nativeReferenceResizeMode !== nativeReferenceResizeMode
    ) {
      throw new ImageTaskError(
        `${model.name} native reference resize capability changed on ${input.server.displayName}; refusing to vary the snapshotted graph.`,
        false,
      );
    }
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const referenceImageName = input.referenceImages[0]
      ? await uploadLocalReference(input.server, input.referenceImages[0])
      : undefined;
    const workflow = createLocalWorkflow(
      {
        ...input,
        ...(nativeReferenceResizeMode ? { nativeReferenceResizeMode } : {}),
      },
      seed,
      referenceImageName,
    );
    let submitted: { prompt_id: string };
    await input.beforeProviderSubmit?.();
    try {
      submitted = await new ComfyUIClient(input.server).submitWorkflow(workflow, input.clientId);
    } catch (error) {
      throw fromComfyError(error, "Local worker image submission failed.");
    }
    if (typeof submitted.prompt_id !== "string" || !submitted.prompt_id) {
      throw new ImageTaskError("Local worker did not return a prompt ID.", false);
    }
    return {
      provider: "LOCAL",
      requestId: submitted.prompt_id,
      metadata: {
        serverId: input.server.id,
        modelId: model.id,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        operation: input.operation,
        width: input.width,
        height: input.height,
        seed,
        count: input.count,
        ...(effectiveDenoiseStrength(input) === undefined
          ? {}
          : { denoiseStrength: effectiveDenoiseStrength(input) }),
        // Comfy's progress stream reports sampler steps per node. Persist the
        // node classes with the receipt so a durable monitor can distinguish
        // sampler progress from preparation and SaveImage execution after a
        // restart, without reconstructing or resubmitting the workflow.
        progressNodes: input.modelId === "local-flux2-klein-4b"
          ? input.referenceMode === "native-reference-edit"
            ? { sampler: ["16"], saving: ["18"] }
            : { sampler: ["11"], saving: ["13"] }
          : { sampler: ["8"], saving: ["10"] },
        ...(input.referenceMode === "native-reference-edit"
          ? {
            referenceMode: "native-reference-edit",
            nativeReferenceResizeMode,
          }
          : {}),
        submittedAt: Date.now(),
      },
    };
  }

  const endpoint = cloudEndpointByOperation[model.id]?.[input.operation];
  if (!endpoint) {
    throw new ImageTaskError(`${model.name} has no verified Cloud endpoint for ${input.operation}.`, false);
  }
  await input.beforeProviderSubmit?.();
  const submitted = await submitCloud(endpoint, buildCloudInput(input, model));
  return {
    provider: "CLOUD",
    requestId: submitted.requestId,
    metadata: {
      endpoint,
      statusUrl: submitted.endpoints.statusUrl,
      responseUrl: submitted.endpoints.responseUrl,
      cancelUrl: submitted.endpoints.cancelUrl,
    },
  };
}

export async function pollImageTask(task: ImageTask): Promise<ImageTaskResult> {
  if (task.provider === "LOCAL") {
    const server = requireTaskServer(task);
    const client = new ComfyUIClient(server);
    let history: Record<string, unknown>;
    try {
      history = await client.getHistory(task.requestId);
    } catch (error) {
      throw fromComfyError(error, "Local worker history request failed.");
    }
    const entry = localHistoryEntry(history, task.requestId);
    const error = localHistoryError(entry);
    if (error) throw new ImageTaskError(error, false);
    const outputs = localOutputDescriptors(entry);
    if (outputs.length > 0) {
      const images = await Promise.all(outputs.map(async (output) => ({
        bytes: await downloadLocalOutput(server, output),
        mimeType: localMimeType(output.filename),
        name: output.filename.split(/[\\/]/).pop() ?? `local-${randomUUID()}.png`,
      })));
      return { status: "COMPLETED", images };
    }
    if (localHistoryIsComplete(entry)) {
      throw new ImageTaskError("Local image generation completed without a raster output.", false);
    }
    let queue: { queue_running?: unknown[]; queue_pending?: unknown[] };
    try {
      queue = await client.getQueue();
    } catch (queueError) {
      throw fromComfyError(queueError, "Local worker queue request failed.");
    }
    if (queueContains(queue.queue_running, task.requestId)) return { status: "RUNNING" };
    if (queueContains(queue.queue_pending, task.requestId)) return { status: "QUEUED" };
    if (entry) return { status: "RUNNING" };
    if (Date.now() - localSubmittedAt(task.metadata) <= LOCAL_TASK_VISIBILITY_GRACE_MS) {
      return { status: "QUEUED" };
    }
    throw new ImageTaskError(
      "Local image task is no longer present in worker history or queue.",
      false,
    );
  }

  const endpoints = endpointsFromMetadata(task.metadata);
  const status = await cloudJsonRequest(endpoints.statusUrl);
  if (status.status === "IN_QUEUE") return { status: "QUEUED" };
  if (status.status === "IN_PROGRESS") return { status: "RUNNING" };
  if (status.status !== "COMPLETED") {
    throw new ImageTaskError("Cloud returned an unknown image task status.", false);
  }
  // A paid task is never submitted again here: its persisted response URL is the only recovery path.
  const result = await cloudJsonRequest(endpoints.responseUrl);
  return { status: "COMPLETED", images: await downloadCloudOutputs(result) };
}

export async function cancelImageTask(task: ImageTask): Promise<void> {
  if (task.provider === "LOCAL") {
    const server = requireTaskServer(task);
    const client = new ComfyUIClient(server);
    let queue: { queue_running?: unknown[]; queue_pending?: unknown[] };
    try {
      queue = await client.getQueue();
    } catch (error) {
      throw fromComfyError(error, "Local worker queue request failed.");
    }
    if (queueContains(queue.queue_pending, task.requestId)) {
      try {
        await client.removeQueuedPrompt(task.requestId);
      } catch (error) {
        throw fromComfyError(error, "Local worker cancellation failed.");
      }
    } else if (queueContains(queue.queue_running, task.requestId)) {
      try {
        await client.interrupt(task.requestId);
      } catch (error) {
        throw fromComfyError(error, "Local worker cancellation failed.");
      }
    }
    return;
  }
  const endpoints = endpointsFromMetadata(task.metadata);
  await cloudJsonRequest(endpoints.cancelUrl, { method: "PUT", body: "{}" });
}