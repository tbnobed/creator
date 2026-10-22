import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedKey, setStorageScope } from "./workspace-storage.ts";

test("keys differ per workspace and user", () => {
  setStorageScope("u1", "t1"); const a = scopedKey("obtv.composerDraft");
  setStorageScope("u1", "t2"); const b = scopedKey("obtv.composerDraft");
  setStorageScope("u2", "t1"); const c = scopedKey("obtv.composerDraft");
  assert.notEqual(a, b); assert.notEqual(a, c);
  assert.equal(a, "obtv.composerDraft:u1:t1");
});

import { discardLegacyDrafts, importLegacyDrafts, pendingLegacyDrafts } from "./workspace-storage.ts";
const mem = (init: Record<string, string>) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("legacy drafts are never used silently and import only on request", () => {
  setStorageScope("u1", "t1");
  const s = mem({ "obtv.composerDraft": "{\"prompt\":\"old\"}" });
  assert.equal(s.getItem(scopedKey("obtv.composerDraft")), null);
  assert.deepEqual(pendingLegacyDrafts(s), ["obtv.composerDraft"]);
  assert.equal(importLegacyDrafts(s), 1);
  assert.equal(s.getItem("obtv.composerDraft:u1:t1"), "{\"prompt\":\"old\"}");
  assert.equal(s.getItem("obtv.composerDraft"), null);
  setStorageScope("u1", "t2");
  assert.equal(s.getItem(scopedKey("obtv.composerDraft")), null);
});

test("explicit import replaces this workspace draft only; discard removes legacy", () => {
  setStorageScope("u1", "t1");
  const s = mem({ "obtv.composerDraft": "old", "obtv.composerDraft:u1:t1": "autosaved-empty", "obtv.composerDraft:u1:t2": "other" });
  assert.deepEqual(pendingLegacyDrafts(s), ["obtv.composerDraft"]);
  assert.equal(importLegacyDrafts(s), 1);
  assert.equal(s.getItem("obtv.composerDraft:u1:t1"), "old");
  assert.equal(s.getItem("obtv.composerDraft:u1:t2"), "other");
  assert.deepEqual(pendingLegacyDrafts(s), []);
  const t = mem({ "obtv.referenceVideo": "x" });
  discardLegacyDrafts(t);
  assert.equal(t.getItem("obtv.referenceVideo"), null);
});
