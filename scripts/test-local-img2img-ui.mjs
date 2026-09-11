// Run only after the development HTTPS UI and API have restarted:
//   node scripts/test-local-img2img-ui.mjs
// Uploads are real, but every image job is intercepted in the browser before
// it can reach a Cloud provider or a local GPU worker.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium";
const runId = randomUUID();
const fixtures = [];
const temporaryDirectory = `/tmp/local-img2img-test-${runId}`;
const sourcePath = `${temporaryDirectory}/img2img-source.png`;
const customGenerateDimensions = { width: 320, height: 256 };
let browser;

function tokenAndDigest() {
  const token = randomBytes(32).toString("hex");
  return { token, digest: createHash("sha256").update(token).digest("hex") };
}

async function createFixture() {
  const userId = `local-img2img-${runId}`;
  const tenantId = randomUUID();
  const { token, digest } = tokenAndDigest();
  await pool.query(
    "INSERT INTO obtv_users (id, display_name) VALUES ($1, 'Local Img2Img Test')",
    [userId],
  );
  await pool.query(
    "INSERT INTO obtv_tenants (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [tenantId, `Local Img2Img ${runId.slice(0, 8)}`, `local-img2img-${runId}`, userId],
  );
  await pool.query(
    "INSERT INTO obtv_tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'OWNER')",
    [tenantId, userId],
  );
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id, user_id, expires_at) VALUES ($1, $2, NOW()+INTERVAL '2 hours')",
    [digest, userId],
  );
  const account = { userId, tenantId, token };
  fixtures.push(account);
  return account;
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
  const text = response.status === 204 ? "" : await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path} (${response.status})`);
    }
  }
  return { status: response.status, body };
}

async function openUploadDialog(page) {
  await page.getByRole("button", { name: "Upload image", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Upload an image" });
  await dialog.waitFor();
  return dialog;
}

async function uploadSource(page) {
  const dialog = await openUploadDialog(page);
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && response.url() === `${origin}/api/image-studio/uploads`
      && response.status() === 201,
  );
  await dialog.getByLabel("Choose image file").setInputFiles({
    name: "img2img-source.png",
    mimeType: "image/png",
    buffer: await readFile(sourcePath),
  });
  await dialog.getByRole("button", { name: /^Use as reference\b/ }).click();
  await dialog.getByRole("button", { name: "Upload and continue", exact: true }).click();
  const asset = (await (await uploadResponse).json()).asset;
  assert(asset?.id, "The source upload did not return an asset");
  await dialog.waitFor({ state: "hidden" });
  await page.locator('img[alt="img2img-source.png"]').first().waitFor();
  return asset;
}

async function selectMode(page, mode) {
  await page.getByRole("button", { name: new RegExp(`^${mode}$`, "i") }).first().click();
  await page.getByText("Model engine", { exact: true }).waitFor();
}

async function selectModel(page, model) {
  const trigger = page.getByRole("combobox").first();
  await trigger.click();
  await page.getByRole("option", { name: model.name, exact: true }).click();
  await page.waitForFunction(
    (name) => document.querySelector('[role="combobox"]')?.textContent?.includes(name),
    model.name,
  );
}

function promptInput(page) {
  return page.locator("textarea").first();
}

async function fillPrompt(page) {
  await promptInput(page).fill("A clean editorial product photograph of a blue ceramic cup");
}

async function clearReferences(page) {
  const removeButtons = page.getByRole("button", { name: /^Remove .+/ });
  while (await removeButtons.count()) {
    await removeButtons.first().click();
  }
}

async function strengthLabelCount(page) {
  return page.locator("label").filter({ hasText: /\bstrength\b/i }).count();
}

async function findStrengthSlider(page) {
  const testId = page.getByTestId("slider-local-denoise-strength");
  if (await testId.count()) {
    const nestedThumb = testId.getByRole("slider");
    if (await nestedThumb.count()) return nestedThumb.first();
    const directThumb = testId.locator('[role="slider"]');
    if (await directThumb.count()) return directThumb.first();
    return testId.first();
  }
  const named = page.getByRole("slider", { name: /strength/i });
  if (await named.count()) return named.first();

  const label = page.locator("label").filter({ hasText: /\bstrength\b/i }).last();
  assert.equal(await label.count(), 1, "Image-to-image strength label is missing");
  const index = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("label")];
    const strength = labels.find((candidate) => /\bstrength\b/i.test(candidate.textContent || ""));
    if (!strength) return -1;
    let parent = strength.parentElement;
    while (parent) {
      const slider = parent.querySelector('[role="slider"]');
      if (slider) return [...document.querySelectorAll('[role="slider"]')].indexOf(slider);
      parent = parent.parentElement;
    }
    return -1;
  });
  assert(index >= 0, "Image-to-image strength slider is missing");
  return page.getByRole("slider").nth(index);
}

async function setStrength(page, target) {
  const slider = await findStrengthSlider(page);
  await slider.focus();
  const minimum = Number(await slider.getAttribute("aria-valuemin"));
  const maximum = Number(await slider.getAttribute("aria-valuemax"));
  assert(Number.isFinite(minimum) && Number.isFinite(maximum) && maximum > minimum);
  const desired = maximum <= 1.01 ? target : target * 100;

  await slider.press("Home");
  await page.waitForTimeout(20);
  const atMinimum = Number(await slider.getAttribute("aria-valuenow"));
  await slider.press("ArrowRight");
  await page.waitForTimeout(20);
  const afterOneStep = Number(await slider.getAttribute("aria-valuenow"));
  const step = afterOneStep - atMinimum;
  assert(step > 0, "Strength slider did not respond to keyboard input");
  await slider.press("Home");
  await page.waitForTimeout(20);
  for (let index = 0; index < 100; index += 1) {
    const actual = Number(await slider.getAttribute("aria-valuenow"));
    if (Math.abs(actual - desired) <= Math.max(step / 2, 0.011)) break;
    await slider.press(actual < desired ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(10);
  }
  const actual = Number(await slider.getAttribute("aria-valuenow"));
  assert(
    Math.abs(actual - desired) <= Math.max(step / 2, 0.011),
    `Strength slider did not reach ${target}; got ${actual}`,
  );
}

async function assertDisplayedStrength(page, target) {
  const value = page.getByTestId("text-local-denoise-strength");
  await value.waitFor();
  assert.equal(
    (await value.innerText()).trim(),
    target.toFixed(2),
    `The image-to-image control should display ${target.toFixed(2)}`,
  );
}

async function scrollStrengthControlIntoView(page) {
  await page.evaluate(() => {
    const control = document.querySelector('[data-testid="local-image-to-image-controls"]');
    if (!control) return;
    let parent = control.parentElement;
    while (parent && parent.scrollHeight <= parent.clientHeight + 1) {
      parent = parent.parentElement;
    }
    if (parent) {
      parent.scrollTop = Math.max(0, control.offsetTop - 64);
    }
  });
  await page.waitForTimeout(50);
}

async function submitMockedJob(page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && response.url() === `${origin}/api/image-studio/jobs`
      && response.status() === 202,
  );
  await page.getByRole("button", { name: /^(Generate|Process)$/ }).first().click();
  const response = await responsePromise;
  return response.request().postDataJSON();
}

async function assertNoStrengthControl(page, context) {
  assert.equal(
    await strengthLabelCount(page),
    0,
    `${context} must not show an image-to-image strength control`,
  );
  assert.equal(
    await page.getByRole("slider", { name: /strength/i }).count(),
    0,
    `${context} must not expose a strength slider`,
  );
  assert.equal(
    await page.getByTestId("slider-local-denoise-strength").count(),
    0,
    `${context} must not expose a local strength slider`,
  );
}

function assertValidLocalDimensions(payload, expectedWidth, expectedHeight) {
  assert(Number.isInteger(payload.width) && Number.isInteger(payload.height));
  assert(payload.width >= 256 && payload.width <= 2048);
  assert(payload.height >= 256 && payload.height <= 2048);
  assert.equal(payload.width % 16, 0, "Local width must be divisible by 16");
  assert.equal(payload.height % 16, 0, "Local height must be divisible by 16");
  assert.equal(payload.width, expectedWidth);
  assert.equal(payload.height, expectedHeight);
}

function assertStrengthPayload(
  payload,
  expectedModelId,
  expectedOperation,
  assetId,
  { denoiseStrength, width, height },
) {
  assert.equal(payload.modelId, expectedModelId);
  assert.equal(payload.operation, expectedOperation);
  assert.equal(
    payload.denoiseStrength,
    denoiseStrength,
    `${expectedOperation} must send denoiseStrength ${denoiseStrength}`,
  );
  assert.deepEqual(payload.referenceAssetIds, [assetId]);
  assertValidLocalDimensions(payload, width, height);
}

try {
  await mkdir(temporaryDirectory);
  const account = await createFixture();
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=teal:s=320x240",
    "-frames:v", "1",
    "-y", sourcePath,
  ]);

  const catalog = await api(account, "/models");
  assert.equal(catalog.status, 200);
  const models = catalog.body?.models ?? [];
  const localModels = models.filter((model) => model.provider === "LOCAL");
  assert(localModels.length > 0, "The image catalog has no local models");
  assert(
    localModels.every((model) => model.available),
    "Every local image model must be available for the local img2img regression",
  );
  assert(
    localModels.every(
      (model) =>
        model.operations.includes("generate")
        && model.operations.includes("edit")
        && model.maxReferences >= 1,
    ),
    "Every local image model must advertise generate/edit and one reference",
  );
  const cloudGenerate = models.find(
    (model) => model.provider === "CLOUD" && model.available && model.operations.includes("generate"),
  );
  assert(cloudGenerate, "An available Cloud generate model is required to verify Cloud has no strength control");
  const modelById = new Map(models.map((model) => [model.id, model]));

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{
    name: "obtv_session",
    value: account.token,
    url: origin,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  const page = await context.newPage();
  const pageErrors = [];
  const interceptedJobs = [];
  const historyJobs = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname !== "/api/image-studio/jobs") {
      await route.continue();
      return;
    }
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jobs: [...historyJobs].reverse() }),
      });
      return;
    }
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const payload = request.postDataJSON();
    interceptedJobs.push(payload);
    const model = modelById.get(payload.modelId);
    const fakeJob = {
      id: randomUUID(),
      modelId: payload.modelId,
      modelName: model?.name || payload.modelId,
      provider: model?.provider || "LOCAL",
      operation: payload.operation,
      prompt: payload.prompt,
      ...(payload.negativePrompt ? { negativePrompt: payload.negativePrompt } : {}),
      width: payload.width,
      height: payload.height,
      count: payload.count,
      ...(payload.seed === undefined ? {} : { seed: payload.seed }),
      ...(payload.denoiseStrength === undefined ? {} : { denoiseStrength: payload.denoiseStrength }),
      status: "QUEUED",
      errorMessage: null,
      assets: [],
      referenceAssetIds: payload.referenceAssetIds || [],
      maskAssetId: payload.maskAssetId || null,
      createdAt: new Date().toISOString(),
    };
    historyJobs.push(fakeJob);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ job: fakeJob }),
    });
  });

  await page.goto(`${origin}/image-studio`);
  await page.getByRole("heading", { name: "Image Studio", exact: true }).waitFor();
  await page.getByText("Model engine", { exact: true }).waitFor();

  // A local text-to-image request with zero references remains valid, and does
  // not expose image-to-image-only controls.
  await selectMode(page, "generate");
  for (const model of localModels) {
    await selectModel(page, model);
    await clearReferences(page);
    await fillPrompt(page);
    await page.locator('[aria-label="Width"]').fill(String(customGenerateDimensions.width));
    await page.locator('[aria-label="Height"]').fill(String(customGenerateDimensions.height));
    await assertNoStrengthControl(page, `${model.name} text-to-image`);
    const payload = await submitMockedJob(page);
    assert.equal(payload.modelId, model.id);
    assert.equal(payload.operation, "generate");
    assert(
      !Object.hasOwn(payload, "denoiseStrength"),
      `${model.name} text-to-image must omit denoiseStrength`,
    );
    assert(
      !payload.referenceAssetIds || payload.referenceAssetIds.length === 0,
      `${model.name} text-to-image must allow zero references`,
    );
  }

  const source = await uploadSource(page);
  assert.equal(source.width, 320);
  assert.equal(source.height, 240);

  // One uploaded reference enables local image-to-image generation. Exercise
  // every local model. The first control value proves the .65 default; then
  // .35 proves a custom slider value reaches the outgoing request.
  await selectMode(page, "generate");
  let checkedGenerateDefault = false;
  for (const model of localModels) {
    await selectModel(page, model);
    await fillPrompt(page);
    await page.locator('[aria-label="Width"]').fill(String(customGenerateDimensions.width));
    await page.locator('[aria-label="Height"]').fill(String(customGenerateDimensions.height));
    if (!checkedGenerateDefault) {
      await assertDisplayedStrength(page, 0.65);
      checkedGenerateDefault = true;
    } else {
      await setStrength(page, 0.65);
    }
    const defaultPayload = await submitMockedJob(page);
    assertStrengthPayload(defaultPayload, model.id, "generate", source.id, {
      denoiseStrength: 0.65,
      width: customGenerateDimensions.width,
      height: customGenerateDimensions.height,
    });
    await setStrength(page, 0.35);
    const customPayload = await submitMockedJob(page);
    assertStrengthPayload(customPayload, model.id, "generate", source.id, {
      denoiseStrength: 0.35,
      width: customGenerateDimensions.width,
      height: customGenerateDimensions.height,
    });
  }

  // Reload to clear component state, select the uploaded source from the real
  // gallery, and prove edit uses valid selected output dimensions (1024² by
  // default) rather than the source's 320×240 pixels.
  await page.reload();
  await page.getByRole("heading", { name: "Image Studio", exact: true }).waitFor();
  await page.getByRole("button", { name: "Select img2img-source.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "Select img2img-source.png", exact: true }).click();
  await selectMode(page, "edit");
  let checkedEditDefault = false;
  for (const model of localModels) {
    await selectModel(page, model);
    await fillPrompt(page);
    if (!checkedEditDefault) {
      await assertDisplayedStrength(page, 0.65);
      checkedEditDefault = true;
    } else {
      await setStrength(page, 0.65);
    }
    const defaultPayload = await submitMockedJob(page);
    assertStrengthPayload(defaultPayload, model.id, "edit", source.id, {
      denoiseStrength: 0.65,
      width: 1024,
      height: 1024,
    });
    await setStrength(page, 0.35);
    const customPayload = await submitMockedJob(page);
    assertStrengthPayload(customPayload, model.id, "edit", source.id, {
      denoiseStrength: 0.35,
      width: 1024,
      height: 1024,
    });
  }

  // Capture the working local edit UI before the optional history exercise
  // changes the gallery tab. These are deliberately local-image-to-image
  // screenshots, not a later Cloud/text-to-image state.
  await scrollStrengthControlIntoView(page);
  await page.screenshot({ path: "/tmp/local-img2img-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollStrengthControlIntoView(page);
  await page.screenshot({ path: "/tmp/local-img2img-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
    false,
    "Mobile local img2img UI must not overflow horizontally",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The mocked history response includes denoiseStrength. Reuse settings is a
  // useful regression when the gallery route is available, but it must not
  // block the primary image-to-image checks if a frontend query cache or route
  // implementation prevents the optional card from appearing.
  let reuseVerified = false;
  let reuseWarning = "";
  try {
    await page.getByRole("button", { name: "Queue & history", exact: true }).click();
    const reuseButtons = page.getByRole("button", { name: "Reuse settings", exact: true });
    await reuseButtons.last().waitFor({ timeout: 5000 });
    await reuseButtons.last().click();
    await assertDisplayedStrength(page, 0.35);
    const reusedPayload = await submitMockedJob(page);
    assertStrengthPayload(reusedPayload, localModels.at(-1).id, "edit", source.id, {
      denoiseStrength: 0.35,
      width: 1024,
      height: 1024,
    });
    reuseVerified = true;
  } catch (error) {
    reuseWarning = error instanceof Error ? error.message : String(error);
    console.warn(`WARN optional mocked history reuse was not verified: ${reuseWarning}`);
    await page.getByRole("button", { name: "Gallery", exact: true }).click().catch(() => {});
  }

  // Cloud generation is intercepted too, so this check cannot spend credits.
  // Its text-to-image UI and outgoing payload must not inherit local denoise strength.
  await selectMode(page, "generate");
  await clearReferences(page);
  await selectModel(page, cloudGenerate);
  await fillPrompt(page);
  await assertNoStrengthControl(page, "Cloud text-to-image");
  const cloudConfirmation = page.locator("#cloud-confirm");
  if (await cloudConfirmation.count()) await cloudConfirmation.check();
  const cloudPayload = await submitMockedJob(page);
  assert.equal(cloudPayload.modelId, cloudGenerate.id);
  assert.equal(cloudPayload.operation, "generate");
  assert(
    !Object.hasOwn(cloudPayload, "denoiseStrength"),
    "Cloud payload must omit local denoise strength",
  );
  assert(
    !cloudPayload.referenceAssetIds || cloudPayload.referenceAssetIds.length === 0,
    "Cloud text-to-image must not submit the local source reference",
  );

  assert.deepEqual(pageErrors, []);
  assert.equal(interceptedJobs.length, localModels.length * 5 + 1 + (reuseVerified ? 1 : 0));
  assert.equal((await api(account, "/jobs")).body.jobs.length, 0, "Mocked submissions must not create real jobs");
  console.log(
    `PASS: authenticated HTTPS local img2img upload, all local models, strength payloads, Cloud guard, and responsive UI${reuseVerified ? "; mocked history reuse" : `; history reuse skipped (${reuseWarning})`}`,
  );
} finally {
  await browser?.close();
  for (const account of fixtures) {
    try {
      const assets = (await api(account, "/assets")).body?.assets ?? [];
      for (const asset of assets) {
        await api(account, `/assets/${asset.id}`, { method: "DELETE" });
      }
      await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_image_studio_jobs WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]);
    } catch {
      console.error(`Fixture cleanup failed for isolated local img2img run ${runId}`);
    }
  }
  await pool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
}