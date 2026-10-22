import assert from "node:assert/strict";
import { test } from "node:test";
import { generationFacts, generationModelLabel } from "./generation-facts";

const base = { status: "COMPLETED", provider: "COMFY", workflowName: "LTX 2.3 (H100)", qualityPreset: "STANDARD", width: 1280, height: 720, durationSeconds: 5, fps: 24, seed: null, createdAt: "2025-01-01T00:00:00Z" };

test("local generation: workflow without GPU suffix, random seed, no optional rows", () => {
  const f = generationFacts(base);
  const get = (k: string) => f.find((x) => x.key === k)?.value;
  assert.equal(get("provider"), "Local GPU / Comfy");
  assert.equal(get("model"), "LTX 2.3");
  assert.equal(get("seed"), "Random");
  assert.equal(get("resolution"), "1280 × 720");
  assert.equal(get("scene"), undefined);
  assert.equal(get("finished"), undefined);
});

test("cloud generation shows paid cloud, friendly model and shot context", () => {
  const f = generationFacts({ ...base, provider: "FAL", providerModelId: "fal-ai/veo3.1/fast", seed: 0, longFormSceneNumber: 2, longFormShotNumber: 3, completedAt: "2025-01-01T00:01:00Z" });
  const get = (k: string) => f.find((x) => x.key === k)?.value;
  assert.equal(get("provider"), "Paid cloud");
  assert.equal(get("model"), "Veo 3.1 Fast");
  assert.equal(get("seed"), "0");
  assert.equal(get("scene"), "2");
  assert.ok(get("finished"));
  assert.equal(generationModelLabel({ provider: "FAL", providerModelId: "x/unknown" }), "x/unknown");
});
