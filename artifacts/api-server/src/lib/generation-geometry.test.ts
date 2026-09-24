import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMiniMaxH3R2vWorkflow,
  miniMaxH3R2vSeed,
  r2vMappings,
} from "./seed-data/minimax-h3-r2v";
import { buildWorkflow } from "./comfy/workflow-builder";
import { normalizeMiniMaxH3SubmissionGeometry, validateMiniMaxH3WorkerModelPair } from "./generation-service";

test("MiniMax H3 rounds requested 1080p to its 32px model grid", () => {
  const geometry = normalizeMiniMaxH3SubmissionGeometry({
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    fps: 24,
  });

  assert.equal(geometry.width, 1920);
  assert.equal(geometry.height, 1088);
});

test("MiniMax H3 uses the seeded 5 + 17n input-length grid", () => {
  const expectedFrameCounts = new Map([
    [5, 124],
    [6, 158],
    [7, 175],
    [8, 192],
  ]);

  for (const [durationSeconds, expectedFrameCount] of expectedFrameCounts) {
    const geometry = normalizeMiniMaxH3SubmissionGeometry({
      width: 1920,
      height: 1080,
      durationSeconds,
      fps: 24,
    });
    assert.equal(geometry.frameCount, expectedFrameCount);
    assert.ok(geometry.effectiveDurationSeconds >= durationSeconds);
    assert.equal(geometry.frameCount % 17, 5 % 17);
  }
});

test("H3 dry graph receives effective dimensions while retaining authored duration", () => {
  const geometry = normalizeMiniMaxH3SubmissionGeometry({
    width: 1920,
    height: 1080,
    durationSeconds: 5,
    fps: 24,
  });
  const graph = buildWorkflow(
    createMiniMaxH3R2vWorkflow(miniMaxH3R2vSeed.blackwell.clipName),
    r2vMappings,
    {
      width: geometry.width,
      height: geometry.height,
      durationSeconds: geometry.requestedDurationSeconds,
      fps: 24,
    },
  ) as Record<string, { inputs: Record<string, unknown> }>;

  assert.equal(graph["136"].inputs.width, 1920);
  assert.equal(graph["136"].inputs.height, 1088);
  assert.equal(graph["132"].inputs.value, 5);
  assert.equal(
    graph["131"].inputs.expression,
    "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
  );
  assert.deepEqual(graph["136"].inputs.length, ["131", 1]);
});

test("MiniMax H3 fails closed for non-24fps requests", () => {
  assert.throws(
    () => normalizeMiniMaxH3SubmissionGeometry({
      width: 1920,
      height: 1080,
      durationSeconds: 5,
      fps: 30,
    }),
    /require 24 fps/,
  );
});

test("MiniMax H3 rejects a seeded A100 UNet paired with a Blackwell worker before submission", () => {
  const graph = createMiniMaxH3R2vWorkflow(
    miniMaxH3R2vSeed.blackwell.clipName,
    miniMaxH3R2vSeed.a100.unetName,
  );
  assert.throws(
    () => validateMiniMaxH3WorkerModelPair(graph, ["minimax-h3", "blackwell"]),
    /model files do not match/,
  );
  graph["127"].inputs.unet_name = miniMaxH3R2vSeed.blackwell.unetName;
  assert.doesNotThrow(() => validateMiniMaxH3WorkerModelPair(graph, ["minimax-h3", "blackwell"]));
  assert.throws(
    () => validateMiniMaxH3WorkerModelPair(graph, ["minimax-h3", "a100"]),
    /model files do not match/,
  );
});