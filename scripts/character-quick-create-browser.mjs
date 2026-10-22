// Mock all APIs: verifies the server-owned character look flow without any GPU or paid provider.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=";
const LOCAL = "local-flux2-klein-4b", PAID = "cloud-nano-banana-pro";
const model = (id, provider) => ({
  id, name: provider === "LOCAL" ? "FLUX.2 Klein" : "Nano Banana Pro", provider, description: "", operations: ["generate", "edit"],
  aspectRatios: ["3:4"], maxImages: 4, supportsSeed: provider === "LOCAL", supportsNegativePrompt: false, maxReferences: 4,
  priceNote: provider === "LOCAL" ? "free" : "$0.15 per image", available: true,
});
const views = ["front", "three-quarter", "profile", "expressions"];
const batch = (kind, modelId, status, slotStatus) => ({
  id: `${kind.toLowerCase()}-batch`, kind, status, modelId, modelName: modelId, provider: modelId === LOCAL ? "LOCAL" : "CLOUD",
  prompt: "A weathered harbor pilot in a navy coat", selectedAssetId: null, createdAt: new Date().toISOString(),
  slots: [0, 1, 2, 3].map(i => ({
    index: i, view: kind === "SHEET" ? views[i] : null, status: slotStatus,
    assetId: slotStatus === "READY" ? `${kind}-asset-${i}` : null, mediaUrl: slotStatus === "READY" ? image : null, error: null,
  })),
});

