import assert from "node:assert/strict";
import { test } from "node:test";
import { productionShotPrompt } from "./production-shot-prompt";

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
