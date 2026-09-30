// Browser-only regression: every API request is mocked, including authentication.
// No accounts, sessions, media, provider jobs or database rows are created.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.TOPAZ_UI_TEST_ORIGIN || "http://127.0.0.1";
const localId = "11111111-1111-4111-8111-111111111111";
const cloudId = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const job = (id, provider) => ({
  id, title: provider === "COMFYUI" ? "Local GPU landscape" : "Cloud landscape", status: "COMPLETED",
  provider, providerModelId: provider === "FAL" ? "fal-ai/veo3.1/fast" : null,
  providerTaskMetadata: {}, providerRequestId: null, voiceCloningEnabled: false,
  prompt: "Landscape video", compiledPrompt: "Landscape video", dialogue: "",
  generationMode: "TEXT_TO_VIDEO", qualityPreset: "STANDARD", width: 1280, height: 720,
  fps: 24, durationSeconds: 8, requestedWidth: 1280, requestedHeight: 720, seed: null,
  progress: 1, currentNode: null, serverName: provider === "COMFYUI" ? "Local worker" : null,
  workflowName: provider === "COMFYUI" ? "Local GPU workflow" : null,
  longFormProjectId: null, longFormShotId: null, longFormSceneNumber: null, longFormShotNumber: null,
  outputUrl: `/api/media/mock-${id}.mp4`, outputMimeType: "video/mp4", errorMessage: null,
  createdAt: "2026-09-30T12:00:00Z", queuedAt: null, completedAt: "2026-09-30T12:00:08Z",
});
const jobs = new Map([[localId, job(localId, "COMFYUI")], [cloudId, job(cloudId, "FAL")]]);
let quoteError = false;
let raceQuotes = false;
let submitMode = "error";
const confirmations = [];
const pageErrors = [];
const unexpectedApi = [];
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(origin).origin) { await route.abort(); return; }
  if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
  const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname === "/api/session") {
    return reply({ user: { id: "browser-mock-user", email: "mock@example.invalid", displayName: "Browser test", siteRole: "USER" },
      activeTenant: { id: "mock-tenant", name: "Mock workspace", slug: "mock", role: "OWNER" } });
  }
  if (url.pathname === "/api/healthz") return reply({ status: "ok" });
  if (url.pathname.startsWith("/api/media/")) return route.fulfill({ status: 204, body: "" });
  if (url.pathname === "/api/generations") return reply({ items: [...jobs.values()], page: 1, pageSize: 24, totalItems: jobs.size, totalPages: 1 });
  if (url.pathname === "/api/video-library") return reply({ items: [] });
  const generation = /^\/api\/generations\/([^/]+)(.*)$/.exec(url.pathname);
  if (generation) {
    const [, id, action] = generation;
    if (!action && route.request().method() === "GET") return reply(jobs.get(id));
    if (action === "/upscale/quote") {
      const body = route.request().postDataJSON();
      if (quoteError) return reply({ error: "Topaz requires the Cloud FAL_KEY configuration, including for local GPU videos." }, 503);
      const is4k = body.targetResolution === "4k";
      if (raceQuotes) await new Promise((resolve) => setTimeout(resolve, is4k ? 20 : 250));
      await reply({
        sourceId: id, sourceWidth: 1280, sourceHeight: 720, targetWidth: is4k ? 3840 : 1920,
        targetHeight: is4k ? 2160 : 1080, durationSeconds: 8, fps: 24, hasAudio: true,
        targetResolution: body.targetResolution, estimatedUsd: is4k ? 0.64 : 0.16,
        pricingNote: "Local Topaz Proteus estimate. Not a provider invoice.", quoteToken: (is4k ? "b" : "a").repeat(64),
      }).catch(() => {}); // A superseded quote may have been aborted by the UI.
      return;
    }
    if (action === "/upscale") {
      confirmations.push({ id, body: route.request().postDataJSON() });
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (submitMode === "error") return reply({ error: "Simulated transport error; acceptance unknown." }, 503);
      const child = { ...job(childId, "FAL"), title: "Topaz 4K — upscaled from 1280×720", status: "QUEUED",
        providerModelId: "fal-ai/topaz/upscale/video", outputUrl: null, progress: 0,
        currentNode: "Waiting for Topaz", width: 3840, height: 2160,
        providerTaskMetadata: { operation: "topaz-upscale", topaz: { sourceId: id, sourceWidth: 1280, sourceHeight: 720 } } };
      jobs.set(childId, child);
      return reply(child);
    }
  }
  unexpectedApi.push(`${route.request().method()} ${url.pathname}`);
  return reply({ error: "Blocked unexpected API request in browser test" }, 501);
});

