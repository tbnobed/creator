import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadFileName, safeStorageGet, safeStorageSet, videoExtension } from "./media-file";

test("download extension follows storage key, then URL, then content type", () => {
  assert.equal(videoExtension({ outputStorageKey: "t/out/fal-1.mov", mediaUrl: "/api/x.mp4" }), "mov");
  assert.equal(videoExtension({ outputStorageKey: null, mediaUrl: "/api/media/a.MOV?sig=1" }), "mov");
  assert.equal(videoExtension({ outputStorageKey: "opaque-key", mediaUrl: "/api/media/abc" }, "video/quicktime"), "mov");
  assert.equal(videoExtension({ outputStorageKey: null, mediaUrl: null }), "mp4");
  assert.equal(downloadFileName({ id: "12345678-aaaa", title: "Rooftop / take 2", outputStorageKey: "k/v.mov" }), "Rooftop-take-2-12345678.mov");
});

test("storage helpers swallow SecurityError", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage() { throw new Error("SecurityError"); } } });
  try {
    assert.equal(safeStorageGet("k"), null);
    assert.doesNotThrow(() => safeStorageSet("k", "v"));
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original); else delete (globalThis as { window?: unknown }).window;
  }
});
