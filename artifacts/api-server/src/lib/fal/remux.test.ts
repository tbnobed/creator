import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { probeVideoMediaProperties } from "../video-media-probe";
import { isRecoverableFalOutputFailure, remuxMp4ToMov } from "./remux";

const execFileAsync = promisify(execFile);

test("synthetic MP4 video and audio remux into a private, previewable MOV without transcoding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "obtv-fal-remux-test-"));
  process.env.OBTV_MEDIA_ROOT = directory;
  const { LocalMediaStorage } = await import("../storage-service");
  const input = path.join(directory, "synthetic.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", "-shortest", "-y", input,
    ], { timeout: 20_000 });
    const original = await readFile(input);
    const converted = await remuxMp4ToMov(original);
    assert.equal(converted.toString("ascii", 4, 8), "ftyp");
    assert.equal(converted.toString("ascii", 8, 12), "qt  ");
    const measured = await probeVideoMediaProperties(converted);
    assert.equal(measured.width, 320);
    assert.equal(measured.height, 180);
    assert.ok(measured.durationSeconds >= 0.9);
    const storage = new LocalMediaStorage();
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const key = await storage.storeOutput("synthetic.mov", "video/quicktime", converted, tenantId);
    assert.match(key, new RegExp(`^tenants/${tenantId}/generations/[a-f0-9-]+\\.mov$`));
    assert.deepEqual(await storage.readBuffer(key), converted);
    assert.ok((await stat(await storage.videoPreviewPath(key, tenantId))).size > 0);

    const inspect = async (file: string) => {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_name,codec_type",
        "-of", "json", file,
      ]);
      return (JSON.parse(stdout) as { streams: Array<{ codec_name: string; codec_type: string }> }).streams
        .map(({ codec_name, codec_type }) => `${codec_type}:${codec_name}`).sort();
    };
    assert.deepEqual(await inspect(storage.resolvePath(key)), await inspect(input));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed remux does not produce a mislabeled MOV output", async () => {
  await assert.rejects(remuxMp4ToMov(Buffer.from("corrupted mp4")), /ffmpeg|Invalid data|could not/i);
  assert.equal(isRecoverableFalOutputFailure("Cloud MOV output finalization failed: incompatible codec"), true);
  assert.equal(isRecoverableFalOutputFailure("Timed out while waiting for Cloud"), true);
  assert.equal(isRecoverableFalOutputFailure("Cloud generation failed"), false);
});