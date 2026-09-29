import assert from "node:assert/strict";
import { test } from "node:test";
import { seedanceReferenceBudget } from "./video-model-capabilities";

const input = { characterCount: 0, hasSetting: false, images: 0, videos: 0, audio: 0, frames: 0, hasSource: false };

test("Seedance 2.5 includes primary images in its thirty-image cap", () => {
  const tooMany = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 1, images: 30 });
  assert.equal(tooMany.imageCount, 31);
  assert.equal(tooMany.overImageLimit, true);
  const valid = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 9, hasSetting: true });
  assert.equal(valid.imageCount, 10);
  assert.equal(valid.overImageLimit, false);
});

test("Seedance 2.0 rejects nine characters plus a setting", () => {
  const budget = seedanceReferenceBudget("seedance-2.0", "reference", { ...input, characterCount: 9, hasSetting: true });
  assert.equal(budget.imageCount, 10);
  assert.equal(budget.overImageLimit, true);
});

test("Start frames and cast cannot be submitted together", () => {
  const budget = seedanceReferenceBudget("seedance-2.5", "reference", { ...input, characterCount: 1, frames: 2 });
  assert.equal(budget.framesWithPrimary, true);
});

test("Editing counts source plus extra images, ignoring cast, setting and extra videos", () => {
  const budget = seedanceReferenceBudget("seedance-2.5", "editing", { ...input, characterCount: 9, hasSetting: true, images: 30, videos: 4, hasSource: true });
  assert.equal(budget.primaryImages, 0);
  assert.equal(budget.total, 31);
  assert.equal(budget.overImageLimit, false);
});
import { cloudOutputOptions, cloudPromptControls, cloudReferencePayload, elementProblems, effectiveModelDuration, inactiveReferenceRoles, modelAcceptsReferences, VIDEO_MODEL_CAPABILITIES } from "./video-model-capabilities";

const img = (k: string) => ({ storageKey: `tenants/t/generation-references/${k}.png` });
const empty = { start: null, end: null, source: null, images: [], videos: [], audio: [] };

test("Kling 3.0 and Veo 3.1 Fast accept references", () => {
  assert.equal(modelAcceptsReferences("kling-v3-standard"), true);
  assert.equal(modelAcceptsReferences("veo-3.1-fast"), true);
});

test("Kling sends frames and (with a start frame) reference images", () => {
  const p = cloudReferencePayload("kling-v3-standard", "reference", { ...empty, start: img("s"), end: img("e"), images: [img("i")] });
  assert.equal(p.startFrameKey, img("s").storageKey);
  assert.equal(p.endFrameKey, img("e").storageKey);
  assert.deepEqual(p.referenceImageKeys, [img("i").storageKey]);
  assert.equal(p.referenceVideoKeys, undefined);
});

test("End frame without start frame is never sent", () => {
  const p = cloudReferencePayload("veo-3.1-fast", "reference", { ...empty, end: img("e") });
  assert.equal(p.endFrameKey, undefined);
});

test("Veo sends reference images when no frames, and forces 8s", () => {
  const p = cloudReferencePayload("veo-3.1-fast", "reference", { ...empty, images: [img("a"), img("b")] });
  assert.deepEqual(p.referenceImageKeys, [img("a").storageKey, img("b").storageKey]);
  assert.equal(effectiveModelDuration("veo-3.1-fast", 4, { hasReferenceImages: true }), 8);
  assert.equal(VIDEO_MODEL_CAPABILITIES["veo-3.1-fast"].limits.images, 3);
});

test("Veo frames suppress reference images", () => {
  const p = cloudReferencePayload("veo-3.1-fast", "reference", { ...empty, start: img("s"), images: [img("a")] });
  assert.equal(p.referenceImageKeys, undefined);
  assert.equal(p.startFrameKey, img("s").storageKey);
});

test("Switching from Seedance drops videos/audio/source for Veo", () => {
  const media = { ...empty, images: [img("a")], videos: [img("v")], audio: [img("au")], source: img("src") };
  const p = cloudReferencePayload("veo-3.1-fast", "editing", media);
  assert.equal(p.referenceVideoKeys, undefined);
  assert.equal(p.referenceAudioKeys, undefined);
  assert.deepEqual(inactiveReferenceRoles("veo-3.1-fast", "editing", media), ["source video", "reference videos", "reference audio"]);
});

