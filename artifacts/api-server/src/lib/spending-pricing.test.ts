import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { quoteImageSpend, quoteVideoSpend, SpendingPricingError } from "./spending-pricing";

const originalFetch = globalThis.fetch;
const originalKey = process.env.FAL_KEY;
const rates: Record<string, { unit_price: number; unit: string }> = {
  "fal-ai/nano-banana-2": { unit_price: 0.08, unit: "images" },
  "openai/gpt-image-2/edit": { unit_price: 1, unit: "units" },
  "fal-ai/flux-2-pro": { unit_price: 0.03, unit: "processed megapixels" },
  "fal-ai/ideogram/v3": { unit_price: 0.03, unit: "images" },
  "fal-ai/esrgan": { unit_price: 0.00111, unit: "compute seconds" },
  "fal-ai/veo3.1/fast": { unit_price: 0.15, unit: "seconds" },
  "bytedance/seedance-2.0/enterprise/mini/text-to-video": {
    unit_price: 0.007,
    unit: "1000 tokens",
  },
};
let requestedEndpoints: string[] = [];

before(() => {
  process.env.FAL_KEY = "test-key-never-logged";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const endpoint = url.searchParams.get("endpoint_id") ?? "";
    requestedEndpoints.push(endpoint);
    const rate = rates[endpoint];
    return new Response(JSON.stringify(rate
      ? { prices: [{ endpoint_id: endpoint, currency: "USD", ...rate }], next_cursor: null, has_more: false }
      : { prices: [], next_cursor: null, has_more: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = originalKey;
});

test("image quotes apply count, resolution, quality, megapixel, and compute allowances", async () => {
  assert.equal((await quoteImageSpend("cloud-nano-banana-2", {
    width: 3000, height: 2000, count: 2, operation: "generate",
  })).estimatedUsd, 0.32);
  assert.equal((await quoteImageSpend("cloud-flux2-pro", {
    width: 1920, height: 1080, count: 1, operation: "generate",
  })).estimatedUsd, 0.06);
  assert.equal((await quoteImageSpend("cloud-ideogram-v3", {
    width: 1024, height: 1024, count: 3, operation: "generate",
  })).estimatedUsd, 0.18);
  assert.equal((await quoteImageSpend("cloud-gpt-image-2", {
    width: 1024, height: 1024, count: 2, operation: "edit", referenceCount: 3,
  })).estimatedUsd, 0.894);
  const compute = await quoteImageSpend("cloud-esrgan-upscale", {
    width: 4096, height: 4096, count: 1, operation: "upscale", referenceCount: 1,
  });
  assert.equal(compute.estimatedUsd, 0.999);
  assert.match(compute.pricingNote, /not a hard bill cap/);
});

test("video quotes use effective duration/resolution inputs and documented token formula", async () => {
  const veo = await quoteVideoSpend("fal-ai/veo3.1/fast", {
    duration: 8, resolution: "1080p", generateAudio: false,
  });
  assert.equal(veo.estimatedUsd, 1.2);

  const seedance = await quoteVideoSpend("bytedance/seedance-2.0/enterprise/mini/text-to-video", {
    duration: 5, resolution: "480p", generateAudio: false,
  });
  assert.equal(seedance.estimatedUsd, 0.336263);
  assert.match(seedance.pricingNote, /24fps token formula/);
});

test("pricing calls are cached and unknown models never make a pricing request", async () => {
  requestedEndpoints = [];
  await quoteVideoSpend("fal-ai/veo3.1/fast", { duration: 4, resolution: "720p" });
  await quoteVideoSpend("fal-ai/veo3.1/fast", { duration: 6, resolution: "720p" });
  assert.equal(requestedEndpoints.filter((value) => value === "fal-ai/veo3.1/fast").length, 0);

  await assert.rejects(
    quoteImageSpend("not-a-model", { width: 1, height: 1, count: 1, operation: "generate" }),
    (error: unknown) => error instanceof SpendingPricingError && error.statusCode === 503,
  );
  assert.equal(requestedEndpoints.length, 0);
});

test("invalid live units fail closed with status 503", async () => {
  await assert.rejects(
    quoteImageSpend("cloud-nano-banana-pro", {
      width: 1024, height: 1024, count: 1, operation: "generate",
    }),
    (error: unknown) => error instanceof SpendingPricingError && error.statusCode === 503,
  );
});
