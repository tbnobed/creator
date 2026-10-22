import test from "node:test";
import assert from "node:assert/strict";
import { longFormStartDisposition } from "./long-form-service";

test("start acknowledges an already-running project after retry", () => {
  assert.equal(longFormStartDisposition("RUNNING"), "running");
});
test("ready, paused and failed projects can start", () => {
  for (const status of ["READY", "PAUSED", "FAILED"]) {
    assert.equal(longFormStartDisposition(status), "start");
  }
});
test("cancelled and finished projects are not silently restarted", () => {
  assert.throws(() => longFormStartDisposition("CANCELLED"), /Retry a cancelled shot/);
  for (const status of ["COMPLETED", "EDITING", "ASSEMBLING"]) {
    assert.throws(() => longFormStartDisposition(status), /Use Review/);
  }
  assert.throws(() => longFormStartDisposition("DRAFT"), /Finish preparing/);
});

test("explicit remaining-scenes action resumes cancelled projects but not finished projects", () => {
  for (const status of ["CANCELLED", "FAILED", "PAUSED", "READY"]) {
    assert.equal(longFormStartDisposition(status, true), "start");
  }
  assert.equal(longFormStartDisposition("RUNNING", true), "running");
  for (const status of ["COMPLETED", "EDITING", "ASSEMBLING", "DRAFT"]) {
    assert.throws(() => longFormStartDisposition(status, true));
  }
});
