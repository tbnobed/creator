import assert from "node:assert/strict";
import { test } from "node:test";
import { measuredVideoJobMetrics, parseVideoMediaProperties, probeVideoMediaProperties } from "./video-media-probe";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("uploaded MP4/MOV supports seeking and early probe completion without pipe failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-probe-test-"));
  try {
    for (const extension of ["mp4", "mov"]) {
      for (const faststart of [false, true]) {
        const file = path.join(directory, `source-${faststart}.${extension}`);
        await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
          "testsrc2=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast",
          "-crf", "0", ...(faststart ? ["-movflags", "+faststart"] : []), "-y", file]);
        const bytes = await readFile(file);
        assert.ok(bytes.length > 1024 * 1024, "fixture exceeds pipe capacity");
        const result = await probeVideoMediaProperties(bytes);
        assert.equal(result.width, 640);
        assert.equal(result.height, 360);
        assert.equal(result.fps, 30);
        assert.equal(result.durationSeconds, 3);
      }
    }
    await assert.rejects(probeVideoMediaProperties(Buffer.alloc(0)), /empty/);
    await assert.rejects(probeVideoMediaProperties(Buffer.from("not a video")), /damaged or unsupported/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("output media metadata resolves actual duration and frame rate for job finalization", () => {
  const properties = parseVideoMediaProperties(JSON.stringify({
    format: { duration: "7.25" },
    streams: [
      { codec_type: "audio", avg_frame_rate: "0/0", r_frame_rate: "0/0" },
      { codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30000/1001", r_frame_rate: "30/1" },
    ],
  }));
  assert.deepEqual(properties, { durationSeconds: 7.25, fps: 30_000 / 1001, width: 1280, height: 720, audioStreams: 1 });
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
  assert.deepEqual(properties, { durationSeconds: 6, audioStreams: 0 });
  assert.deepEqual(measuredVideoJobMetrics(properties, 24), {
    durationSeconds: 6,
    fps: 24,
    frameCount: 144,
  });
});