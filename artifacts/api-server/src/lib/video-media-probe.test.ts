import assert from "node:assert/strict";
import { test } from "node:test";
import { measuredVideoJobMetrics, parseVideoMediaProperties } from "./video-media-probe";

test("output media metadata resolves actual duration and frame rate for job finalization", () => {
  const properties = parseVideoMediaProperties(JSON.stringify({
    format: { duration: "7.25" },
    streams: [
      { codec_type: "audio", avg_frame_rate: "0/0", r_frame_rate: "0/0" },
      { codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30000/1001", r_frame_rate: "30/1" },
    ],
  }));
  assert.deepEqual(properties, { durationSeconds: 7.25, fps: 30_000 / 1001, width: 1280, height: 720 });
  assert.deepEqual(measuredVideoJobMetrics(properties, 24), {
    durationSeconds: 7.25,
    fps: 30_000 / 1001,
    frameCount: 217,
  });
});

test("output duration remains measurable when ffprobe omits a usable frame rate", () => {
  const properties = parseVideoMediaProperties(JSON.stringify({
    format: { duration: 6 },
    streams: [{ codec_type: "video", avg_frame_rate: "0/0", r_frame_rate: "0/0" }],
  }));
  assert.deepEqual(properties, { durationSeconds: 6 });
  assert.deepEqual(measuredVideoJobMetrics(properties, 24), {
    durationSeconds: 6,
    fps: 24,
    frameCount: 144,
  });
});