import test from "node:test";
import assert from "node:assert/strict";
import { planLongFormShotsForTest } from "./long-form-service";

function plan(seconds: number) {
  // Exercise the same untimed SHOT handoff used by production-render.
  const count = Math.ceil(seconds / 5);
  return planLongFormShotsForTest({
    title: "Duration boundary regression",
    script: Array.from({ length: count }, (_, i) => `SHOT ${i + 1}\nVisual: Rain falls outside the window.`).join("\n\n"),
    targetDurationSeconds: seconds,
    shotDurationSeconds: 5,
    generationMode: "H3",
    width: 1280,
    height: 720,
    fps: 24,
    qualityPreset: "STANDARD",
  });
}

for (const seconds of [180, 600, 605, 1800, 5400]) {
  test(`reviewed ${seconds}-second shot plan retains its total without a legacy ten-minute cap`, () => {
    const shots = plan(seconds);
    assert.equal(shots.length, Math.ceil(seconds / 5));
    assert.ok(Math.abs(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) - seconds) < 0.01);
    assert.ok(shots.every(shot => shot.dialogue === ""));
  });
}

test("plans beyond the production limit fail with the correct limit", () => {
  assert.throws(() => plan(5405), /90-minute production limit/);
});
