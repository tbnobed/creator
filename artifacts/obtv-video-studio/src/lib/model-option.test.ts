import assert from "node:assert/strict";
import { test } from "node:test";
import { groupModelOptions, imageModelOption, videoCloudOption } from "./model-option.ts";

test("image adapter marks cloud as paid with price note; local has none", () => {
  const c = imageModelOption({ id: "c", name: "Nano", provider: "CLOUD", priceNote: "$0.15 per image" }, null);
  const l = imageModelOption({ id: "l", name: "Flux", provider: "LOCAL", priceNote: "free" }, "Does not support image editing");
  assert.equal(c.paid, true); assert.equal(c.note, "$0.15 per image");
  assert.equal(l.paid, false); assert.equal(l.note, undefined); assert.equal(l.reason, "Does not support image editing");
});

test("video cloud adapter is always paid and groups after local", () => {
  const v = videoCloudOption({ value: "veo", label: "Veo", rate: 0.15 });
  assert.equal(v.paid, true); assert.equal(v.note, "~$0.150/s estimated");
  const groups = groupModelOptions([v, imageModelOption({ id: "l", name: "Flux", provider: "LOCAL" }, null)]);
  assert.deepEqual(groups.map((g) => g.paid), [false, true]);
  assert.deepEqual(groupModelOptions([v]).map((g) => g.heading), ["Cloud · cost applies"]);
});
