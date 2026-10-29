import assert from "node:assert/strict";
import { test } from "node:test";
import { productionRerenderPrompt, productionRetrySeed, productionShotPrompt } from "./production-shot-prompt";

test("unchanged-prompt local re-renders use a new seed while initial renders retain their seed", () => {
  assert.equal(productionRetrySeed(42, 0), 42);
  assert.equal(productionRetrySeed(42, 1), 43);
  assert.equal(productionRetrySeed(42, 2), 44);
  assert.equal(productionRetrySeed(4294967295, 1), 0);
});

test("a re-render without a correction preserves the exact shot prompt", () => {
  const prompt = "  Visual: Open the door.\nDialogue: Wait.\nCorrection: Keep the same coat.\n";
  for (const correction of [undefined, null, "", "   \n"]) {
    assert.equal(productionRerenderPrompt(prompt, correction), prompt);
  }
  const longPrompt = "x".repeat(20000);
  assert.equal(productionRerenderPrompt(longPrompt), longPrompt);
});

test("optional corrections still append only an explicitly supplied instruction", () => {
  assert.equal(productionRerenderPrompt("Existing shot", " Keep the coat. "), "Existing shot\nCorrection: Keep the coat.");
  assert.equal(productionRerenderPrompt("x".repeat(19999), "Keep the coat.").length, 20000);
  assert.throws(() => productionRerenderPrompt("Existing shot", 123), /Correction/);
  assert.throws(() => productionRerenderPrompt("Existing shot", "x".repeat(5001)), /Correction/);
});

test("legacy screenplay suffix is removed while shot corrections remain", () => {
  const story = "SCENE 1 — LIGHTHOUSE\nMARA: It's a fuse.\nSCENE 2 — HARBOR\nOWEN: Wait.";
  const prompt = `Visual: Mara opens the panel.\n\nPROJECT VISUAL DIRECTION\n${story}\nCorrection: Keep her yellow raincoat.`;
  assert.equal(productionShotPrompt(prompt, story), "Visual: Mara opens the panel.\nCorrection: Keep her yellow raincoat.");
});

test("unrelated visual direction and shot dialogue are preserved", () => {
  const prompt = "Mara opens the panel.\n\nPROJECT VISUAL DIRECTION\nBlue lighting.";
  assert.equal(productionShotPrompt(prompt, "A lighthouse story"), prompt);
  assert.equal(productionShotPrompt("MARA: It's a fuse.", ""), "MARA: It's a fuse.");
});
