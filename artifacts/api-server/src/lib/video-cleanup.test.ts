import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { normalizeCleanupRotation } from "./video-cleanup";
import { probeVideoMediaProperties } from "./video-media-probe";
import { assertCleanupSourceKey, cleanupPayload, cleanupPlan, validateCleanupOutput } from "./video-cleanup";
import { falModelFromEndpoint, FalQueueClient } from "./fal/client";
import { isRecoverableFalOutputFailure } from "./fal/remux";

const properties = { width: 1920, height: 1080, durationSeconds: 4, fps: 30, audioStreams: 1 };
test("cleanup accepts short shots and refuses truncation, invalid metadata and cross-tenant inputs", () => {
  const plan = cleanupPlan(Buffer.from("clip"), properties);
  assert.equal(plan.hasAudio, true);
  assert.equal(plan.estimatedUsd, 5);
  for (const durationSeconds of [0, 5, 5.01, NaN]) {
    assert.throws(() => cleanupPlan(Buffer.from("clip"), { ...properties, durationSeconds }), /shorter than 5/);
  }
  assert.throws(() => cleanupPlan(Buffer.from("clip"), { ...properties, fps: 120 }), /60 fps/);
  const tenant = "11111111-1111-4111-8111-111111111111";
  assert.doesNotThrow(() => assertCleanupSourceKey(`tenants/${tenant}/generation-references/clip.mp4`, tenant));
  assert.throws(() => assertCleanupSourceKey(`tenants/${tenant}/generation-references/clip.mp4`, "22222222-2222-4222-8222-222222222222"));
  assert.throws(() => assertCleanupSourceKey(`tenants/${tenant}/generation-references/../clip.mp4`, tenant));
  assert.notEqual(plan.sourceToken, cleanupPlan(Buffer.from("changed"), properties).sourceToken);
});
test("point mapping uses actual display pixels, clamps boundaries, preserves audio and never auto trims", () => {
  const plan = cleanupPlan(Buffer.from("clip"), { ...properties, rotationDegrees: -90 });
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  const payload = cleanupPayload("https://example.invalid/clip", [
    { x: 0.5, y: 0.5, type: "positive" }, { x: 1, y: 1, type: "negative" },
  ], plan);
  assert.equal(payload.auto_trim, false);
  assert.equal(payload.preserve_audio, true);
  assert.deepEqual(payload.keypoints.map((value) => JSON.parse(value)), [
    { x: 540, y: 960, type: "positive" }, { x: 1079, y: 1919, type: "negative" },
  ]);
  for (const points of [[], [{ x: 0, y: 0, type: "negative" as const }], [{ x: NaN, y: 0, type: "positive" as const }]]) {
    assert.throws(() => cleanupPayload("url", points, plan), /Remove point/);
  }
});
test("cleanup output rejects timing/framing changes and supports recovery without re-billing", () => {
  const plan = cleanupPlan(Buffer.from("clip"), properties);
  assert.doesNotThrow(() => validateCleanupOutput({ ...properties, width: 1280, height: 720 }, plan));
  assert.throws(() => validateCleanupOutput({ ...properties, durationSeconds: 3 }, plan));
  assert.throws(() => validateCleanupOutput({ ...properties, width: 1080, height: 1920 }, plan));
  assert.equal(falModelFromEndpoint("bria/video/erase/keypoints"), "video-cleanup");
  assert.equal(new FalQueueClient("video-cleanup").model, "video-cleanup");
  assert.equal(isRecoverableFalOutputFailure("Video cleanup output verification failed: audio"), true);
});

test("phone rotation is applied before pixel-guided processing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cleanup-rotation-test-"));
  try {
    const run = promisify(execFile);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=24:d=1",
      "-c:v", "libx264", "-movflags", "+faststart", "-y", path.join(dir, "input.mp4")]);
    await run("ffmpeg", ["-v", "error", "-display_rotation", "90", "-i", path.join(dir, "input.mp4"),
      "-c", "copy", "-movflags", "+faststart", "-y", path.join(dir, "rotated.mp4")]);
    const bytes = await readFile(path.join(dir, "rotated.mp4"));
    const plan = cleanupPlan(bytes, await probeVideoMediaProperties(bytes));
    assert.equal(plan.width, 180); assert.equal(plan.height, 320);
    const output = await probeVideoMediaProperties(await normalizeCleanupRotation(bytes, plan));
    assert.equal(output.width, 180); assert.equal(output.height, 320);
    assert.equal(output.rotationDegrees, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});