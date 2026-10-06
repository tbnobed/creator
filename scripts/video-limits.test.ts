import assert from "node:assert/strict";
import test from "node:test";
import { localVideoDurationLimit } from "../lib/api-zod/src/video-limits";
test("single-pass duration policy distinguishes families and frame rates", () => {
  assert.equal(localVideoDurationLimit("Wan 2.2 5B", 24), 5);
  assert.equal(localVideoDurationLimit("Wan 2.2 5B", 30), 4);
  assert.equal(localVideoDurationLimit("MiniMax H3"), 15);
  assert.equal(localVideoDurationLimit("LTX 2.5"), 20);
  assert.equal(localVideoDurationLimit("LTX 2.5", 48), 10);
  assert.equal(localVideoDurationLimit("Unknown custom workflow"), 5);
});
