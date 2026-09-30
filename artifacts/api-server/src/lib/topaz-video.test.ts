import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CreateGenerationBody, SubmitVideoUpscaleBody } from "@workspace/api-zod";
import { planTopazUpscale, topazPayload, validateTopazOutput, finalizeTopazOutput } from "./topaz-video";
import { FalQueueClient, falModelFromEndpoint, TOPAZ_VIDEO_ENDPOINT, validateFalQueueUrl, FalHttpError } from "./fal/client";
import { assertTopazSource, topazSubmissionIsUnbilled } from "./topaz-service";
import type { GenerationJob } from "@workspace/db";
import { probeVideoMediaProperties } from "./video-media-probe";

const source = { width: 1280, height: 720, durationSeconds: 8, fps: 24, audioStreams: 1 };
test("Topaz quotes exact 720→1080 / 720→4K geometry and only local estimates", () => {
  const hd = planTopazUpscale("id", "key", source, "1080p");
  const uhd = planTopazUpscale("id", "key", source, "4k");
  assert.deepEqual([hd.targetWidth, hd.targetHeight, hd.upscaleFactor, hd.estimatedUsd], [1920, 1080, 1.5, 0.16]);
  assert.deepEqual([uhd.targetWidth, uhd.targetHeight, uhd.upscaleFactor, uhd.estimatedUsd], [3840, 2160, 3, 0.64]);
  assert.notEqual(hd.quoteToken, uhd.quoteToken);
  assert.notEqual(hd.quoteToken, planTopazUpscale("id", "changed-key", source, "1080p").quoteToken);
  assert.equal(hd.quoteToken, planTopazUpscale("id", "key", source, "1080p").quoteToken);
  const portrait = planTopazUpscale("id", "key", { ...source, width: 720, height: 1280 }, "1080p");
  assert.deepEqual([portrait.targetWidth, portrait.targetHeight], [1080, 1920]);
  const square = planTopazUpscale("id", "key", { ...source, width: 720 }, "4k");
  assert.deepEqual([square.targetWidth, square.targetHeight], [2160, 2160]);
});
test("Topaz rejects downscale and unknown timing, and conservatively quotes fractional/high FPS", () => {
  assert.throws(() => planTopazUpscale("id", "key", { ...source, width: 1920, height: 1080 }, "1080p"), /larger/);
  assert.throws(() => planTopazUpscale("id", "key", { ...source, fps: undefined }, "4k"), /measurable/);
  assert.throws(() => planTopazUpscale("id", "key", { ...source, fps: 120 }, "4k"), /60 fps/);
  const high = planTopazUpscale("id", "key", { ...source, fps: 60000 / 1001, durationSeconds: 8.01 }, "4k");
  assert.equal(high.estimatedUsd, 1.44);
  assert.equal(high.fps, 60000 / 1001);
  const wide = planTopazUpscale("id", "key", { ...source, width: 2048, height: 512 }, "4k");
  assert.deepEqual([wide.targetWidth, wide.targetHeight], [3840, 960]);
});
test("Topaz payload never interpolates frames, and invalid delivered geometry/timing fails closed", () => {
  const plan = planTopazUpscale("id", "key", source, "1080p");
  assert.deepEqual(topazPayload("https://example.invalid/input.mp4", plan), {
    video_url: "https://example.invalid/input.mp4", model: "Proteus", upscale_factor: 1.5, H264_output: true,
  });
  assert.throws(() => validateTopazOutput(source, plan), /instead of/);
  assert.throws(() => validateTopazOutput({ ...source, width: 1920, height: 1080, fps: 60 }, plan), /frame rate/);
  assert.throws(() => validateTopazOutput({ ...source, width: 1920, height: 1080, durationSeconds: 10 }, plan), /timing/);
});
test("eligibility is provider-neutral, rejects unavailable videos, and submission accounting remains conservative", () => {
  for (const provider of ["FAL", "COMFYUI"]) {
    assert.doesNotThrow(() => assertTopazSource({ provider, status: "COMPLETED", outputStorageKey: "owned", outputMimeType: "video/mp4" } as GenerationJob));
  }
  assert.throws(() => assertTopazSource(undefined), /not found/);
  assert.throws(() => assertTopazSource({ status: "RUNNING" } as GenerationJob), /completed/);
  assert.throws(() => assertTopazSource({ status: "COMPLETED", outputStorageKey: "key", outputMimeType: "image/png" } as GenerationJob), /no video/);
  for (const status of [null, 408, 409, 425, 429, 500]) {
    assert.equal(topazSubmissionIsUnbilled(true, new FalHttpError("uncertain", status, true)), false);
  }
  assert.equal(topazSubmissionIsUnbilled(false, new Error("allowance exceeded")), true);
  assert.equal(topazSubmissionIsUnbilled(true, new FalHttpError("rejected", 422, false)), true);
});
test("Topaz uses a dedicated submit contract, not a generation dropdown model", () => {
  assert.equal(SubmitVideoUpscaleBody.safeParse({ targetResolution: "4k", quoteToken: "a".repeat(64), requestId: "not-uuid" }).success, false);
  assert.equal(CreateGenerationBody.safeParse({ model: "topaz-upscale" }).success, false);
  assert.equal(falModelFromEndpoint(TOPAZ_VIDEO_ENDPOINT), "topaz-upscale");
  assert.throws(() => validateFalQueueUrl("https://evil.invalid/requests/id", "status"), /Cloud|URL|host/i);
});
test("mocked Fal submission/poll/result/cancel reuses exact paid receipt URLs without live requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FAL_KEY;
  process.env.FAL_KEY = "test-only-not-a-secret";
  const status = "https://queue.fal.run/fal-ai/topaz/requests/test/status";
  const response = "https://queue.fal.run/fal-ai/topaz/requests/test";
  const cancel = "https://queue.fal.run/fal-ai/topaz/requests/test/cancel";
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url) === `https://queue.fal.run/${TOPAZ_VIDEO_ENDPOINT}`) {
      const payload = JSON.parse(String(options?.body));
      assert.equal(payload.model, "Proteus");
      assert.equal("target_fps" in payload, false);
      return new Response(JSON.stringify({ request_id: "test", status_url: status, response_url: response, cancel_url: cancel }));
    }
    if (String(url) === status) return new Response(JSON.stringify({ status: "COMPLETED" }));
    if (String(url) === response) return new Response(JSON.stringify({ video: { url: "https://v3.fal.media/result.mp4" } }));
    if (String(url) === cancel) { assert.equal(options?.method, "PUT"); return new Response("{}"); }
    throw new Error(`Unexpected test network request: ${url}`);
  };
  try {
    const client = new FalQueueClient("topaz-upscale");
    const receipt = await client.submit(topazPayload("https://v3.fal.media/input.mp4", planTopazUpscale("id", "key", source, "1080p")));
    const recovered = new FalQueueClient(falModelFromEndpoint(TOPAZ_VIDEO_ENDPOINT)!);
    await recovered.status(receipt.endpoints);
    await recovered.result(receipt.endpoints);
    await recovered.cancel(receipt.endpoints);
    assert.deepEqual(calls, [`https://queue.fal.run/${TOPAZ_VIDEO_ENDPOINT}`, status, response, cancel]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = originalKey;
  }
});
test("real FFmpeg finalization retains original audio and removes unwanted audio for a silent source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "topaz-media-test-"));
  const run = promisify(execFile);
  try {
    const original = path.join(directory, "source.mp4");
    const enhanced = path.join(directory, "enhanced.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=128x72:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac",
      "-movflags", "+faststart", "-shortest", "-y", original]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=192x108:r=24:d=1",
      "-c:v", "libx264", "-movflags", "+faststart", "-y", enhanced]);
    const sourceBytes = await readFile(original);
    const videoBytes = await readFile(enhanced);
    const properties = await probeVideoMediaProperties(sourceBytes);
    const plan = { ...planTopazUpscale("id", "key", properties, "1080p"), targetWidth: 192, targetHeight: 108 };
    const finalized = await finalizeTopazOutput(videoBytes, sourceBytes, plan);
    assert.equal(finalized.properties.audioStreams, 1);
    assert.equal(finalized.properties.fps, 24);
    const silentPlan = { ...plan, audioStreams: 0, hasAudio: false };
    const silent = await finalizeTopazOutput(finalized.bytes, videoBytes, silentPlan);
    assert.equal(silent.properties.audioStreams, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});