test("Seedance 2.5 editing still sends source video plus extras", () => {
  const p = cloudReferencePayload("seedance-2.5", "editing", { ...empty, source: img("src"), images: [img("a")] });
  assert.deepEqual(p.referenceVideoKeys, [img("src").storageKey]);
  assert.deepEqual(p.referenceImageKeys, [img("a").storageKey]);
});

test("Output options follow provider contracts", () => {
  const kling = cloudOutputOptions("kling-v3-standard", { hasStartFrame: true, hasReferenceImages: false, task: "reference" });
  assert.equal(kling.aspectInherited, true);
  assert.deepEqual(kling.resolutions, []);
  assert.equal(kling.durations[0], 3);
  assert.equal(kling.durations.at(-1), 15);
  const veo = cloudOutputOptions("veo-3.1-fast", { hasStartFrame: false, hasReferenceImages: false, task: "reference" });
  assert.deepEqual(veo.aspectRatios, ["16:9", "9:16"]);
  assert.deepEqual(veo.resolutions, ["720p", "1080p", "4k"]);
  assert.deepEqual(veo.durations, [4, 6, 8]);
  assert.equal(veo.nativeAudio, true);
});

test("Kling elements are sent only with a start frame and at least one angle", () => {
  const element = { frontal: img("f"), angles: [img("a1"), img("a2")] };
  const noStart = cloudReferencePayload("kling-v3-standard", "reference", { ...empty, elements: [element] });
  assert.equal(noStart.klingElements, undefined);
  const withStart = cloudReferencePayload("kling-v3-standard", "reference", { ...empty, start: img("s"), images: [img("r")], elements: [element, { frontal: img("g"), angles: [] }] });
  assert.deepEqual(withStart.klingElements, [{ frontalImageKey: img("f").storageKey, referenceImageKeys: [img("a1").storageKey, img("a2").storageKey] }, { frontalImageKey: img("g").storageKey }]);
  assert.deepEqual(withStart.referenceImageKeys, [img("r").storageKey]);
  assert.equal(cloudReferencePayload("kling-v3-standard", "reference", { ...empty, images: [img("r")] }).referenceImageKeys, undefined);
  assert.equal(cloudReferencePayload("veo-3.1-fast", "reference", { ...empty, start: img("s"), elements: [element] }).klingElements, undefined);
});

test("Kling element validation counts cast and requires angles", () => {
  const e = (n: number) => ({ frontal: img(`f${n}`), angles: [img(`a${n}`)] });
  assert.match(elementProblems("kling-v3-standard", { ...empty, elements: [e(1)] }, 0)!, /start frame/);
  assert.match(elementProblems("kling-v3-standard", { ...empty, start: img("s"), elements: [e(1), e(2)] }, 3)!, /at most 4/);
  assert.match(elementProblems("kling-v3-standard", { ...empty, start: img("s"), images: [img("r")], elements: [e(1)] }, 3)!, /at most 4/);
  assert.equal(elementProblems("kling-v3-standard", { ...empty, start: img("s"), elements: [{ frontal: img("x"), angles: [] }] }, 0), null);
  assert.equal(elementProblems("kling-v3-standard", { ...empty, start: img("s"), elements: [e(1)] }, 2), null);
  assert.equal(elementProblems("veo-3.1-fast", { ...empty, elements: [e(1)] }, 0), null);
});

test("Prompt controls follow each provider endpoint", () => {
  assert.deepEqual(cloudPromptControls("seedance-2.0", { referenceImagesActive: false }).negativePrompt, false);
  const kling = cloudPromptControls("kling-v3-standard", { referenceImagesActive: false });
  assert.equal(kling.negativePrompt, true);
  assert.equal(kling.fixedSeed, false);
  assert.deepEqual(kling.guidanceScale, { min: 0, max: 1, step: 0.05, default: 0.5 });
  assert.equal(cloudPromptControls("veo-3.1-fast", { referenceImagesActive: false }).fixedSeed, true);
  const veoRef = cloudPromptControls("veo-3.1-fast", { referenceImagesActive: true });
  assert.equal(veoRef.negativePrompt, false);
  assert.equal(veoRef.fixedSeed, false);
});
