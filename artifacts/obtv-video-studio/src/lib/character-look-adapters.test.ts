import assert from "node:assert/strict";
import { test } from "node:test";
import { appendChip, deriveCharacterName, slotsFromBatch, slotsFromProduction, slotsFromSheet } from "./character-look-adapters.ts";

test("batch slots map statuses and pad to four", () => {
  const slots = slotsFromBatch({ slots: [
    { index: 0, status: "READY", assetId: "a", mediaUrl: "u" },
    { index: 1, status: "RUNNING" },
    { index: 2, status: "FAILED", error: "nsfw" },
  ] });
  assert.deepEqual(slots.map((s) => s.state), ["READY", "PENDING", "FAILED", "EMPTY"]);
  assert.equal(slots[2].error, "nsfw");
  assert.equal(slotsFromBatch(null).length, 4);
});

test("READY without media is not selectable", () => {
  assert.equal(slotsFromBatch({ slots: [{ index: 0, status: "READY", assetId: null, mediaUrl: null }] })[0].state, "EMPTY");
});

test("production options map to ready slots, generating shows progress", () => {
  assert.deepEqual(slotsFromProduction({ options: [{ assetId: "x", mediaUrl: "m" }], status: "READY" }).map((s) => s.state), ["READY", "EMPTY", "EMPTY", "EMPTY"]);
  assert.ok(slotsFromProduction({ options: [{ assetId: "x", mediaUrl: "m" }], status: "RUNNING" }).every((s) => s.state === "PENDING"));
  assert.equal(slotsFromProduction({ options: [], status: "FAILED" })[0].state, "FAILED");
});

test("sheet keeps labels", () => {
  assert.equal(slotsFromSheet([{ assetId: "s", mediaUrl: "m", label: "profile" }])[0].label, "profile");
});

test("derived names drop articles and cap at six words", () => {
  assert.equal(deriveCharacterName("a weathered harbor pilot in her fifties wearing wool, salt braid"), "Weathered Harbor Pilot In Her Fifties");
  assert.equal(deriveCharacterName("   "), "Untitled character");
});

test("chips append on a new line", () => {
  assert.equal(appendChip("", "age"), "age: ");
  assert.equal(appendChip("tall", "hair"), "tall\nhair: ");
});
