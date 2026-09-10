const PRICING_API = "https://api.fal.ai/v1/models/pricing";
const PRICING_CACHE_TTL_MS = 5 * 60_000;
const MAX_QUOTE_USD = 1_000_000;

type Quote = { estimatedUsd: number; pricingNote: string };
type QuoteInput = {
  width: number;
  height: number;
  count: number;
  operation: string;
  referenceCount?: number;
};
type VideoQuoteInput = { duration: number; resolution?: string; generateAudio?: boolean };
type Price = {
  endpointId: string;
  unitPrice: number;
  unit: string;
  fetchedAt: Date;
};

export class SpendingPricingError extends Error {
  readonly statusCode = 503;

  constructor(message: string) {
    super(message);
    this.name = "SpendingPricingError";
  }
}

const imageCatalog = {
  "cloud-nano-banana-2": {
    endpoints: { generate: "fal-ai/nano-banana-2", edit: "fal-ai/nano-banana-2/edit" },
    units: ["images"],
  },
  "cloud-nano-banana-pro": {
    endpoints: { generate: "fal-ai/nano-banana-pro", edit: "fal-ai/nano-banana-pro/edit" },
    units: ["images"],
  },
  "cloud-gpt-image-2": {
    endpoints: {
      generate: "openai/gpt-image-2",
      edit: "openai/gpt-image-2/edit",
      inpaint: "openai/gpt-image-2/edit",
    },
    units: ["units"],
  },
  "cloud-flux2-pro": {
    endpoints: { generate: "fal-ai/flux-2-pro" },
    units: ["processed megapixels"],
  },
  "cloud-seedream-5-lite": {
    endpoints: { generate: "fal-ai/bytedance/seedream/v5/lite/text-to-image" },
    units: ["images"],
  },
  "cloud-ideogram-v3": {
    endpoints: { generate: "fal-ai/ideogram/v3" },
    units: ["images"],
  },
  "cloud-recraft-v3-raster": {
    endpoints: { generate: "fal-ai/recraft/v3/text-to-image" },
    units: ["images"],
  },
  "cloud-qwen-inpaint": {
    endpoints: {
      inpaint: "fal-ai/qwen-image-edit/inpaint",
      outpaint: "fal-ai/qwen-image-edit/inpaint",
    },
    units: ["megapixels"],
  },
  "cloud-esrgan-upscale": {
    endpoints: { upscale: "fal-ai/esrgan" },
    units: ["compute seconds"],
  },
  "cloud-remove-background": {
    endpoints: { "remove-background": "fal-ai/imageutils/rembg" },
    units: ["compute seconds"],
  },
} as const;

const videoCatalog = {
  "fal-ai/veo3.1/fast": { units: ["seconds"] },
  "fal-ai/kling-video/v3/standard/text-to-video": { units: ["seconds"] },
  "bytedance/seedance-2.0/enterprise/mini/text-to-video": { units: ["1000 tokens"] },
  "bytedance/seedance-2.0/enterprise/v2/text-to-video": { units: ["1000 tokens"] },
} as const;

const priceCache = new Map<string, { expiresAt: number; price: Price }>();
const pendingPrices = new Map<string, Promise<Price>>();

function unavailable(message: string): SpendingPricingError {
  return new SpendingPricingError(`Cloud pricing unavailable: ${message}`);
}

function positive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be finite and positive.`);
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer.`);
}

function roundQuote(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_QUOTE_USD) {
    throw unavailable("the estimate is outside the supported USD range");
  }
  return Math.ceil((value - Number.EPSILON) * 1_000_000) / 1_000_000;
}

