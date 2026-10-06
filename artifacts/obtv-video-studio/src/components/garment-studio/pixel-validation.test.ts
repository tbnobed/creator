import assert from "node:assert/strict";
import { test } from "node:test";
import { motionProblem, pixelRangeProblem, pixelSubmitBlocker, polygonProblem } from "./pixel-validation.ts";

const tri = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.3, y: 0.5 }];
const base = {
  hasSource: true, polygon: tri, closed: true, pivot: { x: 0.3, y: 0.1 }, protectedPolygons: [],
  start: 0, duration: 2, total: 10, angle: 12, cps: 0.8, ink: 30, reviewed: true, title: "Wave", busy: false, activeJob: false,
};

test("polygon", () => {
  assert.equal(polygonProblem(tri), null);
  assert.match(polygonProblem(tri.slice(0, 2))!, /at least/);
  assert.match(polygonProblem([...tri, { x: 1.2, y: 0 }])!, /outside/);
  assert.match(polygonProblem([{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0, y: 0.001 }])!, /small/);
  assert.match(polygonProblem([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])!, /too much/);
  assert.equal(polygonProblem([{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 0, y: 0.01 }]), null);
});

test("range and motion", () => {
  assert.equal(pixelRangeProblem(0, 5, 10), null);
  assert.match(pixelRangeProblem(0, 5.1, 10)!, /capped/);
  assert.match(pixelRangeProblem(0, 0.4, 10)!, /least/);
  assert.match(pixelRangeProblem(8, 3, 10)!, /past/);
  assert.match(motionProblem(0.5, 1, 30)!, /at least 1/);
  assert.match(motionProblem(36, 1, 30)!, /limited/);
  assert.match(motionProblem(10, 3, 30)!, /Speed/);
  assert.match(motionProblem(10, 1, 4)!, /Ink/);
});

test("blocker", () => {
  assert.equal(pixelSubmitBlocker(base), null);
  assert.match(pixelSubmitBlocker({ ...base, closed: false })!, /Close/);
  assert.match(pixelSubmitBlocker({ ...base, pivot: null })!, /pivot/);
  assert.match(pixelSubmitBlocker({ ...base, reviewed: false })!, /reviewed/);
  assert.match(pixelSubmitBlocker({ ...base, busy: true })!, /Wait/);
  assert.match(pixelSubmitBlocker({ ...base, pendingProtectPoints: 2 })!, /open protected/);
  assert.equal(motionProblem(-1, 1, 30), null);
  assert.match(pixelSubmitBlocker({ ...base, protectedPolygons: [tri.slice(0, 2)] })!, /Protected area 1/);
});
