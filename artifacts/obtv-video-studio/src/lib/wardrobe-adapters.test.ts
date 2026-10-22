import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaStateOf, outfitFromLibrary, outfitFromProduction, sceneRangeLabel } from "./wardrobe-adapters.ts";

test("production outfit keeps scene range and state change", () => {
  const v = outfitFromProduction({ id: "w1", name: "Slicker", prompt: "yellow", status: "RUNNING", fromScene: 2, toScene: 5, stateNote: "torn", stateFromScene: 4 });
  assert.equal(v.mediaState, "PENDING");
  assert.deepEqual(v.sceneRange, { from: 2, to: 5 });
  assert.deepEqual(v.stateChange, { note: "torn", fromScene: 4 });
  assert.equal(v.approval, undefined);
  assert.equal(sceneRangeLabel(v.sceneRange!), "Scenes 2–5");
  assert.equal(sceneRangeLabel({ from: 3, to: 3 }), "Scene 3");
});

test("library outfit has no scene range; reference resolves through lookup", () => {
  const v = outfitFromLibrary({ id: "o1", name: "", referenceAssetId: "a1" }, (id) => (id === "a1" ? "u.png" : undefined));
  assert.equal(v.name, "Untitled outfit");
  assert.equal(v.sceneRange, undefined);
  assert.equal(v.mediaUrl, "u.png");
  assert.equal(v.mediaState, "READY");
  assert.equal(v.approval, "approved");
  assert.equal(outfitFromLibrary({ id: "o2", name: "x" }).mediaState, "EMPTY");
});

test("failed status without media is FAILED", () => {
  assert.equal(mediaStateOf("FAILED", null), "FAILED");
  assert.equal(mediaStateOf("FAILED", "x.png"), "READY");
});
