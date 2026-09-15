import assert from "node:assert/strict";
import { test } from "node:test";
import { GetCharacterDossierResponse } from "@workspace/api-zod";
import type { ImageStudioJob } from "@workspace/db";
import {
  characterAssetJobReferences,
  hasApprovalReferences,
  isCharacterAssetLabel,
  mergeDossierValues,
  missingWardrobeReferences,
  normalizeDossier,
  presentCharacterImageGeneration,
  revisionMatches,
} from "./character-dossier-service";

test("approval validation requires both a headshot and an appearance view", () => {
  assert.equal(hasApprovalReferences(["headshot"]), false);
  assert.equal(hasApprovalReferences(["full-body"]), false);
  assert.equal(hasApprovalReferences(["headshot", "three-quarter"]), true);
});

test("reference labels are a closed set and legacy labels are not accepted as new metadata", () => {
  assert.equal(isCharacterAssetLabel("headshot"), true);
  assert.equal(isCharacterAssetLabel("other"), true);
  assert.equal(isCharacterAssetLabel("AI generated reference"), false);
  assert.equal(isCharacterAssetLabel(undefined), false);
});

test("wardrobe references must all be in the tenant-owned Image Studio set", () => {
  assert.deepEqual(
    missingWardrobeReferences(["owned", "cross-tenant", "owned"], ["owned"]),
    ["cross-tenant"],
  );
});

test("active character jobs protect both source snapshots and generated outputs", () => {
  const asset = { id: "source", storageKey: "characters/source.png" };
  const base = {
    status: "QUEUED",
    referenceAssetIds: [],
    outputStorageKey: null,
    providerTaskMetadata: {},
  };
  assert.equal(characterAssetJobReferences({
    ...base,
    referenceAssetIds: ["source"],
  }, asset), true);
  assert.equal(characterAssetJobReferences({
    ...base,
    providerTaskMetadata: { sourceReference: { assetId: "source" } },
  }, asset), true);
  assert.equal(characterAssetJobReferences({
    ...base,
    outputStorageKey: asset.storageKey,
  }, asset), true);
  assert.equal(characterAssetJobReferences({
    ...base,
    status: "COMPLETED",
    outputStorageKey: asset.storageKey,
  }, asset), false);
});

test("dossier approval uses an exact optimistic revision", () => {
  assert.equal(revisionMatches(4, 4), true);
  assert.equal(revisionMatches(4, 3), false);
});

test("partial compare-and-swap updates preserve the latest validated dossier fields", () => {
  const latest = normalizeDossier({
    role: "Detective",
    performanceNotes: "Keep the delivery restrained",
    wardrobes: [{
      id: "coat",
      name: "Raincoat",
      description: "Dark wool",
      referenceAssetId: null,
    }],
  });
  assert.deepEqual(
    mergeDossierValues(latest, { performanceNotes: "More urgency" }),
    {
      role: "Detective",
      performanceNotes: "More urgency",
      wardrobes: latest.wardrobes,
    },
  );
});

test("concurrent dossier writers allow one revision winner and reject the stale writer", () => {
  let revision = 8;
  const compareAndSwap = (expected: number): boolean => {
    if (!revisionMatches(revision, expected)) return false;
    revision += 1;
    return true;
  };

  assert.equal(compareAndSwap(8), true);
  assert.equal(compareAndSwap(8), false);
  assert.equal(revision, 9);
});

test("invalidation revision is not reusable for an approval attempt", () => {
  const approvedRevision = 12;
  const invalidatedRevision = approvedRevision + 1;
  assert.equal(revisionMatches(invalidatedRevision, approvedRevision), false);
  assert.equal(revisionMatches(invalidatedRevision, invalidatedRevision), true);
});

test("dossier image-generation serialization round-trips persisted model fields through the API schema", () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const job = {
    id: "job-legacy",
    tenantId: "tenant",
    createdByUserId: "user",
    requestKey: null,
    modelId: "local-flux2-klein-4b",
    modelName: "FLUX.2 Klein 4B",
    provider: "LOCAL",
    operation: "edit",
    prompt: "Preserve the source identity.",
    negativePrompt: null,
    width: 768,
    height: 1024,
    count: 1,
    seed: 42,
    referenceAssetIds: [],
    maskAssetId: null,
    characterId: "character",
    referenceLabel: "headshot",
    status: "COMPLETED",
    errorMessage: null,
    providerRequestId: "legacy-provider-request",
    providerTaskMetadata: {},
    comfyServerId: null,
    outputStorageKey: "characters/job-legacy.png",
    outputMimeType: "image/png",
    submittedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  } as ImageStudioJob;
  const response = {
    role: "",
    performanceNotes: "",
    wardrobes: [],
    status: "DRAFT",
    revision: 1,
    approvedAt: null,
    assets: [],
    imageGeneration: presentCharacterImageGeneration(job, null),
  };
  const parsed = GetCharacterDossierResponse.parse(response);
  assert.equal(parsed.imageGeneration?.modelId, job.modelId);
  assert.equal(parsed.imageGeneration?.modelName, job.modelName);
  assert.equal(parsed.imageGeneration?.provider, job.provider);
});

test("terminal Cloud dossier jobs do not expose the legacy ongoing image-worker error", () => {
  const job = {
    id: "job-terminal-cloud",
    tenantId: "tenant",
    createdByUserId: "user",
    requestKey: null,
    modelId: "cloud-nano-banana-pro",
    modelName: "Nano Banana Pro",
    provider: "CLOUD",
    operation: "generate",
    prompt: "A production character reference.",
    negativePrompt: null,
    width: 768,
    height: 1024,
    count: 1,
    seed: 42,
    referenceAssetIds: [],
    maskAssetId: null,
    characterId: "character",
    referenceLabel: "headshot",
    status: "FAILED",
    errorMessage: "The image worker submission is still being reconciled. No duplicate render will be submitted.",
    providerRequestId: null,
    providerTaskMetadata: {},
    comfyServerId: null,
    outputStorageKey: null,
    outputMimeType: null,
    submittedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as ImageStudioJob;
  const presented = presentCharacterImageGeneration(job, null);
  assert.equal(
    presented.errorMessage,
    "Cloud image submission status could not be confirmed. No duplicate render was submitted.",
  );
});