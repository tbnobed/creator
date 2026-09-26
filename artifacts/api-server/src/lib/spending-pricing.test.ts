import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { quoteImageSpend, quoteVideoSpend, SpendingPricingError } from "./spending-pricing";

const originalFetch = globalThis.fetch;
const originalKey = process.env.FAL_KEY;
let fetchCalls = 0;

before(() => {
  delete process.env.FAL_KEY;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("pricing must not access the network");
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = originalKey;
});

test("all image models use checked-in rates and existing parameter formulas", async () => {
  assert.equal((await quoteImageSpend("cloud-nano-banana-2", {
    width: 3000, height: 2000, count: 2, operation: "generate",
  })).estimatedUsd, 0.32);
  assert.equal((await quoteImageSpend("cloud-nano-banana-2", {
    width: 700, height: 500, count: 1, operation: "edit",
  })).estimatedUsd, 0.06);
  assert.equal((await quoteImageSpend("cloud-nano-banana-2", {
    width: 2000, height: 1000, count: 2, operation: "generate",
  })).estimatedUsd, 0.24);
  assert.equal((await quoteImageSpend("cloud-nano-banana-pro", {
    width: 4000, height: 3000, count: 2, operation: "edit",
  })).estimatedUsd, 0.6);
  assert.equal((await quoteImageSpend("cloud-flux2-pro", {
    width: 1920, height: 1080, count: 1, operation: "generate",
  })).estimatedUsd, 0.06);
  assert.equal((await quoteImageSpend("cloud-ideogram-v3", {
    width: 1024, height: 1024, count: 3, operation: "generate",
  })).estimatedUsd, 0.18);
  assert.equal((await quoteImageSpend("cloud-gpt-image-2", {
    width: 1024, height: 1024, count: 2, operation: "edit", referenceCount: 3,
  })).estimatedUsd, 0.894);
  assert.equal((await quoteImageSpend("cloud-gpt-image-2", {
    width: 1024, height: 1024, count: 1, operation: "generate",
  })).estimatedUsd, 0.411);
  assert.equal((await quoteImageSpend("cloud-seedream-5-lite", {
    width: 1024, height: 1024, count: 2, operation: "generate",
  })).estimatedUsd, 0.07);
  assert.equal((await quoteImageSpend("cloud-recraft-v3-raster", {
    width: 1024, height: 1024, count: 2, operation: "generate",
  })).estimatedUsd, 0.08);
  assert.equal((await quoteImageSpend("cloud-qwen-inpaint", {
    width: 1920, height: 1080, count: 2, operation: "outpaint",
  })).estimatedUsd, 0.18);
  const compute = await quoteImageSpend("cloud-esrgan-upscale", {
    width: 4096, height: 4096, count: 1, operation: "upscale", referenceCount: 1,
  });
  assert.equal(compute.estimatedUsd, 0.999);
  assert.match(compute.pricingNote, /not a hard bill cap/);
  assert.equal((await quoteImageSpend("cloud-remove-background", {
    width: 1024, height: 1024, count: 8, operation: "remove-background",
  })).estimatedUsd, 0.333);
  assert.match(compute.pricingNote, /Locally estimated.*2026-09-10/);
  assert.doesNotMatch(compute.pricingNote, /invoice|reconcil|pending|live rate/i);
});

