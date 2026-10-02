import assert from "node:assert/strict";
import test from "node:test";
import { createLtx25T2vWorkflow, ltx25T2vMappings, ltx25T2vSeed } from "./ltx-25";
import { upgradeLegacyLtxFps } from "./ltx-25-upgrade";

function legacyRow() {
  const apiWorkflow = createLtx25T2vWorkflow();
  apiWorkflow["33"].class_type = "PrimitiveInt";
  return { ...ltx25T2vSeed, modelFamily: "LTX 2.5", mappings: ltx25T2vMappings, apiWorkflow };
}
test("legacy seeded FPS INT is upgraded without mutating the stored graph", () => {
  const row = legacyRow();
  const fixed = upgradeLegacyLtxFps(row)!;
  assert.equal(fixed["33"].class_type, "PrimitiveFloat");
  assert.equal(row.apiWorkflow["33"].class_type, "PrimitiveInt");
  for (const [id, input] of [["5", "frame_rate"], ["9", "frame_rate"], ["26", "fps"]]) {
    assert.deepEqual(fixed[id].inputs[input], ["33", 0]);
  }
  assert.equal(upgradeLegacyLtxFps({ ...row, apiWorkflow: fixed }), null);
});
test("custom graphs, names and mappings are not overwritten", () => {
  const row = legacyRow();
  assert.equal(upgradeLegacyLtxFps({ ...row, name: "Custom LTX" }), null);
  assert.equal(upgradeLegacyLtxFps({ ...row, mappings: {} }), null);
  row.apiWorkflow["3"].inputs.text = "Custom prompt";
  assert.equal(upgradeLegacyLtxFps(row), null);
});