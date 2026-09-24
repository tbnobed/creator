import assert from "node:assert/strict";
import { test } from "node:test";
import { longFormShotActionState } from "./long-form-shot-actions";

test("shot action matrix keeps edit and completed regeneration visible", () => {
  const planned = longFormShotActionState({
    shotStatus: "PLANNED",
    projectStatus: "RUNNING",
    continuityEnabled: false,
    activeShotCount: 1,
  });
  assert.deepEqual(planned.edit, { visible: true, enabled: true });
  assert.deepEqual(planned.regenerate, { visible: false, enabled: false });

  const completed = longFormShotActionState({
    shotStatus: "COMPLETED",
    projectStatus: "COMPLETED",
    continuityEnabled: false,
    activeShotCount: 0,
  });
  assert.deepEqual(completed.edit, { visible: true, enabled: true });
  assert.deepEqual(completed.regenerate, { visible: true, enabled: true });
});

test("active and assembling states expose actionable disabled reasons", () => {
  const rendering = longFormShotActionState({
    shotStatus: "RENDERING",
    projectStatus: "RUNNING",
    continuityEnabled: false,
    activeShotCount: 1,
  });
  assert.equal(rendering.edit.visible, true);
  assert.equal(rendering.edit.enabled, false);
  assert.equal(rendering.regenerate.visible, true);
  assert.equal(rendering.regenerate.enabled, false);
  assert.match(rendering.disabledReason ?? "", /currently rendering/i);

  const assembling = longFormShotActionState({
    shotStatus: "FAILED",
    projectStatus: "ASSEMBLING",
    continuityEnabled: false,
    activeShotCount: 0,
  });
  assert.equal(assembling.edit.enabled, false);
  assert.equal(assembling.retry.enabled, false);
  assert.match(assembling.disabledReason ?? "", /assembly/i);
});

test("continuity completed revisions require a paused project with no active shots", () => {
  const blocked = longFormShotActionState({
    shotStatus: "COMPLETED",
    projectStatus: "RUNNING",
    continuityEnabled: true,
    activeShotCount: 0,
  });
  assert.equal(blocked.edit.enabled, false);
  assert.equal(blocked.regenerate.visible, true);
  assert.equal(blocked.regenerate.enabled, false);
  assert.match(blocked.disabledReason ?? "", /Pause production/i);

  const ready = longFormShotActionState({
    shotStatus: "COMPLETED",
    projectStatus: "PAUSED",
    continuityEnabled: true,
    activeShotCount: 0,
  });
  assert.equal(ready.edit.enabled, true);
  assert.equal(ready.regenerate.enabled, true);
});

test("failed and cancelled retry actions remain available", () => {
  for (const shotStatus of ["FAILED", "CANCELLED"] as const) {
    const state = longFormShotActionState({
      shotStatus,
      projectStatus: "FAILED",
      continuityEnabled: true,
      activeShotCount: 0,
    });
    assert.deepEqual(state.edit, { visible: true, enabled: true });
    assert.deepEqual(state.retry, { visible: true, enabled: true });
  }
});