test("all video models use duration, resolution, audio, and token formulas", async () => {
  const veo = await quoteVideoSpend("fal-ai/veo3.1/fast", {
    duration: 8, resolution: "1080p", generateAudio: false,
  });
  assert.equal(veo.estimatedUsd, 1.2);
  assert.equal((await quoteVideoSpend("fal-ai/veo3.1/fast", {
    duration: 8, resolution: "4k", generateAudio: true,
  })).estimatedUsd, 2.8);
  assert.equal((await quoteVideoSpend("fal-ai/veo3.1/fast", {
    duration: 8, resolution: "4k", generateAudio: false,
  })).estimatedUsd, 2.4);
  assert.equal((await quoteVideoSpend("fal-ai/kling-video/v3/standard/text-to-video", {
    duration: 5, resolution: "720p", generateAudio: true,
  })).estimatedUsd, 0.7);

  const seedance = await quoteVideoSpend("bytedance/seedance-2.0/enterprise/mini/text-to-video", {
    duration: 5, resolution: "480p", generateAudio: false,
  });
  assert.equal(seedance.estimatedUsd, 0.336263);
  assert.match(seedance.pricingNote, /24fps token formula/);
  assert.equal((await quoteVideoSpend("bytedance/seedance-2.0/enterprise/v2/text-to-video", {
    duration: 5, resolution: "480p",
  })).estimatedUsd, 0.672525);
});

test("Seedance 2.5 uses official resolution rates and prices full input plus output video duration", async () => {
  assert.equal((await quoteVideoSpend("bytedance/seedance-2.5/text-to-video", {
    duration: 5, resolution: "720p",
  })).estimatedUsd, 2.3112);
  assert.equal((await quoteVideoSpend("bytedance/seedance-2.5/image-to-video", {
    duration: 5, resolution: "1080p",
  })).estimatedUsd, 5.6862);
  const videoReference = await quoteVideoSpend("bytedance/seedance-2.5/reference-to-video", {
    duration: 5, resolution: "720p", referenceVideoDuration: 5,
  });
  assert.equal(videoReference.estimatedUsd, 2.77344);
  assert.match(videoReference.pricingNote, /5s of input video.*0\.6/);
  const multimodal = await quoteVideoSpend("bytedance/seedance-2.5/reference-to-video", {
    duration: 5, resolution: "720p", referenceVideoDuration: 5,
    referenceAudioDuration: 2, referenceImageCount: 1,
  });
  assert.ok(multimodal.estimatedUsd > videoReference.estimatedUsd);
});

test("Seedance 2.0 quotes include input reference media rather than dropping its cost", async () => {
  const outputOnly = await quoteVideoSpend("bytedance/seedance-2.0/enterprise/v2/reference-to-video", {
    duration: 5, resolution: "720p",
  });
  const withReferences = await quoteVideoSpend("bytedance/seedance-2.0/enterprise/v2/reference-to-video", {
    duration: 5,
    resolution: "720p",
    referenceVideoDuration: 5,
    referenceAudioDuration: 3,
    referenceImageCount: 2,
  });
  assert.ok(withReferences.estimatedUsd > outputOnly.estimatedUsd);
  assert.match(withReferences.pricingNote, /input video.*frame-equivalent audio.*full-resolution image/);
});

test("quotes require neither network nor credentials", async () => {
  await quoteVideoSpend("fal-ai/veo3.1/fast", { duration: 4, resolution: "720p" });
  await quoteImageSpend("cloud-nano-banana-pro", {
    width: 1024, height: 1024, count: 1, operation: "generate",
  });
  assert.equal(fetchCalls, 0);
  assert.equal(process.env.FAL_KEY, undefined);
});

test("unknown models, operations, and invalid units fail explicitly", async () => {
  await assert.rejects(
    quoteImageSpend("not-a-model", { width: 1, height: 1, count: 1, operation: "generate" }),
    (error: unknown) => error instanceof SpendingPricingError
      && error.statusCode === 503 && /unknown image model/.test(error.message),
  );
  await assert.rejects(
    quoteImageSpend("cloud-flux2-pro", {
      width: 1024, height: 1024, count: 1, operation: "edit",
    }),
    (error: unknown) => error instanceof SpendingPricingError
      && /operation is not priced/.test(error.message),
  );
  await assert.rejects(
    quoteVideoSpend("fal-ai/veo3.1/fast", { duration: 1, resolution: "8k" }),
    TypeError,
  );
  assert.equal(fetchCalls, 0);
});
