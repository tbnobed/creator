import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientToNormalized, containedMediaRect, draftStorageKey, durationProblem, emptyDraft, isDefiniteRejection,
  normalizedToBox, findJobForRequest, resolveDraftFromHistory, parseDraft, requestIdForAttempt, selectionFingerprint, selectionLocked, validateCleanupFile,
} from "./video-cleanup.ts";

test("object-contain rect excludes letterbox", () => {
  const r = containedMediaRect(1000, 1000, 1920, 1080)!;
  assert.equal(Math.round(r.left), 0);
  assert.equal(Math.round(r.width), 1000);
  assert.equal(Math.round(r.top), 219);
  const p = containedMediaRect(800, 400, 1080, 1920)!;
  assert.equal(Math.round(p.height), 400);
  assert.equal(Math.round(p.left), 288);
  assert.equal(containedMediaRect(0, 10, 10, 10), null);
});

test("pointer mapping round-trips and rejects letterbox", () => {
  const r = containedMediaRect(1000, 1000, 1920, 1080)!;
  assert.equal(clientToNormalized(500, 100, r), null);
  const n = clientToNormalized(250, 500, r)!;
  assert.equal(n.x, 0.25);
  assert.equal(n.y, 0.5);
  const back = normalizedToBox(n, r);
  assert.equal(Math.round(back.left), 250);
  assert.equal(Math.round(back.top), 500);
});

test("file and duration validation", () => {
  assert.equal(validateCleanupFile({ type: "video/mp4", size: 10 }), null);
  assert.ok(validateCleanupFile({ type: "video/webm", size: 10 }));
  assert.ok(validateCleanupFile({ type: "video/mp4", size: 201 * 1024 * 1024 }));
  assert.equal(durationProblem(4.96), null);
  assert.ok(durationProblem(5));
});

test("draft is tenant scoped and sanitized", () => {
  assert.equal(draftStorageKey("u", null), null);
  assert.notEqual(draftStorageKey("u", "t1"), draftStorageKey("u", "t2"));
  assert.deepEqual(parseDraft("nope"), emptyDraft());
  const src = { storageKey: "k", mediaUrl: "/m", sourceToken: "tok", width: 10, height: 10, fps: 24, durationSeconds: 3, hasAudio: true, estimatedUsd: 5, pricingNote: "n" };
  const d = parseDraft(JSON.stringify({ ...emptyDraft(), source: src, phase: "sending", requestId: "r1", points: [{ x: 2, y: 0, type: "positive" }, { x: 0.5, y: 0.5, type: "negative" }] }));
  assert.equal(d.phase, "uncertain");
  assert.equal(d.points.length, 1);
  assert.ok(selectionLocked(d.phase));
});

test("request ID stable across retries, new when selection changes", () => {
  const fp = selectionFingerprint("tok", "moving", [{ x: 0.1, y: 0.2, type: "positive" }]);
  const draft = { ...emptyDraft(), requestId: "r1", requestFingerprint: fp, phase: "uncertain" as const };
  assert.deepEqual(requestIdForAttempt(draft, fp, () => "r2"), { requestId: "r1", isRetry: true });
  const fp2 = selectionFingerprint("tok", "stationary", [{ x: 0.1, y: 0.2, type: "positive" }]);
  assert.equal(requestIdForAttempt(draft, fp2, () => "r2").requestId, "r2");
  assert.equal(requestIdForAttempt({ ...draft, phase: "accepted" }, fp, () => "r3").requestId, "r3");
  assert.ok(isDefiniteRejection(400));
  assert.ok(!isDefiniteRejection(undefined));
  assert.ok(!isDefiniteRejection(503));
});

test("uncertain attempt resolves by durable request ID match", () => {
  const draft = { ...emptyDraft(), requestId: "abc", requestFingerprint: "fp", phase: "uncertain" as const };
  assert.equal(findJobForRequest([{ jobId: "x" }], "abc"), null);
  assert.equal(findJobForRequest(undefined, "abc"), null);
  assert.deepEqual(resolveDraftFromHistory(draft, [{ jobId: "x" }]), draft);
  const resolved = resolveDraftFromHistory(draft, [{ jobId: "x" }, { jobId: "abc" }]);
  assert.equal(resolved.phase, "accepted");
  assert.equal(resolved.jobId, "abc");
  assert.equal(resolved.requestId, "abc");
  const editing = { ...emptyDraft(), requestId: "abc" };
  assert.equal(resolveDraftFromHistory(editing, [{ jobId: "abc" }]), editing);
  assert.ok(!isDefiniteRejection(425));
  assert.ok(!isDefiniteRejection(409));
});
