// Browser-only regression: API responses are intercepted; no emails or real
// passwords/accounts are touched. Run against the development preview.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({
  headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
try {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  let requests = 0;
  let rejectToken = false;
  await context.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/reset-password") {
      requests++;
      const body = route.request().postDataJSON();
      expect(body.token).toBe("a".repeat(43));
      expect(body.password).toBe("Test replacement password!");
      await route.fulfill(rejectToken
        ? { status: 400, contentType: "application/json", body: '{"error":"Invalid or expired link"}' }
        : { status: 204 });
    } else {
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' });
    }
  });
  const base = process.env.APP_TEST_URL ?? "http://127.0.0.1";
  const other = await context.newPage();
  await other.goto(`${base}/forgot-password`);
  await expect(other.getByTestId("input-forgot-email")).toBeVisible();
  let otherReloads = 0;
  other.on("framenavigated", frame => { if (frame === other.mainFrame()) otherReloads++; });
  const page = await context.newPage();
  await page.goto(`${base}/reset-password#token=${"a".repeat(43)}`);
  await expect(page.getByTestId("input-reset-password")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  let ownReloads = 0;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) ownReloads++; });
  await page.getByTestId("input-reset-password").fill("Test replacement password!");
  await page.getByTestId("input-reset-confirm-password").fill("Test replacement password!");
  await page.getByTestId("button-reset-submit").click();
  // Wait for the cross-tab auth signal, then prove this tab kept its success state.
  await expect.poll(() => otherReloads).toBeGreaterThan(0);
  await expect(page.getByText("Password updated", { exact: true })).toBeVisible();
  expect(ownReloads).toBe(0);
  expect(requests).toBe(1);
  console.log("PASS: successful reset stays successful while other tabs refresh.");
  rejectToken = true;
  const rejected = await context.newPage();
  await rejected.goto(`${base}/reset-password#token=${"a".repeat(43)}`);
  await rejected.getByTestId("input-reset-password").fill("Test replacement password!");
  await rejected.getByTestId("input-reset-confirm-password").fill("Test replacement password!");
  await rejected.getByTestId("button-reset-submit").click();
  await expect(rejected.getByText("This link can't be used", { exact: true })).toBeVisible();
  console.log("PASS: a genuine server rejection still displays the invalid-link screen.");
} finally {
  await browser.close();
}
