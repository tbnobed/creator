import assert from "node:assert/strict";
import { test } from "node:test";

import { CreateGenerationBody } from "@workspace/api-zod";
import { quoteVideoSpend } from "../spending-pricing";

import {
  applyFalSeedanceTask,
  falModelFromEndpoint,
  falModels,
  falSeedanceImageModels,
  falSeedanceReferenceModels,
  normalizeFalRequest,
  selectFalGenerationEndpoint,
  validateFalReferenceMediaLimits,
} from "./client";

const request = {
  prompt: "A quiet landscape at sunrise.",
  width: 1280,
  height: 720,
  durationSeconds: 6,
  fps: 30,
  qualityPreset: "STANDARD",
  seed: 42,
};

test("every Cloud video model normalizes a text-only request without references", () => {
  assert.deepEqual(Object.keys(falModels), [
    "veo-3.1-fast",
    "kling-v3-standard",
    "seedance-2.0-mini",
    "seedance-2.0",
    "seedance-2.0-fast",
    "seedance-2.5",
  ]);

  for (const model of Object.keys(falModels) as Array<keyof typeof falModels>) {
    const normalized = normalizeFalRequest(model, request);

    assert.equal(normalized.input.prompt, request.prompt, model);
    assert.equal(normalized.input.aspect_ratio, "16:9", model);
    assert.equal(normalized.input.generate_audio, false, model);
    assert.equal(normalized.width, 1280, model);
    assert.equal(normalized.height, 720, model);
    assert.equal(normalized.fps, 24, model);
    assert.equal(normalized.frameCount, normalized.durationSeconds * normalized.fps, model);
    assert.equal(
      Object.keys(normalized.input).some((key) => /character|setting|reference|image|video/i.test(key)),
      false,
      model,
    );
  }
});

test("every Cloud video model accepts the text-only signature without an optional seed", () => {
  const { seed: _seed, ...requestWithoutSeed } = request;

  for (const model of Object.keys(falModels) as Array<keyof typeof falModels>) {
    const normalized = normalizeFalRequest(model, requestWithoutSeed);

    assert.equal(normalized.input.prompt, request.prompt, model);
    assert.equal("seed" in normalized.input, false, model);
  }
});

test("Seedance sends native audio for dialogue unless the creator explicitly requests silence", () => {
  for (const model of ["seedance-2.0-mini", "seedance-2.0", "seedance-2.0-fast", "seedance-2.5"] as const) {
    const spoken = normalizeFalRequest(model, { ...request, dialogue: "Love is necessary." });
    assert.equal(spoken.input.generate_audio, true);
    assert.match(String(spoken.input.prompt), /quiet landscape/);
    assert.equal(normalizeFalRequest(model, {
      ...request, dialogue: "Love is necessary.", nativeAudioEnabled: false,
    }).input.generate_audio, false);
    assert.equal(normalizeFalRequest(model, { ...request, dialogue: "   " }).input.generate_audio, false);
    assert.equal(normalizeFalRequest(model, { ...request, nativeAudioEnabled: true }).input.generate_audio, true);
  }
  for (const model of ["veo-3.1-fast", "kling-v3-standard"] as const) {
    assert.equal(normalizeFalRequest(model, { ...request, dialogue: "Love is necessary." }).input.generate_audio, false);
  }
});

test("Seedance endpoint selection keeps frame, reference, and text payloads on supported endpoints", () => {
  assert.equal(selectFalGenerationEndpoint("seedance-2.5"), falModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { imageCount: 2, task: "reference" }), falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { videoCount: 1, imageCount: 1 }), falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { hasStartFrame: true, hasEndFrame: true }), falSeedanceImageModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.0", { imageCount: 1 }), falSeedanceReferenceModels["seedance-2.0"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.0-mini", { hasStartFrame: true }), falSeedanceImageModels["seedance-2.0-mini"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.0", { imageCount: 1, videoCount: 1, audioCount: 1, task: "reference" }), falSeedanceReferenceModels["seedance-2.0"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { task: "reference" }), falModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { videoCount: 1, task: "editing" }), falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { videoCount: 1, task: "extension" }), falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { videoCount: 1, imageCount: 2, audioCount: 1, task: "editing" }), falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(selectFalGenerationEndpoint("seedance-2.5", { videoCount: 1, imageCount: 2, audioCount: 1, task: "extension" }), falSeedanceReferenceModels["seedance-2.5"]);
});

