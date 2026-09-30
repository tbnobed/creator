import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { assertOpaqueTopazSource, topazImageCost, topazImageScale } from "./topaz-image";
import { quoteImageSpend } from "./spending-pricing";

test("Topaz quotes exact output-pixel tiers without network requests", async () => {
  for (const [width, height, expected] of [[6000, 4000, .08], [6001, 4000, .16], [8000, 6000, .16], [8001, 6000, .32], [12000, 8000, .32]]) {
    assert.equal(topazImageCost(width!, height!), expected);
    assert.equal((await quoteImageSpend("cloud-topaz-upscale", { width: width!, height: height!, count: 1, operation: "upscale" })).estimatedUsd, expected);
  }
  assert.throws(() => topazImageCost(12001, 8000), /96 megapixels/);
  assert.throws(() => topazImageCost(32769, 1), /32768/);
});

test("Topaz requires exact measured 2x/4x output geometry", () => {
  assert.equal(topazImageScale({ width: 513, height: 777 }, 1026, 1554), 2);
  assert.equal(topazImageScale({ width: 513, height: 777 }, 2052, 3108), 4);
  for (const [width, height] of [[513, 777], [1026, 1555], [1539, 2331], [4104, 6216]]) {
    assert.throws(() => topazImageScale({ width: 513, height: 777 }, width!, height!), /exact/);
  }
});

test("Topaz pixel-opacity preflight accepts opaque RGB/RGBA PNG/WebP and rejects partial alpha", async () => {
  for (const format of ["png", "webp"]) {
    for (const channels of [3, 4]) {
      for (const alpha of channels === 4 ? [255, 128, 0] : [255]) {
        const pixels = Buffer.from(Array.from({ length: 4 }, () => channels === 4 ? [120, 80, 200, alpha] : [120, 80, 200]).flat());
        const bytes = execFileSync("ffmpeg", [
          "-v", "error", "-f", "rawvideo", "-pix_fmt", channels === 4 ? "rgba" : "rgb24",
          "-s", "2x2", "-i", "pipe:0", "-frames:v", "1", "-threads", "1",
          "-c:v", format === "png" ? "png" : "libwebp", "-f", "image2pipe", "pipe:1",
        ], { input: pixels, timeout: 15_000 });
        if (format === "png" && channels === 4) assert.equal(bytes[25], 6, "fixture retains RGBA");
        if (alpha === 255) await assert.doesNotReject(assertOpaqueTopazSource(bytes, `image/${format}`));
        else await assert.rejects(assertOpaqueTopazSource(bytes, `image/${format}`), /transparency/);
      }
    }
  }
});

test("Topaz opacity decode rejects malformed and oversized encoded inputs", async () => {
  await assert.rejects(assertOpaqueTopazSource(Buffer.from("broken PNG"), "image/png"), /validate image pixels/);
  await assert.rejects(assertOpaqueTopazSource(Buffer.alloc(12 * 1024 * 1024 + 1), "image/png"), /12 MB/);
});

test("Topaz does not round near-opaque 16-bit alpha to opaque", async () => {
  const pixels = Buffer.alloc(32, 255);
  pixels.writeUInt16LE(65534, 6);
  const bytes = execFileSync("ffmpeg", [
    "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba64le", "-s", "2x2", "-i", "pipe:0",
    "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], { input: pixels, timeout: 15_000 });
  assert.equal(bytes[24], 16);
  await assert.rejects(assertOpaqueTopazSource(bytes, "image/png"), /transparency/);
});