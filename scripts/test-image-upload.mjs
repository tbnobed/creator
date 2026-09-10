// Run only after the development UI is ready: node scripts/test-image-upload.mjs
// Exercises real uploads, but intercepts every image job before it reaches a provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = "/repl/tools/bin/chromium";
const fixtures = [];
const temporaryDirectory = `/tmp/image-upload-test-${randomUUID()}`;
const sourcePath = `${temporaryDirectory}/upload-source.png`;
let browser;

await mkdir(temporaryDirectory);

async function fixture() {
  const userId = `image-upload-test-${randomUUID()}`;
  const tenantId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const digest = createHash("sha256").update(token).digest("hex");
  await pool.query(
    "INSERT INTO obtv_users (id, display_name) VALUES ($1, 'Image Upload Test')",
    [userId],
  );
  fixtures.push({ userId, tenantId, token });
  await pool.query(
    "INSERT INTO obtv_tenants (id, name, slug) VALUES ($1, 'Image Upload Test', $2)",
    [tenantId, `image-upload-test-${tenantId}`],
  );
  await pool.query(
    "INSERT INTO obtv_tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'OWNER')",
    [tenantId, userId],
  );
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [
    tenantId,
    userId,
  ]);
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')",
    [digest, userId],
  );
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
  return { status: response.status, body };
}

async function openUploadDialog(page, trigger) {
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Upload an image" });
  await dialog.waitFor();
  return dialog;
}

async function uploadForIntent(page, trigger, intent, filename) {
  const dialog = await openUploadDialog(page, trigger);
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && response.url() === `${origin}/api/image-studio/uploads`
      && response.status() === 201,
  );
  await dialog.getByLabel("Choose image file").setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: await readFile(sourcePath),
  });
  await dialog.getByRole("button", { name: new RegExp(`^${intent}\\b`) }).click();
  await dialog.getByRole("button", { name: "Upload and continue", exact: true }).click();
  const asset = (await (await uploadResponse).json()).asset;
  await dialog.waitFor({ state: "hidden" });
  const preview = page.locator(`img[alt="${filename}"]`).first();
  await preview.waitFor();
  assert(await preview.isVisible(), `${intent} upload must automatically preview the new asset`);
  return asset;
}

async function submitInterceptedCloudJob(page, capturedJobs) {
  const checkbox = page.locator("#cloud-confirm");
  await checkbox.waitFor();
  await checkbox.check();
  assert.equal(await checkbox.isChecked(), true, "Cloud confirmation must be a real checked checkbox");
  const intercepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && response.url() === `${origin}/api/image-studio/jobs`
      && response.status() === 400,
  );
  await page.getByRole("button", { name: /^(Generate|Process)$/ }).click();
  await intercepted;
  return capturedJobs.at(-1);
}

