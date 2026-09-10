#!/usr/bin/env node
// Development-only service integration test. Every outbound HTTP request is stubbed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const root = new URL("..", import.meta.url);
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "obtv-paid-spend-guards-"));
const entry = join(temporaryDirectory, "services.ts");
const bundle = join(temporaryDirectory, "services.mjs");
const userId = `paid-guard-${randomUUID()}`;
const tenantId = randomUUID();
const spoofedUserId = `spoofed-${randomUUID()}`;
const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalLogLevel = process.env.LOG_LEVEL;
const suppliedFalKey = Boolean(process.env.FAL_KEY?.trim());
let providerDispatches = 0;

await writeFile(entry, [
  `export { createAndSubmitGeneration } from ${JSON.stringify(new URL("artifacts/api-server/src/lib/generation-service.ts", root).pathname)};`,
  `export { createImageJob } from ${JSON.stringify(new URL("artifacts/api-server/src/lib/image-studio-service.ts", root).pathname)};`,
].join("\n"));
const esbuild = new URL("../artifacts/api-server/node_modules/.bin/esbuild", import.meta.url).pathname;
execFileSync(esbuild, [
  entry,
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--banner:js=import { createRequire as __createRequire } from "node:module"; const require = __createRequire(${JSON.stringify(new URL("../artifacts/api-server/package.json", import.meta.url).href)});`,
  `--outfile=${bundle}`,
], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });

if (!suppliedFalKey) process.env.FAL_KEY = "paid-spend-guard-dummy-key";
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "silent";
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "queue.fal.run") {
    providerDispatches += 1;
    throw new Error("Paid provider dispatch blocked by regression test");
  }
  throw new Error(`Unexpected outbound request to ${url.origin}`);
};

async function expectLimitExceeded(work) {
  await assert.rejects(work, (error) => {
    assert.equal(error.statusCode ?? error.status, 402);
    assert.match(error.message, /monthly spending limit exceeded/i);
    return true;
  });
}

try {
  await pool.query(
    "INSERT INTO obtv_users(id,display_name) VALUES($1,'Paid spend guard')",
    [userId],
  );
  await pool.query(
    "INSERT INTO obtv_tenants(id,name,slug,created_by_user_id) VALUES($1,'Paid spend guard',$2,$3)",
    [tenantId, `paid-spend-guard-${tenantId}`, userId],
  );
  await pool.query(
    `INSERT INTO obtv_tenant_memberships
       (tenant_id,user_id,role,monthly_limit_micros) VALUES($1,$2,'OWNER',0)`,
    [tenantId, userId],
  );

  const { createAndSubmitGeneration, createImageJob } =
    await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

  await expectLimitExceeded(() => createAndSubmitGeneration({
    tenantId,
    createdByUserId: userId,
    userId: spoofedUserId,
    provider: "FAL",
    model: "veo-3.1-fast",
    prompt: "A locked-off view of a quiet studio.",
    generationMode: "TEXT_TO_VIDEO",
    durationSeconds: 4,
    fps: 24,
    width: 1280,
    height: 720,
    qualityPreset: "STANDARD",
    seedMode: "FIXED",
    seed: 7,
  }));
  const video = await pool.query(
    "SELECT status,created_by_user_id FROM obtv_generation_jobs WHERE tenant_id=$1",
    [tenantId],
  );
  assert.deepEqual(video.rows, [{ status: "FAILED", created_by_user_id: userId }]);

  await expectLimitExceeded(() => createImageJob({
    tenantId,
    userId,
    request: {
      modelId: "cloud-nano-banana-2",
      operation: "generate",
      prompt: "A simple blue ceramic cup.",
      width: 1024,
      height: 1024,
      count: 1,
      cloudConfirmed: true,
      userId: spoofedUserId,
      createdByUserId: spoofedUserId,
    },
  }));
  const image = await pool.query(
    "SELECT status,created_by_user_id FROM obtv_image_studio_jobs WHERE tenant_id=$1",
    [tenantId],
  );
  assert.deepEqual(image.rows, [{ status: "FAILED", created_by_user_id: userId }]);
  assert.equal(providerDispatches, 0, "A paid provider request escaped the zero-limit guard");

  const ledger = await pool.query(
    "SELECT outcome FROM obtv_spending_entries WHERE tenant_id=$1",
    [tenantId],
  );
  assert.equal(ledger.rowCount, 0, "Rejected jobs must not create free or uncertain reservations");
  console.log("PASS: video and image Cloud services reject zero-limit spend before provider dispatch");
} finally {
  globalThis.fetch = originalFetch;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
  if (!suppliedFalKey) delete process.env.FAL_KEY;
  await pool.query(
    `DELETE FROM obtv_spending_events WHERE spending_entry_id IN
       (SELECT id FROM obtv_spending_entries WHERE tenant_id=$1)`,
    [tenantId],
  );
  await pool.query("DELETE FROM obtv_spending_entries WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    `DELETE FROM obtv_generation_characters WHERE generation_job_id IN
       (SELECT id FROM obtv_generation_jobs WHERE tenant_id=$1)`,
    [tenantId],
  );
  await pool.query(
    `DELETE FROM obtv_generation_settings WHERE generation_job_id IN
       (SELECT id FROM obtv_generation_jobs WHERE tenant_id=$1)`,
    [tenantId],
  );
  await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    "DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, userId],
  );
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
}