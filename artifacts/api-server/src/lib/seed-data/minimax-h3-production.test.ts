import assert from "node:assert/strict";
import test from "node:test";
import { createMiniMaxH3ProductionWorkflow, productionMappings } from "./minimax-h3-production";
import { productionWorkflowCapability } from "../comfy/production-capability";
import { buildWorkflow } from "../comfy/workflow-builder";

test("native guide anchors frame zero without consuming reference slots", () => {
  for (const blackwell of [false, true]) {
    const graph = createMiniMaxH3ProductionWorkflow(blackwell);
    assert.deepEqual(productionWorkflowCapability(graph, productionMappings), {
      supportsFirstFrame: true, referenceImageSlots: 3,
    });
    const built = buildWorkflow(graph, productionMappings, {
      firstFrame: "previous.png", referenceImage1: "cast.png",
      referenceImage2: "wardrobe.png", referenceImage3: "scenery.png",
    }) as typeof graph;
    assert.equal(built["140"].inputs.image, "previous.png");
    assert.equal(built["141"].class_type, "MiniMaxH3AddGuide");
    assert.equal(built["141"].inputs.frame_idx, 0);
    assert.deepEqual(built["126"].inputs.conditioning, ["141", 0]);
    assert.deepEqual(built["136"].inputs["ref_images.ref_image_2"], ["142", 0]);
  }
});
