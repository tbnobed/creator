import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  characterAssetsTable,
  characterLookBatchesTable,
  charactersTable,
  db,
  imageStudioAssetsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import {
  advanceCharacterLookBatch,
  CharacterLookError,
  getCharacterLooks,
  keepCharacterLook,
  retryCharacterLookBatch,
  startPortraitBatch,
  type LookJobDeps,
} from "./character-looks";
import { imageModels } from "./image-studio-models";
import { ImageStudioRequestError } from "./image-studio-service";

let fakeNow = Date.now();
const later = () => (fakeNow += 10 * 60_000);

const LOCAL = "local-flux2-klein-4b";
const PAID = imageModels.find((m) => m.provider === "CLOUD" && m.operations.includes("generate") && m.operations.includes("edit") && m.maxReferences > 0)!.id;

type FakeJob = { id: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; assetId?: string; key: string; request: Record<string, unknown> };

/** Mocked image provider: no GPU, no paid calls. Idempotent by request key like the real service. */
function fakeProvider(tenantId: string, userId: string) {
  const jobs = new Map<string, FakeJob>();
  const byKey = new Map<string, FakeJob>();
  const submissions: string[] = [];
  let crashAfter = Infinity;
  let failWith: (() => Error) | null = null;
  const deps: LookJobDeps = {
    createJob: async ({ request }) => {
      const existing = byKey.get(request.requestKey!);
      if (existing) return { id: existing.id } as never;
      if (failWith) throw failWith();
      if (crashAfter-- <= 0) throw new Error("socket hang up");
      submissions.push(request.requestKey!);
      const job: FakeJob = { id: randomUUID(), status: "RUNNING", key: request.requestKey!, request: request as never };
      jobs.set(job.id, job); byKey.set(job.key, job);
      return { id: job.id } as never;
    },
    getJob: async (tenant, id) => {
      const job = jobs.get(id);
      if (!job || tenant !== tenantId) return null;
      return {
        id, status: job.status, errorMessage: job.status === "FAILED" ? "worker failed" : null,
        assets: job.assetId ? [{ id: job.assetId, url: `/api/media/fake/${job.assetId}.png`, storageKey: `fake/${job.assetId}.png`, mimeType: "image/png" }] : [],
      } as never;
    },
    readBytes: async () => Buffer.from("png"),
    storeCharacterImage: async () => `${tenantId}/characters/${randomUUID()}.png`,
  };
  const complete = async (job: FakeJob) => {
    const [asset] = await db.insert(imageStudioAssetsTable).values({
      tenantId, createdByUserId: userId, name: "fake.png", storageKey: `fake/${randomUUID()}.png`, mimeType: "image/png", width: 768, height: 1024, jobId: null,
    }).returning();
    job.status = "COMPLETED"; job.assetId = asset!.id;
  };
  return { deps, jobs, submissions, complete, crashNext: (n: number) => { crashAfter = n; }, setFail: (f: (() => Error) | null) => { failWith = f; } };
}

