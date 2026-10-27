import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasSevereExposureDrift, meanFrameBrightness, productionExposureLock, requestsExposureChange } from "./production-exposure";

test("severe cumulative darkening plus an in-clip decline stops a cascade", () => {
  assert.equal(hasSevereExposureDrift(120, 85, 45), true);
});
test("stable shots, small shifts and intentionally dark baselines do not trigger", () => {
  for (const values of [[120, 120, 110], [120, 50, 49], [20, 18, 10], [120, 80, 75]]) {
    assert.equal(hasSevereExposureDrift(...values as [number, number, number]), false);
  }
  assert.throws(() => hasSevereExposureDrift(NaN, 80, 40), /reliably/);
});
test("exposure instructions preserve exact continuation and explicitly authored changes", () => {
  assert.match(productionExposureLock, /fixed lighting baseline/);
  assert.match(productionExposureLock, /exact starting image/);
  assert.equal(requestsExposureChange("The lights dim."), true);
  assert.equal(requestsExposureChange("Fade to black."), true);
  assert.equal(requestsExposureChange("A dim bakery. Nora gives Eli bread."), false);
  assert.equal(requestsExposureChange("The beam stutters, then dies."), true);
  assert.equal(requestsExposureChange("Eli turns the lights off."), true);
});

test("real ffmpeg decoding measures fading video and its unmodified final frame", async () => {
  const exec = promisify(execFile);
  const dir = await mkdtemp(path.join(tmpdir(), "exposure-regression-"));
  try {
    const video = path.join(dir, "fade.mp4"), last = path.join(dir, "last.png");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x64:r=24:d=1",
      "-vf", "fade=t=out:st=0:d=1", "-c:v", "libx264", "-y", video]);
    await exec("ffmpeg", ["-v", "error", "-sseof", "-1", "-i", video, "-update", "1", "-y", last]);
    const firstBrightness = await meanFrameBrightness(video);
    const lastBrightness = await meanFrameBrightness(last);
    assert.ok(firstBrightness > 100);
    assert.ok(lastBrightness < 20);
    assert.equal(hasSevereExposureDrift(firstBrightness, firstBrightness, lastBrightness), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
