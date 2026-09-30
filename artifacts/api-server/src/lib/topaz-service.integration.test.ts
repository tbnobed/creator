import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, pool, tenantsTable, usersTable, tenantMembershipsTable, generationJobsTable,
  spendingEntriesTable, spendingEventsTable,
} from "@workspace/db";
import { mediaStorage } from "./storage-service";
import { quoteTopaz, submitTopaz } from "./topaz-service";
import { cancelGeneration, recoverTimedOutGeneration } from "./generation-service";

// Isolated disposable tenant, real DB concurrency/ledger, fail-closed mocked ALL HTTP and storage.
// Run only explicitly. No provider credits or persistent media are used.
test("Topaz real create-through-finalize: ownership, local/cloud, concurrent dedup, cap and unknown acceptance", {
  skip: process.env.RUN_TOPAZ_DB_TESTS !== "true" ? "set RUN_TOPAZ_DB_TESTS=true for isolated DB fixtures" : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "topaz-pipeline-test-"));
  const tenantId = randomUUID();
  const userId = `topaz-fixture-${randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const originalRead = mediaStorage.readBuffer;
  const originalStore = mediaStorage.storeOutput;
  const originalKey = process.env.FAL_KEY;
  let dispatches = 0;
  let unknownAcceptance = false;
  let holdQueue = false;
  let cancellationId: string | null = null;
  let originalBytes: Buffer;
  let enhancedBytes: Buffer;
  const storageSource = `tenants/${tenantId}/outputs/original.mp4`;
  try {
    const run = promisify(execFile);
    const sourcePath = path.join(directory, "source.mp4");
    const outputPath = path.join(directory, "enhanced.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=1280x720:r=24:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac",
      "-movflags", "+faststart", "-shortest", "-y", sourcePath]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=1920x1080:r=24:d=1",
      "-c:v", "libx264", "-movflags", "+faststart", "-y", outputPath]);
    originalBytes = await readFile(sourcePath);
    enhancedBytes = await readFile(outputPath);
    process.env.FAL_KEY = "test-only-not-a-secret";
    mediaStorage.readBuffer = async (key: string) => {
      assert.equal(key, storageSource);
      return originalBytes;
    };
    mediaStorage.storeOutput = async (_name, mimeType, bytes, owner) => {
      assert.equal(owner, tenantId);
      assert.equal(mimeType, "video/mp4");
      assert(bytes.length > 0);
      return `tenants/${tenantId}/outputs/enhanced.mp4`;
    };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
        return new Response(JSON.stringify({ upload_url: "https://v3b.fal.media/files/b/test/input", file_url: "https://v3b.fal.media/files/b/test/input" }));
      }
      if (url === "https://v3b.fal.media/files/b/test/input") return new Response("");
      if (url.startsWith("https://rest.fal.ai/storage/auth/token")) return new Response(JSON.stringify({ token: "test-token" }));
      if (url.endsWith("/files/b/test/input/sign")) return new Response("https://v3b.fal.media/files/b/test/input?signature=test");
      if (url === "https://queue.fal.run/fal-ai/topaz/upscale/video") {
        dispatches++;
        if (unknownAcceptance) throw new Error("Simulated receipt connection loss");
        return new Response(JSON.stringify({
          request_id: "topaz-test-receipt",
          status_url: "https://queue.fal.run/fal-ai/topaz/requests/test/status",
          response_url: "https://queue.fal.run/fal-ai/topaz/requests/test",
          cancel_url: "https://queue.fal.run/fal-ai/topaz/requests/test/cancel",
        }));
      }
      if (url.endsWith("/requests/test/status")) return new Response(JSON.stringify({ status: holdQueue ? "IN_QUEUE" : "COMPLETED" }));
      if (url.endsWith("/requests/test/cancel")) {
        assert(cancellationId);
        const [intent] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, cancellationId));
        assert.equal(intent.status, "CANCELLED", "cancellation intent must be durable before HTTP");
        assert.equal(intent.providerTaskMetadata.cancellationRequested, true);
        return new Response("{}");
      }
      if (url.endsWith("/requests/test")) return new Response(JSON.stringify({ video: { url: "https://v3.fal.media/topaz-test-result.mp4" } }));
      if (url === "https://v3.fal.media/topaz-test-result.mp4") return new Response(Uint8Array.from(enhancedBytes), { headers: { "content-type": "video/mp4" } });
      throw new Error(`Blocked unexpected test HTTP: ${url}`);
    };
    await db.insert(tenantsTable).values({ id: tenantId, name: "Disposable Topaz test", slug: `topaz-test-${tenantId}` });
    await db.insert(usersTable).values({ id: userId, email: `${userId}@example.invalid`, displayName: "Disposable Topaz fixture" });
    await db.insert(tenantMembershipsTable).values({ tenantId, userId, role: "MEMBER", monthlyLimitMicros: null });
    const makeSource = async (provider: string) => (await db.insert(generationJobsTable).values({
      tenantId, createdByUserId: userId, title: "Disposable test video", status: "COMPLETED", provider,
      prompt: "Test fixture only", compiledPrompt: "Test fixture only", width: 1280, height: 720,
      fps: 24, frameCount: 24, durationSeconds: 1, generationMode: "TEXT_TO_VIDEO", qualityPreset: "STANDARD",
      outputStorageKey: storageSource, outputMimeType: "video/mp4",
    }).returning())[0];
    const local = await makeSource("COMFYUI");
    const cloud = await makeSource("FAL");
    await assert.rejects(() => quoteTopaz(randomUUID(), local.id, "1080p"), /not found/);
    const quote = await quoteTopaz(tenantId, local.id, "1080p");
    const cloudQuote = await quoteTopaz(tenantId, cloud.id, "1080p");
    assert.equal(cloudQuote.estimatedUsd, quote.estimatedUsd);
    assert.equal(dispatches, 0, "quoting must not dispatch paid work");
    const intent = { tenantId, userId, sourceId: local.id, targetResolution: "1080p" as const, quoteToken: quote.quoteToken, requestId: randomUUID() };
    const results = await Promise.all([submitTopaz(intent), submitTopaz({ ...intent, requestId: randomUUID() })]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(dispatches, 1);
    const childId = results[0].id;
    for (let i = 0; i < 100; i++) {
      const [current] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, childId));
      if (current.status === "COMPLETED") break;
      assert.notEqual(current.status, "FAILED", current.errorMessage ?? undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [finished] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, childId));
    assert.equal(finished.status, "COMPLETED");
    assert.equal(finished.parentGenerationId, local.id);
    assert.equal(finished.width, 1920);
    const [original] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, local.id));
    assert.equal(original.outputStorageKey, storageSource);
    assert.equal(original.width, 1280);
    const [spent] = await db.select().from(spendingEntriesTable).where(eq(spendingEntriesTable.sourceId, childId));
    assert.equal(spent.outcome, "estimated");
    await submitTopaz({ ...intent, requestId: childId });
    assert.equal(dispatches, 1, "retry after completion reuses paid child");
    const coalescedRetry = await submitTopaz({ ...intent, requestId: randomUUID() });
    assert.equal(coalescedRetry.id, childId);
    assert.equal(dispatches, 1, "lost coalesced acknowledgements cannot charge again after completion");
    await db.update(generationJobsTable).set({ status: "FAILED", errorMessage: "Topaz output verification failed: interrupted", failedAt: new Date() })
      .where(eq(generationJobsTable.id, childId));
    assert.equal(await recoverTimedOutGeneration(childId), true);
    assert.equal(dispatches, 1, "recovery retrieves the existing paid result without resubmission");

    await db.update(tenantMembershipsTable).set({ monthlyLimitMicros: 0 }).where(eq(tenantMembershipsTable.tenantId, tenantId));
    await assert.rejects(() => submitTopaz({ ...intent, sourceId: cloud.id, quoteToken: cloudQuote.quoteToken, requestId: randomUUID() }), /spending limit/);
    assert.equal(dispatches, 1, "spending cap blocks provider dispatch");
    await db.update(tenantMembershipsTable).set({ monthlyLimitMicros: null }).where(eq(tenantMembershipsTable.tenantId, tenantId));
    unknownAcceptance = true;
    const uncertain = { ...intent, sourceId: cloud.id, quoteToken: cloudQuote.quoteToken, requestId: randomUUID() };
    await assert.rejects(() => submitTopaz(uncertain));
    assert.equal(dispatches, 2);
    const resumed = await submitTopaz({ ...uncertain, requestId: randomUUID() });
    assert.equal(resumed.id, uncertain.requestId);
    assert.equal(dispatches, 2, "unknown acceptance must never automatically resubmit");
    const [held] = await db.select().from(spendingEntriesTable).where(eq(spendingEntriesTable.sourceId, uncertain.requestId));
    assert.equal(held.outcome, "uncertain");
    unknownAcceptance = false;
    holdQueue = true;
    const cancelSource = await makeSource("COMFYUI");
    const cancelQuote = await quoteTopaz(tenantId, cancelSource.id, "1080p");
    const cancellable = await submitTopaz({ ...intent, sourceId: cancelSource.id, quoteToken: cancelQuote.quoteToken, requestId: randomUUID() });
    cancellationId = cancellable.id;
    await cancelGeneration(cancellationId);
    const [cancelled] = await db.select().from(generationJobsTable).where(eq(generationJobsTable.id, cancellationId));
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.providerTaskMetadata.cancellationConfirmed, true);
    const [cancelledSpend] = await db.select().from(spendingEntriesTable).where(eq(spendingEntriesTable.sourceId, cancellationId));
    assert.equal(cancelledSpend.outcome, "uncertain");
    // Allow the existing queue monitor's current polling delay to observe cancellation.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
  } finally {
    globalThis.fetch = originalFetch;
    mediaStorage.readBuffer = originalRead;
    mediaStorage.storeOutput = originalStore;
    if (originalKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = originalKey;
    const ledger = await db.select({ id: spendingEntriesTable.id }).from(spendingEntriesTable).where(eq(spendingEntriesTable.tenantId, tenantId));
    if (ledger.length) await db.delete(spendingEventsTable).where(inArray(spendingEventsTable.spendingEntryId, ledger.map((item) => item.id)));
    await db.delete(spendingEntriesTable).where(eq(spendingEntriesTable.tenantId, tenantId));
    await db.delete(generationJobsTable).where(eq(generationJobsTable.tenantId, tenantId));
    await db.delete(tenantMembershipsTable).where(and(eq(tenantMembershipsTable.tenantId, tenantId), eq(tenantMembershipsTable.userId, userId)));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await rm(directory, { recursive: true, force: true });
    await pool.end();
  }
});