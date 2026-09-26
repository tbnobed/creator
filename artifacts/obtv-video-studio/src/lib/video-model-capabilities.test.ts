import assert from "node:assert/strict";
import { test } from "node:test";
import { seedanceReferenceBudget } from "./video-model-capabilities";

const input = { characterCount: 0, hasSetting: false, images: 0, videos: 0, audio: 0, frames: 0, hasSource: false };

test("Seedance 2.5 includes primary images in its thirty-image cap", () => {
  const tooMany = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 1, images: 30 });
  assert.equal(tooMany.imageCount, 31);
  assert.equal(tooMany.overImageLimit, true);
  const valid = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 9, hasSetting: true });
  assert.equal(valid.imageCount, 10);
  assert.equal(valid.overImageLimit, false);
});

test("Seedance 2.0 rejects nine characters plus a setting", () => {
  const budget = seedanceReferenceBudget("seedance-2.0", "reference", { ...input, characterCount: 9, hasSetting: true });
  assert.equal(budget.imageCount, 10);
  assert.equal(budget.overImageLimit, true);
});

test("Start frames and cast cannot be submitted together", () => {
  const budget = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 1, frames: 2 });
  assert.equal(budget.framesWithPrimary, true);
});

test("Editing counts source plus extra images, ignoring cast, setting and extra videos", () => {
  const budget = seedanceReferenceBudget("seedance-2.5", "editing", { ...input, characterCount: 9, hasSetting: true, images: 30, videos: 4, hasSource: true });
  assert.equal(budget.primaryImages, 0);
  assert.equal(budget.total, 31);
  assert.equal(budget.overImageLimit, false);
});