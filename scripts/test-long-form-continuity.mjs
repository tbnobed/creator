// Run only after the development HTTPS UI and API are ready:
//   node scripts/test-long-form-continuity.mjs
//
// This is an integration/browser regression harness for the long-form
// continuity contract. It creates isolated tenants and only uses the real
// HTTPS API. It never turns on a fully approved project and never submits a
// render to a GPU or paid provider.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
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
const projectIds = [];
let browser;

const stillPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDAwMDAAAwBAAEGAPr9C8cAAAAASUVORK5CYII=",
  "base64",
);
const replacementStillPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAAC1HAwCAAAAEElEQVR42mNk+M/wHwAE/wJ/l9K8WQAAAABJRU5ErkJggg==",
  "base64",
);

function tokenAndDigest() {
  const token = randomBytes(32).toString("hex");
  return { token, digest: createHash("sha256").update(token).digest("hex") };
}

async function createAccount(label) {
  const userId = `continuity-${runId}-${label.toLowerCase()}`;
  const email = `${label.toLowerCase()}.${runId}@continuity.test`;
  const { token, digest } = tokenAndDigest();
  await pool.query(
    `INSERT INTO obtv_users
       (id,email,password_hash,display_name,site_role)
     VALUES ($1,$2,$3,$4,'USER')`,
    [userId, email, "synthetic-test-password-hash", `Continuity ${label}`],
  );
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '2 hours')",
    [digest, userId],
  );
  const account = { label, userId, email, token, tenantId: null };
  fixtures.push(account);
  return account;
}

async function createTenant(account, label) {
  const tenantId = randomUUID();
  await pool.query(
    `INSERT INTO obtv_tenants (id,name,slug,created_by_user_id)
     VALUES ($1,$2,$3,$4)`,
    [tenantId, `Continuity ${label} ${runId.slice(0, 8)}`, `continuity-${label.toLowerCase()}-${runId}`, account.userId],
  );
  await pool.query(
    `INSERT INTO obtv_tenant_memberships
       (tenant_id,user_id,role)
     VALUES ($1,$2,'OWNER')`,
    [tenantId, account.userId],
  );
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, account.userId]);
  account.tenantId = tenantId;
  return account;
}