test("Seedance 2.5 reference tasks reach the provider input only on its reference endpoint", () => {
  const input: Record<string, unknown> = {};
  applyFalSeedanceTask(input, "seedance-2.5", falSeedanceReferenceModels["seedance-2.5"], "extension");
  assert.equal(input.task, "extension");
  const defaultTask: Record<string, unknown> = {};
  applyFalSeedanceTask(defaultTask, "seedance-2.5", falSeedanceReferenceModels["seedance-2.5"]);
  assert.equal(defaultTask.task, "reference");
  const textInput: Record<string, unknown> = {};
  applyFalSeedanceTask(textInput, "seedance-2.5", falModels["seedance-2.5"], "reference");
  assert.equal("task" in textInput, false);
});

test("Seedance endpoint selection rejects unsupported ignored reference combinations", () => {
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { hasStartFrame: true, imageCount: 1 }), /different endpoints/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { audioCount: 1 }), /require at least one image or video/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { imageCount: 31 }), /at most 30 image/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.0", { task: "extension", imageCount: 1 }), /only on Seedance 2.5/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { task: "editing", videoCount: 1, hasStartFrame: true }), /cannot use start\/end frames/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { task: "extension", videoCount: 2 }), /exactly one source video/);
  assert.throws(() => selectFalGenerationEndpoint("veo-3.1-fast", { hasStartFrame: true }), /supported only by Seedance/);
  assert.throws(() => selectFalGenerationEndpoint("seedance-2.5", { hasEndFrame: true }), /requires a start frame/);
});

test("Seedance reference file-size and combined-duration limits are checked before submission", () => {
  const MiB = 1024 * 1024;
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [
      { sizeBytes: 26 * MiB, durationSeconds: 8, width: 640, height: 640, fps: 24 },
      { sizeBytes: 24 * MiB, durationSeconds: 7, width: 640, height: 640, fps: 24 },
    ],
  }), /less than 50 MB/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [
      { sizeBytes: 20 * MiB, durationSeconds: 8, width: 640, height: 640, fps: 24 },
      { sizeBytes: 20 * MiB, durationSeconds: 8, width: 640, height: 640, fps: 24 },
    ],
  }), /combined duration from 2 to 15/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    audios: [{ sizeBytes: 15 * MiB + 1, durationSeconds: 4 }],
  }), /supported file size/);
  assert.doesNotThrow(() => validateFalReferenceMediaLimits("seedance-2.0", {
    images: [{ sizeBytes: 30 * MiB, }],
    videos: [{ sizeBytes: 49 * MiB, durationSeconds: 15, width: 1112, height: 834, fps: 60 }],
    audios: [{ sizeBytes: 15 * MiB, durationSeconds: 15 }],
  }));
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ sizeBytes: 200 * MiB + 1, durationSeconds: 3, width: 300, height: 300, fps: 24 }],
  }), /supported file size/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [
      { sizeBytes: 100 * MiB, durationSeconds: 20, width: 300, height: 300, fps: 24 },
      { sizeBytes: 100 * MiB, durationSeconds: 11, width: 300, height: 300, fps: 24 },
    ],
  }), /no more than 30.2 seconds/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    audios: [{ sizeBytes: 15 * MiB, durationSeconds: 20 }, { sizeBytes: 15 * MiB, durationSeconds: 11 }],
  }), /no more than 30.2 seconds/);
});

test("Seedance reference video geometry and frame rates are checked at documented boundaries", () => {
  const valid25 = {
    sizeBytes: 1,
    durationSeconds: 1.8,
    width: 300,
    height: 300,
    fps: 24,
  };
  assert.doesNotThrow(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [
      valid25,
      { ...valid25, durationSeconds: 28.4, width: 6000, height: 2400, fps: 60 },
    ],
  }));
  assert.doesNotThrow(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, durationSeconds: 30.2, height: 750 }],
  }));
  assert.doesNotThrow(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 2, width: 640, height: 640, fps: 24 }],
  }));
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, width: 299 }],
  }), /dimensions are outside/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, width: 6001 }],
  }), /dimensions are outside/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, width: 300, height: 751 }],
  }), /aspect ratio/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, width: 751, height: 300 }],
  }), /aspect ratio/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, fps: 23.99 }],
  }), /frame rate/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, fps: 60.01 }],
  }), /frame rate/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, durationSeconds: 1.79 }],
  }), /duration/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [{ ...valid25, durationSeconds: 30.21 }],
  }), /duration/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.5", {
    videos: [
      { ...valid25, durationSeconds: 15.2 },
      { ...valid25, durationSeconds: 15.1 },
    ],
  }), /no more than 30.2 seconds/);

  assert.doesNotThrow(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 15, width: 1112, height: 834, fps: 24 }],
  }));
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 15, width: 639, height: 640, fps: 24 }],
  }), /dimensions are outside/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 15, width: 1112, height: 835, fps: 24 }],
  }), /dimensions are outside/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 15, width: 640, height: 640, fps: 23.99 }],
  }), /frame rate/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [{ sizeBytes: 1, durationSeconds: 15, width: 640, height: 640, fps: 60.01 }],
  }), /frame rate/);
  assert.throws(() => validateFalReferenceMediaLimits("seedance-2.0", {
    videos: [
      { sizeBytes: 1, durationSeconds: 7.6, width: 640, height: 640, fps: 24 },
      { sizeBytes: 1, durationSeconds: 7.5, width: 640, height: 640, fps: 24 },
    ],
  }), /combined duration from 2 to 15/);
});

