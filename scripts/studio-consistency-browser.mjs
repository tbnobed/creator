// All APIs mocked: verifies route terminology, shell containment, shared confirm/error UI and
// the library-location model flow on desktop and mobile. No GPU or paid provider is reached.
import { chromium, expect } from "@playwright/test";

const BASE = process.env.APP_TEST_URL ?? "http://127.0.0.1";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=";
const now = new Date().toISOString();
const LOCAL = "local-flux2-klein-4b", PAID = "cloud-nano-banana-pro";
const model = (id, provider) => ({
  id, name: provider === "LOCAL" ? "FLUX.2 Klein" : "Nano Banana Pro", provider, description: "", operations: ["generate", "edit"],
  aspectRatios: ["16:9"], maxImages: 4, supportsSeed: true, supportsNegativePrompt: false, maxReferences: 4,
  priceNote: provider === "LOCAL" ? "free" : "$0.15 per image", available: true,
});
const setting = {
  id: "loc-1", name: "Gull Point Lantern Room", description: "Lighthouse top", promptDescription: "Brass lantern room", thumbnail: image,
  tags: ["interior"], assetCount: 2, createdAt: now, updatedAt: now,
  references: [
    { id: "ref-1", name: "Base", url: image, prompt: "base", imageAssetId: "asset-1" },
    { id: "ref-2", name: "Night", url: image, prompt: "night", imageAssetId: "asset-2" },
  ],
};
const production = { id: "prod-1", title: "Harbor Light", renderProjectId: "rp-1", state: {}, revision: 1, createdAt: now, updatedAt: now };
const renderProject = (id, title) => ({ id, title, status: "RUNNING", script: "", shots: [], finalOutputUrl: null, createdAt: now, updatedAt: now, totalShots: 0, completedShots: 0 });

