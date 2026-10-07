import assert from "node:assert/strict";
import { test } from "node:test";
import { MOTION_PRESETS, effectiveTarget, effectiveTitle, guide, presetFor } from "./guided-steps.ts";
import { motionProblem } from "./pixel-validation.ts";

const base = { hasSource: true, frameReady: true, points: 0, closed: false, hasPivot: false, reviewed: false };

test("guide walks the three steps in order", () => {
  assert.equal(guide({ ...base, hasSource: false }).step, 1);
  assert.equal(guide(base).tool, "outline");
  assert.match(guide({ ...base, points: 3 }).action, /Finish/);
  const pivot = guide({ ...base, points: 4, closed: true });
  assert.equal(pivot.tool, "pivot");
  assert.equal(pivot.step, 2);
  assert.equal(guide({ ...base, points: 4, closed: true, hasPivot: true }).step, 3);
  assert.match(guide({ ...base, points: 4, closed: true, hasPivot: true, reviewed: true }).action, /Create/);
});

test("presets are valid bounded motion and round-trip", () => {
  for (const p of MOTION_PRESETS) {
    assert.equal(motionProblem(p.angle, p.cps, 28), null);
    assert.equal(presetFor(p.angle, p.cps), p.id);
  }
  assert.equal(presetFor(13, 0.8), null);
});

test("hidden title/note never block submit", () => {
  assert.ok(effectiveTitle("  ").length > 0);
  assert.ok(effectiveTarget("").length > 0);
  assert.equal(effectiveTitle(" Flag "), "Flag");
});
