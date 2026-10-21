import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction, validateScenes } from "./production-types";
import { applyProductionPatch } from "./production-store";
import { parseAuthoredScenes } from "./production-script-plan";
import { requireProductionScenery, resolveProductionScenery } from "./production-scenery";
import { outlineStory } from "./production-story";
function fixture() {
  const state = emptyProduction();
  state.story.scenes = [{ sceneNumber: 1, title: "Lantern Room", location: "Lighthouse Lantern Room, Gull Point", timeOfDay: "Night", characters: [], action: "Rain lashes the glass.", dialogue: "" }];
  state.places = [{ id: "room", name: "Lantern Room", prompt: "An interior", seed: 1, status: "READY", assetId: "base-image", variants: [{ id: "dawn", name: "Pre-dawn", prompt: "Same room at dawn", status: "READY", assetId: "dawn-image" }] }];
  return state;
}
test("authored scene location never acquires the production title or its setting", async () => {
  const script = "SCENE 1 — LIGHTHOUSE LANTERN ROOM — NIGHT — 0:00–0:45\nRain lashes the glass.\nOWEN: Tell me it's a fuse.";
  const parsed = validateScenes(parseAuthoredScenes(script));
  assert.equal(parsed[0].location, "LIGHTHOUSE LANTERN ROOM");
  assert.equal(parsed[0].timeOfDay, "NIGHT");
  assert.equal(parsed[0].durationSeconds, 45);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("An authored scene must not be sent to a model for rewriting."); }) as typeof fetch;
  try {
    const scenes = await outlineStory({ title: "The Last Light at Gull Point", script: "", summary: script, targetMinutes: 10 });
    assert.equal(scenes[0].location, "LIGHTHOUSE LANTERN ROOM");
    assert.equal(scenes[0].durationSeconds, 45);
  } finally { globalThis.fetch = previousFetch; }
});
test("explicit ID mapping reuses differently named scenery without rewriting the scene", () => {
  const state = fixture();
  assert.throws(() => requireProductionScenery(state, state.story.scenes[0]), /Assign an existing place/);
  const assigned = applyProductionPatch(state, { settings: { sceneReferences: { "1": { placeId: "room" } } } });
  assert.equal(requireProductionScenery(assigned, assigned.story.scenes[0]).reference.assetId, "base-image");
  assert.equal(assigned.story.scenes[0].location, state.story.scenes[0].location);
  assigned.places[0].name = "Renamed room";
  assert.equal(requireProductionScenery(assigned, assigned.story.scenes[0]).reference.assetId, "base-image");
  assert.equal(assigned.tasks.length, 0);
});
test("variant IDs are used exactly; removed/not-ready selections never fall back to another image", () => {
  const state = applyProductionPatch(fixture(), { settings: { sceneReferences: { "1": { placeId: "room", variantId: "dawn" } } } });
  assert.equal(requireProductionScenery(state, state.story.scenes[0]).reference.assetId, "dawn-image");
  state.places[0].variants[0].assetId = undefined;
  assert.throws(() => requireProductionScenery(state, state.story.scenes[0]), /ready scenery/);
  state.places[0].variants = [];
  assert.equal(resolveProductionScenery(state, state.story.scenes[0]), undefined);
});
test("automatic matching normalizes whitespace but never guesses among duplicate places", () => {
  const state = fixture(); state.story.scenes[0].location = "  LANTERN   ROOM ";
  assert.equal(requireProductionScenery(state, state.story.scenes[0]).reference.assetId, "base-image");
  state.places.push({ ...state.places[0], id: "other" });
  assert.throws(() => requireProductionScenery(state, state.story.scenes[0]), /Assign an existing place/);
});
test("assignment rejects foreign scene/place/variant IDs and preserves unrelated mappings", () => {
  const state = fixture();
  assert.throws(() => applyProductionPatch(state, { settings: { sceneReferences: { "1": { placeId: "foreign" } } } }), /from this production/);
  assert.throws(() => applyProductionPatch(state, { settings: { sceneReferences: { "1": { placeId: "room", variantId: "foreign" } } } }), /belonging/);
  assert.throws(() => applyProductionPatch(state, { settings: { sceneReferences: { "99": { placeId: "room" } } } }), /existing scene/);
  const assigned = applyProductionPatch(state, { settings: { sceneReferences: { "1": { placeId: "room" } } } });
  assert.equal(applyProductionPatch(assigned, { settings: { width: 1280 } }).settings.sceneReferences?.["1"]?.placeId, "room");
  const moved = applyProductionPatch(assigned, { story: { scenes: assigned.story.scenes.map(s => ({ ...s, location: "Harbor shed" })) } });
  assert.equal(moved.settings.sceneReferences?.["1"], null);
});
