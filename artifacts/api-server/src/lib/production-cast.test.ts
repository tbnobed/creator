import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction, type ProductionCharacter } from "./production-types";
import { resolveOpeningCast, resolveProductionCast } from "./production-cast";
import { openingInputs } from "./production-openings";

const character = (name = "Cleo", id = "cleo"): ProductionCharacter => ({
  id, name, description: "Approved main character", seed: 1, selectedAssetId: `${id}-approved`,
  locked: true, options: [], referenceSheet: [], status: "LOCKED",
});
function fixture() {
  const state = emptyProduction();
  state.characters = [character()];
  state.places = [{ id: "bay", name: "Marsh", prompt: "Marsh at dawn", seed: 1, status: "READY", assetId: "marsh-image", variants: [] }];
  state.story.scenes = [{
    sceneNumber: 1, title: "EXT. BAY — DAWN", location: "Marsh", timeOfDay: "Dawn",
    characters: [], action: "Wide shot of Cleo atop the spiral mud fortress. She gestures with her huge golden claw and backward purple cap.", dialogue: "",
  }];
  return { state, scene: state.story.scenes[0] };
}

test("Cleo in the action receives her approved image even when the scene cast is empty", () => {
  const { state, scene } = fixture();
  const inputs = openingInputs(state, scene);
  assert.deepEqual(inputs.ids, ["marsh-image", "cleo-approved"]);
  assert.match(inputs.prompt, /Exactly 1 character, each appearing ONCE, from image 2/);
  assert.match(inputs.prompt, /Cleo: preserve the exact face/);
  assert.doesNotMatch(inputs.prompt, /Use the location reference and the subjects described/);
});

test("trimmed names, unique short names, and shot-only mentions use the same identity", () => {
  const { state, scene } = fixture();
  state.characters[0].name = "Cleo (main character)";
  scene.characters = ["  CLEO  "];
  assert.equal(resolveProductionCast(state, scene)[0].id, "cleo");
  scene.characters = [];
  scene.action = "The tide flows.";
  scene.shots = [{ prompt: "Cleo surveys the fortress.", dialogue: "", durationSeconds: 5 }];
  assert.equal(openingInputs(state, scene).ids[1], "cleo-approved");
});

test("missing, ambiguous, and unlocked identities fail before opening generation", () => {
  const { state, scene } = fixture();
  scene.characters = ["Missing character"];
  assert.throws(() => openingInputs(state, scene), /no matching production character/);
  scene.characters = ["Cleo"];
  state.characters = [character("Cleo North"), character("Cleo South", "other")];
  assert.throws(() => openingInputs(state, scene), /matches multiple characters/);
  scene.characters = ["Cleo North"];
  assert.deepEqual(openingInputs(state, scene).ids, ["marsh-image", "cleo-approved"]);
  state.characters[0].locked = false;
  assert.throws(() => openingInputs(state, scene), /Lock Cleo North/);
});

test("cast-free scenery remains cast-free and substring matches do not add characters", () => {
  const { state, scene } = fixture();
  scene.action = "A clear view of the marsh and a sign reading Cleopatra.";
  assert.deepEqual(openingInputs(state, scene).ids, ["marsh-image"]);
});

test("approved wardrobe replaces the base look when a missing cast entry is recovered", () => {
  const { state, scene } = fixture();
  state.wardrobes = [{ id: "outfit", characterId: "cleo", name: "Purple cap", prompt: "Purple cap",
    fromScene: 1, toScene: 2, assetId: "dressed-cleo", approvedAssetId: "dressed-cleo", status: "READY" }];
  assert.deepEqual(openingInputs(state, scene).ids, ["marsh-image", "dressed-cleo"]);
});

test("full-name resolution does not depend on library order or also select a shorter name", () => {
  const { state, scene } = fixture();
  state.characters = [character("Cleo South", "south"), character("Cleo North", "north"), character()];
  scene.action = "Cleo North surveys the fortress.";
  assert.deepEqual(resolveProductionCast(state, scene).map(c => c.id), ["north"]);
});

test("dialogue speaker cues recover cast, but merely discussing another character does not", () => {
  const { state, scene } = fixture();
  scene.action = "The tide flows.";
  scene.dialogue = "CLEO: Look at my fortress.";
  assert.equal(resolveProductionCast(state, scene)[0].id, "cleo");
  scene.dialogue = "NARRATOR: Cleo will return tomorrow.";
  assert.deepEqual(resolveProductionCast(state, scene), []);
});

test("a Cleo-only opening excludes Ridley and Barnaby from later shots", () => {
  const { state, scene } = fixture();
  state.characters = [
    { ...character(), description: "A crab with a golden claw and purple cap" },
    { ...character("Ridley", "ridley"), description: "An orange shorebird with long yellow legs" },
    character("Barnaby", "barnaby"),
  ];
  scene.characters = ["Cleo", "Ridley", "Barnaby"];
  scene.action = "Cleo surveys her fortress. Later Ridley and Barnaby arrive.";
  scene.shots = [
    { prompt: "Wide shot of Cleo atop the spiral mud fortress.", dialogue: "", durationSeconds: 5 },
    { prompt: "Ridley and Barnaby walk up to Cleo.", dialogue: "", durationSeconds: 5 },
  ];
  assert.equal(resolveProductionCast(state, scene).length, 3);
  assert.deepEqual(resolveOpeningCast(state, scene).map(c => c.name), ["Cleo"]);
  const opening = openingInputs(state, scene);
  assert.deepEqual(opening.ids, ["marsh-image", "cleo-approved"]);
  assert.match(opening.prompt, /Image 2 is Cleo's identity reference only/);
  assert.match(opening.prompt, /A crab with a golden claw and purple cap/);
  assert.doesNotMatch(opening.prompt, /Ridley|Barnaby|shorebird/);
});

test("an opening explicitly showing two characters binds each identity to its own image", () => {
  const { state, scene } = fixture();
  state.characters.push(character("Ridley", "ridley"));
  scene.characters = ["Cleo", "Ridley"];
  scene.action = "Cleo and Ridley stand beside the tidal channel.";
  const opening = openingInputs(state, scene);
  assert.deepEqual(opening.ids, ["marsh-image", "cleo-approved", "ridley-approved"]);
  assert.match(opening.prompt, /Image 2 is Cleo's identity reference only/);
  assert.match(opening.prompt, /Image 3 is Ridley's identity reference only/);
});

test("legacy unnamed group openings retain their declared cast", () => {
  const { state, scene } = fixture();
  scene.characters = ["Cleo"];
  scene.action = "The group stands beside the channel.";
  assert.deepEqual(resolveOpeningCast(state, scene).map(c => c.name), ["Cleo"]);
});
