import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMiniMaxH3R2vVideoWorkflow,
  createMiniMaxH3R2vWorkflow,
  miniMaxH3R2vSeed,
  miniMaxH3R2vVideoSeed,
} from "./seed-data/minimax-h3-r2v";
import { hasRequiredTags, selectServer } from "./comfy/scheduler";

function modelPair(workflow: Record<string, { inputs: Record<string, unknown> }>) {
  return {
    unet: workflow["127"]?.inputs.unet_name,
    clip: workflow["128"]?.inputs.clip_name,
  };
}

test("MiniMax H3 seed factories keep each worker's UNet and CLIP pair aligned", () => {
  assert.deepEqual(
    modelPair(createMiniMaxH3R2vWorkflow(
      miniMaxH3R2vSeed.a100.clipName,
      miniMaxH3R2vSeed.a100.unetName,
    )),
    {
      unet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      clip: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    },
  );
  assert.deepEqual(
    modelPair(createMiniMaxH3R2vWorkflow(
      miniMaxH3R2vSeed.blackwell.clipName,
      miniMaxH3R2vSeed.blackwell.unetName,
    )),
    {
      unet: "minimax_h3_ref2va_pruned_nvfp4.safetensors",
      clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
  );
  assert.deepEqual(
    modelPair(createMiniMaxH3R2vVideoWorkflow(
      miniMaxH3R2vVideoSeed.blackwell.clipName,
      miniMaxH3R2vVideoSeed.blackwell.unetName,
    )),
    {
      unet: "minimax_h3_ref2va_pruned_nvfp4.safetensors",
      clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    },
  );
});

test("MiniMax H3 factory remains backward-compatible with the original A100 call shape", () => {
  assert.deepEqual(
    modelPair(createMiniMaxH3R2vWorkflow(miniMaxH3R2vSeed.a100.clipName)),
    {
      unet: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      clip: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    },
  );
});

function server(id: string, tags: string[]) {
  return {
    id,
    displayName: id,
    hostname: `${id}.local`,
    apiBaseUrl: `http://${id}.local`,
    websocketUrl: `ws://${id}.local`,
    gpuName: null,
    vramGb: null,
    tags,
    enabled: true,
    priority: 0,
    maxConcurrentJobs: 1,
    status: "ONLINE",
    queueSize: 0,
    activeJobCount: 0,
    memoryUsedGb: null,
    lastHeartbeat: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Parameters<typeof selectServer>[0][number];
}

test("scheduler keeps hardware-specific workflows on the matching worker", () => {
  const a100 = server("a100", ["minimax-h3", "a100"]);
  const blackwell = server("blackwell", ["minimax-h3", "blackwell"]);

  assert.equal(hasRequiredTags(a100.tags, ["minimax-h3", "blackwell"]), false);
  assert.equal(hasRequiredTags(blackwell.tags, ["minimax-h3", "a100"]), false);
  assert.equal(selectServer([a100, blackwell], ["minimax-h3", "a100"])?.id, "a100");
  assert.equal(selectServer([a100, blackwell], ["minimax-h3", "blackwell"])?.id, "blackwell");
});

test("scheduler rejects ambiguous legacy hardware tags for a model-specific workflow", () => {
  assert.equal(
    hasRequiredTags(["minimax-h3", "a100", "blackwell"], ["minimax-h3", "blackwell"]),
    false,
  );
});