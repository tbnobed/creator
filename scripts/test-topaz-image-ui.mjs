// Fail-closed browser test. All API/auth/media requests are synthetic; no paid calls.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = process.env.TOPAZ_UI_TEST_ORIGIN || "http://127.0.0.1";
const assets = ["Local GPU output", "Cloud output", "Uploaded image", "Oversized source"].map((name, index) => ({
  id: `11111111-1111-4111-8111-11111111111${index}`, name, mimeType: "image/png",
  width: index === 3 ? 8000 : 1024, height: index === 3 ? 8000 : 768,
  url: `/api/media/image-${index}.png`, favorite: false, collection: "",
  jobId: index < 2 ? `22222222-2222-4222-8222-22222222222${index}` : null, createdAt: new Date().toISOString(),
}));
let available = true;
let submissionError = "transport";
const submissions = [];
const unexpected = [];
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session") return reply({
      user: { id: "mock-user", email: "mock@example.invalid", displayName: "Browser test", siteRole: "USER" },
      activeTenant: { id: "mock-tenant", name: "Mock workspace", slug: "mock", role: "OWNER" },
    });
    if (url.pathname === "/api/healthz") return reply({ status: "ok" });
    if (url.pathname.startsWith("/api/media/")) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64") });
    if (url.pathname === "/api/image-studio/models") return reply({ models: [{
      id: "cloud-topaz-upscale", name: "Topaz Image Upscale", provider: "CLOUD",
      operations: ["upscale"], aspectRatios: ["source"], maxImages: 1, supportsSeed: false,
      supportsNegativePrompt: false, maxReferences: 1, description: "Topaz Standard V2",
      priceNote: "Tiered image pricing", available, unavailableReason: available ? undefined : "Cloud credentials are not configured",
    }] });
    if (url.pathname === "/api/image-studio/assets") return reply({ assets });
    if (url.pathname === "/api/image-studio/jobs") {
      if (route.request().method() === "GET") return reply({ jobs: [] });
      submissions.push(route.request().postDataJSON());
      if (submissionError === "transport") return reply({ error: "Simulated submission transport failure" }, 503);
      if (submissionError === "allowance") return reply({ error: "Monthly Cloud spending allowance exceeded" }, 402);
      return reply({ job: { id: "mock-child", status: "QUEUED" } }, 201);
    }
    unexpected.push(url.pathname);
    return reply({ error: "Unexpected mocked API" }, 500);
  });
  await page.goto(`${origin}/image-studio`);
  for (const name of ["Local GPU output", "Cloud output", "Uploaded image"]) {
    await page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Upscale with Topaz", exact: true }).click();
    await expect(page.getByText("Estimated cost: $0.08 USD.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Process", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "4×", exact: true }).click();
    await expect(page.getByText("4096 × 3072", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "I approve this cost and sending the source image to Fal / Topaz" }).check();
    await expect(page.getByRole("button", { name: "Process", exact: true })).toBeEnabled();
  }
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: "screenshots/topaz-image-upscale.jpg", fullPage: true });
  await page.getByRole("button", { name: "Process", exact: true }).click();
  await expect(page.getByText("Image job failed to start", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Process", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(2);
  assert.equal(submissions[0].requestKey, submissions[1].requestKey);
  assert.equal(submissions[0].modelId, "cloud-topaz-upscale");
  assert.equal(submissions[0].width, 4096);
  assert.deepEqual(submissions[0].referenceAssetIds, [assets[2].id]);
  submissionError = "allowance";
  await page.getByRole("button", { name: "Process", exact: true }).click();
  await expect(page.getByText("Monthly Cloud spending allowance exceeded", { exact: true })).toBeVisible();
  submissionError = "";
  await page.getByRole("button", { name: "Process", exact: true }).click();
  await expect(page.getByText("Job started", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Process", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(page.getByRole("button", { name: "Upscale with Topaz", exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 403));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Select Oversized source", exact: true }).click();
  await expect(page.getByRole("button", { name: "2×", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "4×", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Process", exact: true })).toBeDisabled();
  available = false;
  await page.reload();
  await page.getByRole("button", { name: "Select Uploaded image", exact: true }).click();
  await page.getByRole("button", { name: "Upscale with Topaz", exact: true }).click();
  await expect(page.getByText("Topaz is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Process", exact: true })).toBeDisabled();
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("Topaz image UI: local/cloud/upload selection, sizes, cost consent, retry idempotency, allowance error, success, mobile, upper bounds, missing credentials passed. No paid calls.");
} finally {
  await browser.close();
}