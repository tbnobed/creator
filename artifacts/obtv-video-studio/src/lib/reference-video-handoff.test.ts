import assert from "node:assert/strict";
import test from "node:test";
import { handoffReferenceVideo } from "./reference-video-handoff";

test("saved videos open the composer without another upload", async () => {
  const keys: string[] = [];
  assert.equal(await handoffReferenceVideo("saved-key", async () => { throw new Error("Must not upload"); }, key => keys.push(key)), true);
  assert.deepEqual(keys, ["saved-key"]);
});

test("local video is uploaded before the composer opens", async () => {
  const events: string[] = [];
  const result = await handoffReferenceVideo(null, async () => {
    events.push("upload");
    await Promise.resolve();
    return "uploaded-key";
  }, key => events.push(`navigate:${key}`));
  assert.equal(result, true);
  assert.deepEqual(events, ["upload", "navigate:uploaded-key"]);
});

test("failed or absent uploads never navigate with an unusable reference", async () => {
  assert.equal(await handoffReferenceVideo(null, async () => null, () => assert.fail("Must not navigate")), false);
  await assert.rejects(handoffReferenceVideo(null, async () => { throw new Error("Upload failed"); }, () => assert.fail("Must not navigate")), /Upload failed/);
});
