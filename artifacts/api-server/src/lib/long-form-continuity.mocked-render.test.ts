import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import {
  completionVoiceCharacterId,
  compileLongFormPromptForTest,
  planContinuityReferenceSlots,
} from "./generation-service";
import {
  invalidatedStillValues,
  missingApprovedContinuityShot,
} from "./continuity-service";

test("mocked render injects approved still first and never overwrites setting slots", () => {
  const mappings: ParameterMappings = {
    referenceImage1: { nodeId: "still", input: "image" },
    referenceImage2: { nodeId: "mara", input: "image" },
    referenceImage3: { nodeId: "guest", input: "image" },
    settingImage1: { nodeId: "setting", input: "image" },
  };
  const planned = planContinuityReferenceSlots(mappings, ["approved.png"], ["mara.png", "guest.png", "overflow.png"]);
  assert.deepEqual(planned, [
    { field: "referenceImage1", storageKey: "approved.png" },
    { field: "referenceImage2", storageKey: "mara.png" },
    { field: "referenceImage3", storageKey: "guest.png" },
  ]);
  const workflow = buildWorkflow({
    still: { class_type: "LoadImage", inputs: { image: "" } },
    mara: { class_type: "LoadImage", inputs: { image: "" } },
    guest: { class_type: "LoadImage", inputs: { image: "" } },
    setting: { class_type: "LoadImage", inputs: { image: "canonical-setting.png" } },
  }, mappings, {
    ...Object.fromEntries(planned.map(({ field, storageKey }) => [field, storageKey])),
    settingImage1: "canonical-setting.png",
  });
  const nodes = workflow as Record<string, { inputs: { image: string } }>;
  assert.equal(nodes.still.inputs.image, "approved.png");
  assert.equal(nodes.mara.inputs.image, "mara.png");
  assert.equal(nodes.guest.inputs.image, "guest.png");
  assert.equal(nodes.setting.inputs.image, "canonical-setting.png");
  assert.throws(() => planContinuityReferenceSlots(
    { referenceImage2: mappings.referenceImage2 },
    ["approved.png"],
    [],
  ), /referenceImage1/);
  assert.throws(() => planContinuityReferenceSlots(mappings, ["approved.png", "wardrobe.png"], [], 4), /enough reference image slots/);
});

test("mocked completion uses explicit non-first voice snapshot for local and Cloud paths", () => {
  const cast = ["first-character", "selected-speaker"];
  assert.equal(completionVoiceCharacterId("selected-speaker", cast), "selected-speaker", "local completion");
  assert.equal(completionVoiceCharacterId("selected-speaker", cast), "selected-speaker", "Cloud completion");
  assert.throws(() => completionVoiceCharacterId("foreign-character", cast), /not part/);
});

test("continuity gate and invalidation fail closed without a render submission", () => {
  const shots = [
    { id: "approved", stillStatus: "APPROVED", stillStorageKey: "tenants/t/still.png" },
    { id: "pending", stillStatus: "PENDING", stillStorageKey: "tenants/t/pending.png" },
  ];
  assert.equal(missingApprovedContinuityShot(true, shots)?.id, "pending");
  assert.equal(missingApprovedContinuityShot(false, shots), undefined);
  assert.deepEqual(invalidatedStillValues("tenants/t/still.png", 7), {
    stillStatus: "PENDING",
    stillRevision: 8,
    stillApprovedAt: null,
    stillReviewNote: "Still approval must be renewed after continuity changes.",
  });
  assert.deepEqual(invalidatedStillValues(null, 7), {
    stillStatus: "NONE",
    stillRevision: 8,
    stillApprovedAt: null,
    stillReviewNote: null,
  });
});

test("H3 receives exact dialogue early and concise shot-only continuity context", () => {
  const prompt = compileLongFormPromptForTest([{
    id: "mara",
    name: "Mara",
    promptDescription: "Copper scarf",
  }], {
    tenantId: "tenant",
    createdByUserId: "creator",
    characterIds: ["mara"],
    speakerCharacterId: "mara",
    prompt: "Mara watches the tower.",
    dialogue: "The signal is still alive.",
    continuityContext: "Wardrobe: indigo jacket. Shot emotion: focused.",
    generationMode: "H3",
    durationSeconds: 5,
    fps: 24,
    width: 1280,
    height: 720,
    qualityPreset: "DRAFT",
    seedMode: "RANDOM",
  });
  assert.ok(prompt.indexOf("exact_dialogue") < prompt.indexOf("subject_definitions"));
  assert.match(prompt, /Wardrobe: indigo jacket/);
  assert.doesNotMatch(prompt, /unrelated project bible/i);
});