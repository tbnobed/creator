import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, analyzePrompt } from "./prompt-guidance";

test("builder joins subject and action and preserves the authored style", () => {
  const prompt = buildPrompt({
    subject: "an elderly potter…", action: "shapes a clay bowl.",
    composition: "medium close-up.", setting: "a studio", lighting: "warm", style: "painterly",
  });
  assert.match(prompt, /^An elderly potter shapes a clay bowl\. Medium close-up\./);
  assert.match(prompt, /Visual style: painterly\./);
  assert.doesNotMatch(prompt, /live-action|cinematic|\.\./i);
});

test("camera direction satisfies the motion-readiness hint", () => {
  const issues = analyzePrompt({ prompt: "A bird perched on a branch in sunlight.", cameraInstructions: "slow lateral tracking shot" });
  assert.equal(issues.some(issue => issue.message.includes("Add motion behavior")), false);
});
