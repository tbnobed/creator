import assert from "node:assert/strict";
import { test } from "node:test";

import { compileMiniMaxH3PromptForTest, type GenerationRequest } from "./generation-service";

const characters = [
  { id: "maya", name: "Maya", promptDescription: "A host with dark hair and a cream blouse." },
];
const setting = {
  name: "Wellness Podcast Studio",
  promptDescription: "A warm studio with walnut panels and broadcast microphones.",
};
const request: GenerationRequest = {
  tenantId: "tenant",
  createdByUserId: "creator",
  characterIds: ["maya"],
  settingId: "studio",
  prompt: "talking about love and sorrow",
  generationMode: "r2v",
  durationSeconds: 5,
  fps: 24,
  width: 1280,
  height: 720,
  qualityPreset: "DRAFT",
  seedMode: "FIXED",
  seed: 25002,
};

test("single-video H3 prompt includes the selected cast and environment without name mentions", () => {
  const prompt = compileMiniMaxH3PromptForTest(characters, setting, request);
  assert.match(prompt, /<Subject 1> is Maya, whose appearance and identity/);
  assert.match(prompt, /<Subject 2> is the referenced environment: A warm studio/);
  assert.match(prompt, /using <Subject 1>, <Subject 2>/);
  assert.match(prompt, /<Subject 1> appears with the referenced identity fully preserved/);
  assert.match(prompt, /The shot takes place in <Subject 2>/);
  assert.match(prompt, /talking about love and sorrow/);
  assert.doesNotMatch(prompt, /No supplied reference subject is required/);
});

test("long-form B-roll still omits project cast and setting not called for by the shot", () => {
  const prompt = compileMiniMaxH3PromptForTest(characters, setting, {
    ...request,
    longFormShotId: "b-roll-shot",
    prompt: "A wide landscape with rolling clouds.",
  });
  assert.match(prompt, /No supplied reference subject is required/);
  assert.doesNotMatch(prompt, /<Subject 1> is Maya|<Subject 2> is the referenced environment/);
});

test("long-form shots still retain explicitly mentioned references", () => {
  const prompt = compileMiniMaxH3PromptForTest(characters, setting, {
    ...request,
    longFormShotId: "cast-shot",
    prompt: "Maya speaks in the Wellness Podcast Studio.",
  });
  assert.match(prompt, /<Subject 1> is Maya/);
  assert.match(prompt, /<Subject 2> is the referenced environment/);
});

test("single-video H3 reference-video prompt retains selected assets and source audio rules", () => {
  const prompt = compileMiniMaxH3PromptForTest(characters, setting, {
    ...request,
    referenceVideoKey: "presenter.mp4",
  });
  assert.match(prompt, /<Subject 1> is Maya/);
  assert.match(prompt, /<Subject 2> is the referenced environment/);
  assert.match(prompt, /<Audio 1> is the synchronized original audio track/);
  assert.match(prompt, /Reuse <Audio 1> as the synchronized output audio/);
});