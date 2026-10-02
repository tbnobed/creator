import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, pool, tenantsTable, usersTable, tenantMembershipsTable, generationJobsTable, spendingEntriesTable, spendingEventsTable } from "@workspace/db";
import { mediaStorage } from "./storage-service";
import { inspectCleanup, submitCleanup, listCleanupJobs } from "./video-cleanup-service";
import { cancelGeneration, recoverTimedOutGeneration } from "./generation-service";
import { probeVideoMediaProperties } from "./video-media-probe";

// ALL network and media storage are fail-closed mocks. Only disposable DB fixtures are real.
test("cleanup lifecycle: ownership, paid confirmation, duplicate submission, audio, recovery, cancellation and spending", {
  skip: process.env.RUN_CLEANUP_DB_TESTS !== "true" ? "set RUN_CLEANUP_DB_TESTS=true" : false,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cleanup-fixture-"));
  const tenantId = randomUUID(), userId = `cleanup-fixture-${randomUUID()}`;
  const sourceKey = `tenants/${tenantId}/generation-references/fixture.mp4`;
  const original = {
    fetch: globalThis.fetch, read: mediaStorage.readBuffer, reference: mediaStorage.readGenerationReferenceMedia,
    store: mediaStorage.storeOutput, key: process.env.FAL_KEY,
  };
  let dispatches = 0, lostReceipt = false, queued = false, saved: Buffer | undefined;
  let cancelledId = "";
  try {
    const run = promisify(execFile);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac",
      "-movflags", "+faststart", "-shortest", "-y", path.join(dir, "source.mp4")]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=1",
      "-c:v", "libx264", "-movflags", "+faststart", "-y", path.join(dir, "cleaned.mp4")]);
    const source = await readFile(path.join(dir, "source.mp4")), cleaned = await readFile(path.join(dir, "cleaned.mp4"));
    process.env.FAL_KEY = "test-only-not-a-secret";
    mediaStorage.readGenerationReferenceMedia = async (key) => {
      assert.equal(key, sourceKey); return { bytes: source, mimeType: "video/mp4" };
    };
    mediaStorage.readBuffer = async (key) => { assert.equal(key, sourceKey); return source; };
    mediaStorage.storeOutput = async (_name, mime, bytes, owner) => {
      assert.equal(owner, tenantId); assert.equal(mime, "video/mp4"); saved = bytes;
      return `tenants/${tenantId}/generations/cleanup-fixture.mp4`;
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
        return Response.json({ upload_url: "https://v3b.fal.media/files/b/test/input", file_url: "https://v3b.fal.media/files/b/test/input" });
      }
      if (url === "https://v3b.fal.media/files/b/test/input") return new Response("");
      if (url.startsWith("https://rest.fal.ai/storage/auth/token")) return Response.json({ token: "test-token" });
      if (url.endsWith("/files/b/test/input/sign")) return new Response("https://v3b.fal.media/files/b/test/input?signature=test");
      if (url === "https://queue.fal.run/bria/video/erase/keypoints") {
        dispatches++;
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.auto_trim, false); assert.equal(payload.preserve_audio, true);
        assert.deepEqual(JSON.parse(payload.keypoints[0]), { x: 160, y: 90, type: "positive" });
        if (lostReceipt) throw new Error("Simulated lost receipt");
        return Response.json({ request_id: "cleanup-test",
          status_url: "https://queue.fal.run/bria/video/requests/test/status",
          response_url: "https://queue.fal.run/bria/video/requests/test",
          cancel_url: "https://queue.fal.run/bria/video/requests/test/cancel" });
      }
      if (url.endsWith("/requests/test/status")) return Response.json({ status: queued ? "IN_QUEUE" : "COMPLETED" });
      if (url.endsWith("/requests/test/cancel")) {
        const [job] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, cancelledId));
        assert.equal(job.status, "CANCELLED"); assert.equal(job.providerTaskMetadata.cancellationRequested, true);
        return Response.json({});
      }
      if (url.endsWith("/requests/test")) return Response.json({ video: { url: "https://v3.fal.media/cleanup-fixture.mp4" } });
      if (url === "https://v3.fal.media/cleanup-fixture.mp4") return new Response(Uint8Array.from(cleaned), { headers: { "content-type": "video/mp4" } });
      throw new Error(`Blocked unexpected HTTP in test: ${url}`);
    };
    await db.insert(tenantsTable).values({ id: tenantId, name: "Disposable cleanup test", slug: `cleanup-${tenantId}` });
    await db.insert(usersTable).values({ id: userId, email: `${userId}@example.invalid`, displayName: "Disposable fixture" });
    await db.insert(tenantMembershipsTable).values({ tenantId, userId, role: "MEMBER", monthlyLimitMicros: null });
    await assert.rejects(() => inspectCleanup(randomUUID(), sourceKey), /workspace/);
    const plan = await inspectCleanup(tenantId, sourceKey);
    assert.equal(dispatches, 0);
    const request = { tenantId, userId, requestId: randomUUID(), confirmPaid: true, sourceStorageKey: sourceKey,
      sourceToken: plan.sourceToken, cameraMode: "moving" as const, points: [{ x: 0.5, y: 0.5, type: "positive" as const }] };
    await assert.rejects(() => submitCleanup({ ...request, confirmPaid: false }), /Confirm paid/);
    const jobs = await Promise.all([submitCleanup(request), submitCleanup(request)]);
    assert.equal(jobs[0].id, jobs[1].id); assert.equal(dispatches, 1);
    for (let i = 0; i < 150; i++) {
      const rows = await listCleanupJobs(tenantId);
      if (rows[0]?.status === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = (await listCleanupJobs(tenantId))[0];
    assert.equal(completed.status, "COMPLETED", completed.errorMessage ?? undefined);
    assert.equal(completed.cameraMode, "moving");
    assert.match(completed.outputMediaUrl!, /generations/);
    assert.equal((await probeVideoMediaProperties(saved!)).audioStreams, 1, "source audio restored to silent provider output");
    assert.deepEqual(await listCleanupJobs(randomUUID()), []);
    await db.update(generationJobsTable).set({
      status: "FAILED", errorMessage: "Video cleanup output verification failed: simulated storage outage",
    }).where(eq(generationJobsTable.id, request.requestId));
    assert.equal(await recoverTimedOutGeneration(request.requestId), true);
    assert.equal(dispatches, 1, "recovery reuses paid result");
    await submitCleanup(request); assert.equal(dispatches, 1);
    await assert.rejects(() => submitCleanup({ ...request, cameraMode: "stationary" }), /different processing/);
    await db.update(tenantMembershipsTable).set({ monthlyLimitMicros: 0 }).where(eq(tenantMembershipsTable.tenantId, tenantId));
    const capped = await submitCleanup({ ...request, requestId: randomUUID() });
    assert.equal(capped.status, "FAILED"); assert.equal(dispatches, 1);
    await db.update(tenantMembershipsTable).set({ monthlyLimitMicros: null }).where(eq(tenantMembershipsTable.tenantId, tenantId));
    lostReceipt = true;
    const uncertainRequest = { ...request, requestId: randomUUID() };
    const unknown = await submitCleanup(uncertainRequest);
    assert.equal(unknown.status, "FAILED"); assert.match(unknown.errorMessage!, /outcome is unknown/);
    await submitCleanup(uncertainRequest); assert.equal(dispatches, 2, "unknown acceptance never auto resubmits");
    lostReceipt = false; queued = true;
    cancelledId = randomUUID();
    await submitCleanup({ ...request, requestId: cancelledId, cameraMode: "stationary" });
    await cancelGeneration(cancelledId);
    assert.equal((await listCleanupJobs(tenantId)).find((job) => job.jobId === cancelledId)?.status, "CANCELLED");
    await new Promise((resolve) => setTimeout(resolve, 5500));
  } finally {
    globalThis.fetch = original.fetch;
    mediaStorage.readBuffer = original.read; mediaStorage.readGenerationReferenceMedia = original.reference; mediaStorage.storeOutput = original.store;
    if (original.key === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = original.key;
    const ledger = await db.select({ id: spendingEntriesTable.id }).from(spendingEntriesTable).where(eq(spendingEntriesTable.tenantId, tenantId));
    if (ledger.length) await db.delete(spendingEventsTable).where(inArray(spendingEventsTable.spendingEntryId, ledger.map((row) => row.id)));
    await db.delete(spendingEntriesTable).where(eq(spendingEntriesTable.tenantId, tenantId));
    await db.delete(generationJobsTable).where(eq(generationJobsTable.tenantId, tenantId));
    await db.delete(tenantMembershipsTable).where(eq(tenantMembershipsTable.tenantId, tenantId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await rm(dir, { recursive: true, force: true });
    await pool.end();
  }
});