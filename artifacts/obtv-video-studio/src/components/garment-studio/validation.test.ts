import assert from "node:assert/strict";
import { test } from "node:test";
import { clampStart, defaultRange, fileProblem, isActiveJob, rangeProblem, submitBlocker, usesReference, workerProblem } from "./validation.ts";

const source = { mediaUrl: "x", durationSeconds: 10, width: 1920, height: 1080 };
const worker = { id: "w1", name: "GPU A", ready: true, busy: false };

test("range validation", () => {
  assert.equal(rangeProblem(0, 3, 10), null);
  assert.match(rangeProblem(0, 3.5, 10)!, /capped/);
  assert.match(rangeProblem(-1, 2, 10)!, /negative/);
  assert.match(rangeProblem(8, 3, 10)!, /source is 10s/);
  assert.match(rangeProblem(0, 0.2, 10)!, /at least/);
  assert.match(rangeProblem(0, 1, 0)!, /unknown/);
  assert.equal(rangeProblem(0, 1.8, 1.8), null);
});

test("defaults and clamping", () => {
  assert.deepEqual(defaultRange(10), { start: 0, duration: 3 });
  assert.deepEqual(defaultRange(1.25), { start: 0, duration: 1.25 });
  assert.equal(clampStart(9, 3, 10), 7);
  assert.equal(clampStart(-2, 3, 10), 0);
});

test("files and workers", () => {
  assert.equal(fileProblem({ name: "a.MOV", type: "" }), null);
  assert.equal(fileProblem({ name: "a.bin", type: "video/mp4" }), null);
  assert.ok(fileProblem({ name: "a.webm", type: "video/webm" }));
  assert.match(workerProblem(undefined)!, /Select/);
  assert.match(workerProblem({ ...worker, ready: false, reason: "model missing" })!, /model missing/);
  assert.match(workerProblem({ ...worker, busy: true })!, /busy/);
});

test("submit blocker ordering", () => {
  const base = { source, worker, prompt: "orange button-down", targetGarment: "jacket worn by the person on the left", start: 0, duration: 3, job: null };
  assert.equal(submitBlocker(base), null);
  const rep = { ...base, mode: "replace-garment" as const, hasReference: true };
  const art = { ...base, mode: "animate-artwork" as const, artworkSource: "existing" as const };
  assert.equal(submitBlocker(rep), null);
  assert.match(submitBlocker({ ...rep, hasReference: false })!, /reference image/);
  assert.equal(submitBlocker({ ...art, hasReference: false }), null);
  assert.match(submitBlocker({ ...rep, prompt: "   " })!, /Describe/);
  assert.match(submitBlocker({ ...art, prompt: "" })!, /move/);
  assert.match(submitBlocker({ ...art, artworkSource: "upload", hasReference: false })!, /Upload the artwork/);
  assert.equal(submitBlocker({ ...art, artworkSource: "upload", hasReference: true }), null);
  assert.ok(usesReference("replace-garment", "existing"));
  assert.ok(usesReference("animate-artwork", "upload"));
  assert.ok(!usesReference("animate-artwork", "existing"));
  assert.match(submitBlocker({ ...rep, worker: { ...worker, busy: true } })!, /busy/);
  assert.match(submitBlocker({ ...art, worker: { ...worker, busy: true } })!, /busy/);
  assert.match(submitBlocker({ ...rep, duration: 3.5 })!, /capped/);
  assert.match(submitBlocker({ ...art, duration: 0.2 })!, /at least/);
  assert.match(submitBlocker({ ...rep, start: 9 })!, /source is/);
  assert.match(submitBlocker({ ...base, source: null })!, /Upload/);
  assert.match(submitBlocker({ ...base, prompt: "  " })!, /Describe/);
  assert.match(submitBlocker({ ...base, job: { id: "j", status: "running" } })!, /already running/);
  assert.equal(submitBlocker({ ...base, job: { id: "j", status: "failed" } }), null);
  assert.match(submitBlocker({ ...rep, targetGarment: "  " })!, /Name the garment/);
  assert.match(submitBlocker({ ...art, targetGarment: "" })!, /Name the garment/);
  assert.match(submitBlocker({ ...art, targetGarment: "x".repeat(161) })!, /160/);
  assert.equal(submitBlocker({ ...art, targetGarment: "x".repeat(160) }), null);
  assert.ok(isActiveJob({ id: "j", status: "queued" }));
});
