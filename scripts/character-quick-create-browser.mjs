// Mock all APIs: verifies UI contracts without using a GPU or paid provider.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=";
  let character, generation = null, creates = 0, attempts = 0;
  const bodies = [];
  await context.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let data = [];
    if (path === "/api/session") data = { user: { id: "test", name: "Test", siteRole: "SITE_ADMIN" }, tenant: { id: "test", name: "Test" } };
    if (path === "/api/characters" && req.method() === "POST") {
      creates++;
      character = { ...req.postDataJSON(), id: "character-test", dossierStatus: "DRAFT", dossierRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data = character;
    } else if (path === "/api/characters") data = character ? [character] : [];
    if (path.endsWith("/generate-image")) {
      attempts++;
      bodies.push(req.postDataJSON());
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: "No local GPU available" } });
      generation = { id: `job-${attempts}`, status: "QUEUED", modelId: "local-flux2-klein-4b", provider: "LOCAL" };
      return route.fulfill({ status: 202, json: generation });
    }
    if (path.endsWith("/dossier")) data = {
      characterId: "character-test", revision: 0, status: "DRAFT", role: "", performanceNotes: "",
      wardrobes: [], assets: [], imageGeneration: generation,
    };
    await route.fulfill({ json: data });
  });
  const page = await context.newPage();
  const base = process.env.APP_TEST_URL ?? "http://127.0.0.1";
  await page.goto(`${base}/characters`);
  await page.getByTestId("button-new-character").click();
  const button = page.getByTestId("button-generate-character");
  await expect(button).toBeDisabled();
  await page.getByTestId("input-new-character-prompt").fill("A weathered harbor pilot in a navy coat");
  await button.click();
  await expect(page.getByTestId("status-new-character-error")).toContainText("No local GPU available");
  await expect(page.getByTestId("input-new-character-prompt")).toHaveValue("A weathered harbor pilot in a navy coat");
  await button.click();
  await expect(page.getByTestId("status-new-character-stage")).toHaveText("Queued");
  await expect(button).toBeDisabled();
  expect(creates).toBe(1);
  expect(bodies[0].requestKey).toBe(bodies[1].requestKey);
  generation = { ...generation, status: "FAILED", errorMessage: "Test worker failure" };
  await expect(page.getByTestId("status-new-character-failed")).toContainText("Test worker failure", { timeout: 10000 });
  await page.getByTestId("button-retry-new-character").click();
  await expect(page.getByTestId("status-new-character-stage")).toHaveText("Queued");
  expect(creates).toBe(1);
  expect(bodies[2].requestKey).not.toBe(bodies[1].requestKey);
  generation = { ...generation, status: "RUNNING", progressStage: "rendering", progress: 0.4, progressStep: 8, progressTotalSteps: 20 };
  await expect(page.getByTestId("text-new-character-progress")).toContainText("40%", { timeout: 10000 });
  generation = { ...generation, status: "COMPLETED", mediaUrl: image, assetId: "asset-test" };
  character.thumbnail = image;
  await expect(page.getByTestId("img-new-character-output")).toHaveAttribute("src", image, { timeout: 10000 });
  for (const body of bodies) {
    expect(body.modelId).toBe("local-flux2-klein-4b");
    expect(body.allowNewIdentity).toBe(true);
    expect(body.referenceAssetId).toBeUndefined();
  }
  await page.getByTestId("button-close-new-character").click();
  await expect(page.getByText(character.name, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(character.name, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("button-new-character").click();
  await expect(button).toBeVisible();
  await expect.poll(async () => {
    const bounds = await page.getByTestId("dialog-new-character").boundingBox();
    return bounds.x >= -0.5 && bounds.width <= 390;
  }).toBe(true);
  await page.screenshot({ path: "/tmp/character-quick-mobile.png" });
  console.log("PASS: prompt-only create, local-only model, failed submission retry, failed job retry, one character, progress, saved output, reload, mobile.");
} finally { await browser.close(); }
