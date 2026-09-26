import assert from "node:assert/strict";
import { test } from "node:test";

import { falModelFromEndpoint, falModels, falSeedanceImageModels, falSeedanceReferenceModels, normalizeFalRequest } from "./client";
import { falSpendQuoteInput, planSeedanceReferences, seedanceReferencePrompt } from "../generation-service";
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
  ], "seedance-2.5");
  assert.deepEqual(refs.map((ref) => ref.storageKey), ["primary.png", "studio.webp"]);
  const prompt = seedanceReferencePrompt("ACTION\nLooking at the camera.", refs);
  assert.match(prompt, /@Image1 is Maya's appearance reference/);
  assert.match(prompt, /@Image2 is the visual reference for Wellness Podcast Studio/);
  assert.match(prompt, /ACTION\nLooking at the camera/);
});

test("Seedance does not silently send selected characters as text only", () => {
  assert.throws(() => planSeedanceReferences([maya], [], undefined, [], "seedance-2.5"), /Maya has no character reference image/);
  assert.throws(() => planSeedanceReferences([], [], studio, [], "seedance-2.5"), /has no environment reference image/);
  const tooMany = Array.from({ length: 10 }, (_, n) => ({ id: `person-${n}`, name: `Person ${n}` }));
  const refs = tooMany.map((character) => ({
    characterId: character.id, storageKey: `${character.id}.jpg`, mimeType: "image/jpeg",
  }));
  assert.throws(() => planSeedanceReferences(tooMany, refs, undefined, [], "seedance-2.0"), /at most 9 image references/);
});

test("Seedance image reference limits are model-specific and count primary plus extra images", () => {
  const characters = Array.from({ length: 9 }, (_, index) => ({
    id: `character-${index}`,
    name: `Character ${index}`,
  }));
  const characterAssets = characters.map((character) => ({
    characterId: character.id,
    storageKey: `${character.id}.jpg`,
    mimeType: "image/jpeg",
  }));
  const settingAssets = [{ storageKey: "setting.jpg", mimeType: "image/jpeg" }];
  assert.equal(
    planSeedanceReferences(characters, characterAssets, { name: "Studio" }, settingAssets, "seedance-2.5").length,
    10,
  );
  assert.throws(
    () => planSeedanceReferences(characters, characterAssets, { name: "Studio" }, settingAssets, "seedance-2.0"),
    /at most 9 image references/,
  );
  assert.throws(
    () => planSeedanceReferences([maya], assets, undefined, [], "seedance-2.5", 30),
    /at most 30 image references/,
  );
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
    assert.equal(normalized.input.generate_audio, false);
    const spoken = normalizeFalRequest(model, {
      prompt: seedanceReferencePrompt("DIALOGUE\nLove is necessary.\n\nACTION\nMaya speaks.", [
        { storageKey: "primary.png", mimeType: "image/png", subject: "Maya", kind: "character" },
      ]),
      dialogue: "Love is necessary.", width: 1280, height: 720, durationSeconds: 5,
      fps: 24, qualityPreset: "STANDARD",
    });
    spoken.input.image_urls = ["data:image/png;base64,cGl4ZWw="];
    assert.equal(spoken.input.generate_audio, true);
    assert.match(String(spoken.input.prompt), /DIALOGUE\nLove is necessary/);
    assert.deepEqual(spoken.input.image_urls, ["data:image/png;base64,cGl4ZWw="]);
    const textQuote = await quoteVideoSpend(falModels[model], {
      duration: normalized.durationSeconds, resolution: String(normalized.input.resolution),
    });
    const referenceQuote = await quoteVideoSpend(falSeedanceReferenceModels[model], {
      duration: normalized.durationSeconds, resolution: String(normalized.input.resolution),
    });
    assert.equal(referenceQuote.estimatedUsd, textQuote.estimatedUsd);
    assert.equal((await quoteVideoSpend(falSeedanceReferenceModels[model], {
      duration: normalized.durationSeconds, resolution: String(normalized.input.resolution), generateAudio: true,
    })).estimatedUsd, referenceQuote.estimatedUsd);
  }
});

test("Seedance 2.5 text, image, and multimodal endpoints recover to the same model", async () => {
  const model = "seedance-2.5";
  for (const endpoint of [falModels[model], falSeedanceImageModels[model], falSeedanceReferenceModels[model]]) {
    assert.equal(falModelFromEndpoint(endpoint), model);
    const quote = await quoteVideoSpend(endpoint, { duration: 5, resolution: "720p" });
    assert.ok(quote.estimatedUsd > 0);
  }
  assert.equal((await quoteVideoSpend(falSeedanceReferenceModels[model], {
    duration: 5, resolution: "1080p",
  })).estimatedUsd, 5.6862);
});

test("Seedance editing auto duration keeps the spend reservation at 30 seconds plus the source video", async () => {
  const normalized = normalizeFalRequest("seedance-2.5", {
    prompt: "Edit the source video.",
    width: 1280,
    height: 720,
    durationSeconds: 4,
    fps: 24,
    qualityPreset: "STANDARD",
    seedanceTask: "editing",
  });
  const quoteInput = falSpendQuoteInput(normalized, { referenceVideoDuration: 12 });
  assert.equal(quoteInput.duration, 30);
  assert.equal(quoteInput.referenceVideoDuration, 12);
  const quote = await quoteVideoSpend(falSeedanceReferenceModels["seedance-2.5"], quoteInput);
  assert.match(quote.pricingNote, /30s output plus 12s of input video/);
});