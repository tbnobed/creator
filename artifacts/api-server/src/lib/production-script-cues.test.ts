import test from "node:test";
import assert from "node:assert/strict";
import { isProductionDirectionLabel } from "./production-script-cues";
import { parseAuthoredScenes } from "./production-script-plan";
import { emptyProduction, validateScenes } from "./production-types";
import { openingInputs } from "./production-openings";

test("sound and direction label variants are recognized, not real role names", () => {
  for (const label of ["SFX", " s.f.x. ", "SFX (waves)", "[SFX]", "SOUND EFFECTS", "MUSIC:", "B-ROLL", "ON-SCREEN TEXT"]) {
    assert.equal(isProductionDirectionLabel(label), true, label);
  }
  for (const name of ["Cleo", "Sfx Jones", "Narrator", "Voice Over", "Musician"]) {
    assert.equal(isProductionDirectionLabel(name), false, name);
  }
});

test("authored sound cues stay in action, never become cast or spoken dialogue", () => {
  const [scene] = parseAuthoredScenes(`SCENE 2 — MARSH — DAWN
CLEO: Look at my fortress!
SFX: Waves splash against the mud.
MUSIC: A playful flute phrase.
CLEO: It is perfect.
`)!;
  assert.deepEqual(scene.characters, ["CLEO"]);
  assert.match(scene.action, /SFX: Waves splash against the mud/);
  assert.match(scene.action, /MUSIC: A playful flute phrase/);
  assert.doesNotMatch(scene.dialogue, /Waves splash|flute/);
  assert.match(scene.dialogue, /CLEO: It is perfect/);
});

test("imported cast arrays omit directions while preserving script content", () => {
  const raw = { title: "Marsh", location: "Marsh", timeOfDay: "Dawn",
    action: "Cleo admires the fortress. SFX: water splashes.", dialogue: "CLEO: Done!",
    characters: ["Cleo", "SFX", "MUSIC", "Sound Effects"] };
  const [scene] = validateScenes([raw]);
  assert.deepEqual(scene.characters, ["Cleo"]);
  assert.equal(scene.action, raw.action);
  assert.equal(scene.dialogue, raw.dialogue);
});

test("existing drafts containing SFX generate with the real character reference and still reject unknown people", () => {
  const state = emptyProduction();
  state.characters = [{ id: "cleo", name: "Cleo", description: "Approved main character", seed: 1,
    locked: true, selectedAssetId: "cleo-image", status: "LOCKED", options: [], referenceSheet: [] }];
  state.places = [{ id: "marsh", name: "Marsh", prompt: "Marsh", seed: 1,
    status: "READY", assetId: "marsh-image", variants: [] }];
  const scene = { sceneNumber: 2, title: "Marsh", location: "Marsh", timeOfDay: "Dawn",
    action: "Cleo admires the fortress.", dialogue: "SFX: Waves splash.",
    characters: ["Cleo", "SFX", "MUSIC"] };
  assert.deepEqual(openingInputs(state, scene).ids, ["marsh-image", "cleo-image"]);
  assert.deepEqual(scene.characters, ["Cleo", "SFX", "MUSIC"]);
  assert.throws(() => openingInputs(state, { ...scene, characters: ["Cleo", "Missing Person", "SFX"] }), /Missing Person.*no matching/);
});
