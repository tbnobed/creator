import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveShortDescription, hasDistinctShortDescription, locationThumbnailInput, parseTags, resolveShortDescription, SHORT_DESCRIPTION_MAX } from "./location-form.ts";

test("derives first sentence within limit", () => {
  assert.equal(deriveShortDescription("  Rooftop bar at dusk.  Neon signs flicker."), "Rooftop bar at dusk.");
  assert.equal(deriveShortDescription(""), "");
  const long = deriveShortDescription("word ".repeat(100));
  assert.ok(long.length <= SHORT_DESCRIPTION_MAX);
  assert.ok(long.endsWith("…"));
});

test("preserves distinct existing summary only", () => {
  assert.equal(hasDistinctShortDescription("Cozy bar", "Rooftop bar at dusk. Neon."), true);
  assert.equal(hasDistinctShortDescription("Rooftop bar at dusk.", "Rooftop bar at dusk. Neon."), false);
  assert.equal(hasDistinctShortDescription("", "x"), false);
  assert.equal(resolveShortDescription("New prompt.", "Cozy bar"), "Cozy bar");
  assert.equal(resolveShortDescription("New prompt. More.", null), "New prompt.");
});

test("parses tags", () => {
  assert.deepEqual(parseTags(" a, b,,a "), ["a", "b"]);
});

test("saving stale empty form state does not clear a generated thumbnail", () => {
  assert.deepEqual(locationThumbnailInput(""), {});
  assert.deepEqual(locationThumbnailInput("/api/media/saved-image"), { thumbnail: "/api/media/saved-image" });
});