test("Seedance image endpoints send supported first and end frame fields", () => {
  const framed = normalizeFalRequest("seedance-2.5", {
    ...request,
    startFrameUrl: "data:image/png;base64,c3RhcnQ=",
    endFrameUrl: "data:image/jpeg;base64,ZW5k",
  });
  assert.equal(framed.input.image_url, "data:image/png;base64,c3RhcnQ=");
  assert.equal(framed.input.end_image_url, "data:image/jpeg;base64,ZW5k");
  assert.throws(() => normalizeFalRequest("seedance-2.0", {
    ...request, endFrameUrl: "data:image/png;base64,ZW5k",
  }), /requires a start frame/);
});

test("Seedance 2.5 duration normalizes through the documented 30 second maximum", () => {
  assert.equal(normalizeFalRequest("seedance-2.5", { ...request, durationSeconds: 28 }).durationSeconds, 28);
  assert.equal(normalizeFalRequest("seedance-2.5", { ...request, durationSeconds: 45 }).durationSeconds, 30);
  assert.equal(normalizeFalRequest("seedance-2.0", { ...request, durationSeconds: 28 }).durationSeconds, 15);
});

test("Seedance 2.5 editing requests provider auto duration and quotes the 30 second ceiling", async () => {
  const editing = normalizeFalRequest("seedance-2.5", {
    ...request,
    durationSeconds: 4,
    seedanceTask: "editing",
  });
  assert.equal(editing.input.duration, "auto");
  assert.equal(editing.input.aspect_ratio, "auto");
  assert.equal(editing.durationSeconds, 30);
  assert.equal(editing.frameCount, 30 * editing.fps);
  const quote = await quoteVideoSpend(falSeedanceReferenceModels["seedance-2.5"], {
    duration: editing.durationSeconds,
    referenceVideoDuration: 12,
    resolution: String(editing.input.resolution),
  });
  const underquoted = await quoteVideoSpend(falSeedanceReferenceModels["seedance-2.5"], {
    duration: 4,
    referenceVideoDuration: 12,
    resolution: String(editing.input.resolution),
  });
  assert.ok(quote.estimatedUsd > underquoted.estimatedUsd);
  assert.match(quote.pricingNote, /30s output plus 12s of input video/);
});

