import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "production-frame-test-"));
process.env.OBTV_MEDIA_ROOT = root;
const { registerProductionFrame, productionDispatchBlock } = await import("./production-dispatch");
const { LocalMediaStorage, isTenantGenerationReferenceKey } = await import("./storage-service");

test("approved scenery is registered as a readable private generation frame without changing its bytes", async () => {
  const storage = new LocalMediaStorage();
  const tenant = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("test plate")]);
  try {
    const plate = await storage.storeImage("plate.png", "image/png", bytes, "settings", tenant);
    assert.equal(isTenantGenerationReferenceKey(plate, tenant), false);
    const frame = await registerProductionFrame(plate, "image/png", tenant, storage);
    assert.equal(isTenantGenerationReferenceKey(frame, tenant), true);
    assert.deepEqual((await storage.readGenerationReferenceMedia(frame)).bytes, bytes);
    assert.deepEqual(await storage.readBuffer(plate), bytes);
    await assert.rejects(registerProductionFrame(plate, "image/png", other, storage), /owned by this workspace/);
    await assert.rejects(registerProductionFrame(plate, "video/mp4", tenant, storage), /must be an image/);
    const continuation = await storage.storeGenerationReferenceMedia("image/png", bytes, tenant);
    assert.equal(isTenantGenerationReferenceKey(continuation, tenant), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const shot = (status: string, shotNumber: number, outputStorageKey?: string) => ({ status, shotNumber, sceneNumber: 1, outputStorageKey });
test("a failed opening shot blocks subsequent shots without changing their statuses", () => {
  const shots = [shot("FAILED", 1), shot("PLANNED", 2), shot("PLANNED", 3)];
  assert.equal(productionDispatchBlock(shots)?.failed, true);
  assert.deepEqual(shots.map(s => s.status), ["FAILED", "PLANNED", "PLANNED"]);
});
test("dependent shots wait for real output, and retrying the failed first shot allows dispatch", () => {
  assert.equal(productionDispatchBlock([shot("RENDERING", 1), shot("PLANNED", 2)])?.failed, false);
  assert.equal(productionDispatchBlock([shot("COMPLETED", 1), shot("PLANNED", 2)])?.failed, false);
  assert.equal(productionDispatchBlock([shot("COMPLETED", 1, "output.mp4"), shot("PLANNED", 2)]), null);
  assert.equal(productionDispatchBlock([shot("PLANNED", 1), shot("FAILED", 2)]), null);
  assert.equal(productionDispatchBlock([shot("CANCELLED", 1), shot("PLANNED", 2)])?.failed, true);
});
