// Mocked browser checks: no generation request can reach a provider.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true });
const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
const models = [
  { id: "local-flux", name: "Local FLUX", provider: "LOCAL", operations: ["generate", "edit"], maxImages: 4 },
  { id: "cloud-nano", name: "Paid Nano", provider: "CLOUD", operations: ["generate", "edit"], maxImages: 4 },
  { id: "cloud-paint", name: "Paid paint", provider: "CLOUD", operations: ["inpaint", "outpaint"], maxImages: 1 },
  { id: "cloud-topaz-upscale", name: "Topaz", provider: "CLOUD", operations: ["upscale"], maxImages: 1 },
  { id: "cloud-remove", name: "Remove background", provider: "CLOUD", operations: ["remove-background"], maxImages: 1 },
].map(m => ({ ...m, available: true, aspectRatios: ["1:1"], maxReferences: 1, supportsSeed: true, supportsNegativePrompt: false, description: "Test model", priceNote: "Cost applies" }));
let posts = 0;
let showAsset = false;
await context.route("**/api/**", async route => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() === "POST") posts++;
  let body = [];
  if (path === "/api/session") body = { user: { id: "test", name: "Test", siteRole: "SITE_ADMIN" }, tenant: { id: "test", name: "Test" } };
  if (path.endsWith("/image-studio/models")) body = { models };
  if (path.endsWith("/image-studio/assets")) body = { assets: showAsset ? [{
    id: "sample", name: "Sample image", url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
    width: 256, height: 256, mimeType: "image/png", favorite: false, collection: "", createdAt: new Date().toISOString(),
  }] : [], total: showAsset ? 1 : 0 };
  if (path.endsWith("/image-studio/jobs")) body = { jobs: [] };
  await route.fulfill({ json: body });
});
const page = await context.newPage();
try {
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/image-studio`);
  await expect(page.getByRole("combobox").filter({ hasText: "Local FLUX" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true }).filter({ has: page.locator('svg') }).last()).toBeDisabled();
  for (const mode of ["edit", "inpaint", "upscale", "remove background", "outpaint", "generate"]) {
    await page.getByRole("button", { name: mode, exact: true }).first().click();
    if (["upscale", "remove background"].includes(mode)) {
      await expect(page.getByText("Number of images", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Select a supported 2×", { exact: false })).toHaveCount(0);
    }
  }
  await expect(page.getByRole("combobox").filter({ hasText: "Local FLUX" })).toBeVisible();
  await page.getByPlaceholder("Describe the result you want…").fill("A tree");
  const submit = page.locator('button[type="submit"]');
  await expect(submit).toBeEnabled();
  await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("20000");
  await expect(submit).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "2048" })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Width", exact: true }).fill("1024");
  await page.getByRole("combobox").filter({ hasText: "Local FLUX" }).click();
  await page.getByRole("option", { name: /Paid Nano/ }).click();
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox", { name: /confirm the cost/ }).check();
  await expect(submit).toBeEnabled();
  await page.getByPlaceholder("Describe the result you want…").fill("");
  await expect(submit).toBeDisabled();
  showAsset = true;
  await page.reload();
  await page.getByRole("button", { name: "Select Sample image", exact: true }).click();
  await page.getByRole("button", { name: "inpaint", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Brush size" })).toBeVisible();
  await page.getByRole("slider", { name: "Brush size" }).fill("100");
  await expect(page.getByText("Brush 100px")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/image-studio`);
  await expect(page.getByRole("button", { name: "remove background", exact: true })).toBeVisible();
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/missing-test-page`);
  await expect(page.getByRole("heading", { name: "404 Page Not Found" })).toBeVisible();
  await expect(page.getByText("Did you forget", { exact: false })).toHaveCount(0);
  if (posts) throw new Error(`Unexpected POST requests: ${posts}`);
  console.log("PASS: per-mode selection, paid confirmation, empty prompt, dimensions, tool controls, 404; zero POST requests");
} finally { await browser.close(); }
