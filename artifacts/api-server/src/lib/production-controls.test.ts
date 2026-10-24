import test from "node:test";
import assert from "node:assert/strict";
import { emptyProduction, validateScenes } from "./production-types";
import { applyProductionPatch } from "./production-store";
import { mutateProductionAsset } from "./production-assets";
import { parseAuthoredScenes, scriptSource, sceneWritingSeconds, shotDurations } from "./production-script-plan";
import { cancelActiveStory, registerStoryWriter, StoryCancelled } from "./production-story-control";
import type { ProductionProjectRow } from "@workspace/db";

test("three-minute and custom durations save; invalid values are rejected", () => {
  const state = emptyProduction();
  assert.equal(state.story.targetMinutes, 3);
  for (const minutes of [2 / 60, 0.5, 1, 2.5, 3, 7, 10, 30, 90]) assert.equal(applyProductionPatch(state, { story: { targetMinutes: minutes } }).story.targetMinutes, minutes);
  for (const minutes of [0, 91, NaN]) assert.throws(() => applyProductionPatch(state, { story: { targetMinutes: minutes } }), /2 seconds to 90 minutes/);
});
test("a timed screenplay pasted into Summary keeps its four scenes and 180 seconds", () => {
  const script = [0, 1, 2, 3].map((n) => {
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return `SCENE ${n + 1} — LIGHTHOUSE — NIGHT — ${fmt(n * 45)}–${fmt((n + 1) * 45)}\nRain hits the window.\nOWEN: Tell me it's a fuse.\nMARA: It's a fuse.`;
  }).join("\n\n");
  const input = { summary: script, script: "", targetMinutes: 10 };
  assert.equal(scriptSource(input), script);
  const scenes = validateScenes(parseAuthoredScenes(script));
  assert.equal(scenes.length, 4);
  assert.equal(scenes.reduce((n, s) => n + sceneWritingSeconds(s, input, scenes.length), 0), 180);
  assert.equal(scenes[0].dialogue, "OWEN: Tell me it's a fuse.\nMARA: It's a fuse.");
  for (const s of scenes) assert.equal(shotDurations(sceneWritingSeconds(s, input, 4), 8).reduce((a, b) => a + b), 45);
});
test("selected Summary ignores an old hidden script; untimed scripts are not padded", () => {
  const input = { summary: "A short story.", script: "An older script.", sourceMode: "summary" as const, targetMinutes: 3 };
  assert.equal(scriptSource(input), "");
  const scene = { sceneNumber: 1, title: "Test", location: "Room", timeOfDay: "DAY", characters: [], action: "The light dims.", dialogue: "" };
  assert.equal(sceneWritingSeconds(scene, input, 2), 90);
  assert.equal(sceneWritingSeconds(scene, { ...input, sourceMode: "script" }, 2), 8);
  assert.deepEqual(shotDurations(41, 8), [8, 8, 8, 8, 7, 2]);
  assert.throws(() => parseAuthoredScenes("SCENE 1 — ROOM — 1:00–0:45\nA light."), /invalid time range/);
});
test("cancellation aborts only its own writer and cleans up registrations", () => {
  const a = new AbortController(), b = new AbortController();
  const releaseA = registerStoryWriter("a", a), releaseB = registerStoryWriter("b", b);
  cancelActiveStory("a");
  assert.ok(a.signal.reason instanceof StoryCancelled);
  assert.equal(b.signal.aborted, false);
  releaseA(); releaseB();
  cancelActiveStory("b");
  assert.equal(b.signal.aborted, false);
});
function sceneryRow() {
  const state = emptyProduction();
  state.places = [{ id: "p", name: "Lighthouse", prompt: "A lighthouse", seed: 1, status: "READY", assetId: "shared",
    variants: [{ id: "v", name: "Night", prompt: "At night", status: "READY", assetId: "shared-variant" }] }];
  return { id: "production", state } as unknown as ProductionProjectRow;
}
test("remove scenery/variant detaches only the selected production references", async () => {
  const row = sceneryRow();
  const variant = await mutateProductionAsset(row, "remove-variant", { placeId: "p", id: "v" });
  assert.equal(variant.places[0].variants.length, 0);
  assert.equal(variant.places[0].assetId, "shared");
  const removed = await mutateProductionAsset(row, "remove-place", { placeId: "p" });
  assert.equal(removed.places.length, 0);
});
test("cannot remove generating scenery or someone else's missing variant", async () => {
  const row = sceneryRow();
  const state = row.state as unknown as ReturnType<typeof emptyProduction>;
  state.tasks.push({ id: "job", type: "variant", entityId: "v", placeId: "p", status: "RUNNING", index: 0 });
  await assert.rejects(mutateProductionAsset(row, "remove-place", { placeId: "p" }), /still generating/);
  await assert.rejects(mutateProductionAsset(row, "remove-variant", { placeId: "p", id: "foreign" }), /not found/);
});
