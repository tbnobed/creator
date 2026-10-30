import assert from "node:assert/strict";
import test from "node:test";
import { localImageReferenceError, localImageReferenceLimit } from "./local-image-references";

test("image slots are chosen only from compatible video/setting workflows", () => {
  const caps = [
    { supportsReferenceVideo: false, requiresSettingReference: false, referenceImageSlots: 2 },
    { supportsReferenceVideo: false, requiresSettingReference: true, referenceImageSlots: 4 },
    { supportsReferenceVideo: true, requiresSettingReference: false, referenceImageSlots: 3 },
  ];
  assert.equal(localImageReferenceLimit(caps, false, false), 2);
  assert.equal(localImageReferenceLimit(caps, false, true), 4);
  assert.equal(localImageReferenceLimit(caps, true, false), 3);
  assert.equal(localImageReferenceLimit([], false, false), 0);
  assert.equal(localImageReferenceLimit([{ supportsReferenceVideo: false, requiresSettingReference: false }], false, false), 0);
});

test("unsupported, excess and pending images block submission, empty optional input does not", () => {
  assert.equal(localImageReferenceError(0, 0, false), null);
  assert.equal(localImageReferenceError(2, 2, false), null);
  assert.match(localImageReferenceError(1, 0, false)!, /does not accept/);
  assert.match(localImageReferenceError(3, 2, false)!, /at most 2/);
  assert.match(localImageReferenceError(0, 2, true)!, /upload to finish/);
});