test("Seedance 2.5 extension inherits aspect from source while retaining chosen duration", () => {
  const extension = normalizeFalRequest("seedance-2.5", {
    ...request, durationSeconds: 18, seedanceTask: "extension",
  });
  assert.equal(extension.input.duration, "18");
  assert.equal(extension.input.aspect_ratio, "auto");
  assert.throws(() => normalizeFalRequest("seedance-2.5", {
    ...request, seedanceTask: "extension", aspectRatio: "16:9",
  }), /source video's aspect ratio automatically/);
});

test("every Seedance endpoint remains mapped to its model for queue recovery", () => {
  for (const model of ["seedance-2.0-mini", "seedance-2.0", "seedance-2.0-fast", "seedance-2.5"] as const) {
    assert.equal(falModelFromEndpoint(falModels[model]), model);
    assert.equal(falModelFromEndpoint(falSeedanceReferenceModels[model]), model);
    assert.equal(falModelFromEndpoint(falSeedanceImageModels[model]), model);
  }
});

test("Seedance six shapes and 4k use submitted geometry in cost quotes", async () => {
  for (const ratio of ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const) {
    const normalized = normalizeFalRequest("seedance-2.0", { ...request, aspectRatio: ratio, outputResolution: "4k" });
    const [w, h] = ratio.split(":").map(Number);
    assert.equal(normalized.input.aspect_ratio, ratio);
    assert.equal(normalized.input.resolution, "4k");
    assert.ok(Math.abs(normalized.width / normalized.height - w / h) < 0.001);
    assert.equal(Math.min(normalized.width, normalized.height), 2160);
    const quote = await quoteVideoSpend(falModels["seedance-2.0"], {
      duration: normalized.durationSeconds,
      resolution: "4k",
      width: normalized.width,
      height: normalized.height,
    });
    assert.ok(quote.estimatedUsd > 0);
  }
  const wide = normalizeFalRequest("seedance-2.0", { ...request, aspectRatio: "21:9", outputResolution: "4k" });
  const wideQuote = await quoteVideoSpend(falModels["seedance-2.0"], {
    duration: 6, resolution: "4k", width: wide.width, height: wide.height,
  });
  const landscape = await quoteVideoSpend(falModels["seedance-2.0"], { duration: 6, resolution: "4k" });
  assert.ok(wideQuote.estimatedUsd > landscape.estimatedUsd);
  assert.throws(() => normalizeFalRequest("seedance-2.5", { ...request, outputResolution: "4k" }), /only by Seedance 2.0 standard/);
  assert.throws(() => normalizeFalRequest("seedance-2.0-fast", { ...request, outputResolution: "1080p" }), /480p and 720p only/);
});

test("Seedance 2.0 Fast routes text, frames, and multimodal references to official fast endpoints", () => {
  const model = "seedance-2.0-fast";
  assert.equal(selectFalGenerationEndpoint(model), falModels[model]);
  assert.equal(selectFalGenerationEndpoint(model, { hasStartFrame: true }), falSeedanceImageModels[model]);
  assert.equal(selectFalGenerationEndpoint(model, { imageCount: 1, videoCount: 1, audioCount: 1 }), falSeedanceReferenceModels[model]);
  for (const endpoint of [falModels[model], falSeedanceImageModels[model], falSeedanceReferenceModels[model]]) {
    assert.equal(falModelFromEndpoint(endpoint), model);
  }
});

const generationInput = {
  provider: "FAL",
  model: "veo-3.1-fast",
  prompt: "A quiet landscape at sunrise.",
  generationMode: "TEXT_TO_VIDEO",
  durationSeconds: 6,
  fps: 24,
  width: 1280,
  height: 720,
  qualityPreset: "STANDARD",
  seedMode: "RANDOM",
} as const;

test("CreateGenerationBody accepts omitted characterIds", () => {
  assert.equal(CreateGenerationBody.safeParse(generationInput).success, true);
});

test("CreateGenerationBody accepts an explicit empty characterIds array", () => {
  assert.equal(CreateGenerationBody.safeParse({ ...generationInput, characterIds: [] }).success, true);
});

test("CreateGenerationBody accepts an explicit null settingId", () => {
  assert.equal(CreateGenerationBody.safeParse({ ...generationInput, settingId: null }).success, true);
});

test("CreateGenerationBody rejects more than nine characterIds", () => {
  const characterIds = Array.from({ length: 10 }, (_, index) => `character-${index}`);
  assert.equal(CreateGenerationBody.safeParse({ ...generationInput, characterIds }).success, false);
});

test("CreateGenerationBody requires prompt", () => {
  const { prompt: _prompt, ...inputWithoutPrompt } = generationInput;
  assert.equal(CreateGenerationBody.safeParse(inputWithoutPrompt).success, false);
});

test("CreateGenerationBody accepts explicit Seedance audio on and off", () => {
  for (const nativeAudioEnabled of [true, false]) {
    const parsed = CreateGenerationBody.safeParse({
      ...generationInput, model: "seedance-2.0-mini", dialogue: "Love is necessary.", nativeAudioEnabled,
    });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.nativeAudioEnabled, nativeAudioEnabled);
  }
});

test("CreateGenerationBody accepts Seedance 2.5 tasks, frames, and typed media storage keys", () => {
  const parsed = CreateGenerationBody.safeParse({
    ...generationInput,
    model: "seedance-2.5",
    seedanceTask: "extension",
    startFrameKey: "tenants/tenant-id/generation-references/start.png",
    endFrameKey: "tenants/tenant-id/generation-references/end.png",
    referenceImageKeys: ["tenants/tenant-id/generation-references/ref.webp"],
    referenceVideoKeys: ["tenants/tenant-id/generation-references/ref.mp4"],
    referenceAudioKeys: ["tenants/tenant-id/generation-references/ref.mp3"],
  });
  assert.equal(parsed.success, true);
  assert.equal(CreateGenerationBody.safeParse({
    ...generationInput, model: "seedance-2.5", seedanceTask: "unknown",
  }).success, false);
  assert.equal(CreateGenerationBody.strict().safeParse({
    ...generationInput, model: "seedance-2.5", image_url: "https://arbitrary.example/reference.png",
  }).success, false);
});