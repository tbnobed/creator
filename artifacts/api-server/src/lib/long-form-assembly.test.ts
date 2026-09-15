import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  buildLongFormAssemblyFfmpegArgs,
  type LongFormAssemblyFfmpegOptions,
} from "./long-form-service";

const execFileAsync = promisify(execFile);

function assemblyOptions(
  overrides: Partial<LongFormAssemblyFfmpegOptions> = {},
): LongFormAssemblyFfmpegOptions {
  return {
    sourcePath: "/tmp/source.mp4",
    destinationPath: "/tmp/output.mp4",
    project: {
      generationMode: "minimax-h3-r2v",
      width: 1920,
      height: 1080,
      fps: 24,
    },
    mediaInfo: {
      durationSeconds: 158 / 24,
      hasAudio: false,
      width: 1920,
      height: 1088,
    },
    clip: {
      trimStartSeconds: 0,
      trimEndSeconds: 6,
    },
    ...overrides,
  };
}

test("H3 assembly crops its padded model height and honors authored frame duration", () => {
  const args = buildLongFormAssemblyFfmpegArgs(assemblyOptions());
  const filter = args[args.indexOf("-vf") + 1];

  assert.match(filter, /crop=1920:1080:\(iw-1920\)\/2:\(ih-1080\)\/2/);
  assert.match(filter, /setsar=1/);
  assert.equal(args[args.indexOf("-frames:v") + 1], "144");
  assert.equal(args[args.indexOf("-t") + 1], "6");
  assert.equal(args[args.indexOf("-ss") + 1], "0");
});

test("assembly preserves edited trim points and fails on a meaningfully short source", () => {
  const edited = buildLongFormAssemblyFfmpegArgs(assemblyOptions({
    clip: { trimStartSeconds: 1.25, trimEndSeconds: 3.75 },
  }));
  assert.equal(edited[edited.indexOf("-ss") + 1], "1.25");
  assert.equal(edited[edited.indexOf("-frames:v") + 1], "60");
  assert.throws(() => buildLongFormAssemblyFfmpegArgs(assemblyOptions({
    mediaInfo: { ...assemblyOptions().mediaInfo, durationSeconds: 5.9 },
  })), /shorter than its timeline trim/);
});

test("24fps frame planning keeps thirty authored clips at exactly 190 seconds", () => {
  const clipDuration = 190 / 30;
  const totalFrames = Array.from({ length: 30 }, () => buildLongFormAssemblyFfmpegArgs(assemblyOptions({
    clip: { trimStartSeconds: 0, trimEndSeconds: clipDuration },
  }))).reduce((sum, args) => sum + Number(args[args.indexOf("-frames:v") + 1]), 0);
  assert.equal(totalFrames, 190 * 24);
  assert.equal(totalFrames / 24, 190);
});

test("H3 fixture assembly outputs 1920x1080 square-pixel video with 144 frames", async () => {
  const workDir = await mkdtemp(path.join("/tmp", "obtv-h3-assembly-test-"));
  const sourcePath = path.join(workDir, "source.mp4");
  const outputPath = path.join(workDir, "output.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=size=1920x1088:rate=24",
      "-frames:v", "158",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      sourcePath,
    ]);
    const args = buildLongFormAssemblyFfmpegArgs(assemblyOptions({
      sourcePath,
      destinationPath: outputPath,
    }));
    await execFileAsync("ffmpeg", args);
    const probe = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,width,height,nb_frames,sample_aspect_ratio",
      "-of", "json",
      outputPath,
    ]);
    const parsed = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        nb_frames?: string;
        sample_aspect_ratio?: string;
      }>;
    };
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    assert.equal(video?.width, 1920);
    assert.equal(video?.height, 1080);
    assert.equal(video?.nb_frames, "144");
    assert.equal(video?.sample_aspect_ratio, "1:1");
    assert.ok(Math.abs(Number(parsed.format?.duration) - 6) < 0.05);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});