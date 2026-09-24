import assert from "node:assert/strict";
import { test } from "node:test";
import { CreateGenerationBody, CreateLongFormProjectBody } from "@workspace/api-zod";
import { buildWorkflow, type ParameterMappings } from "./comfy/workflow-builder";
import {
  completionVoiceCharacterId,
  compileLongFormPromptForTest,
  planContinuityReferenceSlots,
} from "./generation-service";
import { characterIdsForLongFormShot, retryLongFormShotError } from "./long-form-service";
import {
  invalidatedStillValues,
  missingApprovedContinuityShot,
} from "./continuity-service";
import { assertOwnedAssetSelections, ResourceNotFoundError } from "./resource-errors";

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

test("anonymous H3 long-form dispatch preserves an empty cast", () => {
  const projectInput = {
    title: "Anonymous B-roll",
    script: "B-ROLL 1: Empty broadcast facility",
    targetDurationSeconds: 5,
    generationMode: "H3",
    width: 1280,
    height: 720,
    fps: 24,
    qualityPreset: "DRAFT",
  };
  assert.equal(CreateLongFormProjectBody.safeParse(projectInput).success, true);
  assert.equal(CreateLongFormProjectBody.safeParse({
    ...projectInput,
    characterIds: [],
    settingId: null,
  }).success, true);
  const suppliedAssets = CreateLongFormProjectBody.parse({
    ...projectInput,
    characterIds: ["owned-character"],
    settingId: "owned-setting",
  });
  assert.deepEqual(suppliedAssets.characterIds, ["owned-character"]);
  assert.equal(suppliedAssets.settingId, "owned-setting");

  const generationInput = {
    prompt: "A wide broadcast facility stage.",
    generationMode: "H3",
    durationSeconds: 5,
    fps: 24,
    width: 1280,
    height: 720,
    qualityPreset: "DRAFT",
    seedMode: "RANDOM",
  };
  assert.equal(CreateGenerationBody.safeParse(generationInput).success, true);
  assert.equal(CreateGenerationBody.safeParse({
    ...generationInput,
    characterIds: [],
    settingId: null,
  }).success, true);
  assert.doesNotThrow(() => assertOwnedAssetSelections({
    characterIds: ["owned-character"],
    foundCharacterIds: ["owned-character"],
    settingId: "owned-setting",
    settingFound: true,
  }));
  assert.throws(() => assertOwnedAssetSelections({
    characterIds: ["foreign-character"],
    foundCharacterIds: [],
    settingFound: true,
  }), ResourceNotFoundError);
  assert.throws(() => assertOwnedAssetSelections({
    characterIds: [],
    foundCharacterIds: [],
    settingId: "foreign-setting",
    settingFound: false,
  }), ResourceNotFoundError);

  const characterIds = characterIdsForLongFormShot([], {
    characterIds: [],
    continuity: { voiceCloningEnabled: false },
  });
  assert.deepEqual(characterIds, []);
  assert.equal(completionVoiceCharacterId(null, characterIds), null);

  const prompt = compileLongFormPromptForTest([], {
    tenantId: "tenant",
    createdByUserId: "creator",
    characterIds,
    prompt: "A wide broadcast facility stage with empty seats and soft practical lighting.",
    generationMode: "H3",
    durationSeconds: 5,
    fps: 24,
    width: 1280,
    height: 720,
    qualityPreset: "DRAFT",
    seedMode: "RANDOM",
  });
  assert.match(prompt, /No supplied reference subject is required/);
  assert.doesNotMatch(prompt, /<Subject 1>|CHARACTERS|first-character/i);
});

test("long-form retry eligibility keeps failed and cancelled shots available without bypassing active states", () => {
  for (const shotStatus of ["FAILED", "CANCELLED"]) {
    assert.equal(retryLongFormShotError(shotStatus, "FAILED"), undefined);
    assert.equal(retryLongFormShotError(shotStatus, "RUNNING"), undefined);
    assert.equal(retryLongFormShotError(shotStatus, "CANCELLED"), undefined);
    assert.match(retryLongFormShotError(shotStatus, "ASSEMBLING") ?? "", /assembly finishes/i);
  }
  assert.match(retryLongFormShotError("RENDERING", "RUNNING") ?? "", /Only failed, cancelled, or completed/i);
  assert.equal(retryLongFormShotError("COMPLETED", "EDITING"), undefined);
  assert.equal(retryLongFormShotError("COMPLETED", "RUNNING", false, 2), undefined);
  assert.match(retryLongFormShotError("COMPLETED", "RUNNING", true, 0) ?? "", /Pause production/i);
  assert.match(retryLongFormShotError("COMPLETED", "PAUSED", true, 1) ?? "", /active renders/i);
  assert.equal(retryLongFormShotError("COMPLETED", "PAUSED", true, 0), undefined);
});
