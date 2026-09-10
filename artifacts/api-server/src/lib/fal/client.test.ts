import assert from "node:assert/strict";
import { test } from "node:test";

import { CreateGenerationBody } from "@workspace/api-zod";

import { falModels, normalizeFalRequest } from "./client";

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

test("CreateGenerationBody rejects more than nine characterIds", () => {
  const characterIds = Array.from({ length: 10 }, (_, index) => `character-${index}`);
  assert.equal(CreateGenerationBody.safeParse({ ...generationInput, characterIds }).success, false);
});

test("CreateGenerationBody requires prompt", () => {
  const { prompt: _prompt, ...inputWithoutPrompt } = generationInput;
  assert.equal(CreateGenerationBody.safeParse(inputWithoutPrompt).success, false);
});