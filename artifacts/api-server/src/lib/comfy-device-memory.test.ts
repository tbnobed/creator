import { test } from "node:test";
import assert from "node:assert/strict";
import { comfyDeviceMemory } from "./comfy-device-memory";
test("MIG telemetry uses actual slice capacity, not stale whole-GPU memory", () => {
  assert.equal(comfyDeviceMemory({ vram_total: 42412802048, vram_free: 42074308608, total_memory: 80 * 1024 ** 3 }).vramGb, 39.5);
});
test("legacy telemetry and zero free VRAM work", () => {
  assert.deepEqual(comfyDeviceMemory({ total_memory: 40 * 1024 ** 3, free_memory: 0 }), { vramGb: 40, memoryUsedGb: 40 });
});
test("invalid or missing telemetry is not fabricated", () => {
  assert.deepEqual(comfyDeviceMemory(undefined), { vramGb: null, memoryUsedGb: null });
  assert.equal(comfyDeviceMemory({ vram_total: 100, vram_free: 101 }).memoryUsedGb, null);
});
