import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "./prompt-guidance";

test("builder joins subject and action and preserves the authored style", () => {
  const prompt = buildPrompt({
    subject: "an elderly potter…", action: "shapes a clay bowl.",
    composition: "medium close-up.", setting: "a studio", lighting: "warm", style: "painterly",
  });
  assert.match(prompt, /^An elderly potter shapes a clay bowl\. Medium close-up\./);
  assert.match(prompt, /Visual style: painterly\./);
  assert.doesNotMatch(prompt, /live-action|cinematic|\.\./i);
});
