import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerSourceLoadState,
  generationEditDestination,
  restoreComposerFields,
} from "./generation-edit";

test("long-form generation edits stay attached to the validated parent shot", () => {
  assert.deepEqual(
    generationEditDestination({
      id: "job-1",
      longFormProjectId: "project-1",
      longFormShotId: "shot-1",
    }),
    { kind: "long-form", path: "/projects/project-1?shot=shot-1" },
  );
});

test("standalone generation edits route through the studio composer", () => {
  assert.deepEqual(
    generationEditDestination({
      id: "job with spaces",
      longFormProjectId: null,
      longFormShotId: null,
    }),
    { kind: "composer", path: "/studio?cloneJob=job%20with%20spaces" },
  );
});

test("partial long-form linkage fails closed instead of opening a detached composer", () => {
  const destination = generationEditDestination({
    id: "job-1",
    longFormProjectId: "project-1",
    longFormShotId: null,
  });
  assert.equal(destination.kind, "invalid");
});

test("unresolved composer sources block submission states", () => {
  assert.equal(composerSourceLoadState({
    cloneJobId: "job-1",
    isLoading: true,
    hasSourceJob: false,
    hasError: false,
  }), "loading");
  assert.equal(composerSourceLoadState({
    cloneJobId: "job-1",
    isLoading: false,
    hasSourceJob: false,
    hasError: true,
  }), "error");
  assert.equal(composerSourceLoadState({
    cloneJobId: null,
    isLoading: false,
    hasSourceJob: false,
    hasError: false,
  }), "idle");
});

test("source restoration replaces stale draft fields and preserves requested geometry", () => {
  assert.deepEqual(
    restoreComposerFields({
      provider: "COMFYUI",
      providerModelId: null,
      voiceCloningEnabled: true,
      characterIds: ["character-1"],
      settingId: "setting-1",
      referenceVideoKey: "tenants/tenant-1/reference.mp4",
      prompt: "A quiet control room.",
      dialogue: "The signal is live.",
      negativePrompt: null,
      cameraInstructions: "Slow push in.",
      motionInstructions: "Subtle monitor flicker.",
      generationMode: "H3",
      durationSeconds: 8,
      fps: 24,
      requestedWidth: 1920,
      requestedHeight: 1080,
      requestedDurationSeconds: 8,
      qualityPreset: "STANDARD",
      seed: null,
    }, {}),
    {
      provider: "COMFYUI",
      model: undefined,
      voiceCloningEnabled: true,
      selectedChars: ["character-1"],
      selectedSetting: "setting-1",
      referenceVideoKey: "tenants/tenant-1/reference.mp4",
      prompt: "A quiet control room.",
      dialogue: "The signal is live.",
      negativePrompt: "",
      cameraInstructions: "Slow push in.",
      motionInstructions: "Subtle monitor flicker.",
      generationMode: "H3",
      duration: 8,
      fps: 24,
      width: 1920,
      height: 1080,
      qualityPreset: "STANDARD",
      seedMode: "RANDOM",
      seed: 0,
    },
  );
});

test("source restoration keeps the original Cloud model instead of a draft model", () => {
  const restored = restoreComposerFields({
    provider: "FAL",
    providerModelId: "fal-ai/veo3.1/fast",
    voiceCloningEnabled: false,
    characterIds: [],
    settingId: null,
    referenceVideoKey: null,
    prompt: "A control room.",
    dialogue: "",
    negativePrompt: "",
    cameraInstructions: "",
    motionInstructions: "",
    generationMode: "txt2vid",
    durationSeconds: 4,
    fps: 24,
    requestedWidth: 1280,
    requestedHeight: 720,
    requestedDurationSeconds: 4,
    qualityPreset: "DRAFT",
    seed: 42,
  }, { "fal-ai/veo3.1/fast": "veo-3.1-fast" });
  assert.equal(restored.provider, "FAL");
  assert.equal(restored.model, "veo-3.1-fast");
  assert.equal(restored.seedMode, "FIXED");
  assert.equal(restored.seed, 42);
});