import test from "node:test";
import assert from "node:assert/strict";
import { shotRerenderDisabled, renderNeedsPolling, shotIsRendering } from "./production-shot-state";

test("already-open corrections cannot resubmit a queued or rendering shot", () => {
  for (const status of ["QUEUED", "RENDERING"]) {
    assert.equal(shotIsRendering(status), true);
    assert.equal(shotRerenderDisabled(status, false), true);
  }
});

test("idle shots can re-render without a correction, but pending requests block submissions", () => {
  for (const status of ["COMPLETED", "FAILED", "CANCELLED", "PLANNED"]) {
    assert.equal(shotRerenderDisabled(status, false), false);
    assert.equal(shotRerenderDisabled(status, true), true);
  }
});

test("active child renders keep polling even when the parent has failed or paused", () => {
  for (const status of ["FAILED", "PAUSED", "CANCELLED", "EDITING", "COMPLETED"]) {
    for (const child of ["QUEUED", "RENDERING"]) {
      assert.equal(renderNeedsPolling({ status, shots: [{ status: child }] }), true);
    }
    assert.equal(renderNeedsPolling({ status, shots: [{ status: "COMPLETED" }, { status: "FAILED" }] }), false);
  }
});

test("running and assembling projects keep polling, including before shots arrive", () => {
  assert.equal(renderNeedsPolling({ status: "RUNNING" }), true);
  assert.equal(renderNeedsPolling({ status: "ASSEMBLING", shots: [] }), true);
  assert.equal(renderNeedsPolling({ status: "FAILED" }), false);
});
