import test from "node:test";
import assert from "node:assert/strict";
import { longFormPauseDisposition, longFormStartDisposition } from "./long-form-service";

test("correction pauses a running queue", () => {
  assert.equal(longFormPauseDisposition("RUNNING", true), "pause");
});

test("corrections of failed and paused projects do not attempt an invalid pause", () => {
  for (const status of ["FAILED", "PAUSED", "READY"]) {
    assert.equal(longFormPauseDisposition(status, true), "unchanged");
    assert.equal(longFormStartDisposition(status), "start");
  }
});

test("finished and cancelled shots may enter the existing explicit correction flow", () => {
  for (const status of ["COMPLETED", "EDITING", "CANCELLED"]) {
    assert.equal(longFormPauseDisposition(status, true), "unchanged");
  }
});

test("ordinary Pause remains limited to a running project", () => {
  assert.equal(longFormPauseDisposition("RUNNING"), "pause");
  for (const status of ["FAILED", "PAUSED", "READY", "COMPLETED", "EDITING", "CANCELLED", "DRAFT", "ASSEMBLING"]) {
    assert.throws(() => longFormPauseDisposition(status), /Only a running project/);
  }
});

test("correction does not bypass assembly or unprepared projects", () => {
  assert.throws(() => longFormPauseDisposition("ASSEMBLING", true), /assembly to finish/);
  assert.throws(() => longFormPauseDisposition("DRAFT", true));
  assert.throws(() => longFormPauseDisposition("unknown", true));
});
