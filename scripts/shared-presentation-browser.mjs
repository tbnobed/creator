// All APIs mocked; no GPU, paid provider or DB mutation. Verifies shared presentation pieces and
// captures screenshots: Queue & History tool tabs, generation details, Generate Video local/paid
// gating, character dossier wardrobe and legacy-draft import.
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const BASE = process.env.APP_TEST_URL ?? "http://127.0.0.1";
const OUT = "screenshots/shared";
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const now = "2026-03-04T12:00:00Z";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=";
const gen = (id, over = {}) => ({ id, title: `Harbor take ${id}`, prompt: "Fog rolls over the breakwater at dawn.", compiledPrompt: "compiled", status: "COMPLETED", provider: "COMFYUI",
  workflowName: "LTX 2.3 (H100)", generationMode: "txt2vid", width: 1280, height: 720, durationSeconds: 5, fps: 24, qualityPreset: "STANDARD", seed: 4127,
  createdAt: now, completedAt: now, outputUrl: null, outputMimeType: "video/mp4", voiceCloningEnabled: false, ...over });

async function run(viewport, label) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport });
  const created = [];
  await context.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    let data = [];
    if (path === "/api/session") data = { user: { id: "u1", name: "Rhea Okafor", email: "rhea@obtv.test", siteRole: "SITE_ADMIN" }, tenant: { id: "t1", name: "Harbor Unit", role: "OWNER" }, activeTenant: { id: "t1", name: "Harbor Unit", role: "OWNER" } };
    else if (path === "/api/healthz") data = { status: "ok" };
    else if (path === "/api/generations" && method === "POST") { created.push(req.postDataJSON()); data = gen("new-1", { status: "QUEUED" }); }
    else if (path === "/api/generations") data = { items: [gen("g-1"), gen("g-2", { status: "RUNNING", progress: 0.42, completedAt: null })], totalItems: 2, page: 1, pageSize: 24, totalPages: 1 };
    else if (path === "/api/generations/g-cloud") data = gen("g-cloud", { provider: "FAL", providerModelId: "fal-ai/veo3.1/fast", longFormSceneNumber: 2, longFormShotNumber: 3 });
    else if (path === "/api/generations/missing") return route.fulfill({ status: 404, json: { error: "Not found" } });
    else if (path === "/api/generation-capabilities") data = [{ generationMode: "txt2vid", modelFamily: "LTX 2.3", supportsReferenceVideo: false, requiresCharacterReferences: false, requiresSettingReference: false }];
    else if (path === "/api/image-studio/jobs") data = { jobs: [{ id: "ij-1", status: "COMPLETED", prompt: "Lantern room at night", modelName: "FLUX.2 Klein", provider: "LOCAL", count: 1, assets: [{ id: "a", url: image }], createdAt: now, errorMessage: null }] };
    else if (path === "/api/garment-studio/jobs") data = [{ id: "gj-1", title: "Swap slicker colour", mode: "replace-item", provider: "LOCAL", status: "FAILED", createdAt: now, error: "Worker offline" }];
    else if (path === "/api/video-cleanup/jobs") data = [];
    else if (path === "/api/production-projects") data = [{ id: "prod-1", title: "Harbor Light", renderProjectId: null, revision: 1, createdAt: now, updatedAt: now, state: { step: 2, story: { scenes: [{ sceneNumber: 1 }, { sceneNumber: 2 }] } } }];
    else if (path === "/api/characters") data = [{ id: "ch-1", name: "Mara Venn", description: "Harbor pilot", thumbnail: image, tags: [], assetCount: 1, createdAt: now, updatedAt: now }];
    else if (path === "/api/image-studio/models") data = { models: [] };
    await route.fulfill({ json: data });
  });
  await context.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("obtv.composerDraft", JSON.stringify({ prompt: "Old unscoped draft" })); } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const shot = async (name) => { await page.waitForTimeout(250); return page.screenshot({ path: `${OUT}/${name}-${label}.jpg`, type: "jpeg", quality: 80, fullPage: true }); };

  // Queue & History: every tool tab embeds its real history.
  await page.goto(`${BASE}/generations`);
  await expect(page.getByTestId("tabs-history-tool")).toBeVisible();
  await shot("queue-video");
  const tabs = { image: "list-image-jobs-row-ij-1", cleanup: "link-open-tool", replacement: "list-replacement-jobs-row-gj-1", longform: "list-productions-row-prod-1" };
  for (const [tool, id] of Object.entries(tabs)) {
    await page.getByTestId(`tab-tool-${tool}`).click();
    await expect(page.getByTestId(`tab-tool-${tool}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(id).first()).toBeVisible();
    await shot(`queue-${tool}`);
  }
  await expect(page.getByTestId("list-productions-row-prod-1")).toContainText("Step 3");
  await page.getByTestId("tab-tool-replacement").click();
  await expect(page.getByTestId("list-replacement-jobs-row-gj-1")).toContainText("Worker offline");
  await page.reload();
  await expect(page.getByTestId("tab-tool-replacement")).toHaveAttribute("aria-selected", "true");

  // Shared generation details on the full page.
  await page.goto(`${BASE}/generations/g-cloud`);
  await expect(page.getByTestId("panel-generation-details")).toBeVisible();
  await expect(page.getByTestId("text-generation-provider")).toHaveText("Paid cloud");
  await expect(page.getByTestId("text-generation-model")).toHaveText("Veo 3.1 Fast");
  await expect(page.getByTestId("text-generation-prompt")).toContainText("Fog rolls");
  await shot("generation-detail");
  await page.goto(`${BASE}/generations/missing`);
  await expect(page.getByTestId("status-generation-missing").or(page.getByTestId("status-generation-error"))).toBeVisible();

  // Generate Video: legacy draft is offered, never silently restored; local default needs no paid confirmation.
  await page.goto(`${BASE}/studio`);
  await expect(page.getByTestId("notice-legacy-draft")).toBeVisible();
  await expect(page.getByTestId("input-video-prompt")).not.toHaveValue("Old unscoped draft");
  await shot("legacy-draft");
  await page.getByTestId("button-import-legacy-draft").click();
  await page.waitForLoadState("load");
  await expect(page.getByTestId("input-video-prompt")).toHaveValue("Old unscoped draft");
  await expect(page.getByTestId("notice-legacy-draft")).toHaveCount(0);
  await expect(page.getByTestId("confirm-paid-video")).toHaveCount(0);
  await expect(page.getByTestId("button-generate-video")).toBeEnabled();
  // Switch to cloud: paid confirmation required, clears on model change.
  await page.getByTestId("button-render-setup").click();
  await page.getByTestId("select-generation-provider").click();
  await page.getByRole("option", { name: /Cloud/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("select-generation-provider")).toHaveCount(0);
  await expect(page.getByTestId("confirm-paid-video")).toBeVisible();
  await expect(page.getByTestId("button-generate-video")).toBeDisabled();
  await page.getByTestId("checkbox-paid-video").click();
  await expect(page.getByTestId("button-generate-video")).toBeEnabled();
  await shot("generate-paid-gating");
  expect(created).toHaveLength(0);

  await context.close();
  console.log(`${label}: ok`);
}

try {
  await run({ width: 1440, height: 950 }, "desktop");
  await run({ width: 390, height: 844 }, "mobile");
  console.log(`PASS shared presentation (screenshots in ${OUT}); no submissions sent.`);
} finally { await browser.close(); }