try {
  // Completed local output: free quote, explicit paid confirmation, no automatic submission.
  await page.goto(`${origin}/generations/${localId}`);
  await page.getByTestId("button-topaz-upscale").click();
  const dialog = page.getByTestId("dialog-topaz-upscale");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("topaz-quote")).toContainText("1920 × 1080");
  await expect(page.getByTestId("topaz-quote")).toContainText("$0.16");
  await expect(dialog).toContainText("Original audio retained (AAC)");
  assert.equal(confirmations.length, 0);

  // Target changes discard stale quotes, even when the older response arrives last.
  raceQuotes = true;
  await page.getByTestId("select-topaz-target").selectOption("4k");
  await expect(page.getByTestId("topaz-quote")).toContainText("3840 × 2160");
  await page.getByTestId("select-topaz-target").selectOption("1080p");
  await expect(page.getByTestId("button-confirm-topaz")).toBeDisabled();
  await page.getByTestId("select-topaz-target").selectOption("4k");
  await expect(page.getByTestId("topaz-quote")).toContainText("$0.64");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("topaz-quote")).toContainText("3840 × 2160");
  raceQuotes = false;
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/topaz-upscale.jpg", type: "jpeg", quality: 90 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.equal(confirmations.length, 0);

  // Configuration errors are explicit; submission stays unavailable.
  quoteError = true;
  await page.getByTestId("button-topaz-upscale").click();
  await expect(dialog.getByRole("alert")).toContainText("FAL_KEY");
  await expect(page.getByTestId("button-confirm-topaz")).toBeDisabled();
  quoteError = false;
  await dialog.getByRole("button", { name: "Retry estimate" }).click();
  await expect(page.getByTestId("topaz-quote")).toContainText("$0.64");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // Completed cloud output exposes the same action, including on mobile.
  await page.goto(`${origin}/generations/${cloudId}`);
  await page.setViewportSize({ width: 402, height: 874 });
  await page.getByTestId("button-topaz-upscale").click();
  await expect(page.getByTestId("topaz-quote")).toContainText("$0.16");
  await expect.poll(async () => {
    const bounds = await dialog.boundingBox();
    return Boolean(bounds && bounds.x >= -0.5 && bounds.x + bounds.width <= 403);
  }, { message: "mobile dialog fits viewport after its opening transition" }).toBe(true);
  await page.getByTestId("select-topaz-target").selectOption("4k");
  await expect(page.getByTestId("topaz-quote")).toContainText("$0.64");
  await page.getByTestId("button-confirm-topaz").click();
  await expect(page.getByTestId("button-confirm-topaz")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("acceptance unknown");
  assert.equal(confirmations.length, 1);
  submitMode = "success";
  await page.getByTestId("button-confirm-topaz").click();
  await expect(page).toHaveURL(`${origin}/generations/${childId}`);
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[0].body.requestId, confirmations[1].body.requestId, "transport retry reuses idempotency key");
  assert.equal(confirmations[1].body.targetResolution, "4k");
  await expect(page.getByText("Topaz Proteus · Upscale", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View original video" })).toHaveAttribute("href", `/generations/${cloudId}`);
  await expect(page.getByTestId("button-topaz-upscale")).not.toBeVisible();
  await expect(page.getByTestId("button-edit-generation")).not.toBeVisible();

  // The common history viewer also offers Topaz for local output.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/generations`);
  await page.getByTestId(`button-open-generation-${localId}`).click();
  await expect(page.getByTestId("dialog-video-generation-viewer")).toBeVisible();
  await page.getByTestId("button-topaz-upscale").click();
  await expect(page.getByTestId("topaz-quote")).toContainText("1920 × 1080");
  await expect(dialog).toBeVisible();
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(pageErrors, []);
  console.log("PASS: mocked local/cloud detail and history viewer, mobile fit, quote refresh/races, cancellation/close, configuration and transport errors, disabled confirmation, idempotent retry, separate queued child and provenance. All API traffic mocked; no paid calls or DB mutations. Screenshot: screenshots/topaz-upscale.jpg");
} finally {
  await browser.close();
}