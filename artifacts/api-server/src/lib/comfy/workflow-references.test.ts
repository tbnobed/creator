import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLtx25T2vWorkflow,
  ltx25T2vMappings,
} from "../seed-data/ltx-25";
import {
  createMiniMaxH3R2vWorkflow,
  miniMaxH3R2vSeed,
  r2vMappings,
} from "../seed-data/minimax-h3-r2v";
import {
  createWan22I2vWorkflow,
  createWan22T2vWorkflow,
  wan22I2vMappings,
  wan22T2vMappings,
} from "../seed-data/wan-22";
import { buildWorkflow, type ParameterMappings } from "./workflow-builder";
import { getWorkflowReferenceRequirements } from "./workflow-references";

type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

function nodes(workflow: Record<string, unknown>): Record<string, WorkflowNode> {
  return workflow as Record<string, WorkflowNode>;
}

function assertNoDanglingLinks(workflow: Record<string, unknown>): void {
  const graph = nodes(workflow);
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number") {
        assert.ok(
          value[0] in graph,
          `node ${nodeId} input ${input} links to missing node ${value[0]}`,
        );
      }
    }
  }
}

test("seeded MiniMax H3 standard variants allow omitted character references", () => {
  for (const variant of Object.values(miniMaxH3R2vSeed)) {
    const workflow = createMiniMaxH3R2vWorkflow(variant.clipName);
    assert.deepEqual(getWorkflowReferenceRequirements(workflow, r2vMappings), {
      requiresCharacterReferences: false,
      requiresSettingReference: false,
    }, variant.name);
  }
});

test("building seeded MiniMax H3 variants without references prunes image nodes and preserves generation parameters", () => {
  const parameters = {
    prompt: "A slow dolly shot through a sunlit conservatory.",
    width: 1024,
    height: 576,
    durationSeconds: 7,
    seed: 8675309,
  };

  for (const variant of Object.values(miniMaxH3R2vSeed)) {
    const built = buildWorkflow(
      createMiniMaxH3R2vWorkflow(variant.clipName),
      r2vMappings,
      parameters,
    );
    const graph = nodes(built);

    assert.equal(
      Object.values(graph).some((node) => node.class_type === "LoadImage"),
      false,
      variant.name,
    );
    assertNoDanglingLinks(built);
    assert.equal(graph["138"].inputs.value, parameters.prompt);
    assert.equal(graph["136"].inputs.width, parameters.width);
    assert.equal(graph["136"].inputs.height, parameters.height);
    assert.equal(graph["132"].inputs.value, parameters.durationSeconds);
    assert.equal(graph["129"].inputs.noise_seed, parameters.seed);
  }
});

test("building MiniMax H3 with character images keeps loaders connected", () => {
  const built = nodes(buildWorkflow(
    createMiniMaxH3R2vWorkflow(miniMaxH3R2vSeed.blackwell.clipName),
    r2vMappings,
    {
      referenceImage1: "/uploads/character-one.png",
      referenceImage2: "/uploads/character-two.png",
    },
  ));

  assert.equal(built["137"].inputs.image, "/uploads/character-one.png");
  assert.equal(built["139"].inputs.image, "/uploads/character-two.png");
  assert.deepEqual(built["136"].inputs["ref_images.ref_image_0"], ["137", 0]);
  assert.deepEqual(built["136"].inputs["ref_images.ref_image_1"], ["139", 0]);
});

test("building without an optional setting image removes its loader and consumer input", () => {
  const workflow = createMiniMaxH3R2vWorkflow(miniMaxH3R2vSeed.blackwell.clipName);
  workflow["140"] = {
    class_type: "LoadImage",
    inputs: { image: "reference-setting.png" },
  };
  workflow["136"].inputs["ref_images.ref_image_2"] = ["140", 0];
  const mappings: ParameterMappings = {
    ...r2vMappings,
    settingImage1: { nodeId: "140", input: "image" },
  };

  assert.deepEqual(getWorkflowReferenceRequirements(workflow, mappings), {
    requiresCharacterReferences: false,
    requiresSettingReference: false,
  });

  const built = nodes(buildWorkflow(workflow, mappings, {}));
  assert.equal("140" in built, false);
  assert.equal("ref_images.ref_image_2" in built["136"].inputs, false);
  assertNoDanglingLinks(built);
});

test("Wan image-to-video keeps its genuinely required image requirement", () => {
  assert.deepEqual(
    getWorkflowReferenceRequirements(createWan22I2vWorkflow(), wan22I2vMappings),
    {
      requiresCharacterReferences: true,
      requiresSettingReference: false,
    },
  );
});

test("Wan and LTX text-to-video workflows require no references", () => {
  assert.deepEqual(
    getWorkflowReferenceRequirements(createWan22T2vWorkflow(), wan22T2vMappings),
    {
      requiresCharacterReferences: false,
      requiresSettingReference: false,
    },
  );
  assert.deepEqual(
    getWorkflowReferenceRequirements(createLtx25T2vWorkflow(), ltx25T2vMappings),
    {
      requiresCharacterReferences: false,
      requiresSettingReference: false,
    },
  );
});

test("unknown and mixed LoadImage consumers fail closed as required", () => {
  const mapping = {
    referenceImage1: { nodeId: "load", input: "image" },
  };
  const optionalConsumer = {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: { "ref_images.ref_image_0": ["load", 0] },
  };

  const unknownConsumerWorkflow = {
    load: { class_type: "LoadImage", inputs: { image: "reference.png" } },
    unknown: { class_type: "UnknownImageConsumer", inputs: { image: ["load", 0] } },
  };
  assert.equal(
    getWorkflowReferenceRequirements(unknownConsumerWorkflow, mapping).requiresCharacterReferences,
    true,
  );

  const mixedConsumerWorkflow = {
    ...unknownConsumerWorkflow,
    optional: optionalConsumer,
  };
  assert.equal(
    getWorkflowReferenceRequirements(mixedConsumerWorkflow, mapping).requiresCharacterReferences,
    true,
  );
});