try {
  const owner = await fixture();
  const outsider = await fixture();
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=teal:s=320x240",
    "-frames:v", "1",
    "-y", sourcePath,
  ]);

  const catalog = await api(owner, "/models");
  assert.equal(catalog.status, 200);

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "obtv_session", value: owner.token, url: origin }]);
  const page = await context.newPage();
  const pageErrors = [];
  const capturedJobs = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/image-studio/jobs", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON();
    capturedJobs.push(body);
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Regression harness intercepted this image job" }),
    });
  });

  await page.goto(`${origin}/image-studio`);
  await page.getByRole("heading", { name: "Image Studio", exact: true }).waitFor();
  await page.getByText("Model engine", { exact: true }).waitFor();

  const visibleUpload = page.getByRole("button", { name: "Upload image", exact: true });
  await visibleUpload.waitFor();
  await page.getByRole("button", { name: "Upload an image", exact: true }).waitFor();

  const validationDialog = await openUploadDialog(page, visibleUpload);
  await page.screenshot({ path: "/tmp/image-upload-dialog.png", fullPage: true });
  await validationDialog.getByLabel("Choose image file").setInputFiles({
    name: "oversized.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(12 * 1024 * 1024 + 1),
  });
  await validationDialog.getByRole("alert").getByText(/(?:too large|must not exceed|up to 12 MB)/i).waitFor();
  await validationDialog.getByLabel("Choose image file").setInputFiles({
    name: "unsupported.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await validationDialog.getByRole("alert").getByText(/(?:unsupported|only (?:PNG|JPEG|WebP)|file type)/i).waitFor();
  await page.keyboard.press("Escape");
  await validationDialog.waitFor({ state: "hidden" });

  const referenceAsset = await uploadForIntent(
    page,
    visibleUpload,
    "Use as reference",
    "newasset.png",
  );
  const referenceRequest = await submitInterceptedCloudJob(page, capturedJobs);
  assert.equal(referenceRequest.operation, "generate");
  assert(referenceRequest.referenceAssetIds.includes(referenceAsset.id));
  const referenceModel = catalog.body.models.find(
    (model) => model.id === referenceRequest.modelId,
  );
  assert(
    referenceModel?.available
      && referenceModel.provider === "CLOUD"
      && referenceModel.operations.includes("generate")
      && referenceModel.maxReferences > 0,
    "Reference upload must switch to an available reference-capable generate model",
  );
  assert.equal(referenceRequest.cloudConfirmed, true);

  const editAsset = await uploadForIntent(
    page,
    visibleUpload,
    "Edit image",
    "editsource.png",
  );
  const editRequest = await submitInterceptedCloudJob(page, capturedJobs);
  assert.equal(editRequest.operation, "edit");
  assert.equal(editRequest.referenceAssetIds[0], editAsset.id, "Edit upload must select its new source");
  assert.equal(editRequest.width, 320);
  assert.equal(editRequest.height, 240);
  assert.equal(editRequest.cloudConfirmed, true);

  const upscaleAsset = await uploadForIntent(
    page,
    visibleUpload,
    "Upscale image",
    "newsource.png",
  );
  const upscaleRequest = await submitInterceptedCloudJob(page, capturedJobs);
  assert.equal(upscaleRequest.operation, "upscale");
  assert.deepEqual(
    upscaleRequest.referenceAssetIds,
    [upscaleAsset.id],
    "Upscale must submit only the newly uploaded source",
  );
  assert.equal(upscaleRequest.width, 640);
  assert.equal(upscaleRequest.height, 480);
  assert.equal(upscaleRequest.cloudConfirmed, true);

  await page.screenshot({ path: "/tmp/image-upload-desktop.png", fullPage: true });
  await page.reload();
  await page.getByRole("heading", { name: "Image Studio", exact: true }).waitFor();
  for (const name of ["newasset.png", "editsource.png", "newsource.png"]) {
    await page.locator(`img[alt="${name}"]`).first().waitFor();
  }

  const outsiderAssets = await api(outsider, "/assets");
  assert.equal(outsiderAssets.status, 200);
  assert.equal(outsiderAssets.body.assets.length, 0);
  const foreignMedia = await fetch(new URL(upscaleAsset.url, origin), {
    headers: { cookie: `obtv_session=${outsider.token}` },
  });
  assert(
    [403, 404].includes(foreignMedia.status),
    "A second tenant must not read uploaded asset media",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/image-upload-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
    false,
    "Mobile horizontal overflow",
  );
  assert.deepEqual(pageErrors, []);
  assert.equal((await api(owner, "/jobs")).body.jobs.length, 0, "No image jobs may be submitted");
  console.log("PASS: upload intents, validation, persistence, isolation, and responsive UI");
} finally {
  await browser?.close();
  for (const account of fixtures) {
    try {
      const assets = (await api(account, "/assets")).body?.assets ?? [];
      for (const asset of assets) {
        await api(account, `/assets/${asset.id}`, { method: "DELETE" });
      }
      await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [
        account.tenantId,
      ]);
      await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [
        account.tenantId,
      ]);
      await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [
        account.tenantId,
      ]);
      await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]);
    } catch {
      console.error("Test fixture cleanup failed; remove isolated image-upload-test fixtures.");
    }
  }
  await pool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
}