async function run(viewport, label) {
  const context = await browser.newContext({ serviceWorkers: "block", viewport });
  const calls = { deleteProduction: 0, productionDeleted: false, rename: [], imageJobs: [], deleteSetting: 0, legacy: 0, unknown: new Set() };
  await context.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    let data;
    if (path === "/api/session") data = { user: { id: "u1", name: "Rhea Okafor", email: "rhea@obtv.test", siteRole: "SITE_ADMIN" }, tenant: { id: "t1", name: "Harbor Unit", role: "OWNER" } };
    else if (path === "/api/healthz") data = { status: "ok" };
    else if (path === "/api/image-studio/models") data = { models: [model(LOCAL, "LOCAL"), model(PAID, "CLOUD")] };
    else if (path === "/api/image-studio/jobs" && method === "GET") data = { jobs: [{ id: "ij-1", status: "RUNNING", prompt: "Harbor at dusk", modelName: "FLUX.2 Klein", provider: "LOCAL", count: 1, assets: [], createdAt: now, errorMessage: null }] };
    else if (path.startsWith("/api/image-studio/jobs/")) data = { job: { id: "ij-loc", status: "QUEUED", assets: [], errorMessage: null } };
    else if (path === "/api/settings" && method === "GET") data = [setting];
    else if (path === "/api/settings/loc-1" && method === "DELETE") { calls.deleteSetting++; data = {}; }
    else if (path === "/api/settings/loc-1" && method === "PATCH") data = setting;
    else if (path === "/api/settings/loc-1/image-jobs") { calls.imageJobs.push(req.postDataJSON()); return route.fulfill({ status: 202, json: { id: "ij-loc", status: "QUEUED", assets: [], errorMessage: null } }); }
    else if (path.endsWith("/generate-image")) { calls.legacy++; data = {}; }
    else if (path === "/api/settings/loc-1/references/ref-2" && method === "PATCH") { calls.rename.push(req.postDataJSON()); return route.fulfill({ status: 204 }); }
    else if (path === "/api/settings/loc-1/references/ref-2" && method === "DELETE") return route.fulfill({ status: 409, json: { error: "This location is used by a production. Detach it there first." } });
    else if (path === "/api/video-cleanup/jobs" || path === "/api/garment-studio/jobs") data = [];
    else if (path === "/api/characters") data = url.searchParams.get("fail") ? [] : [];
    else if (path === "/api/production-projects/prod-1" && method === "DELETE") { calls.deleteProduction++; if (calls.deleteProduction === 1) return route.fulfill({ status: 409, json: { error: "Cancel the queued or running work in this production first." } }); calls.productionDeleted = true; return route.fulfill({ status: 204 }); }
    else if (path === "/api/production-projects") data = calls.productionDeleted ? [] : [{ ...production, state: { step: 1 } }];
    else if (false) data = [{ ...production, state: { step: 1 } }];
    else if (path === "/api/long-form-projects") data = [renderProject("rp-1", "Harbor Light render"), renderProject("rp-2", "Standalone teaser")];
    else if (path === "/api/generations") data = { items: [], totalItems: 0, page: 1, pageSize: 24, totalPages: 0 };
    else if (path === "/api/spending") data = { periodStart: now, periodEnd: now, currency: "USD", scope: { tenantId: "t1", userId: null }, totals: { reservedUSD: 0, estimatedUSD: 1.87, actualUSD: 0, totalUSD: 1.87 }, rows: [], pendingInvitations: [], permissions: { canViewAllTenants: true } };
    else if (path === "/api/spending/entries") data = { items: [], entries: [], totalItems: 0, total: 0, page: 1, pageSize: 25, totalPages: 0 };
    else if (path === "/api/dashboard/summary") data = { onlineServerCount: 1, activeGenerationCount: 0, characterCount: 0, settingCount: 1, completedGenerationCount: 3 };
    else { calls.unknown.add(`${method} ${path}`); data = []; }
    await route.fulfill({ json: data });
  });
  const page = await context.newPage();
  // Browser-native dialogs are a regression: all confirmations use the shared dialog.
  page.on("dialog", d => { throw new Error(`${label}: native dialog "${d.message()}"`); });
  const go = p => page.goto(`${BASE}${p}`);

  const titles = { "/studio": "Generate Video", "/image-studio": "Image Studio", "/projects": "Long-Form", "/characters": "Characters", "/settings": "Locations & Scenery", "/generations": "Queue & History" };
  for (const [p, t] of Object.entries(titles)) {
    await go(p);
    await expect(page).toHaveTitle(new RegExp(`^${t.replace("&", "&")}`), { timeout: 15000 });
  }

  // Long-Form stays the active section inside a production.
  await go("/productions/prod-1");
  await expect(page).toHaveTitle(/^Long-Form/);

  // Unknown URLs render inside the shell with navigation.
  await go("/definitely-missing");
  await expect(page.getByTestId("page-not-found")).toBeVisible();
  await expect(page.getByTestId("link-notfound-queue")).toBeVisible();

  if (viewport.width < 768) {
    await expect(page.getByRole("button", { name: "Open studio menu" })).toBeVisible();
    await page.getByTestId("button-mobile-more").click();
    await expect(page.getByRole("button", { name: "Close studio menu" })).toBeVisible();
    await page.getByTestId("button-mobile-menu-close").click();
  } else {
    await expect(page.getByTestId("status-api")).toHaveText("API reachable");
  }

  // Long-Form lists a linked render project once, on its production.
  await go("/projects");
  await expect(page.getByTestId("card-production-prod-1")).toBeVisible();
  await expect(page.getByTestId("link-production-timeline-prod-1")).toHaveAttribute("href", /\/projects\/rp-1$/);
  await expect(page.getByText("Harbor Light render")).toHaveCount(0);
  await expect(page.getByText("Standalone teaser")).toBeVisible();

  // Guided production delete: shared confirm lists consequences; cancel sends nothing, 409 keeps the card, success removes it.
  await page.getByTestId("button-delete-production-prod-1").click();
  await expect(page.getByTestId("dialog-confirm")).toContainText("Shared characters and scenery in your library are kept");
  await expect(page.getByTestId("dialog-confirm")).toContainText("linked render project");
  await expect(page.getByTestId("dialog-confirm")).toContainText("must be cancelled first");
  await page.getByTestId("button-confirm-cancel").click();
  await expect(page.getByTestId("dialog-confirm")).toHaveCount(0);
  expect(calls.deleteProduction).toBe(0);
  await page.getByTestId("button-delete-production-prod-1").click();
  await page.getByTestId("button-confirm-accept").click();
  await expect(page.getByText("Cancel the queued or running work").first()).toBeVisible();
  await expect(page.getByTestId("card-production-prod-1")).toBeVisible();
  await expect(page.getByTestId("dialog-confirm")).toHaveCount(0);
  await page.getByTestId("button-delete-production-prod-1").click();
  await page.getByTestId("button-confirm-accept").click();
  await expect(page.getByTestId("card-production-prod-1")).toHaveCount(0);
  expect(calls.deleteProduction).toBe(2);
  calls.productionDeleted = false;

  // Queue & History links every job type without inventing global totals.
  await go("/generations");
  await page.getByTestId("tab-tool-image").click();
  await expect(page).toHaveURL(/tool=image/);
  await expect(page.getByTestId("list-image-jobs-row-ij-1")).toBeVisible();
  await page.getByTestId("tab-tool-replacement").click();
  await expect(page.getByTestId("list-replacement-jobs-empty")).toBeVisible();
  await page.getByTestId("tab-tool-longform").click();
  await expect(page.getByTestId("list-productions-row-prod-1")).toBeVisible();
  await page.getByTestId("tab-tool-cleanup").click();
  await expect(page.getByTestId("link-open-tool")).toHaveAttribute("href", "/video-cleanup");

  // Spending states estimated-cost and workspace/system boundaries.
  await go("/spending");
  await expect(page.getByTestId("text-spending-boundaries")).toContainText("Estimated, not billed");

  // Admin shows only verified health.
  await go("/admin");
  await expect(page.getByTestId("status-storage")).toHaveText("Not verified");
  await expect(page.getByText("v0.1.0-beta")).toHaveCount(0);

  // Locations: shared confirm on delete (cancel keeps it).
  await go("/settings");
  await page.getByRole("button", { name: "Delete Gull Point Lantern Room" }).click();
  await expect(page.getByTestId("dialog-confirm")).toBeVisible();
  await page.getByTestId("button-confirm-cancel").click();
  expect(calls.deleteSetting).toBe(0);

  // Library references: rename and a blocked delete surface shared feedback.
  await page.getByTestId("details-references-loc-1").locator("summary").click();
  await page.getByTestId("button-rename-reference-ref-2").click();
  await page.getByTestId("input-rename-reference-ref-2").fill("Night storm");
  await page.getByTestId("button-save-reference-ref-2").click();
  await expect.poll(() => calls.rename.length).toBe(1);
  expect(calls.rename[0]).toEqual({ name: "Night storm" });
  await page.getByTestId("button-delete-reference-ref-2").click();
  await page.getByTestId("button-confirm-accept").click();
  await expect(page.getByTestId("status-reference-error")).toContainText("used by a production");

  // Location variant: paid model gated by explicit confirmation, async job queued.
  await page.getByRole("button", { name: "Edit Gull Point Lantern Room" }).click();
  await page.getByTestId("tab-location-variant").click();
  await page.getByTestId("chip-location-variant-storm").click();
  await page.getByTestId("input-location-image-prompt").fill("Same room in a storm");
  const generate = page.getByTestId("button-generate-location-image");
  await expect(page.getByTestId("select-model-variants")).toContainText("FLUX.2 Klein");
  await page.getByTestId("select-model-variants").click();
  await page.getByTestId(`option-model-variants-${PAID}`).click();
  await expect(generate).toBeDisabled();
  await page.getByTestId("checkbox-paid-variants").click();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByTestId("status-location-job")).toBeVisible();
  expect(calls.imageJobs).toHaveLength(1);
  const body = calls.imageJobs[0];
  expect(body).toMatchObject({ modelId: PAID, cloudConfirmed: true, operation: "edit", referenceAssetIds: ["asset-1"], referenceName: "Storm", count: 1 });
  expect(typeof body.requestKey).toBe("string");
  expect(calls.legacy).toBe(0);
  // Paid confirmation resets after each submission.
  await expect(page.getByTestId("checkbox-paid-variants")).not.toBeChecked();

  await context.close();
  console.log(`${label}: ok${calls.unknown.size ? ` (unmocked defaults: ${[...calls.unknown].join(", ")})` : ""}`);
}

try {
  await run({ width: 1440, height: 900 }, "desktop");
  await run({ width: 390, height: 844 }, "mobile");
} finally {
  await browser.close();
}
