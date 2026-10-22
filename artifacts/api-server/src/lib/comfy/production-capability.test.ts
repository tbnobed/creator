import test from "node:test";
import assert from "node:assert/strict";
import { productionWorkflowCapability } from "./production-capability";
import { createMiniMaxH3R2vWorkflow, r2vMappings } from "../seed-data/minimax-h3-r2v";
import { createWan22I2vWorkflow, wan22I2vMappings } from "../seed-data/wan-22";

test("H3 references are not first-frame conditioning", () => {
  assert.equal(productionWorkflowCapability(createMiniMaxH3R2vWorkflow("test"), r2vMappings).supportsFirstFrame, false);
});
test("a Wan starting frame alias cannot count as a separate reference", () => {
  assert.deepEqual(productionWorkflowCapability(createWan22I2vWorkflow(), {
    ...wan22I2vMappings, firstFrame: wan22I2vMappings.referenceImage1,
  }), { supportsFirstFrame: true, referenceImageSlots: 0 });
});
test("missing frame node fails closed; independent references retain capacity", () => {
  const mappings = { firstFrame: { nodeId: "frame", input: "image" }, referenceImage1: { nodeId: "cast", input: "image" } };
  assert.equal(productionWorkflowCapability({}, mappings).supportsFirstFrame, false);
  assert.deepEqual(productionWorkflowCapability({ frame: { inputs: { image: "" } } }, mappings),
    { supportsFirstFrame: true, referenceImageSlots: 1 });
});
