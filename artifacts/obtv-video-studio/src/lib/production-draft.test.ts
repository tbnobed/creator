import test from "node:test";
import assert from "node:assert/strict";
import { draftPatch, rebaseDraft, ProductionDraftConflict, type ProductionDraft } from "./production-draft";
import { DEFAULT_SETTINGS } from "./production-types";
function draft(): ProductionDraft {
  return { title: "Gull Point", step: 4, story: { summary: "Storm", script: "", targetMinutes: 10, scenes: [{ sceneNumber: 1, title: "Light", location: "Tower", timeOfDay: "Night", characters: ["Mara"], action: "Waits.", dialogue: "MARA: Ready." }] }, settings: { ...DEFAULT_SETTINGS } };
}
test("step navigation preserves background story and settings updates", () => {
  const base = draft(), local = structuredClone(base), remote = structuredClone(base);
  local.step = 5; remote.story.scenes[0].action = "The new server draft."; remote.settings.width = 1600;
  const merged = rebaseDraft(base, local, remote);
  assert.equal(merged.story.scenes[0].action, remote.story.scenes[0].action);
  assert.equal(merged.settings.width, 1600);
  assert.deepEqual(draftPatch(remote, merged), { state: { step: 5 } });
});
test("independent model changes merge without replacing other modes", () => {
  const base = draft(), local = structuredClone(base), remote = structuredClone(base);
  local.settings.imageModels = { characters: "local-character-model" };
  remote.settings.imageModels = { places: "local-place-model" };
  const merged = rebaseDraft(base, local, remote);
  assert.deepEqual(merged.settings.imageModels, { characters: "local-character-model", places: "local-place-model" });
  assert.deepEqual(draftPatch(remote, merged).state, { settings: { imageModels: { characters: "local-character-model" } } });
});
test("competing edits fail closed until the user explicitly keeps their value", () => {
  const base = draft(), local = structuredClone(base), remote = structuredClone(base);
  local.title = "My edit"; remote.title = "Other editor"; remote.settings.fps = 30;
  assert.throws(() => rebaseDraft(base, local, remote), ProductionDraftConflict);
  const merged = rebaseDraft(base, local, remote, true);
  assert.equal(merged.title, "My edit"); assert.equal(merged.settings.fps, 30);
});
test("typing during a save survives its older successful response", () => {
  const initial = draft(), live = structuredClone(initial), saved = structuredClone(initial);
  live.title = "New typing"; saved.step = 5;
  const next = rebaseDraft(initial, live, saved, true);
  assert.equal(next.title, "New typing"); assert.equal(next.step, 5);
});
test("simultaneous authored scene edits are not silently overwritten", () => {
  const base = draft(), local = structuredClone(base), remote = structuredClone(base);
  local.story.scenes[0].dialogue = "MARA: My line.";
  remote.story.scenes[0].dialogue = "MARA: Their line.";
  assert.throws(() => rebaseDraft(base, local, remote), /story.scenes/);
});
