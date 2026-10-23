import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflow } from "../comfy/workflow-builder";
import { productionWorkflowCapability } from "../comfy/production-capability";
import { createMiniMaxH3Fl2vaWorkflow, fl2vaMappings, isEmptyFl2vaPlaceholder } from "./minimax-h3-fl2va";

for (const blackwell of [false, true]) {
  test(`FL2VA native frame graph (${blackwell ? "Blackwell" : "Hopper"})`, () => {
    const source = createMiniMaxH3Fl2vaWorkflow(blackwell);
    const graph = buildWorkflow(source, fl2vaMappings, {
      firstFrame: "start.png", lastFrame: "end.png", prompt: "A calm sea.",
      width: 1280, height: 704, durationSeconds: 5, fps: 24, seed: 123,
    }) as typeof source;
    assert.equal(graph["136"].class_type, "MiniMaxH3ImageToVideo");
    assert.deepEqual(graph["136"].inputs.first_frame, ["137", 0]);
    assert.deepEqual(graph["136"].inputs.last_frame, ["139", 0]);
    assert.equal(graph["137"].inputs.image, "start.png");
    assert.equal(graph["139"].inputs.image, "end.png");
    assert.equal(graph["138"].inputs.value, "A calm sea.");
    assert.match(String(graph["127"].inputs.unet_name), blackwell ? /fl2va_pruned_nvfp4/ : /fl2va_pruned_int8_convrot/);
    assert.equal(graph["136"].inputs.audio_vae, undefined);
    assert.equal(graph["136"].inputs.ref_image_size, undefined);
    assert.deepEqual(productionWorkflowCapability(source, fl2vaMappings), {
      supportsFirstFrame: true, referenceImageSlots: 0,
    });
    for (const supplied of [{}, { firstFrame: "start.png" }, { lastFrame: "end.png" }]) {
      const optional = buildWorkflow(source, fl2vaMappings, supplied) as typeof source;
      assert.equal(Boolean(optional["137"]), "firstFrame" in supplied);
      assert.equal(Boolean(optional["139"]), "lastFrame" in supplied);
      for (const node of Object.values(optional)) {
        for (const value of Object.values(node.inputs)) {
          if (Array.isArray(value)) assert.ok(optional[value[0]], `dangling link ${value[0]}`);
        }
      }
    }
    assert.ok(source["137"], "building must not mutate the saved graph");
  });
}

test("only the empty app placeholder is upgraded; imported graphs and mappings survive", () => {
  const empty = { name: "MiniMax H3 FL2VA", modelFamily: "MiniMax H3", apiWorkflow: null, mappings: {} };
  assert.equal(isEmptyFl2vaPlaceholder(empty), true);
  assert.equal(isEmptyFl2vaPlaceholder({ ...empty, apiWorkflow: createMiniMaxH3Fl2vaWorkflow(true) }), false);
  assert.equal(isEmptyFl2vaPlaceholder({ ...empty, mappings: fl2vaMappings }), false);
  assert.equal(isEmptyFl2vaPlaceholder({ ...empty, name: "My custom FL2VA" }), false);
});
