import test from "node:test";
import assert from "node:assert/strict";
import { displayDuration, localOutputSize } from "./studio-display";

test("durations use consistent whole seconds", () => {
  assert.equal(displayDuration(20), "20s");
  assert.equal(displayDuration(11.91), "12s");
  assert.equal(displayDuration(10.11), "10s");
});
test("output dimensions match the server's model-specific alignment", () => {
  assert.equal(localOutputSize(1280, 720, ["LTX 2.5"]), "1280 × 704");
  assert.equal(localOutputSize(1920, 1080, ["LTX 2.5"]), "1920 × 1024");
  assert.equal(localOutputSize(1280, 720, ["MiniMax H3"]), "1280 × 736");
  assert.equal(localOutputSize(1280, 704, ["MiniMax H3"]), "1280 × 704");
  assert.equal(localOutputSize(1280, 720, ["Other"]), "1280 × 720");
});
test("unknown or mixed workflow families do not promise an exact final size", () => {
  assert.equal(localOutputSize(1280, 720, []), "1280 × 720 requested");
  assert.equal(localOutputSize(1280, 720, ["LTX 2.5", "MiniMax H3"]), "1280 × 720 requested");
});