async function createStudioRows(account, label) {
  const characterId = randomUUID();
  const nonCastCharacterId = randomUUID();
  const settingId = randomUUID();
  await pool.query(
    `INSERT INTO obtv_characters
       (id,tenant_id,created_by_user_id,name,description,prompt_description)
     VALUES
       ($1,$2,$3,$4,$5,$6),
       ($7,$2,$3,$8,$9,$10)`,
    [
      characterId,
      account.tenantId,
      account.userId,
      `${label} Mara`,
      "A synthetic continuity-test presenter.",
      "A poised presenter with a copper scarf.",
      nonCastCharacterId,
      `${label} Guest`,
      "A synthetic character that is intentionally not cast in the project.",
      "A guest who must not become an implicit speaker.",
    ],
  );
  await pool.query(
    `INSERT INTO obtv_settings
       (id,tenant_id,created_by_user_id,name,description,prompt_description)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      settingId,
      account.tenantId,
      account.userId,
      `${label} Rain Platform`,
      "A synthetic setting for long-form continuity regression.",
      "A rain-slick broadcast platform at blue hour.",
    ],
  );
  return { characterId, nonCastCharacterId, settingId };
}

function isFormDataBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function isBinaryBody(body) {
  return Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer;
}

async function api(account, path, options = {}) {
  const body = options.body;
  const requestHeaders = {
    cookie: `obtv_session=${account.token}`,
    origin,
    ...(
      body !== undefined
      && !isFormDataBody(body)
      && !isBinaryBody(body)
      && !options.headers?.["content-type"]
      && !options.headers?.["Content-Type"]
        ? { "content-type": "application/json" }
        : {}
    ),
    ...options.headers,
  };
  const response = await fetch(`${origin}/api${path}`, {
    ...options,
    headers: requestHeaders,
  });
  const text = response.status === 204 ? "" : await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function projectBody(response) {
  return response.body?.project ?? response.body;
}

function shotBody(response) {
  return response.body?.shot ?? response.body;
}

function stillOf(shot) {
  assert(shot?.still, "The long-form shot response must include the still contract");
  return shot.still;
}

function errorText(response) {
  if (typeof response.body === "string") return response.body;
  return response.body?.error ?? JSON.stringify(response.body);
}

function assertRejected(response, expectedStatuses, context) {
  assert(
    expectedStatuses.includes(response.status),
    `${context} should be rejected (${expectedStatuses.join("/")}); got ${response.status}: ${errorText(response)}`,
  );
}

async function uploadImageAsset(account, bytes, name) {
  const response = await api(account, "/image-studio/uploads", {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": "image/png",
      "x-file-name": name,
    },
  });
  assert.equal(response.status, 201, `Image Studio upload failed: ${errorText(response)}`);
  assert(response.body?.asset?.id, "The real image upload did not return an asset");
  return response.body.asset;
}

async function uploadStill(account, projectId, shotId, bytes, name) {
  // The contract intentionally permits multipart uploads. Try the two common
  // field names at most once each so a fixture cannot loop forever while a UI
  // or API contract is being iterated on.
  let lastResponse;
  for (const fieldName of ["file", "still"]) {
    const form = new FormData();
    form.append(fieldName, new Blob([bytes], { type: "image/png" }), name);
    lastResponse = await api(account, `/long-form-projects/${projectId}/shots/${shotId}/still`, {
      method: "POST",
      body: form,
    });
    if (lastResponse.status !== 400) break;
  }
  assert.equal(
    lastResponse.status,
    201,
    `Shot still upload failed after two bounded multipart attempts: ${errorText(lastResponse)}`,
  );
  const shot = shotBody(lastResponse);
  assert(stillOf(shot).assetUrl, "Uploaded shot still must expose an asset URL");
  return shot;
}

async function reviewStill(account, projectId, shotId, action, revision, note) {
  const response = await api(account, `/long-form-projects/${projectId}/shots/${shotId}/still/review`, {
    method: "POST",
    body: jsonBody({ action, revision, ...(note ? { note } : {}) }),
  });
  return response;
}

async function generationJobCount(account) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM obtv_generation_jobs WHERE tenant_id=$1",
    [account.tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function guardRenderRoutes(page, attempts) {
  page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST"
      && (
        /\/long-form-projects\/[^/]+\/start$/u.test(pathname)
        || /(?:^|\/)jobs(?:\/|$)/u.test(pathname)
        || /(?:^|\/)generate(?:\/|$)/u.test(pathname)
      )
    ) {
      attempts.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 418,
        contentType: "application/json",
        body: JSON.stringify({ error: "Continuity regression harness blocks render submissions" }),
      });
      return;
    }
    await route.continue();
  });
}

async function visibleLabel(page, patterns, description) {
  for (const pattern of patterns) {
    const matches = page.getByLabel(pattern);
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  throw new Error(
    `UI field "${description}" was not found after ${patterns.length} bounded selector attempts`,
  );
}

async function visibleButton(page, patterns, description) {
  for (const pattern of patterns) {
    const matches = page.getByRole("button", { name: pattern });
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  throw new Error(
    `UI button "${description}" was not found after ${patterns.length} bounded selector attempts`,
  );
}

async function visibleTestId(page, testId, description) {
  const candidate = page.getByTestId(testId);
  if (await candidate.count()) {
    try {
      await candidate.first().waitFor({ state: "visible", timeout: 5_000 });
      return candidate.first();
    } catch {
      // Preserve the bounded, descriptive error below.
    }
  }
  throw new Error(`UI test control "${description}" (${testId}) was not visible after one bounded 5s wait`);
}

async function waitForVisibleTestId(page, testId, description, diagnostic = false) {
  const candidate = page.getByTestId(testId).first();
  try {
    await candidate.waitFor({ state: "visible", timeout: 5_000 });
    return candidate;
  } catch (error) {
    if (diagnostic) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const diagnostics = {
        error: error instanceof Error ? error.message : String(error),
        url: page.url(),
        readyState: await page.evaluate(() => document.readyState).catch(() => "unavailable"),
        manageCount: await page.getByTestId("button-manage-continuity").count().catch(() => -1),
        saveCount: await page.getByTestId("button-save-continuity").count().catch(() => -1),
        dialogCount: await page.getByRole("dialog").count().catch(() => -1),
        pageErrors: page.__continuityPageErrors ?? [],
        consoleErrors: page.__continuityConsoleErrors ?? [],
        bodyText: bodyText.slice(0, 16_000),
      };
      await page.screenshot({
        path: "/tmp/long-form-continuity-ui-open-failure.png",
        fullPage: true,
      }).catch(() => undefined);
      console.error("Continuity editor did not mount after Manage click:", JSON.stringify(diagnostics, null, 2));
    }
    throw error;
  }
}

async function visibleControl(page, { labels = [], placeholders = [] }, description) {
  try {
    return await visibleLabel(page, labels, description);
  } catch (labelError) {
    for (const pattern of placeholders) {
      const matches = page.getByPlaceholder(pattern);
      for (let index = 0; index < await matches.count(); index += 1) {
        const candidate = matches.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
    }
    const bodyText = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({
      path: `/tmp/long-form-continuity-ui-${description.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`,
      fullPage: true,
    }).catch(() => undefined);
    console.error("Continuity UI field lookup failed:", JSON.stringify({
      description,
      error: labelError instanceof Error ? labelError.message : String(labelError),
      url: page.url(),
      pageErrors: page.__continuityPageErrors ?? [],
      consoleErrors: page.__continuityConsoleErrors ?? [],
      bodyText: bodyText.slice(0, 16_000),
    }, null, 2));
    throw labelError;
  }
}

async function runContinuityUi(account, project, expectedValues, browserShotId, options = {}) {
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
  const consoleErrors = [];
  const renderAttempts = [];
  let expectedClose = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("close", () => {
    if (expectedClose) return;
    console.error("Continuity UI page closed unexpectedly", JSON.stringify({
      url: page.url(),
      pageErrors,
      consoleErrors,
    }, null, 2));
  });
  context.on("close", () => {
    if (expectedClose) return;
    console.error("Continuity UI browser context closed unexpectedly", JSON.stringify({
      pageErrors,
      consoleErrors,
    }, null, 2));
  });
  page.__continuityPageErrors = pageErrors;
  page.__continuityConsoleErrors = consoleErrors;
  guardRenderRoutes(page, renderAttempts);

  await page.goto(`${origin}/projects/${project.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: project.title, exact: true }).waitFor({ timeout: 10_000 });

  const startButton = await visibleButton(
    page,
    [/^Start(?: Production)?$/i, /^Start\b/i],
    "Start Production",
  );
  assert.equal(
    await startButton.isDisabled(),
    true,
    "A continuity project without every approved still must disable Start before any request",
  );

  const openEditorButton = await visibleTestId(
    page,
    "button-manage-continuity",
    "project continuity editor",
  );
  await openEditorButton.click();
  await waitForVisibleTestId(
    page,
    "button-save-continuity",
    "continuity editor save control",
    options.diagnosticOpen,
  );

  const characterTab = page.getByRole("tab", { name: /characters.*wardrobes/i });
  await characterTab.waitFor({ state: "visible", timeout: 5_000 });
  await characterTab.click();
  const wardrobeName = await visibleControl(page, {
    labels: [/wardrobe.*name/i, /outfit.*name/i],
    placeholders: [/heist suit/i, /outfit/i],
  }, "wardrobe name");
  await wardrobeName.fill(expectedValues.wardrobeName);
  const scenesTab = page.getByRole("tab", { name: /scene defaults|scenes/i });
  await scenesTab.waitFor({ state: "visible", timeout: 5_000 });
  await scenesTab.click();
  const settingNotes = await visibleControl(page, {
    labels: [/setting.*notes/i, /scene.*setting/i, /scene.*notes/i],
    placeholders: [/lighting.*time of day/i, /setting/i],
  }, "scene setting notes");
  await settingNotes.fill(expectedValues.settingNotes);

  const saveButton = await visibleTestId(page, "button-save-continuity", "continuity settings");
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT"
      && new URL(response.url()).pathname.endsWith(`/long-form-projects/${project.id}/continuity`)
      && response.status() === 200,
    { timeout: 10_000 },
  );
  await saveButton.click();
  await saveResponse;

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: project.title, exact: true }).waitFor({ timeout: 10_000 });
  const reopenEditorButton = await visibleTestId(
    page,
    "button-manage-continuity",
    "project continuity editor after reload",
  );
  await reopenEditorButton.click();
  await waitForVisibleTestId(
    page,
    "button-save-continuity",
    "continuity editor save control after reload",
    options.diagnosticOpen,
  );
  const reloadedCharacterTab = page.getByRole("tab", { name: /characters.*wardrobes/i });
  await reloadedCharacterTab.waitFor({ state: "visible", timeout: 5_000 });
  await reloadedCharacterTab.click();
  const reloadedWardrobeName = await visibleControl(page, {
    labels: [/wardrobe.*name/i, /outfit.*name/i],
    placeholders: [/heist suit/i, /outfit/i],
  }, "reloaded wardrobe name");
  assert.equal(await reloadedWardrobeName.inputValue(), expectedValues.wardrobeName);
  const reloadedScenesTab = page.getByRole("tab", { name: /scene defaults|scenes/i });
  await reloadedScenesTab.waitFor({ state: "visible", timeout: 5_000 });
  await reloadedScenesTab.click();
  const reloadedSettingNotes = await visibleControl(page, {
    labels: [/setting.*notes/i, /scene.*setting/i, /scene.*notes/i],
    placeholders: [/lighting.*time of day/i, /setting/i],
  }, "reloaded scene setting notes");
  assert.equal(await reloadedSettingNotes.inputValue(), expectedValues.settingNotes);
  const persistedProject = projectBody(await api(account, `/long-form-projects/${project.id}`));
  assert.equal(persistedProject.continuity.characters[0].wardrobes[0].name, expectedValues.wardrobeName);
  assert.equal(persistedProject.continuity.scenes[0].settingNotes, expectedValues.settingNotes);
  assert.equal(persistedProject.continuity.scenes[0].title, expectedValues.sceneTitle);

  // Exercise the real browser upload path, not the raw assetId shortcut. The
  // upload response must hydrate the project cache, render a real image (not a
  // media 404), and expose the approval control for the PENDING revision.
  await page.keyboard.press("Escape");
  const reviewButton = await visibleTestId(
    page,
    `button-review-still-${browserShotId}`,
    "browser still review",
  );
  await reviewButton.click();
  const dialog = page.getByRole("dialog");
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: `browser-continuity-${runId}.png`,
    mimeType: "image/png",
    buffer: stillPng,
  });
  await page.screenshot({ path: "/tmp/long-form-continuity-before-upload-response.png", fullPage: true }).catch(() => undefined);
  const uploadButton = fileInput.locator("xpath=..").locator("button").last();
  await uploadButton.waitFor({ state: "visible", timeout: 5_000 });
  await uploadButton.click();
  const uploadedImage = dialog.locator('img[alt="Shot Still"]');
  await uploadedImage.waitFor({ state: "visible", timeout: 10_000 });
  const imageState = await uploadedImage.evaluate((image) => ({
    complete: image instanceof HTMLImageElement && image.complete,
    naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
  }));
  assert.equal(imageState.complete, true, "Uploaded still image did not finish loading in the browser");
  assert(imageState.naturalWidth > 0, "Uploaded still image resolved to a media 404 or empty image");
  assert(await dialog.getByText("PENDING", { exact: true }).isVisible(), "Uploaded still must be PENDING");

  const approveButton = await visibleTestId(page, "button-approve-still", "approve browser still");
  const approveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/long-form-projects/${project.id}/shots/${browserShotId}/still/review`)
      && response.status() === 200,
    { timeout: 10_000 },
  );
  await approveButton.click();
  await approveResponse;
  // Approval intentionally closes the review dialog. Verify the approved
  // state through the real API before reloading, then assert the UI state in
  // the reopened dialog below.
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  await page.screenshot({ path: "/tmp/long-form-continuity-after-approve.png", fullPage: true }).catch(() => undefined);
  const browserApprovedBeforeReload = projectBody(await api(account, `/long-form-projects/${project.id}`));
  assert.equal(
    browserApprovedBeforeReload.shots.find((shot) => shot.id === browserShotId)?.still.status,
    "APPROVED",
    "Browser approval must persist through the real API",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: project.title, exact: true }).waitFor({ timeout: 10_000 });
  const reloadedReviewButton = await visibleTestId(
    page,
    `button-review-still-${browserShotId}`,
    "reloaded browser still review",
  );
  await reloadedReviewButton.click();
  const reloadedDialog = page.getByRole("dialog");
  const reloadedImage = reloadedDialog.locator('img[alt="Shot Still"]');
  await reloadedImage.waitFor({ state: "visible", timeout: 10_000 });
  const reloadedImageState = await reloadedImage.evaluate((image) => ({
    complete: image instanceof HTMLImageElement && image.complete,
    naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
  }));
  assert.equal(reloadedImageState.complete, true, "Approved still did not survive browser reload");
  assert(reloadedImageState.naturalWidth > 0, "Approved still media URL is not readable after reload");
  assert(await reloadedDialog.getByText("APPROVED", { exact: true }).isVisible(), "Reloaded API state must remain APPROVED");
  const browserApprovedProject = projectBody(await api(account, `/long-form-projects/${project.id}`));
  const browserApprovedShot = browserApprovedProject.shots.find((shot) => shot.id === browserShotId);
  assert.equal(browserApprovedShot?.still.status, "APPROVED", "Reload verification must use the real API state");

  await page.screenshot({ path: "/tmp/long-form-continuity-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: "/tmp/long-form-continuity-mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
    false,
    "Mobile long-form continuity UI must not overflow horizontally",
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(
    renderAttempts,
    [],
    "The continuity browser harness must not attempt a render or GPU submission",
  );
  expectedClose = true;
  await context.close();
}

const continuityCharacter = (characterId, wardrobeId, label) => ({
  characterId,
  appearance: `${label} has a consistent copper scarf and short dark hair.`,
  behavior: "Measured, observant, and calm between takes.",
  voiceDescription: "Warm, low, and deliberate broadcast delivery.",
  wardrobes: [{
    id: wardrobeId,
    name: "Indigo Field Jacket",
    description: "Indigo field jacket with a copper scarf.",
  }],
});

async function runUiOnlyFixture() {
  const owner = await createTenant(await createAccount("UiOnly"), "UiOnly");
  const ownerStudio = await createStudioRows(owner, "UiOnly");
  const wardrobeId = `wardrobe-${runId}`;
  const continuity = {
    enabled: true,
    characters: [continuityCharacter(ownerStudio.characterId, wardrobeId, "UiOnly Mara")],
    scenes: [{
      sceneNumber: 1,
      title: "UI Diagnostic Scene",
      settingNotes: "A diagnostic blue-hour platform.",
      emotionNotes: "Focused and calm.",
      wardrobeAssignments: [{ characterId: ownerStudio.characterId, wardrobeId }],
    }],
  };
  const script = [
    "SHOT 1 — UI Diagnostic Scene",
    "Mara stands on the rain-slick platform.",
    'Dialogue: "The signal is still alive."',
    "",
    "SHOT 2 — UI Diagnostic Follow-up",
    "Mara watches the tower in the same wardrobe and setting.",
    'Dialogue: "Then we keep moving."',
  ].join("\n");
  const capabilities = await api(owner, "/generation-capabilities");
  const capability = Array.isArray(capabilities.body) ? capabilities.body[0] : null;
  const created = await api(owner, "/long-form-projects", {
    method: "POST",
    body: jsonBody({
      title: `UI Diagnostic ${runId.slice(0, 8)}`,
      script,
      storyline: "Keep the named wardrobe, setting, and performance consistent.",
      targetDurationSeconds: 10,
      shotDurationSeconds: 5,
      characterIds: [ownerStudio.characterId],
      settingId: ownerStudio.settingId,
      generationMode: capability?.generationMode ?? "LTX_VIDEO",
      negativePrompt: "text, watermark, blurry",
      width: 1280,
      height: 720,
      fps: 24,
      qualityPreset: "DRAFT",
      continuity,
    }),
  });
  assert.equal(created.status, 201, `UI-only project creation failed: ${errorText(created)}`);
  const project = projectBody(created);
  assert.equal(project.continuity.enabled, true);
  assert.equal(project.shots.length, 2);
  projectIds.push(project.id);
  await runContinuityUi(
    owner,
    project,
    {
      wardrobeName: `UI Diagnostic Outfit ${runId.slice(0, 8)}`,
      sceneTitle: continuity.scenes[0].title,
      settingNotes: `UI diagnostic persistence ${runId.slice(0, 8)}`,
    },
    project.shots[1].id,
    { diagnosticOpen: true },
  );
  assert.equal(await generationJobCount(owner), 0);
  console.log("PASS: isolated UI continuity upload, preview, approval, reload, and no-render guard");
}

try {
  if (process.env.CONTINUITY_UI_ONLY === "1") {
    await runUiOnlyFixture();
  } else {
  const owner = await createTenant(await createAccount("Owner"), "Owner");
  const foreign = await createTenant(await createAccount("Foreign"), "Foreign");
  const ownerStudio = await createStudioRows(owner, "Owner");
  const foreignStudio = await createStudioRows(foreign, "Foreign");

  const wardrobeId = `wardrobe-${runId}`;
  const initialContinuity = {
    enabled: true,
    characters: [continuityCharacter(ownerStudio.characterId, wardrobeId, "Mara")],
    scenes: [{
      sceneNumber: 1,
      title: "Rain Platform Arrival",
      settingNotes: "Blue-hour rain glints across the platform.",
      emotionNotes: "Mara is focused but quietly hopeful.",
      wardrobeAssignments: [{
        characterId: ownerStudio.characterId,
        wardrobeId,
      }],
    }],
  };
  const replacementContinuity = {
    ...initialContinuity,
    scenes: [{
      ...initialContinuity.scenes[0],
      settingNotes: "The same platform remains wet, blue, and continuous.",
      emotionNotes: "Mara relaxes only after she sees the signal.",
    }],
  };
  const script = [
    "SHOT 1 — Rain Platform Arrival",
    "Mara stands on the rain-slick platform at blue hour.",
    'Dialogue: "The signal is still alive."',
    "",
    "SHOT 2 — Signal",
    "Mara watches the distant tower and keeps the same wardrobe and lighting.",
    'Dialogue: "Then we keep moving."',
  ].join("\n");

  const capabilities = await api(owner, "/generation-capabilities");
  const capability = Array.isArray(capabilities.body)
    ? capabilities.body.find((candidate) => candidate.supportsCharacterReferences && !candidate.supportsReferenceVideo)
    : null;
  const generationMode = capability?.generationMode ?? "LTX_VIDEO";
  const createResponse = await api(owner, "/long-form-projects", {
    method: "POST",
    body: jsonBody({
      title: `Continuity Regression ${runId.slice(0, 8)}`,
      script,
      storyline: "Keep the named wardrobe, setting, and performance consistent.",
      targetDurationSeconds: 10,
      shotDurationSeconds: 5,
      characterIds: [ownerStudio.characterId],
      settingId: ownerStudio.settingId,
      generationMode,
      negativePrompt: "text, watermark, blurry",
      width: 1280,
      height: 720,
      fps: 24,
      qualityPreset: "DRAFT",
      continuity: initialContinuity,
    }),
  });
  assert.equal(createResponse.status, 201, `Project creation failed: ${errorText(createResponse)}`);
  const project = projectBody(createResponse);
  assert(project?.id, "Project creation did not return an ID");
  projectIds.push(project.id);
  assert.equal(project.continuity.enabled, true);
  assert.equal(project.continuity.characters[0].wardrobes[0].name, "Indigo Field Jacket");
  assert.equal(project.continuity.scenes[0].title, "Rain Platform Arrival");
  assert.equal(project.shots.length, 2, "The fixture must create two shots for partial approval coverage");

  const foreignProjectResponse = await api(foreign, "/long-form-projects", {
    method: "POST",
    body: jsonBody({
      title: `Foreign Continuity Regression ${runId.slice(0, 8)}`,
      script: "SHOT 1 — Foreign\nA foreign tenant test shot.",
      targetDurationSeconds: 5,
      shotDurationSeconds: 5,
      characterIds: [foreignStudio.characterId],
      settingId: foreignStudio.settingId,
      generationMode,
      width: 1280,
      height: 720,
      fps: 24,
      qualityPreset: "DRAFT",
    }),
  });
  assert.equal(foreignProjectResponse.status, 201, `Foreign project creation failed: ${errorText(foreignProjectResponse)}`);
  const foreignProject = projectBody(foreignProjectResponse);
  projectIds.push(foreignProject.id);

  const ownerProject = projectBody(await api(owner, `/long-form-projects/${project.id}`));
  assert.equal(ownerProject.id, project.id);
  assert.equal(ownerProject.continuity.enabled, true);
  assert.deepEqual(ownerProject.continuity.characters, initialContinuity.characters);
  assert.deepEqual(ownerProject.continuity.scenes, initialContinuity.scenes);
  const shots = ownerProject.shots;
  const firstShot = shots[0];
  const secondShot = shots[1];
  assert(firstShot && secondShot, "The project must return both continuity shots");
  assert.equal(stillOf(firstShot).status, "NONE");
  assert.equal(stillOf(firstShot).revision, 0);
  assert.equal(firstShot.continuity.voiceCloningEnabled, false);

  // A project/shot is tenant-scoped even when the ID is known.
  assert.equal((await api(foreign, `/long-form-projects/${project.id}`)).status, 404);
  assert.equal((await api(owner, `/long-form-projects/${foreignProject.id}`)).status, 404);
  assert.equal(
    (await api(owner, `/long-form-projects/${project.id}/shots/${foreignProject.shots[0].id}`)).status,
    404,
  );

  // Start must be blocked while no current still has an approval. This call
  // is intentionally made before uploading a still; no render route is used.
  const jobsBeforeNoStill = await generationJobCount(owner);
  const noStillStart = await api(owner, `/long-form-projects/${project.id}/start`, { method: "POST" });
  assertRejected(noStillStart, [409], "Start without an approved continuity still");
  await wait(300);
  assert.equal(await generationJobCount(owner), jobsBeforeNoStill, "No-still Start must create no GPU job");

  // The speaker must be in the shot's effective cast, not merely exist in the
  // same tenant. Clone activation additionally requires recorded consent.
  const nonCastSpeaker = await api(owner, `/long-form-projects/${project.id}/shots/${firstShot.id}`, {
    method: "PATCH",
    body: jsonBody({
      continuity: {
        speakerCharacterId: ownerStudio.nonCastCharacterId,
        voiceCloningEnabled: false,
      },
    }),
  });
  assertRejected(nonCastSpeaker, [409], "Speaker outside the shot cast");

  const cloneWithoutConsent = await api(owner, `/long-form-projects/${project.id}/shots/${firstShot.id}`, {
    method: "PATCH",
    body: jsonBody({
      continuity: {
        characterIds: [ownerStudio.characterId],
        speakerCharacterId: ownerStudio.characterId,
        voiceCloningEnabled: true,
      },
    }),
  });
  assertRejected(cloneWithoutConsent, [409], "Voice clone without consent");

  const validShotContinuity = await api(owner, `/long-form-projects/${project.id}/shots/${firstShot.id}`, {
    method: "PATCH",
    body: jsonBody({
      continuity: {
        characterIds: [ownerStudio.characterId],
        speakerCharacterId: ownerStudio.characterId,
        voiceCloningEnabled: false,
        emotionNotes: "Focused, quietly hopeful.",
        performanceNotes: "Hold eye contact with the signal tower.",
      },
    }),
  });
  assert.equal(validShotContinuity.status, 200, `Valid shot continuity failed: ${errorText(validShotContinuity)}`);
  assert.equal(shotBody(validShotContinuity).continuity.speakerCharacterId, ownerStudio.characterId);
  assert.equal(shotBody(validShotContinuity).continuity.voiceCloningEnabled, false);

  // Existing tenant assets are accepted, but a foreign tenant asset is not.
  const ownerAsset = await uploadImageAsset(owner, stillPng, `continuity-owner-${runId}.png`);
  const foreignAsset = await uploadImageAsset(foreign, stillPng, `continuity-foreign-${runId}.png`);
  const foreignAssetStill = await api(owner, `/long-form-projects/${project.id}/shots/${secondShot.id}/still`, {
    method: "POST",
    body: jsonBody({ assetId: foreignAsset.id }),
  });
  assertRejected(foreignAssetStill, [403, 404], "Foreign tenant still asset");

  const beforeAssetAttach = (await api(owner, `/long-form-projects/${project.id}`)).body.shots[0].still;
  assert.equal(beforeAssetAttach.status, "NONE");
  const attachedAssetShot = shotBody(await api(owner, `/long-form-projects/${project.id}/shots/${firstShot.id}/still`, {
    method: "POST",
    body: jsonBody({ assetId: ownerAsset.id }),
  }));
  const firstPendingStill = stillOf(attachedAssetShot);
  assert.equal(firstPendingStill.status, "PENDING");
  assert.equal(firstPendingStill.revision, beforeAssetAttach.revision + 1);
  assert(firstPendingStill.assetUrl);

  const approvedResponse = await reviewStill(
    owner,
    project.id,
    firstShot.id,
    "approve",
    firstPendingStill.revision,
    "Approved by the continuity regression fixture.",
  );
  assert.equal(approvedResponse.status, 200, `Still approval failed: ${errorText(approvedResponse)}`);
  const approvedShot = shotBody(approvedResponse);
  assert.equal(stillOf(approvedShot).status, "APPROVED");
  assert.equal(stillOf(approvedShot).revision, firstPendingStill.revision);
  assert(stillOf(approvedShot).approvedAt);

  // One approved shot is still insufficient for Start because shot two has no
  // approved still. This also proves the gate runs before dispatch.
  const jobsBeforePartialApproval = await generationJobCount(owner);
  const partialStart = await api(owner, `/long-form-projects/${project.id}/start`, { method: "POST" });
  assertRejected(partialStart, [409], "Start with only one approved still");
  await wait(300);
  assert.equal(await generationJobCount(owner), jobsBeforePartialApproval);

  // A replacement increments the revision and invalidates approval. A stale
  // review from the prior revision must not be able to approve it.
  const replacedShot = await uploadStill(
    owner,
    project.id,
    firstShot.id,
    replacementStillPng,
    `continuity-replacement-${runId}.png`,
  );
  const replacementStill = stillOf(replacedShot);
  assert.equal(replacementStill.status, "PENDING");
  assert(replacementStill.revision > firstPendingStill.revision);
  assert.equal(replacementStill.approvedAt, null);
  const staleReview = await reviewStill(owner, project.id, firstShot.id, "approve", firstPendingStill.revision);
  assertRejected(staleReview, [409], "Stale still revision review");

  const rejectedSecond = await uploadStill(
    owner,
    project.id,
    secondShot.id,
    stillPng,
    `continuity-second-${runId}.png`,
  );
  const rejectedSecondReview = await reviewStill(
    owner,
    project.id,
    secondShot.id,
    "reject",
    stillOf(rejectedSecond).revision,
    "The fixture intentionally rejects this review.",
  );
  assert.equal(rejectedSecondReview.status, 200, `Still rejection failed: ${errorText(rejectedSecondReview)}`);
  const rejectedShot = shotBody(rejectedSecondReview);
  assert.equal(stillOf(rejectedShot).status, "REJECTED");
  assert.equal(stillOf(rejectedShot).approvedAt, null);
  const clearedSecondResponse = await api(
    owner,
    `/long-form-projects/${project.id}/shots/${secondShot.id}/still`,
    { method: "DELETE" },
  );
  assert.equal(clearedSecondResponse.status, 200, `Still clear failed: ${errorText(clearedSecondResponse)}`);
  const clearedSecondShot = shotBody(clearedSecondResponse);
  assert.equal(stillOf(clearedSecondShot).status, "NONE");
  assert.equal(stillOf(clearedSecondShot).assetUrl, null);
  assert(stillOf(clearedSecondShot).revision > stillOf(rejectedShot).revision);

  // Prepare-revision regression: isolate one completed shot in a completed
  // project. Retrying it must pause the project, reset only that shot, retain
  // its sibling, and avoid dispatching a generation job.
  const siblingBeforePrepare = projectBody(await api(owner, `/long-form-projects/${project.id}`))
    .shots.find((shot) => shot.id === secondShot.id);
  await pool.query(
    `UPDATE obtv_long_form_shots
       SET status='COMPLETED',
           output_storage_key=$1,
           output_mime_type='video/mp4',
           completed_at=NOW(),
           generation_job_id=NULL
     WHERE id=$2 AND project_id=$3`,
    [`tenants/${owner.tenantId}/long-form/prepare-fixture.mp4`, firstShot.id, project.id],
  );
  await pool.query(
    `UPDATE obtv_long_form_projects
       SET status='COMPLETED', completed_shots=1, failed_shots=0, progress=100,
           final_output_storage_key=NULL, final_output_mime_type=NULL
     WHERE id=$1 AND tenant_id=$2`,
    [project.id, owner.tenantId],
  );
  const jobsBeforePrepareRevision = await generationJobCount(owner);
  const prepareRevision = await api(owner, `/long-form-projects/${project.id}/shots/${firstShot.id}/retry`, {
    method: "POST",
  });
  assert.equal(prepareRevision.status, 200, `Prepare revision failed: ${errorText(prepareRevision)}`);
  const preparedShot = shotBody(prepareRevision);
  assert.equal(preparedShot.status, "PLANNED");
  assert.equal(preparedShot.outputUrl, null);
  assert(preparedShot.retryCount >= 1);
  const preparedProject = projectBody(await api(owner, `/long-form-projects/${project.id}`));
  assert.equal(preparedProject.status, "PAUSED");
  const preparedSibling = preparedProject.shots.find((shot) => shot.id === secondShot.id);
  assert.deepEqual(
    { status: preparedSibling?.status, revision: preparedSibling?.still.revision },
    { status: siblingBeforePrepare?.status, revision: siblingBeforePrepare?.still.revision },
    "Prepare revision must retain the sibling shot",
  );
  assert.equal(
    await generationJobCount(owner),
    jobsBeforePrepareRevision,
    "Prepare revision must not dispatch a generation job",
  );

  // Deliberately over-subscribe mandatory wardrobe references. This exercises
  // the Start capacity gate before any missing-still or render dispatch path.
  const capacityAssignments = Array.from({ length: 50 }, () => ({
    characterId: ownerStudio.characterId,
    wardrobeId,
  }));
  const capacityContinuity = {
    ...replacementContinuity,
    characters: replacementContinuity.characters.map((character) => ({
      ...character,
      wardrobes: character.wardrobes.map((wardrobe) => ({
        ...wardrobe,
        referenceAssetId: ownerAsset.id,
      })),
    })),
    scenes: replacementContinuity.scenes.map((scene, index) => (
      index === 0 ? { ...scene, wardrobeAssignments: capacityAssignments } : scene
    )),
  };
  const capacityUpdate = await api(owner, `/long-form-projects/${project.id}/continuity`, {
    method: "PUT",
    body: jsonBody(capacityContinuity),
  });
  assert.equal(capacityUpdate.status, 200, `Capacity fixture continuity update failed: ${errorText(capacityUpdate)}`);
  const jobsBeforeCapacityGate = await generationJobCount(owner);
  const capacityStart = await api(owner, `/long-form-projects/${project.id}/start`, { method: "POST" });
  assertRejected(capacityStart, [409], "Mandatory wardrobe reference capacity gate");
  assert.match(errorText(capacityStart), /enough reference slots|reference image slots/i);
  await wait(250);
  assert.equal(await generationJobCount(owner), jobsBeforeCapacityGate);
  const restoreContinuity = await api(owner, `/long-form-projects/${project.id}/continuity`, {
    method: "PUT",
    body: jsonBody(replacementContinuity),
  });
  assert.equal(restoreContinuity.status, 200, `Capacity fixture restore failed: ${errorText(restoreContinuity)}`);

  const replacementProject = projectBody(await api(owner, `/long-form-projects/${project.id}/continuity`, {
    method: "PUT",
    body: jsonBody(replacementContinuity),
  }));
  assert.equal(replacementProject.continuity.scenes[0].settingNotes, replacementContinuity.scenes[0].settingNotes);
  assert.equal(replacementProject.continuity.scenes[0].emotionNotes, replacementContinuity.scenes[0].emotionNotes);
  const reloadedProject = projectBody(await api(owner, `/long-form-projects/${project.id}`));
  assert.deepEqual(reloadedProject.continuity, replacementContinuity);

  const expectedValues = {
    wardrobeName: `UI Raincoat ${runId.slice(0, 8)}`,
    sceneTitle: replacementContinuity.scenes[0].title,
    settingNotes: `UI persistence notes ${runId.slice(0, 8)}`,
  };
  await runContinuityUi(owner, reloadedProject, expectedValues, secondShot.id);

  assert.equal(await generationJobCount(owner), 0, "Continuity regression must leave the tenant without render jobs");
  console.log(
    "PASS: HTTPS tenant isolation, continuity persistence, still review/revision gates, cast/consent guards, Start blocking, prepare-revision pause/reset, wardrobe capacity blocking, and desktop/mobile UI",
  );
  }
} finally {
  await browser?.close();
  for (const account of fixtures) {
    try {
      for (const projectId of projectIds) {
        await api(account, `/long-form-projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
      }
      const assetsResponse = await api(account, "/image-studio/assets");
      const assets = assetsResponse.body?.assets ?? [];
      for (const asset of assets) {
        await api(account, `/image-studio/assets/${asset.id}`, { method: "DELETE" }).catch(() => undefined);
      }
      // A failed API cleanup must not strand isolated fixture rows. These
      // tenants are synthetic and cannot contain user data, so remove any
      // remaining fixture assets and their local media before deleting the
      // tenant itself.
      const remainingAssets = await pool.query(
        "SELECT storage_key FROM obtv_image_studio_assets WHERE tenant_id=$1",
        [account.tenantId],
      );
      for (const asset of remainingAssets.rows) {
        await rm(
          path.resolve(process.env.OBTV_MEDIA_ROOT ?? "data/obtv-media", asset.storage_key),
          { force: true },
        ).catch(() => undefined);
      }
      await pool.query("DELETE FROM obtv_image_studio_assets WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("UPDATE obtv_long_form_shots SET generation_job_id=NULL WHERE project_id IN (SELECT id FROM obtv_long_form_projects WHERE tenant_id=$1)", [account.tenantId]);
      await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_long_form_projects WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_character_assets WHERE character_id IN (SELECT id FROM obtv_characters WHERE tenant_id=$1)", [account.tenantId]);
      await pool.query("DELETE FROM obtv_setting_assets WHERE setting_id IN (SELECT id FROM obtv_settings WHERE tenant_id=$1)", [account.tenantId]);
      await pool.query("DELETE FROM obtv_characters WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_settings WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1", [account.tenantId]);
      await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id=$1", [account.userId]);
      await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [account.tenantId]);
      await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [account.userId]);
      await pool.query("DELETE FROM obtv_users WHERE id=$1", [account.userId]);
    } catch (error) {
      console.error(
        `Fixture cleanup failed for isolated continuity run ${runId} (${account.label}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  await pool.end();
}