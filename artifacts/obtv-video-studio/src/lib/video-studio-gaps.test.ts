import assert from "node:assert/strict";
import { test } from "node:test";
import { activeSeedanceRoles, aspectRatioIsInherited, seedanceReferenceBudget, VIDEO_MODEL_CAPABILITIES, RESOLUTION_QUALITY } from "./video-model-capabilities";
import { nextSelection } from "./selection";

const input = { characterCount: 2, hasSetting: true, images: 3, videos: 0, audio: 1, frames: 0, hasSource: true };

test("Seedance 2.5 Edit/Extend accepts source plus image and audio, never extra videos or frames", () => {
  for (const task of ["editing", "extension"] as const) {
    assert.deepEqual(activeSeedanceRoles("seedance-2.5", task), { frames: false, images: true, videos: false, audio: true, source: true });
    const budget = seedanceReferenceBudget("seedance-2.5", task, input);
    assert.equal(budget.primaryImages, 0);
    assert.equal(budget.imageCount, 3);
    assert.equal(budget.total, 5);
  }
});

test("aspect ratio is inherited only in Edit/Extend", () => {
  assert.equal(aspectRatioIsInherited("seedance-2.5", "editing"), true);
  assert.equal(aspectRatioIsInherited("seedance-2.5", "extension"), true);
  assert.equal(aspectRatioIsInherited("seedance-2.5", "reference"), false);
  assert.equal(aspectRatioIsInherited("seedance-2.0", "reference"), false);
});

test("six aspect ratios and resolution limits per model", () => {
  assert.deepEqual(VIDEO_MODEL_CAPABILITIES["seedance-2.0"].aspectRatios, ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
  assert.ok(VIDEO_MODEL_CAPABILITIES["seedance-2.0"].resolutions?.includes("4k"));
  assert.deepEqual(VIDEO_MODEL_CAPABILITIES["seedance-2.0-fast"].resolutions, ["480p", "720p"]);
  assert.ok(!VIDEO_MODEL_CAPABILITIES["seedance-2.5"].resolutions?.includes("4k"));
  assert.equal(RESOLUTION_QUALITY["4k"], "HIGH");
});

test("selection toggles and shift-ranges in display order", () => {
  const order = ["a", "b", "c", "d", "e"];
  let sel = nextSelection(order, new Set(), "b", null, false);
  assert.deepEqual([...sel], ["b"]);
  sel = nextSelection(order, sel, "d", "b", true);
  assert.deepEqual([...sel].sort(), ["b", "c", "d"]);
  sel = nextSelection(order, sel, "c", "d", false);
  assert.deepEqual([...sel].sort(), ["b", "d"]);
  sel = nextSelection(order, sel, "a", "e", true);
  assert.equal(sel.size, 5);
});
