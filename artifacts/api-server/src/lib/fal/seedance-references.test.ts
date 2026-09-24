import assert from "node:assert/strict";
import { test } from "node:test";

import { falModelFromEndpoint, falModels, falSeedanceReferenceModels, normalizeFalRequest } from "./client";
import { planSeedanceReferences, seedanceReferencePrompt } from "../generation-service";
import { quoteVideoSpend } from "../spending-pricing";

const maya = { id: "maya", name: "Maya" };
const studio = { name: "Wellness Podcast Studio" };
const assets = [
  { characterId: "maya", storageKey: "wardrobe.jpg", mimeType: "image/jpeg", label: "wardrobe", isPrimary: false },
  { characterId: "maya", storageKey: "alternate.jpg", mimeType: "image/jpeg", isPrimary: false },
  { characterId: "maya", storageKey: "primary.png", mimeType: "image/png", isPrimary: true },
];

test("selected Seedance character and environment bind to primary images in prompt order", () => {
  const refs = planSeedanceReferences([maya], assets, studio, [
    { storageKey: "studio.webp", mimeType: "image/webp" },
  ]);
  assert.deepEqual(refs.map((ref) => ref.storageKey), ["primary.png", "studio.webp"]);
  const prompt = seedanceReferencePrompt("ACTION\nLooking at the camera.", refs);
  assert.match(prompt, /@Image1 is Maya's appearance reference/);
  assert.match(prompt, /@Image2 is the visual reference for Wellness Podcast Studio/);
  assert.match(prompt, /ACTION\nLooking at the camera/);
});

test("Seedance does not silently send selected characters as text only", () => {
  assert.throws(() => planSeedanceReferences([maya], [], undefined, []), /Maya has no character reference image/);
  assert.throws(() => planSeedanceReferences([], [], studio, []), /has no environment reference image/);
  const tooMany = Array.from({ length: 10 }, (_, n) => ({ id: `person-${n}`, name: `Person ${n}` }));
  const refs = tooMany.map((character) => ({
    characterId: character.id, storageKey: `${character.id}.jpg`, mimeType: "image/jpeg",
  }));
  assert.throws(() => planSeedanceReferences(tooMany, refs, undefined, []), /at most 9 reference images/);
});

test("Seedance reference endpoints remain recoverable and priced without changing text-only requests", async () => {
  for (const model of ["seedance-2.0-mini", "seedance-2.0"] as const) {
    assert.equal(falModelFromEndpoint(falModels[model]), model);
    assert.equal(falModelFromEndpoint(falSeedanceReferenceModels[model]), model);
    const normalized = normalizeFalRequest(model, {
      prompt: "Maya speaks.", width: 1280, height: 720, durationSeconds: 5,
      fps: 24, qualityPreset: "STANDARD",
    });
    assert.equal("image_urls" in normalized.input, false);
    const textQuote = await quoteVideoSpend(falModels[model], {
      duration: normalized.durationSeconds, resolution: String(normalized.input.resolution),
    });
    const referenceQuote = await quoteVideoSpend(falSeedanceReferenceModels[model], {
      duration: normalized.durationSeconds, resolution: String(normalized.input.resolution),
    });
    assert.equal(referenceQuote.estimatedUsd, textQuote.estimatedUsd);
  }
});