// All API requests intercepted; no paid provider or GPU can be called.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
const tenant = "11111111-1111-4111-8111-111111111111";
const key = `tenants/${tenant}/generation-references/22222222-2222-4222-8222-222222222222.mp4`;
let requests = [], jobs = [], failOnce = true, cancelled = false;
await context.route("**/api/**", async route => {
  const req = route.request(), url = new URL(req.url());
  let body = [], status = 200;
  if (url.pathname === "/api/session") body = { user: { id: "test", name: "Test", siteRole: "SITE_ADMIN" }, tenant: { id: tenant, name: "Test" } };
  if (url.pathname.endsWith("/reference-media")) body = { storageKey: key, mediaUrl: "/api/media/test.mp4" };
  if (url.pathname.endsWith("/garment-studio/inspect")) body = { sourceStorageKey: key, mediaUrl: "/api/media/test.mp4", durationSeconds: 10, width: 1280, height: 720 };
  if (url.pathname.endsWith("/garment-studio/jobs")) {
    body = jobs;
    if (req.method() === "POST") {
      const data = req.postDataJSON();
      requests.push(data);
      if (failOnce) { failOnce = false; status = 500; body = { error: "Simulated lost response" }; }
      else {
        jobs = [{ id: data.requestId, provider: "FAL", model: "seedance-2.5", mode: "replace-item", title: "Object replacement",
          status: "queued", sourceUrl: "/api/media/test.mp4", maskUrl: null, outputUrl: null, error: null, stage: "Queued", createdAt: new Date().toISOString() }];
        body = { jobId: data.requestId };
      }
    }
  }
  if (url.pathname.endsWith("/cancel")) {
    cancelled = true;
    jobs = jobs.map(j => ({ ...j, status: "cancelled", stage: null }));
    body = { jobId: jobs[0].id };
  }
  await route.fulfill({ status, json: body });
});
const page = await context.newPage();
try {
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/garment-studio`);
  await expect(page.getByTestId("button-provider-local")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("button-provider-fal").click();
  const run = page.getByTestId("button-cloud-submit"), consent = page.getByTestId("checkbox-cloud-confirm-paid");
  await expect(run).toBeDisabled();
  await page.locator('input[type="file"][accept*="video"]').setInputFiles({ name: "test.mp4", mimeType: "video/mp4", buffer: Buffer.from("mocked source") });
  await page.getByTestId("input-cloud-target").fill("The person on the left");
  await page.getByTestId("input-cloud-prompt").fill("Replace the person with a friendly robot");
  await expect(run).toBeDisabled();
  await consent.check();
  await expect(run).toBeEnabled(); // No local workers exist in this fixture.
  await page.getByTestId("input-cloud-duration").fill("16");
  await expect(consent).not.toBeChecked();
  await expect(run).toBeDisabled();
  await page.getByTestId("input-cloud-duration").fill("3");
  await consent.check();
  await expect(run).toBeDisabled();
  await page.getByTestId("input-cloud-duration").fill("4");
  await consent.check();
  await run.click();
  await expect(page.getByText("Could not confirm the job was created.", { exact: false })).toBeVisible();
  await run.click();
  await expect(page.getByTestId("button-cloud-cancel")).toBeVisible();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(requests[0].provider, "FAL");
  assert.equal(requests[0].model, "seedance-2.5");
  assert.equal(requests[0].mode, "replace-item");
  assert.equal(requests[0].confirmPaid, true);
  assert.equal(requests[0].workerId, undefined);
  await page.getByTestId("button-cloud-cancel").click();
  await expect(consent).not.toBeChecked();
  await expect(run).toBeDisabled();
  assert.equal(cancelled, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("input-cloud-target")).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log("PASS: explicit cloud selection, generic targets, validation, consent reset, no worker dependency, retry ID reuse, cancellation, mobile layout. All submissions mocked.");
} finally {
  await browser.close();
}
