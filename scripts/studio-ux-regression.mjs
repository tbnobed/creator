// Isolated UI regression tests. Every API response is mocked; no render or deletion reaches a server.
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
const jobs = Array.from({ length: 24 }, (_, i) => ({
  id: `ux-${i}`, title: `Scene ${i + 1}`, prompt: "A red teapot on a wooden table in warm sunlight.",
  status: i === 23 ? "RUNNING" : "COMPLETED", provider: "COMFYUI",
  workflowName: "MiniMax H3", generationMode: "txt2vid", width: 1280, height: 704,
  durationSeconds: 11.91, fps: 24, qualityPreset: "STANDARD", createdAt: "2026-10-04T12:00:00Z",
  outputUrl: i === 23 ? null : "/ux-preview.mp4",
}));
let deleteRequests = 0;
await context.route("**/api/**", async route => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() === "DELETE") deleteRequests++;
  let body = [];
  if (path === "/api/session") body = { user: { id: "ux-user", name: "UX test", email: "ux@example.invalid", siteRole: "SITE_ADMIN" }, tenant: { id: "ux-tenant", name: "UX" } };
  else if (path === "/api/healthz") body = { status: "ok" };
  else if (path === "/api/generations") body = { items: jobs, totalItems: 76, page: 1, pageSize: 24, totalPages: 4 };
  else if (path === "/api/generation-capabilities") body = [{ generationMode: "txt2vid", modelFamily: "MiniMax H3", supportsReferenceVideo: false, requiresCharacterReferences: false, requiresSettingReference: false }];
  else if (path.includes("check")) body = { summary: "Test check", strengths: [], issues: [] };
  await route.fulfill({ json: body });
});
// Delay previews so the loading state is deterministic.
await context.route("**/ux-preview.mp4", route => route.abort());
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/studio`);
  const prompt = page.getByTestId("input-video-prompt");
  await expect(prompt).toBeVisible();
  await expect(page.getByText("Showing 24 of 76", { exact: true })).toBeVisible();
  const more = page.locator("summary").filter({ hasText: "More" });
  await more.click();
  await expect(page.getByText("Manage", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("details[open]").filter({ has: more })).toHaveCount(0);
  await more.click();
  await prompt.click();
  await expect(page.locator("details[open]").filter({ has: more })).toHaveCount(0);
  await more.click();
  await page.evaluate(() => document.querySelector('[aria-labelledby="recent-creations-heading"] > div:last-child').dispatchEvent(new Event("scroll")));
  await expect(page.locator("details[open]").filter({ has: more })).toHaveCount(0);
  await page.getByTestId("button-render-setup").click();
  await expect(page.getByTestId("select-generation-pipeline")).toContainText("MiniMax H3");
  await page.keyboard.press("Escape");
  await expect(prompt).toBeFocused();
  await page.keyboard.type("Original draft");
  await expect(prompt).toHaveValue("Original draft");
  const before = await page.getByTestId("button-shot-controls").boundingBox();
  await page.getByTestId("button-shot-controls").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const after = await page.getByTestId("button-shot-controls").boundingBox();
  if (before.y !== after.y) throw new Error("Shot direction moved the toolbar");
  await page.getByText("Prompt Builder & Live AI Check", { exact: true }).click();
  await page.getByPlaceholder("Who or what is the focus?").fill("A blue bird");
  await page.getByRole("button", { name: "Preview built prompt" }).click();
  await expect(prompt).toHaveValue("Original draft");
  await page.getByRole("button", { name: "Append to main prompt" }).click();
  await expect(prompt).toHaveValue(/Original draft\n\n.*blue bird/);
  await page.keyboard.press("Escape");
  await expect(prompt).toBeFocused();
  await prompt.fill("");
  await expect(page.getByTestId("button-generate-video")).toBeDisabled();
  await page.getByTestId("button-shot-controls").click();
  await page.getByText("Prompt Builder & Live AI Check", { exact: true }).click();
  await expect(page.getByText("0%", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "In progress", exact: true }).click();
  await expect(page.getByText("1 in progress in the latest 24 creations")).toBeVisible();
  await page.getByRole("button", { name: "all", exact: true }).click();
  await page.getByTestId("button-open-studio-generation-ux-0").click();
  await expect(page.getByText("Completed generation · 1 of 24 in this view")).toBeVisible();
  await page.locator("video[controls]").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Completed generation · 2 of 24 in this view")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText("Completed generation · 1 of 24 in this view")).toBeVisible();
  await page.getByTestId("button-delete-generation").click();
  await expect(page.getByRole("button", { name: "Confirm delete", exact: true })).toBeVisible();
  if (deleteRequests) throw new Error("Delete occurred before confirmation");
  await page.getByRole("button", { name: "Keep generation" }).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prompt).toBeVisible();
  await page.getByTestId("button-shot-controls").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeFocused();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: menu dismissal, counts/filters, focus and typing, stable toolbar, safe prompt builder, readiness, disabled render, viewer keyboard navigation, delete confirmation, mobile panel.");
} finally {
  await browser.close();
}