async function fetchPrice(endpointId: string, expectedUnits: readonly string[]): Promise<Price> {
  const cached = priceCache.get(endpointId);
  if (cached && cached.expiresAt > Date.now()) return cached.price;
  const pending = pendingPrices.get(endpointId);
  if (pending) return pending;

  const promise = (async () => {
    const key = process.env.FAL_KEY?.trim();
    if (!key) throw unavailable("credentials are not configured");
    let response: Response;
    try {
      const query = new URLSearchParams({ endpoint_id: endpointId });
      response = await fetch(`${PRICING_API}?${query}`, {
        method: "GET",
        headers: { Authorization: `Key ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw unavailable("the live rate could not be retrieved");
    }
    if (!response.ok) throw unavailable(`the live rate request returned HTTP ${response.status}`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable("the live rate response was not valid JSON");
    }
    const prices = body && typeof body === "object"
      ? (body as { prices?: unknown }).prices
      : undefined;
    const row = Array.isArray(prices)
      ? prices.find((item) => item && typeof item === "object"
        && (item as { endpoint_id?: unknown }).endpoint_id === endpointId)
      : undefined;
    const candidate = row as { unit_price?: unknown; unit?: unknown; currency?: unknown } | undefined;
    if (!candidate || candidate.currency !== "USD"
      || typeof candidate.unit_price !== "number" || !Number.isFinite(candidate.unit_price)
      || candidate.unit_price <= 0 || typeof candidate.unit !== "string"
      || !expectedUnits.includes(candidate.unit)) {
      throw unavailable("the live rate had an unknown currency, unit, or value");
    }
    const price = {
      endpointId,
      unitPrice: candidate.unit_price,
      unit: candidate.unit,
      fetchedAt: new Date(),
    };
    priceCache.set(endpointId, { price, expiresAt: Date.now() + PRICING_CACHE_TTL_MS });
    return price;
  })();
  pendingPrices.set(endpointId, promise);
  try {
    return await promise;
  } finally {
    pendingPrices.delete(endpointId);
  }
}

function note(price: Price, detail: string): string {
  const snapshotDate = price.fetchedAt.toISOString();
  return `Estimated reservation, not an invoice. pricing-v1 snapshot ${snapshotDate}: `
    + `$${price.unitPrice}/${price.unit}; ${detail}`;
}

function megapixels(width: number, height: number): number {
  return width * height / 1_000_000;
}

function googleResolution(modelId: string, width: number, height: number): "0.5K" | "1K" | "2K" | "4K" {
  const longest = Math.max(width, height);
  if (modelId === "cloud-nano-banana-2" && longest <= 768) return "0.5K";
  if (longest <= 1280) return "1K";
  if (longest <= 2560) return "2K";
  return "4K";
}

export async function quoteImageSpend(modelId: string, input: QuoteInput): Promise<Quote> {
  positive(input.width, "width");
  positive(input.height, "height");
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
    throw new TypeError("width and height must be integers.");
  }
  positive(input.count, "count");
  if (!Number.isSafeInteger(input.count)) throw new TypeError("count must be an integer.");
  const referenceCount = input.referenceCount ?? 0;
  nonNegativeInteger(referenceCount, "referenceCount");

  const model = imageCatalog[modelId as keyof typeof imageCatalog];
  if (!model) throw unavailable("unknown image model");
  const endpoints = model.endpoints as Record<string, string>;
  const endpoint = endpoints[input.operation];
  if (!endpoint) throw unavailable("the operation is not priced for this image model");
  const price = await fetchPrice(endpoint, model.units);

  let raw: number;
  let detail: string;
  const mp = megapixels(input.width, input.height);
  if (modelId === "cloud-nano-banana-2") {
    const resolution = googleResolution(modelId, input.width, input.height);
    const multiplier = resolution === "0.5K" ? 0.75 : resolution === "2K" ? 1.5 : resolution === "4K" ? 2 : 1;
    raw = price.unitPrice * multiplier * input.count;
    detail = `${input.count} output(s), ${resolution} documented multiplier ${multiplier}.`;
  } else if (modelId === "cloud-nano-banana-pro") {
    const resolution = googleResolution(modelId, input.width, input.height);
    const multiplier = resolution === "4K" ? 2 : 1;
    raw = price.unitPrice * multiplier * input.count;
    detail = `${input.count} output(s), ${resolution} documented multiplier ${multiplier}.`;
  } else if (modelId === "cloud-gpt-image-2") {
    // The live endpoint reports an opaque USD "unit". The documented high-quality
    // 4K tables are used as conservative factors; edit includes one input image,
    // with the largest documented one-input delta applied to every extra reference.
    const highQuality4kUnits = input.operation === "generate" ? 0.401 : 0.413;
    const extraInputUnits = input.operation === "generate" ? 0 : Math.max(0, referenceCount - 1) * 0.012;
    const allowanceUnits = highQuality4kUnits + extraInputUnits + 0.01;
    raw = price.unitPrice * allowanceUnits * input.count;
    detail = `${input.count} high-quality output(s), 4K table allowance plus text-token margin`
      + `${referenceCount ? ` and ${referenceCount} input image(s)` : ""}; actual token use can vary.`;
  } else if (modelId === "cloud-flux2-pro") {
    const roundedMp = Math.max(1, Math.ceil(mp));
    raw = price.unitPrice * (1 + Math.max(0, roundedMp - 1) * 0.5) * input.count;
    detail = `${input.count} output(s), ${roundedMp} rounded output MP; first MP at live rate, extras at documented half-rate.`;
  } else if (modelId === "cloud-ideogram-v3") {
    raw = price.unitPrice * 2 * input.count;
    detail = `${input.count} BALANCED output(s), documented 2x base-rate multiplier.`;
  } else if (modelId === "cloud-qwen-inpaint") {
    const roundedMp = Math.max(1, Math.ceil(mp));
    raw = price.unitPrice * roundedMp * input.count;
    detail = `${input.count} output(s), ${roundedMp} rounded output MP.`;
  } else if (modelId === "cloud-esrgan-upscale" || modelId === "cloud-remove-background") {
    const computeSeconds = modelId === "cloud-esrgan-upscale" ? 900 : 300;
    raw = price.unitPrice * computeSeconds;
    detail = `conservative ${computeSeconds}-compute-second reservation allowance`
      + ` for ${mp.toFixed(3)} output MP; compute billing is runtime-dependent, so this is not a hard bill cap.`;
  } else {
    raw = price.unitPrice * input.count;
    detail = `${input.count} output image(s).`;
  }
  return { estimatedUsd: roundQuote(raw), pricingNote: note(price, detail) };
}

function videoDimensions(resolution: string | undefined): { width: number; height: number; label: string } {
  const normalized = (resolution ?? "720p").toLowerCase();
  if (normalized === "480p") return { width: 854, height: 480, label: normalized };
  if (normalized === "720p") return { width: 1280, height: 720, label: normalized };
  if (normalized === "1080p") return { width: 1920, height: 1080, label: normalized };
  if (normalized === "4k" || normalized === "2160p") return { width: 3840, height: 2160, label: "4k" };
  throw new TypeError("resolution is not supported for Cloud spend quoting.");
}

export async function quoteVideoSpend(modelId: string, input: VideoQuoteInput): Promise<Quote> {
  positive(input.duration, "duration");
  const model = videoCatalog[modelId as keyof typeof videoCatalog];
  if (!model) throw unavailable("unknown video model");
  const price = await fetchPrice(modelId, model.units);
  const dimensions = videoDimensions(input.resolution);
  const audio = input.generateAudio === true;

  let raw: number;
  let detail: string;
  if (modelId.includes("seedance-2.0")) {
    const tokens = dimensions.width * dimensions.height * input.duration * 24 / 1024;
    raw = price.unitPrice * tokens / 1000;
    detail = `${input.duration}s at ${dimensions.label}, 24fps token formula`
      + ` (${Math.ceil(tokens)} estimated tokens); audio does not change the documented token rate.`;
  } else if (modelId === "fal-ai/veo3.1/fast" && dimensions.label === "4k") {
    // The live rate is the 720p/1080p audio rate. Documented 4K rates are
    // $0.35 with audio and $0.30 without it, represented as relative factors.
    const multiplier = audio ? 0.35 / 0.15 : 0.30 / 0.15;
    raw = price.unitPrice * multiplier * input.duration;
    detail = `${input.duration}s at 4k, audio ${audio ? "on" : "off"}, documented ${multiplier.toFixed(4)}x multiplier.`;
  } else {
    // The current live rates exceed the documented no-audio rates for both
    // endpoints, so using the unmodified live rate safely over-reserves.
    raw = price.unitPrice * input.duration;
    detail = `${input.duration}s at ${dimensions.label}, audio ${audio ? "on" : "off"};`
      + " unmodified live per-second rate used conservatively.";
  }
  return { estimatedUsd: roundQuote(raw), pricingNote: note(price, detail) };
}
