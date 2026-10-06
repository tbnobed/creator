import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, after } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, pool, generationJobsTable, tenantsTable, usersTable } from "@workspace/db";
import { submitPaidReplacement, type ReplacementSubmission } from "./video-replacement-service";
import { listGarmentJobs } from "./garment-service";

after(() => pool.end());
for (const model of ["seedance-2.5", "kling-o3-edit"] as const) {
test(`${model} saved replacements are idempotent, tenant scoped, and visible after restart`, {
  skip: process.env.RUN_VIDEO_REPLACEMENT_DB_TESTS !== "true",
}, async () => {
  const userId = `replacement-test-${randomUUID()}`;
  const owners = await db.insert(tenantsTable).values([
    { name: "Replacement fixture", slug: `replacement-${randomUUID()}` },
    { name: "Isolation fixture", slug: `replacement-${randomUUID()}` },
  ]).returning();
  const tenantIds = owners.map(t => t.id);
  try {
    await db.insert(usersTable).values({ id: userId, displayName: "Replacement fixture" });
    const input: ReplacementSubmission = {
      tenantId: owners[0].id, userId, requestId: randomUUID(), provider: "FAL",
      model, confirmPaid: true, mode: "replace-item",
      targetGarment: "The red car", prompt: "Replace it with a bicycle",
      sourceStorageKey: `tenants/${owners[0].id}/generation-references/${randomUUID()}.mp4`,
      startSeconds: 0, durationSeconds: 4, seed: 1,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, userId: undefined })).digest("hex");
    await db.insert(generationJobsTable).values({
      id: input.requestId, tenantId: input.tenantId, createdByUserId: userId,
      title: "Fixture, never submitted", provider: "FAL", providerModelId: model === "seedance-2.5" ? "bytedance/seedance-2.5/reference-to-video" : "fal-ai/kling-video/o3/standard/video-to-video/edit",
      status: "FAILED", prompt: input.prompt, compiledPrompt: input.prompt, generationMode: "replace-item",
      qualityPreset: "STANDARD", width: 1280, height: 720, fps: 24, frameCount: 720,
      durationSeconds: 30,
      providerTaskMetadata: {
        model,
        videoReplacement: { fingerprint, preparedKey: input.sourceStorageKey, sourceStorageKey: input.sourceStorageKey, target: input.targetGarment },
        submissionOutcome: "unknown",
      },
    });
    // No media exists: a retry must return the durable job, never prepare or pay again.
    assert.deepEqual(await submitPaidReplacement(input), { jobId: input.requestId });
    assert.deepEqual(await submitPaidReplacement(input), { jobId: input.requestId });
    await assert.rejects(submitPaidReplacement({ ...input, prompt: "Different edit" }), /different processing/);
    await assert.rejects(submitPaidReplacement({
      ...input, tenantId: owners[1].id, sourceStorageKey: input.sourceStorageKey.replace(owners[0].id, owners[1].id),
    }), /different processing/);
    assert.equal((await listGarmentJobs(owners[1].id)).length, 0);
    const [saved] = await listGarmentJobs(owners[0].id);
    assert.equal(saved.id, input.requestId);
    assert.equal(saved.provider, "FAL");
    assert.equal(saved.mode, "replace-item");
    assert.equal(saved.sourceUrl, `/api/media/${input.sourceStorageKey}`);
    assert.match(saved.title, /red car/);
    assert.equal(saved.model, model);
  } finally {
    await db.delete(generationJobsTable).where(inArray(generationJobsTable.tenantId, tenantIds));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
});
}
