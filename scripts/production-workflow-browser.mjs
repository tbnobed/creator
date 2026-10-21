// Mock all APIs: verifies the six-step production workflow without real jobs, GPUs or paid providers.
import { chromium, expect } from "@playwright/test";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=";
const now = () => new Date().toISOString();
const scenes = [
  { sceneNumber: 1, title: "Return to Harrow Point", location: "Lighthouse", timeOfDay: "Night", characters: ["Eli"], action: "Eli climbs the stairs.", dialogue: "ELI: Still standing." },
  { sceneNumber: 2, title: "The harbour", location: "lighthouse ", timeOfDay: "Morning", characters: ["Eli", "Mara"], action: "Mara waits.", dialogue: "MARA: You came back." },
  { sceneNumber: 3, title: "Cliff path", location: "Lighthouse Cliffs", timeOfDay: "Dusk", characters: ["Eli"], action: "Wind.", dialogue: "" },
];

function makeMock() {
  const m = { project: null, actions: [], patches: [], conflictNext: false, list: [] };
  m.handle = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname, method = req.method();
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/session") return json({ user: { id: "u1", email: "t@example.com", displayName: "Test", siteRole: "SITE_ADMIN" }, activeTenant: { id: "t1", name: "Test", slug: "test", role: "OWNER" } });
    if (path === "/api/image-studio/models") return json({ models: [
      { id: "local-flux2-klein-4b", name: "FLUX.2 klein", provider: "LOCAL", description: "", operations: ["generate", "edit"], aspectRatios: ["1:1"], maxImages: 4, supportsSeed: true, supportsNegativePrompt: false, maxReferences: 4, priceNote: "", available: true },
      { id: "cloud-nano-banana-pro", name: "Nano Banana Pro", provider: "CLOUD", description: "", operations: ["generate", "edit"], aspectRatios: ["1:1"], maxImages: 4, supportsSeed: false, supportsNegativePrompt: false, maxReferences: 8, priceNote: "about $0.14 per image", available: true },
      { id: "local-offline", name: "Offline model", provider: "LOCAL", description: "", operations: ["generate"], aspectRatios: ["1:1"], maxImages: 1, supportsSeed: true, supportsNegativePrompt: false, maxReferences: 0, priceNote: "", available: false, unavailableReason: "No worker online" },
    ] });
    if (path.includes("capabilit")) return json([{ id: "w1", name: "Wan Character", generationMode: "wan-character", modelFamily: "wan", supportsReferenceVideo: false, supportsCharacterReferences: true, supportsSettingReference: true, requiresCharacterReferences: false, requiresSettingReference: false }]);
    if (path === "/api/production-projects" && method === "GET") return json(m.project ? [m.project] : m.list);
    if (path === "/api/production-projects" && method === "POST") {
      const body = req.postDataJSON();
      m.project = { id: "prod-1", title: body.title, revision: 1, state: { characters: [], wardrobes: [], places: [], tasks: [], review: { status: "NOT_IMPLEMENTED", issues: [] }, ...body.state }, renderProjectId: null, createdAt: now(), updatedAt: now() };
      return json(m.project, 201);
    }
    if (path === "/api/production-projects/prod-1" && method === "GET") return json(m.project);
    if (path === "/api/production-projects/prod-1" && method === "PATCH") {
      const body = req.postDataJSON();
      m.patches.push(body);
      if (m.conflictNext || body.revision !== m.project.revision) { m.conflictNext = false; return json({ error: "Revision conflict" }, 409); }
      const st = m.project.state;
      m.project = { ...m.project, title: body.title, revision: m.project.revision + 1, updatedAt: now(), state: { ...st, ...body.state, story: { ...st.story, ...body.state.story } } };
      return json(m.project);
    }
    if (path === "/api/production-projects/prod-1/actions") {
      const body = req.postDataJSON();
      m.actions.push(body);
      if (body.revision !== m.project.revision) return json({ error: "Revision conflict" }, 409);
      const st = structuredClone(m.project.state);
      if (body.action === "draft-story") st.story = { ...st.story, draftStatus: "READY", scenes };
      if (body.action === "add-character") st.characters.push({ id: "pc-1", name: body.payload.name, description: body.payload.description, seed: 42, options: [0, 1, 2, 3].map((i) => ({ assetId: `opt-${i}`, mediaUrl: image })), locked: false, referenceSheet: [], status: "READY" });
      if (body.action === "keep-look") st.characters = st.characters.map((c) => c.id === body.payload.id ? { ...c, locked: true, selectedAssetId: body.payload.assetId, referenceSheet: [{ assetId: "ref-1", mediaUrl: image, label: "front" }] } : c);
      m.project = { ...m.project, revision: m.project.revision + 1, state: st, updatedAt: now() };
      return json(m.project);
    }
    if (path.startsWith("/api/long-form-projects")) return json([]);
    return json([]);
  };
  return m;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const base = process.env.APP_TEST_URL ?? "http://127.0.0.1";