async function run(viewport, label) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport });
  let character = null, looks = { portraits: null, sheet: null }, creates = 0;
  const calls = { start: [], keep: [], legacy: 0 };
  await context.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    let data = [];
    if (path === "/api/session") data = { user: { id: "test", name: "Test", siteRole: "SITE_ADMIN" }, tenant: { id: "test", name: "Test" } };
    else if (path === "/api/image-studio/models") data = { models: [model(LOCAL, "LOCAL"), model(PAID, "CLOUD")] };
    else if (path === "/api/characters" && method === "POST") {
      creates++;
      character = { ...req.postDataJSON(), id: "character-test", thumbnail: null, assetCount: 0, dossierStatus: "DRAFT", dossierRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data = character;
    } else if (path === "/api/characters") data = character ? [character] : [];
    else if (path.endsWith("/generate-image")) calls.legacy++;
    else if (path === "/api/characters/character-test/looks" && method === "POST") {
      calls.start.push(req.postDataJSON());
      looks = { portraits: batch("PORTRAITS", req.postDataJSON().modelId, "ACTIVE", "RUNNING"), sheet: null };
      return route.fulfill({ status: 202, json: looks });
    } else if (path === "/api/characters/character-test/looks") data = looks;
    else if (path.endsWith("/keep")) {
      const body = req.postDataJSON();
      calls.keep.push(body);
      looks = { portraits: { ...looks.portraits, selectedAssetId: body.assetId }, sheet: batch("SHEET", body.modelId, "ACTIVE", "RUNNING") };
      character.thumbnail = image;
      return route.fulfill({ status: 202, json: looks });
    } else if (path.endsWith("/dossier")) data = { characterId: "character-test", revision: 0, status: "DRAFT", role: "", performanceNotes: "", wardrobes: [], assets: [], imageGeneration: null };
    await route.fulfill({ json: data });
  });
  const page = await context.newPage();
  await page.goto(`${process.env.APP_TEST_URL ?? "http://127.0.0.1"}/characters`);
  await page.getByTestId("button-new-character").click();
  const generate = page.getByTestId("button-generate-character");
  await expect(generate).toBeDisabled();
  await page.getByTestId("input-new-character-prompt").fill("A weathered harbor pilot in a navy coat");
  await expect(page.getByTestId("select-model-characters")).toContainText("FLUX.2 Klein");
  await expect(generate).toBeEnabled();

  // Paid gating: choosing a paid model blocks submission until this batch is confirmed.
  await page.getByTestId("select-model-characters").click();
  await page.getByTestId(`option-model-characters-${PAID}`).click();
  await expect(page.getByTestId("confirm-paid-characters")).toBeVisible();
  await expect(generate).toBeDisabled();
  await page.getByTestId("checkbox-paid-characters").click();
  await expect(generate).toBeEnabled();
  // Switch back to local and generate four looks.
  await page.getByTestId("select-model-characters").click();
  await page.getByTestId(`option-model-characters-${LOCAL}`).click();
  await expect(page.getByTestId("confirm-paid-characters")).toHaveCount(0);
  await generate.click();
  await expect(generate).toContainText("Generating four looks");
  expect(creates).toBe(1);
  expect(calls.start).toHaveLength(1);
  expect(calls.start[0]).toMatchObject({ modelId: LOCAL, cloudConfirmed: false, prompt: "A weathered harbor pilot in a navy coat" });
  expect(calls.start[0].requestKey).toMatch(/^[0-9a-f-]{36}$/);

  // Server finishes while the dialog is closed; reopening shows all four from the server.
  await page.getByTestId("button-close-new-character").click();
  looks = { portraits: batch("PORTRAITS", LOCAL, "COMPLETED", "READY"), sheet: null };
  await page.reload();
  await page.getByTestId("button-edit-character-character-test").click();
  for (const i of [0, 1, 2, 3]) await expect(page.getByTestId(`option-portrait-${i}`)).toBeVisible();
  await expect(page.getByTestId("input-new-character-prompt")).toHaveValue("A weathered harbor pilot in a navy coat");

  // Keep this look with a paid sheet model: requires its own confirmation.
  const keep = page.getByTestId("button-keep-look");
  await expect(keep).toBeDisabled();
  await page.getByTestId("option-portrait-2").click();
  await expect(keep).toBeEnabled();
  await page.getByTestId("select-model-referenceSheet").click();
  await page.getByTestId(`option-model-referenceSheet-${PAID}`).click();
  await expect(keep).toBeDisabled();
  await page.getByTestId("checkbox-paid-referenceSheet").click();
  await keep.click();
  await expect(page.getByTestId("reference-sheet")).toBeVisible();
  expect(calls.keep).toHaveLength(1);
  expect(calls.keep[0]).toMatchObject({ assetId: "PORTRAITS-asset-2", modelId: PAID, cloudConfirmed: true });
  // Confirmation resets after the batch.
  await expect(page.getByTestId("checkbox-paid-referenceSheet")).toHaveAttribute("data-state", "unchecked");

  // Close, server completes the sheet, reopen: kept look selected and completed references visible.
  await page.getByTestId("button-close-new-character").click();
  looks = { portraits: looks.portraits, sheet: batch("SHEET", PAID, "COMPLETED", "READY") };
  await page.reload();
  await page.getByTestId("button-edit-character-character-test").click();
  await expect(page.getByTestId("option-portrait-2")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("option-portrait-2")).toContainText("Kept");
  await expect(page.getByTestId("reference-sheet").locator("img")).toHaveCount(4);
  await expect(page.getByTestId("button-keep-look")).toBeDisabled();
  // Wait for the open animation to settle before checking it fits the viewport.
  await expect.poll(async () => {
    const box = await page.getByTestId("dialog-new-character").boundingBox();
    return box.x >= -0.5 && box.x + box.width <= viewport.width + 0.5;
  }).toBe(true);
  expect(calls.legacy).toBe(0);
  await page.screenshot({ path: `screenshots/shared/character-looks-${label}.jpg`, type: "jpeg", quality: 80 });
  await context.close();
}

try {
  await run({ width: 1366, height: 900 }, "desktop");
  await run({ width: 390, height: 844 }, "mobile");
  console.log("PASS desktop+mobile: local default, paid gating per batch, four looks, close/reopen from server, keep (paid confirmed), sheet survives close, no legacy endpoint, no real jobs.");
} finally { await browser.close(); }
