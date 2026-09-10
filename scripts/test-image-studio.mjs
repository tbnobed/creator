// Run against a development server: node scripts/test-image-studio.mjs
// Optional real local inference: IMAGE_STUDIO_TEST_RENDER=1 node scripts/test-image-studio.mjs
// Never submits a paid Cloud generation.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = "http://localhost:80";
const fixtures = [];
let browser;
const temporaryDirectory = `/tmp/image-studio-test-${randomUUID()}`;
await mkdir(temporaryDirectory);

async function fixture() {
  const userId = `image-test-${randomUUID()}`;
  const tenantId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const digest = createHash("sha256").update(token).digest("hex");
  await pool.query("INSERT INTO obtv_users (id, display_name) VALUES ($1, 'Image Studio Test')", [userId]);
  fixtures.push({ userId, tenantId, token });
  await pool.query("INSERT INTO obtv_tenants (id, name, slug) VALUES ($1, 'Image Test', $2)", [tenantId, `image-test-${tenantId}`]);
  await pool.query("INSERT INTO obtv_tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')", [tenantId, userId]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  await pool.query("INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')", [digest, userId]);
  return fixtures.at(-1);
}

async function api(account, path, options = {}) {
  const response = await fetch(`${origin}/api/image-studio${path}`, {
    ...options,
    headers: {
      cookie: `obtv_session=${account.token}`,
      origin,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const body = response.status === 204 ? null : await response.json();
  assert(!/\bfal(?:\.ai)?\b/i.test(JSON.stringify(body)), "Provider branding leaked in public payload");
  return { status: response.status, body };
}

try {
  const a = await fixture();
  const b = await fixture();
  assert.equal((await fetch(`${origin}/api/image-studio/jobs`)).status, 401);
  const catalog = await api(a, "/models");
  assert.equal(catalog.status, 200);
  assert(catalog.body.models.filter(m => m.provider === "LOCAL").length >= 3);
  assert(catalog.body.models.filter(m => m.provider === "CLOUD").length >= 8);
  const cloud = catalog.body.models.find(m => m.provider === "CLOUD" && m.operations.includes("generate"));
  const denied = await api(a, "/jobs", {
    method: "POST",
    body: JSON.stringify({ modelId: cloud.id, operation: "generate", prompt: "Test", width: 1024, height: 1024, count: 1 }),
  });
  assert(denied.status >= 400, "Cloud jobs must require explicit cost confirmation");
  assert.equal((await api(a, "/jobs")).body.jobs.length, 0, "Rejected request must not create a paid job");

  const source = `${temporaryDirectory}/source.png`;
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=teal:s=512x512", "-frames:v", "1", "-y", source]);
  const upload = await api(a, "/uploads", {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": "test-source.png" },
    body: await readFile(source),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const asset = upload.body.asset;
  assert.equal(asset.width, 512);
  assert.equal((await api(b, "/assets")).body.assets.length, 0);
  assert.equal((await api(b, `/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify({ name: "not yours" }) })).status, 404);
  assert.equal((await api(b, `/assets/${asset.id}`, { method: "DELETE" })).status, 404);
  const foreignMedia = await fetch(new URL(asset.url, origin), { headers: { cookie: `obtv_session=${b.token}` } });
  assert([403, 404].includes(foreignMedia.status));
  const update = await api(a, `/assets/${asset.id}`, {
    method: "PATCH", body: JSON.stringify({ name: "Studio regression test", favorite: true, collection: "Tests" }),
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.asset.favorite, true);
  assert.equal(update.body.asset.collection, "Tests");
  assert.equal((await api(a, "/assets?search=regression")).body.assets.length, 1);
  const toolModel = catalog.body.models.find(
    m => m.provider === "CLOUD" && m.operations.includes("remove-background"),
  );
  assert(toolModel, "Background-removal model is missing");
  const oddSource = `${temporaryDirectory}/odd-source.png`;
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=513x517", "-frames:v", "1", "-y", oddSource]);
  const oddUpload = await api(a, "/uploads", {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": "odd-source.png" },
    body: await readFile(oddSource),
  });
  assert.equal(oddUpload.status, 201, JSON.stringify(oddUpload.body));
  const unpaidTool = await api(a, "/jobs", {
    method: "POST",
    body: JSON.stringify({
      modelId: toolModel.id,
      operation: "remove-background",
      prompt: "",
      width: 513,
      height: 517,
      count: 1,
      referenceAssetIds: [oddUpload.body.asset.id],
      requestKey: randomUUID(),
    }),
  });
  assert.equal(unpaidTool.status, 402, "Blank-prompt tools with arbitrary source dimensions must reach paid confirmation");
  assert.equal((await api(a, "/jobs")).body.jobs.length, 0, "Rejected tool request must not create a paid job");
  const interruptedJobId = randomUUID();
  const interruptedRequestKey = randomUUID();
  await pool.query(
    `INSERT INTO obtv_image_studio_jobs
      (id, tenant_id, created_by_user_id, request_key, model_id, model_name, provider, operation, prompt,
       width, height, count, status, provider_task_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,'CLOUD','generate','test',512,512,1,'QUEUED',$7::jsonb)`,
    [
      interruptedJobId,
      a.tenantId,
      a.userId,
      interruptedRequestKey,
      cloud.id,
      cloud.name,
      JSON.stringify({ submissionIntent: true, submissionIntentAt: new Date().toISOString() }),
    ],
  );
  const inFlightDuplicate = await api(a, "/jobs", {
    method: "POST",
    body: JSON.stringify({
      modelId: cloud.id,
      operation: "generate",
      prompt: "test",
      width: 512,
      height: 512,
      count: 1,
      cloudConfirmed: true,
      requestKey: interruptedRequestKey,
    }),
  });
  assert.equal(inFlightDuplicate.status, 202);
  assert.equal(inFlightDuplicate.body.job.id, interruptedJobId);
  await new Promise(resolve => setTimeout(resolve, 100));
  const freshSubmission = await pool.query(
    "SELECT status FROM obtv_image_studio_jobs WHERE id=$1",
    [interruptedJobId],
  );
  assert.equal(freshSubmission.rows[0].status, "QUEUED", "A duplicate must not monitor a fresh in-flight submission");
  await pool.query(
    "UPDATE obtv_image_studio_jobs SET provider_task_metadata=provider_task_metadata || $2::jsonb WHERE id=$1",
    [interruptedJobId, JSON.stringify({ submissionIntentAt: new Date(Date.now() - 3 * 60_000).toISOString() })],
  );
  const interruptedCancel = await api(a, `/jobs/${interruptedJobId}/cancel`, { method: "POST" });
  assert.equal(interruptedCancel.status, 200);
  assert.equal(interruptedCancel.body.job.status, "FAILED");
  assert.match(interruptedCancel.body.job.errorMessage, /outcome unknown/i);
  const cancellationIntent = await pool.query(
    "SELECT provider_task_metadata->>'cancellationRequested' AS requested FROM obtv_image_studio_jobs WHERE id=$1",
    [interruptedJobId],
  );
  assert.equal(cancellationIntent.rows[0].requested, "true", "Cancellation intent must be durable before provider I/O");
  assert.equal((await api(a, `/jobs/${interruptedJobId}`, { method: "DELETE" })).status, 204);
  console.log("PASS: authentication, isolation, uploads, metadata, tools, search, Cloud cost confirmation");

  if (process.env.IMAGE_STUDIO_TEST_SKIP_BROWSER !== "1") {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "obtv_session", value: a.token, url: origin }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto(`${origin}/image-studio`);
  await page.getByRole("heading", { name: "Image Studio", exact: true }).waitFor();
  await page.getByText("FLUX.2 klein 4B", { exact: true }).first().waitFor();
  await page.getByText("Studio regression test", { exact: true }).first().waitFor();
  assert(!/\bfal(?:\.ai)?\b/i.test(await page.locator("body").innerText()));
  await page.getByText("Studio regression test", { exact: true }).first().click();
  await page.getByRole("button", { name: /^inpaint$/i }).click();
  const canvas = page.getByLabel("Paint edit mask");
  await canvas.waitFor();
  const box = await canvas.boundingBox();
  assert(box && box.width > 0 && box.height > 0, "Mask canvas must be visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();
  const maskUploaded = page.waitForResponse(r => r.url().endsWith("/api/image-studio/uploads") && r.status() === 201);
  await page.getByRole("button", { name: "Save mask", exact: true }).click();
  const savedMask = (await (await maskUploaded).json()).asset;
  assert.equal(savedMask.width, 512);
  await page.getByRole("button", { name: /^outpaint$/i }).click();
  await page.getByLabel("Outpaint padding").selectOption("256");
  await page.getByRole("button", { name: "Prepare canvas", exact: true }).click();
  await page.getByText("Outpaint canvas prepared", { exact: true }).waitFor();
  const prepared = (await api(a, "/assets")).body.assets;
  const expanded = prepared.find(item => item.name.startsWith("outpaint-source-"));
  const expandedMask = prepared.find(item => item.name.startsWith("outpaint-mask-"));
  assert(expanded && expandedMask, "Outpaint must upload a real expanded source and mask");
  assert.equal(expanded.width, 1024);
  assert.equal(expandedMask.width, expanded.width);
  await page.screenshot({ path: "/tmp/image-studio-outpaint.png", fullPage: true });
  await page.getByRole("button", { name: /^generate$/i }).first().click();
  console.log("PASS: interactive mask painting/upload and expanded outpaint source/mask");
  await page.screenshot({ path: "/tmp/image-studio-desktop.png", fullPage: true });
  await page.reload();
  await page.getByText("Studio regression test", { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/image-studio-mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2), false, "Mobile horizontal overflow");
  assert.deepEqual(pageErrors, []);
  console.log("PASS: authenticated desktop/mobile UI, persisted gallery after reload, no browser errors");
  }

  if (process.env.IMAGE_STUDIO_TEST_RENDER === "1") {
    const local = catalog.body.models.find(m => m.provider === "LOCAL" && m.available && m.operations.includes("generate"));
    assert(local, "No available local image worker");
    const requestKey = randomUUID();
    const requestBody = {
      modelId: local.id,
      operation: "generate",
      prompt: "A studio product photograph of a simple blue ceramic cup on a white background, soft natural light",
      width: 512,
      height: 512,
      count: 1,
      seed: 42,
      requestKey,
    };
    const created = await api(a, "/jobs", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const id = created.body.job.id;
    const duplicate = await api(a, "/jobs", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
    assert.equal(duplicate.status, 202, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.job.id, id, "A request key must return the original durable job");
    const duplicateCount = await pool.query(
      "SELECT count(*)::int AS count FROM obtv_image_studio_jobs WHERE tenant_id=$1 AND request_key=$2",
      [a.tenantId, requestKey],
    );
    assert.equal(duplicateCount.rows[0].count, 1, "A request key must dispatch at most once");
    assert.equal((await api(b, `/jobs/${id}`)).status, 404);
    let job = created.body.job;
    const deadline = Date.now() + 8 * 60_000;
    while (["QUEUED", "RUNNING"].includes(job.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      job = (await api(a, `/jobs/${id}`)).body.job;
    }
    assert.equal(job.status, "COMPLETED", job.errorMessage ?? "Local render did not finish");
    assert.equal(job.assets.length, 1);
    assert.equal((await fetch(new URL(job.assets[0].url, origin), { headers: { cookie: `obtv_session=${a.token}` } })).status, 200);
    console.log("PASS: real local GPU submission, polling, saved output and tenant-private media");
  }
} finally {
  await browser?.close();
  for (const account of fixtures) {
    try {
      const { body } = await api(account, "/jobs");
      for (const job of body?.jobs ?? []) {
        if (["QUEUED", "RUNNING"].includes(job.status)) await api(account, `/jobs/${job.id}/cancel`, { method: "POST" });
        await api(account, `/jobs/${job.id}`, { method: "DELETE" });
      }
      const assets = (await api(account, "/assets")).body?.assets ?? [];
      for (const asset of assets) await api(account, `/assets/${asset.id}`, { method: "DELETE" });
      await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]);
    } catch {
      console.error("Test fixture cleanup failed; remove isolated image-test fixtures before re-running.");
    }
  }
  await pool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
}