#!/usr/bin/env node
// Isolated Cloud character lifecycle regression. The only network responses
// accepted by this runner are the fixture FAL queue/receipt/output URLs below.
// It uses a scoped tenant and a temporary media root, then removes both.
//
//   NODE_ENV=production tsx scripts/test-cloud-character-pipeline.mjs

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const runId = randomUUID();
const mediaRoot = `/tmp/obtv-cloud-character-${runId}`;
process.env.OBTV_MEDIA_ROOT = mediaRoot;
process.env.FAL_KEY = "fixture-only-never-sent";

const submitRequestId = `fixture-cloud-${runId}`;
const submitUrl = "https://queue.fal.run/fal-ai/nano-banana-pro/edit";
const statusUrl = `https://queue.fal.run/requests/${submitRequestId}/status`;
const responseUrl = `https://queue.fal.run/requests/${submitRequestId}`;
const cancelUrl = `https://queue.fal.run/requests/${submitRequestId}/cancel`;
const outputUrl = "https://fal.media/fixture-cloud-character.png";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAwMDAAAwBAAEGAPr9C8cAAAAASUVORK5CYII=",
  "base64",
);
const fetchCalls = [];

function requestUrl(input) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);
  const method = init?.method ?? "GET";
  fetchCalls.push({ method, url });
  if (url === submitUrl && method === "POST") {
    return new Response(JSON.stringify({
      request_id: submitRequestId,
      status_url: statusUrl,
      response_url: responseUrl,
      cancel_url: cancelUrl,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === statusUrl && method === "GET") {
    return new Response(JSON.stringify({ status: "COMPLETED" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url === responseUrl && method === "GET") {
    return new Response(JSON.stringify({
      images: [{ url: outputUrl, content_type: "image/png", file_name: "fixture-cloud-character.png" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url === outputUrl && method === "GET") {
    return new Response(tinyPng, { status: 200, headers: { "content-type": "image/png" } });
  }
  throw new Error(`Blocked non-fixture network request: ${method} ${url}`);
};

const sourceRequire = createRequire(pathToFileURL(
  `${process.cwd()}/artifacts/api-server/src/lib/studio-image-generation.ts`,
));
const {
  characterAssetsTable,
  charactersTable,
  db,
  imageStudioJobsTable,
  spendingEntriesTable,
  spendingEventsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
  pool,
} = sourceRequire("@workspace/db");
const { eq, inArray } = sourceRequire("drizzle-orm");
const { createCharacterImageJob } = await import("../artifacts/api-server/src/lib/studio-image-generation.ts");
const { mediaStorage } = await import("../artifacts/api-server/src/lib/storage-service.ts");

const tenantId = randomUUID();
const userId = `fixture-cloud-character-${runId}`;
const characterId = randomUUID();
const assetId = randomUUID();
const slug = `fixture-cloud-character-${runId}`;
let jobId;

async function cleanup() {
  if (jobId) {
    const entries = await db
      .select({ id: spendingEntriesTable.id })
      .from(spendingEntriesTable)
      .where(eq(spendingEntriesTable.sourceId, jobId));
    if (entries.length > 0) {
      await db.delete(spendingEventsTable).where(inArray(
        spendingEventsTable.spendingEntryId,
        entries.map((entry) => entry.id),
      ));
      await db.delete(spendingEntriesTable).where(inArray(
        spendingEntriesTable.id,
        entries.map((entry) => entry.id),
      ));
    }
  }
  await db.delete(characterAssetsTable).where(eq(characterAssetsTable.characterId, characterId));
  await db.delete(charactersTable).where(eq(charactersTable.id, characterId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

try {
  await db.insert(usersTable).values({
    id: userId,
    email: `${userId}@fixture.invalid`,
    displayName: "Cloud Character Fixture",
  });
  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Cloud Character Fixture",
    slug,
    createdByUserId: userId,
  });
  await db.insert(tenantMembershipsTable).values({
    tenantId,
    userId,
    role: "OWNER",
    monthlyLimitMicros: null,
  });
  const sourceKey = await mediaStorage.storeImage(
    "fixture-source.png",
    "image/png",
    tinyPng,
    "characters",
    tenantId,
  );
  await db.insert(charactersTable).values({
    id: characterId,
    tenantId,
    createdByUserId: userId,
    name: "Cloud Character Fixture",
    description: "Scoped test-only character.",
    promptDescription: "A test-only character reference.",
    thumbnail: `/api/media/${sourceKey}`,
    dossier: { role: "", performanceNotes: "", wardrobes: [] },
  });
  await db.insert(characterAssetsTable).values({
    id: assetId,
    characterId,
    storageKey: sourceKey,
    originalName: "fixture-source.png",
    mimeType: "image/png",
    label: "headshot",
    isPrimary: true,
  });

  const response = await createCharacterImageJob({
    characterId,
    tenantId,
    userId,
    modelId: "cloud-nano-banana-pro",
    cloudConfirmed: true,
    prompt: "A scoped fixture character profile.",
    referenceLabel: "profile",
    referenceAssetId: assetId,
    allowNewIdentity: false,
    requestKey: randomUUID(),
  });
  jobId = response.id;
  assert.equal(response.provider, "CLOUD");

  const deadline = Date.now() + 20_000;
  let completedJob;
  while (Date.now() < deadline) {
    [completedJob] = await db
      .select()
      .from(imageStudioJobsTable)
      .where(eq(imageStudioJobsTable.id, jobId));
    if (completedJob?.status === "COMPLETED") break;
    if (completedJob?.status === "FAILED") {
      throw new Error(`Fixture Cloud job failed: ${completedJob.errorMessage}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(completedJob?.status, "COMPLETED");
  assert.equal(completedJob?.providerRequestId, submitRequestId);
  assert.equal(completedJob?.providerTaskMetadata.submissionPromptAttempted, true);
  assert.equal(completedJob?.providerTaskMetadata.finalizedAt !== undefined, true);
  assert.equal(fetchCalls.filter((call) => call.url === submitUrl && call.method === "POST").length, 1);
  assert.equal(fetchCalls.filter((call) => call.url === statusUrl && call.method === "GET").length, 1);
  assert.equal(fetchCalls.filter((call) => call.url === responseUrl && call.method === "GET").length, 1);
  assert.equal(fetchCalls.filter((call) => call.url === outputUrl && call.method === "GET").length, 1);

  const assets = await db
    .select()
    .from(characterAssetsTable)
    .where(eq(characterAssetsTable.characterId, characterId));
  const source = assets.find((asset) => asset.id === assetId);
  const generated = assets.find((asset) => asset.id !== assetId);
  assert.equal(source?.storageKey, sourceKey);
  assert.equal(source?.isPrimary, true);
  assert.equal(generated?.isPrimary, false);
  assert.equal(generated?.label, "profile");
  assert.equal(generated?.storageKey, completedJob.outputStorageKey);

  const [spend] = await db
    .select()
    .from(spendingEntriesTable)
    .where(eq(spendingEntriesTable.sourceId, jobId));
  assert.equal(spend?.outcome, "estimated");
  console.log(JSON.stringify({
    ok: true,
    jobId,
    submitCount: fetchCalls.filter((call) => call.url === submitUrl && call.method === "POST").length,
    status: completedJob.status,
    sourcePrimary: source?.isPrimary,
    generatedPrimary: generated?.isPrimary,
    spendOutcome: spend?.outcome,
  }));
} finally {
  await cleanup();
  await pool.end();
  await rm(mediaRoot, { recursive: true, force: true });
}