test("character looks: durable four-portrait batches, keep look, server-attached sheet, tenancy", {
  skip: process.env.RUN_CHARACTER_LOOK_DB_TESTS !== "true" ? "set RUN_CHARACTER_LOOK_DB_TESTS=true" : false,
}, async () => {
  const userId = `look-test-${randomUUID()}`;
  const [tenant] = await db.insert(tenantsTable).values({ name: "Look fixture", slug: `look-${randomUUID()}` }).returning();
  const [foreign] = await db.insert(tenantsTable).values({ name: "Foreign fixture", slug: `look-f-${randomUUID()}` }).returning();
  await db.insert(usersTable).values({ id: userId, email: `${randomUUID()}@look.test`, displayName: "Look fixture" });
  const tenantId = tenant!.id;
  const [character] = await db.insert(charactersTable).values({ tenantId, createdByUserId: userId, name: "Ines Varga", description: "harbor pilot" }).returning();
  const characterId = character!.id;
  const fake = fakeProvider(tenantId, userId);
  try {
    // Paid models require explicit confirmation per batch; nothing is stored or submitted otherwise.
    await assert.rejects(
      startPortraitBatch({ tenantId, userId, characterId, prompt: "harbor pilot", modelId: PAID, requestKey: randomUUID() }),
      (e: unknown) => e instanceof CharacterLookError && e.status === 402,
    );
    assert.equal((await getCharacterLooks(tenantId, characterId)).portraits, null);

    // Local batch: four slots, no paid confirmation needed.
    const startKey = randomUUID();
    let looks = await startPortraitBatch({ tenantId, userId, characterId, prompt: "harbor pilot, salt-gray braid", modelId: LOCAL, requestKey: startKey });
    assert.equal(looks.portraits!.slots.length, 4);
    assert.equal(looks.portraits!.provider, "LOCAL");
    // Retried POST with the same key returns the same batch, never a second one.
    const again = await startPortraitBatch({ tenantId, userId, characterId, prompt: "harbor pilot, salt-gray braid", modelId: LOCAL, requestKey: startKey });
    assert.equal(again.portraits!.id, looks.portraits!.id);
    await assert.rejects(startPortraitBatch({ tenantId, userId, characterId, prompt: "x", modelId: LOCAL, requestKey: randomUUID() }), /already generating/);
    const batchId = looks.portraits!.id;

    // Partial submission: the connection drops after two jobs; the next tick resumes without duplicates.
    const keysBefore = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, batchId)))[0]!.slots.map((s) => s.requestKey);
    fake.crashNext(2);
    await advanceCharacterLookBatch(batchId, fake.deps, later);
    assert.equal(fake.submissions.length, 2);
    // Backoff: an immediate tick does not resubmit; ambiguous slots keep their key and stay pending.
    await advanceCharacterLookBatch(batchId, fake.deps, () => fakeNow);
    assert.equal(fake.submissions.length, 2);
    const mid = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, batchId)))[0]!;
    assert.deepEqual(mid.slots.map((s) => s.requestKey), keysBefore);
    assert.deepEqual(mid.slots.map((s) => s.status), ["RUNNING", "RUNNING", "PENDING", "PENDING"]);
    fake.crashNext(Infinity);
    await advanceCharacterLookBatch(batchId, fake.deps, later);
    await advanceCharacterLookBatch(batchId, fake.deps, later);
    assert.equal(fake.submissions.length, 4);
    assert.equal(new Set(fake.submissions).size, 4);
    for (const job of fake.jobs.values()) assert.equal(job.request.operation, "generate");

    for (const job of fake.jobs.values()) await fake.complete(job);
    await advanceCharacterLookBatch(batchId, fake.deps, later);
    // Reopen: state comes from the server, all four options selectable.
    looks = await getCharacterLooks(tenantId, characterId);
    assert.equal(looks.portraits!.status, "COMPLETED");
    assert.equal(looks.portraits!.slots.filter((s) => s.status === "READY" && s.mediaUrl).length, 4);

    // Foreign tenant cannot read, keep or retry.
    await assert.rejects(getCharacterLooks(foreign!.id, characterId), (e: unknown) => e instanceof CharacterLookError && e.status === 404);
    const chosen = looks.portraits!.slots[2]!.assetId!;
    await assert.rejects(keepCharacterLook({ tenantId: foreign!.id, userId, characterId, batchId, assetId: chosen, modelId: LOCAL, requestKey: randomUUID() }, fake.deps), /not found/);
    await assert.rejects(retryCharacterLookBatch({ tenantId: foreign!.id, characterId, batchId }), /not found/);

    // Paid reference sheet without confirmation is refused before any side effect.
    await assert.rejects(keepCharacterLook({ tenantId, userId, characterId, batchId, assetId: chosen, modelId: PAID, requestKey: randomUUID() }, fake.deps), (e: unknown) => e instanceof CharacterLookError && e.status === 402);
    assert.equal((await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, characterId))).length, 0);

    // Keep this look: primary headshot + thumbnail + sheet batch, all server side.
    const keepKey = randomUUID();
    looks = await keepCharacterLook({ tenantId, userId, characterId, batchId, assetId: chosen, modelId: PAID, cloudConfirmed: true, requestKey: keepKey }, fake.deps);
    assert.equal(looks.portraits!.selectedAssetId, chosen);
    assert.equal(looks.sheet!.slots.length, 4);
    assert.equal(looks.sheet!.provider, "CLOUD");
    const again2 = await keepCharacterLook({ tenantId, userId, characterId, batchId, assetId: chosen, modelId: PAID, cloudConfirmed: true, requestKey: keepKey }, fake.deps);
    assert.equal(again2.sheet!.id, looks.sheet!.id);
    let assets = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, characterId));
    assert.equal(assets.length, 1);
    assert.equal(assets[0]!.isPrimary, true);
    assert.equal(assets[0]!.label, "headshot");
    const [reloaded] = await db.select().from(charactersTable).where(eq(charactersTable.id, characterId));
    assert.equal(reloaded!.thumbnail, `/api/media/${assets[0]!.storageKey}`);

    // The UI is gone now; the server alone submits and attaches the sheet.
    const sheetId = looks.sheet!.id;
    const before = fake.jobs.size;
    await advanceCharacterLookBatch(sheetId, fake.deps, later);
    const sheetJobs = [...fake.jobs.values()].slice(before);
    assert.equal(sheetJobs.length, 4);
    for (const job of sheetJobs) {
      assert.equal(job.request.operation, "edit");
      assert.equal(job.request.cloudConfirmed, true);
      assert.deepEqual(job.request.referenceAssetIds, [chosen]);
    }
    await fake.complete(sheetJobs[0]!); await fake.complete(sheetJobs[1]!); await fake.complete(sheetJobs[3]!);
    sheetJobs[2]!.status = "FAILED";
    await advanceCharacterLookBatch(sheetId, fake.deps, later);
    await advanceCharacterLookBatch(sheetId, fake.deps, later); // repeated ticks never duplicate attachments
    assets = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, characterId));
    assert.equal(assets.length, 4);
    assert.deepEqual(assets.filter((a) => !a.isPrimary).map((a) => a.label).sort(), ["expression", "full-body", "three-quarter"]);
    looks = await getCharacterLooks(tenantId, characterId);
    assert.equal(looks.sheet!.status, "COMPLETED");
    assert.equal(looks.sheet!.slots[2]!.status, "FAILED");

    // Retry of a paid batch requires fresh confirmation and only resubmits the failed view.
    await assert.rejects(retryCharacterLookBatch({ tenantId, characterId, batchId: sheetId }), (e: unknown) => e instanceof CharacterLookError && e.status === 402);
    const submittedBefore = fake.submissions.length;
    await retryCharacterLookBatch({ tenantId, characterId, batchId: sheetId, cloudConfirmed: true });
    await advanceCharacterLookBatch(sheetId, fake.deps, later);
    assert.equal(fake.submissions.length, submittedBefore + 1);
    const retried = [...fake.jobs.values()].at(-1)!;
    assert.equal((retried.request.prompt as string).includes("profile"), true);
    await fake.complete(retried);
    await advanceCharacterLookBatch(sheetId, fake.deps, later);
    assets = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, characterId));
    assert.equal(assets.length, 5);
    const [row] = await db.select().from(characterLookBatchesTable).where(and(eq(characterLookBatchesTable.id, sheetId), eq(characterLookBatchesTable.tenantId, tenantId)));
    assert.equal(row!.slots.every((s) => s.status === "READY" && s.characterAssetId), true);

    // --- Regressions: concurrency and ambiguous submissions on a second character ---
    const [second] = await db.insert(charactersTable).values({ tenantId, createdByUserId: userId, name: "Second", description: "x" }).returning();
    const secondId = second!.id;
    // Racing starts with different keys: exactly one batch.
    const races = await Promise.allSettled([0, 1, 2].map(() => startPortraitBatch({ tenantId, userId, characterId: secondId, prompt: "racer", modelId: LOCAL, requestKey: randomUUID() })));
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(races.filter((r) => r.status === "rejected" && /already generating/.test(String((r as PromiseRejectedResult).reason))).length, 2);
    // Racing identical starts: both succeed with one batch.
    const sameKey = randomUUID();
    const third = (await db.insert(charactersTable).values({ tenantId, createdByUserId: userId, name: "Third", description: "x" }).returning())[0]!.id;
    const same = await Promise.all([0, 1].map(() => startPortraitBatch({ tenantId, userId, characterId: third, prompt: "twin", modelId: LOCAL, requestKey: sameKey })));
    assert.equal(same[0]!.portraits!.id, same[1]!.portraits!.id);
    assert.equal((await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.characterId, third))).length, 1);

    const [secondBatch] = await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.characterId, secondId));
    const secondKeys = secondBatch!.slots.map((s) => s.requestKey);
    // Ambiguous failures, many times: never FAILED, never a new key, retry has nothing to do.
    fake.setFail(() => new Error("ECONNRESET after submit"));
    for (let i = 0; i < 12; i++) await advanceCharacterLookBatch(secondBatch!.id, fake.deps, later);
    let row2 = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, secondBatch!.id)))[0]!;
    assert.deepEqual(row2.slots.map((s) => s.status), ["PENDING", "PENDING", "PENDING", "PENDING"]);
    assert.deepEqual(row2.slots.map((s) => s.requestKey), secondKeys);
    assert.equal(row2.status, "ACTIVE");
    await assert.rejects(retryCharacterLookBatch({ tenantId, characterId: secondId, batchId: secondBatch!.id }), /Nothing failed/);
    // Busy worker (409) also waits with the same key.
    fake.setFail(() => new ImageStudioRequestError("All compatible local GPUs are at safe render capacity", 409));
    await advanceCharacterLookBatch(secondBatch!.id, fake.deps, later);
    row2 = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, secondBatch!.id)))[0]!;
    assert.equal(row2.slots.every((s) => s.status === "PENDING"), true);
    // Deterministic rejection is terminal; only then does retry mint a new key.
    fake.setFail(() => new ImageStudioRequestError("Prompt is required", 400));
    await advanceCharacterLookBatch(secondBatch!.id, fake.deps, later);
    row2 = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, secondBatch!.id)))[0]!;
    assert.equal(row2.status, "FAILED");
    fake.setFail(null);
    await retryCharacterLookBatch({ tenantId, characterId: secondId, batchId: secondBatch!.id });
    row2 = (await db.select().from(characterLookBatchesTable).where(eq(characterLookBatchesTable.id, secondBatch!.id)))[0]!;
    assert.equal(row2.slots.every((s, i) => s.status === "PENDING" && s.requestKey !== secondKeys[i]), true);
    await advanceCharacterLookBatch(secondBatch!.id, fake.deps, later);
    for (const job of [...fake.jobs.values()].slice(-4)) await fake.complete(job);
    await advanceCharacterLookBatch(secondBatch!.id, fake.deps, later);
    const done2 = await getCharacterLooks(tenantId, secondId);
    const pick = done2.portraits!.slots[1]!.assetId!;
    // Racing keeps (same key, and a different key): one primary, one sheet, selection unchanged.
    const k = randomUUID();
    const keeps = await Promise.allSettled([
      keepCharacterLook({ tenantId, userId, characterId: secondId, batchId: secondBatch!.id, assetId: pick, modelId: LOCAL, requestKey: k }, fake.deps),
      keepCharacterLook({ tenantId, userId, characterId: secondId, batchId: secondBatch!.id, assetId: pick, modelId: LOCAL, requestKey: k }, fake.deps),
      keepCharacterLook({ tenantId, userId, characterId: secondId, batchId: secondBatch!.id, assetId: done2.portraits!.slots[0]!.assetId!, modelId: LOCAL, requestKey: randomUUID() }, fake.deps),
    ]);
    assert.equal(keeps[0]!.status, "fulfilled");
    assert.equal(keeps[1]!.status, "fulfilled");
    assert.equal(keeps[2]!.status, "rejected");
    const secondAssets = await db.select().from(characterAssetsTable).where(eq(characterAssetsTable.characterId, secondId));
    assert.equal(secondAssets.length, 1);
    assert.equal(secondAssets[0]!.isPrimary, true);
    assert.equal((await db.select().from(characterLookBatchesTable).where(and(eq(characterLookBatchesTable.characterId, secondId), eq(characterLookBatchesTable.kind, "SHEET")))).length, 1);
    assert.equal((await getCharacterLooks(tenantId, secondId)).portraits!.selectedAssetId, pick);
    await db.delete(charactersTable).where(inArray(charactersTable.id, [secondId, third]));
  } finally {
    await db.delete(charactersTable).where(eq(charactersTable.tenantId, tenantId));
    await db.delete(imageStudioAssetsTable).where(eq(imageStudioAssetsTable.tenantId, tenantId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantId, foreign!.id]));
  }
});
