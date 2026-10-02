import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerSourceLoadState,
  ComposerModelSelection,
  generationEditDestination,
  localPipelineError,
  restoreComposerFields,
} from "./generation-edit";

const ltxFirstCapabilities = [
  { generationMode: "LTX", supportsReferenceVideo: false },
  { generationMode: "Wan", supportsReferenceVideo: false },
];

test("saved Wan selection survives LTX-first capabilities arriving after draft restoration", () => {
  const selection = new ComposerModelSelection("Wan", null);
  assert.equal(selection.initialMode(null, undefined), undefined);
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), undefined);
  assert.equal(localPipelineError("Wan", ltxFirstCapabilities), null);
});

test("only a fresh composer without a saved selection chooses a capability default", () => {
  const selection = new ComposerModelSelection(undefined, null);
  assert.equal(selection.initialMode(null, []), undefined);
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), "LTX");
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), undefined);
});

test("explicit pipeline edit before delayed capabilities wins over their default", () => {
  const selection = new ComposerModelSelection(undefined, null);
  selection.selectExplicitly(null);
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), undefined);
});

test("explicit model selection during delayed clone load wins over clone prefill", () => {
  const selection = new ComposerModelSelection(undefined, "clone-ltx");
  assert.equal(selection.initialMode("clone-ltx", ltxFirstCapabilities), undefined);
  selection.selectExplicitly("clone-ltx");
  assert.equal(selection.needsRestore("clone-ltx", undefined), false);
  assert.equal(selection.needsRestore("clone-ltx", "clone-ltx"), true);
  // Other clone fields may restore, but provider/model/pipeline must not.
  assert.equal(selection.restoreSelection("clone-ltx"), false);
  assert.equal(selection.needsRestore("clone-ltx", "clone-ltx"), false);
});

test("cloned LTX restores once, then switching to Wan survives clone refetches", () => {
  const selection = new ComposerModelSelection(undefined, "clone-ltx");
  assert.equal(selection.initialMode("clone-ltx", ltxFirstCapabilities), undefined);
  assert.equal(selection.needsRestore("clone-ltx", "clone-ltx"), true);
  assert.equal(selection.restoreSelection("clone-ltx"), true);
  selection.selectExplicitly("clone-ltx");
  assert.equal(selection.needsRestore("clone-ltx", "clone-ltx"), false);
  assert.equal(selection.initialMode("clone-ltx", ltxFirstCapabilities), undefined);
  assert.equal(localPipelineError("Wan", ltxFirstCapabilities), null);
});

test("cloneJob changes restore the new source and reject stale previous query data", () => {
  const selection = new ComposerModelSelection(undefined, "clone-ltx");
  selection.restoreSelection("clone-ltx");
  selection.selectExplicitly("clone-ltx");
  assert.equal(selection.needsRestore("clone-wan", "clone-ltx"), false);
  assert.equal(selection.initialMode("clone-wan", ltxFirstCapabilities), undefined);
  assert.equal(selection.needsRestore("clone-wan", "clone-wan"), true);
  assert.equal(selection.restoreSelection("clone-wan"), true);
  assert.equal(selection.needsRestore("clone-ltx", "clone-ltx"), true);
  assert.equal(selection.restoreSelection("clone-ltx"), true);
});

test("unavailable saved mode is preserved and blocks submission until an explicit valid choice", () => {
  const selection = new ComposerModelSelection("retired-wan", null);
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), undefined);
  assert.match(localPipelineError("retired-wan", ltxFirstCapabilities)!, /unavailable.*Choose an available pipeline/);
  assert.match(localPipelineError("retired-wan", undefined)!, /Loading local pipelines/);
  assert.match(localPipelineError("retired-wan", [])!, /unavailable/);
  selection.selectExplicitly(null);
  assert.equal(localPipelineError("Wan", ltxFirstCapabilities), null);
  assert.equal(selection.initialMode(null, ltxFirstCapabilities), undefined);
});

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
      nativeAudioEnabled: null,
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
  assert.equal(restored.nativeAudioEnabled, null);
});

test("Seedance edit preserves explicit native sound choice including silence", () => {
  for (const enabled of [true, false]) {
    const restored = restoreComposerFields({
      provider: "FAL", providerModelId: "bytedance/seedance-2.0/enterprise/mini/reference-to-video",
      providerTaskMetadata: { nativeAudioEnabled: enabled },
      voiceCloningEnabled: false, characterIds: [], settingId: null, referenceVideoKey: null,
      prompt: "Maya speaks.", dialogue: "Love is necessary.", negativePrompt: null,
      cameraInstructions: "", motionInstructions: "", generationMode: "txt2vid",
      durationSeconds: 5, fps: 24, requestedWidth: 1280, requestedHeight: 720,
      requestedDurationSeconds: 5, qualityPreset: "STANDARD",
    }, { "bytedance/seedance-2.0/enterprise/mini/reference-to-video": "seedance-2.0-mini" });
    assert.equal(restored.nativeAudioEnabled, enabled);
  }
});