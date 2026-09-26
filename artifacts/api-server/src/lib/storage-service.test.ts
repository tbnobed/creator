import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const storageRoot = await mkdtemp(path.join(tmpdir(), "obtv-reference-media-test-"));
process.env.OBTV_MEDIA_ROOT = storageRoot;
const { isTenantGenerationReferenceKey, LocalMediaStorage } = await import("./storage-service");
const storage = new LocalMediaStorage();

test("generation reference media is stored privately under its owner tenant", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const otherTenantId = "22222222-2222-4222-8222-222222222222";
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("private image bytes"),
  ]);
  try {
    const key = await storage.storeGenerationReferenceMedia("image/png", png, tenantId);
    assert.match(key, new RegExp(`^tenants/${tenantId}/generation-references/`));
    assert.equal(isTenantGenerationReferenceKey(key, tenantId), true);
    assert.equal(isTenantGenerationReferenceKey(key, otherTenantId), false);
    const stored = await storage.readGenerationReferenceMedia(key);
    assert.equal(stored.mimeType, "image/png");
    assert.deepEqual(stored.bytes, png);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("reference media storage rejects MIME spoofing, empty data, and non-tenant keys", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(
    storage.storeGenerationReferenceMedia("image/jpeg", Buffer.from("not a jpeg"), tenantId),
    /do not match declared MIME type/,
  );
  await assert.rejects(
    storage.storeGenerationReferenceMedia("image/png", Buffer.alloc(0), tenantId),
    /between 1 byte/,
  );
  assert.equal(isTenantGenerationReferenceKey("generation-references/reference.png", tenantId), false);
});