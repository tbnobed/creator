import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SubmitGarmentJobBody } from "@workspace/api-zod";
import { validatePaidReplacement, replacementSampling, type ReplacementSubmission } from "./video-replacement-service";
import { prepareReplacementSource, preserveReplacementAudio, replacementPrompt, validateReplacementRange } from "./video-replacement-media";
import { garmentFrames } from "./garment-media";
import { probeVideoMediaProperties } from "./video-media-probe";

const tenant = "11111111-1111-4111-8111-111111111111";
const request: ReplacementSubmission = {
  tenantId: tenant, userId: "test", requestId: "22222222-2222-4222-8222-222222222222",
  sourceStorageKey: `tenants/${tenant}/generation-references/33333333-3333-4333-8333-333333333333.mp4`,
  provider: "FAL", model: "seedance-2.5", confirmPaid: true, mode: "replace-item",
  targetGarment: "The person on the left", prompt: "Replace them with a robot",
  startSeconds: 0, durationSeconds: 4, seed: 42,
};

test("paid replacement explicitly requires model, mode, and cost consent before media or provider access", () => {
  assert.doesNotThrow(() => validatePaidReplacement(request));
  for (const change of [
    { confirmPaid: false }, { confirmPaid: undefined }, { model: undefined },
    { provider: "LOCAL" as const }, { mode: "animate-artwork" as const },
    { workerId: tenant }, { prompt: "" }, { targetGarment: "" },
    { durationSeconds: 3 }, { durationSeconds: 3.99 }, { durationSeconds: 16 },
    { sourceStorageKey: request.sourceStorageKey.replace(tenant, request.requestId) },
  ]) assert.throws(() => validatePaidReplacement({ ...request, ...change }));
});

test("API accepts cloud without a worker, retains local requests, rejects unknown models", () => {
  assert.deepEqual(replacementSampling, { seedMode: "RANDOM" });
  const { tenantId, userId, ...body } = request;
  assert.equal(SubmitGarmentJobBody.strict().safeParse(body).success, true);
  assert.equal(SubmitGarmentJobBody.strict().safeParse({ ...body, model: "imaginary-editor" }).success, false);
  assert.equal(SubmitGarmentJobBody.strict().safeParse({ ...body, durationSeconds: 30 }).success, false);
  assert.throws(() => garmentFrames(4), /0.5 to 3/);
});

test("replacement targets people, objects, and garments, with optional reference conditioning", () => {
  for (const target of ["the person on the left", "the red car", "the jacket"]) {
    assert.match(replacementPrompt(target, "Make the requested replacement", false), new RegExp(target));
    assert.doesNotMatch(replacementPrompt(target, "Replace it", false), /@Image1/);
    assert.match(replacementPrompt(target, "Replace it", true), /@Image1/);
  }
  for (const [start, duration, total] of [[-1, 2, 5], [0, 1, 5], [0, 16, 30], [4, 2, 5], [NaN, 2, 5]]) {
    assert.throws(() => validateReplacementRange(start, duration, total));
  }
  assert.throws(() => validateReplacementRange(2, 3, 5), /at least 4 seconds/);
  assert.doesNotThrow(() => validateReplacementRange(2, 4, 6));
});

test("real FFmpeg window preparation retains resolution/audio; finalization strips synthetic audio and keeps provider duration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "replacement-test-"));
  const execute = promisify(execFile);
  try {
    const source = path.join(dir, "source.mp4"), silent = path.join(dir, "silent.mp4");
    await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", source]);
    await execute("ffmpeg", ["-v", "error", "-i", source, "-an", "-c:v", "copy", "-y", silent]);
    const prepared = await prepareReplacementSource(await readFile(source), 1, 4);
    const props = await probeVideoMediaProperties(prepared);
    assert.equal(props.width, 640);
    assert.equal(props.height, 360);
    assert.equal(props.fps, 24);
    assert.equal(props.audioStreams, 1);
    assert.ok(Math.abs(props.durationSeconds - 4) < .1);
    const final = await preserveReplacementAudio(await readFile(silent), prepared);
    const finalProps = await probeVideoMediaProperties(final);
    assert.equal(finalProps.audioStreams, 1);
    assert.ok(Math.abs(finalProps.durationSeconds - 6) < .1);
    const noAudioSource = await prepareReplacementSource(await readFile(silent), 0, 4);
    const noSyntheticSpeech = await preserveReplacementAudio(await readFile(source), noAudioSource);
    assert.equal((await probeVideoMediaProperties(noSyntheticSpeech)).audioStreams, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