try {
  // Desktop: create, draft, navigate six steps, portrait lock, review honesty, 409.
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const mock = makeMock();
    await context.route("**/api/**", mock.handle);
    const page = await context.newPage();
    await page.goto(`${base}/projects/new`);
    await page.getByTestId("input-production-title").fill("Harrow Point");
    await page.getByTestId("input-story-summary").fill("A storm-chaser returns home.");
    await page.getByTestId("button-length-30").click();
    await expect(page.getByTestId("button-step-next")).toBeDisabled();
    await page.getByTestId("button-story-model-openai").click();
    await expect(page.getByTestId("button-draft-story")).toBeDisabled();
    await page.getByTestId("checkbox-paid-story").click();
    await expect(page.getByTestId("button-draft-story")).toBeEnabled();
    await page.getByTestId("button-story-model-local").click();
    await page.getByTestId("button-draft-story").click();
    await expect(page).toHaveURL(/\/productions\/prod-1$/);
    expect(mock.project.title).toBe("Harrow Point");
    expect(mock.project.state.story.targetMinutes).toBe(30);
    expect(mock.actions[0]).toMatchObject({ action: "draft-story", revision: 1 });
    expect(mock.actions[0].payload.cloudConfirmed).toBeUndefined();
    await expect(page.getByTestId("card-scene-1")).toBeVisible();
    await expect(page.getByTestId("card-scene-3")).toBeVisible();

    // Reload resumes saved project.
    await page.reload();
    await expect(page.getByTestId("input-production-title")).toHaveValue("Harrow Point");
    await expect(page.getByTestId("card-scene-2")).toBeVisible();

    // Step 2: characters, portrait selection -> lock.
    await page.getByTestId("button-approve-draft").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Characters");
    expect(mock.project.state.step).toBe(1);
    await page.getByTestId("button-add-character").click();
    await expect(page.getByTestId("button-generate-character")).toBeDisabled();
    await page.getByTestId("input-character-name").fill("Eli");
    await page.getByTestId("chip-age").click();
    await expect(page.getByTestId("input-character-description")).toHaveValue("age: ");
    await page.getByTestId("input-character-description").fill("age: 34, weathered");
    await page.getByTestId("select-model-characters").click();
    await page.getByTestId("option-model-characters-cloud-nano-banana-pro").click();
    await expect(page.getByTestId("button-generate-character")).toBeDisabled();
    await page.getByTestId("checkbox-paid-characters").click();
    await expect(page.getByTestId("button-generate-character")).toBeEnabled();
    await page.getByTestId("select-model-characters").click();
    await page.getByTestId("option-model-characters-local-flux2-klein-4b").click();
    await page.getByTestId("button-generate-character").click();
    await expect(page.getByTestId("option-portrait-2")).toBeVisible();
    await expect(page.getByTestId("button-keep-look")).toBeDisabled();
    await page.getByTestId("option-portrait-2").click();
    await expect(page.getByTestId("option-portrait-2")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("button-keep-look").click();
    expect(mock.actions.at(-1)).toMatchObject({ action: "keep-look", payload: { id: "pc-1", assetId: "opt-2", modelId: "local-flux2-klein-4b", cloudConfirmed: false } });
    expect(mock.actions.find((a) => a.action === "add-character").payload).toMatchObject({ modelId: "local-flux2-klein-4b", cloudConfirmed: false });
    await expect(page.getByTestId("badge-locked-pc-1")).toBeVisible();

    // Steps 3-6.
    for (const label of ["Wardrobe", "Places", "Create", "Review"]) {
      await page.getByTestId("button-step-next").click();
      await expect(page.getByTestId("text-step-label")).toContainText(label);
    }
    await expect(page.getByTestId("empty-review")).toBeVisible();

    // Review honesty with a render project and NOT_IMPLEMENTED review.
    mock.project = { ...mock.project, renderProjectId: "lf-1" };
    await context.unroute("**/api/**");
    await context.route("**/api/**", async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.includes("/long-form-projects/lf-1")) return route.fulfill({ json: { id: "lf-1", title: "x", status: "EDITING", progress: 100, totalShots: 1, completedShots: 1, failedShots: 0, shots: [{ id: "s1", sceneNumber: 1, shotNumber: 1, title: "Stairs", status: "COMPLETED", outputUrl: null, errorMessage: null }], finalOutputUrl: null, errorMessage: null } });
      return mock.handle(route);
    });
    await page.reload();
    await expect(page.getByTestId("status-continuity")).toContainText("not checked");
    await expect(page.getByTestId("text-issue-count")).toContainText("0 things");
    await expect(page.getByTestId("text-all-clear")).toHaveCount(0);

    // 409 preserves draft.
    await page.getByTestId("button-step-0").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Story");
    await page.getByTestId("input-production-title").fill("Harrow Point (director's cut)");
    mock.conflictNext = true;
    await page.getByTestId("button-save-draft").click();
    await expect(page.getByTestId("alert-save-error")).toBeVisible();
    await expect(page.getByTestId("input-production-title")).toHaveValue("Harrow Point (director's cut)");
    await page.getByTestId("button-retry-save").click();
    await expect(page.getByTestId("status-save")).toContainText("Saved");
    expect(mock.project.title).toBe("Harrow Point (director's cut)");
    await context.close();
  }

  // Mobile: workflow usable, no horizontal overflow.
  {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mock = makeMock();
    await context.route("**/api/**", mock.handle);
    const page = await context.newPage();
    await page.goto(`${base}/projects/new`);
    await expect(page.getByTestId("input-production-title")).toBeVisible();
    await expect(page.getByTestId("button-length-90")).toBeVisible();
    await page.getByTestId("input-story-summary").fill("Short mobile story.");
    await page.getByTestId("button-draft-story").click();
    await expect(page.getByTestId("card-scene-1")).toBeVisible();
    await expect(page.getByTestId("button-step-next")).toBeEnabled();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "/tmp/production-workflow-mobile.png", fullPage: true });
    await context.close();
  }
  // An in-progress writer shows the actual model/stage, then exits the
  // spinner and exposes its persisted error when inference fails.
  {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const mock = makeMock();
    mock.project = {
      id: "prod-1", title: "GPU writer progress", revision: 3, renderProjectId: null,
      createdAt: now(), updatedAt: now(),
      state: { step: 0, story: {
        summary: "A lighthouse keeper repairs the light.", script: "", targetMinutes: 10,
        draftStatus: "RUNNING", scenes: [],
        progress: { stage: "Writing scene 2 of 5", model: "qwen2.5:1.5b", target: "GB10 / Blackwell", startedAt: now(), active: true, gpuVerified: true },
      }, tasks: [{ id: "story-progress", type: "story", status: "RUNNING", index: 2 }], settings: { storyModel: "local" } },
    };
    await context.route("**/api/**", mock.handle);
    const page = await context.newPage();
    await page.goto(`${base}/productions/prod-1`);
    await expect(page.getByTestId("status-story-progress")).toContainText("Writing scene 2 of 5");
    await expect(page.getByTestId("status-story-progress")).toContainText("qwen2.5:1.5b");
    await expect(page.getByTestId("status-story-progress")).toContainText("GPU model verified");
    await expect(page.getByTestId("button-draft-story")).toBeDisabled();
    await page.screenshot({ path: "/tmp/gb10-writer-progress.png", fullPage: true });
    mock.project.state.story.draftStatus = "FAILED";
    mock.project.state.story.error = "The GB10 script writer timed out. Your input is saved.";
    mock.project.state.story.progress = { ...mock.project.state.story.progress, active: false, stage: "Writing stopped" };
    mock.project.state.tasks[0].status = "FAILED";
    mock.project.revision++;
    await expect(page.getByTestId("text-draft-error")).toContainText("timed out", { timeout: 10000 });
    await expect(page.getByTestId("button-draft-story")).toBeEnabled();
    await context.close();
  }
  console.log("production workflow browser checks passed");
} finally {
  await browser.close();
}
