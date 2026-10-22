import assert from "node:assert/strict";
import { test } from "node:test";
import { fileMatchesAccept } from "./file-accept.ts";

test("mime, wildcard and extension rules", () => {
  assert.ok(fileMatchesAccept({ name: "a.png", type: "image/png" }, "image/jpeg,image/png"));
  assert.ok(!fileMatchesAccept({ name: "a.gif", type: "image/gif" }, "image/jpeg,image/png"));
  assert.ok(fileMatchesAccept({ name: "a.MOV", type: "" }, "video/mp4,.mov"));
  assert.ok(fileMatchesAccept({ name: "x.webp", type: "image/webp" }, "image/*"));
  assert.ok(!fileMatchesAccept({ name: "x.mp4", type: "video/mp4" }, "image/*"));
});

import { pickAccepted } from "./file-accept.ts";
test("pickAccepted enforces count and type before tool-specific checks", () => {
  const png = { name: "a.png", type: "image/png" }, mov = { name: "b.mov", type: "video/quicktime" };
  assert.deepEqual(pickAccepted([], "image/png"), { ok: false, error: "" });
  assert.deepEqual(pickAccepted([png, png], "image/png", false, "image"), { ok: false, error: "Choose one image at a time." });
  assert.equal(pickAccepted([mov], "image/png").ok, false);
  assert.deepEqual(pickAccepted([mov], "video/mp4,video/quicktime,.mp4,.mov"), { ok: true, files: [mov] });
  assert.equal(pickAccepted([png, png], "image/*", true).ok, true);
});
