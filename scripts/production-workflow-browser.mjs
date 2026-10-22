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
  const m = { project: null, actions: [], patches: [], conflictNext: false, bumpNextPatch: false, delayNextPatchMs: 0, list: [] };
  m.handle = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname, method = req.method();
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (path === "/api/session") return json({ user: { id: "u1", email: "t@example.com", displayName: "Test", siteRole: "SITE_ADMIN" }, activeTenant: { id: "t1", name: "Test", slug: "test", role: "OWNER" } });
    if (path === "/api/characters") return json([{ id: "saved-mara", name: "Saved Mara", description: "Mechanic", promptDescription: "Mechanic", thumbnail: image, tags: [], assetCount: 1 }]);
    if (path === "/api/settings") return json([{ id: "library-room", name: "Shared lantern room", description: "Shared room", promptDescription: "Room", thumbnail: image, tags: [], assetCount: 2, createdAt: now(), updatedAt: now(), references: [{ id: "base", name: "Base", prompt: "Night", url: image }, { id: "dawn", name: "Dawn", prompt: "Dawn", url: image }] }]);
    if (path === "/api/image-studio/models") return json({ models: [
      { id: "local-flux2-klein-4b", name: "FLUX.2 klein", provider: "LOCAL", description: "", operations: ["generate", "edit"], aspectRatios: ["1:1"], maxImages: 4, supportsSeed: true, supportsNegativePrompt: false, maxReferences: 4, priceNote: "", available: true },
      { id: "cloud-nano-banana-pro", name: "Nano Banana Pro", provider: "CLOUD", description: "", operations: ["generate", "edit"], aspectRatios: ["1:1"], maxImages: 4, supportsSeed: false, supportsNegativePrompt: false, maxReferences: 8, priceNote: "about $0.14 per image", available: true },
      { id: "local-offline", name: "Offline model", provider: "LOCAL", description: "", operations: ["generate"], aspectRatios: ["1:1"], maxImages: 1, supportsSeed: true, supportsNegativePrompt: false, maxReferences: 0, priceNote: "", available: false, unavailableReason: "No worker online" },
    ] });
    if (path.includes("capabilit")) return json([{ id: "w1", name: "Wan Character", generationMode: "wan-character", modelFamily: "wan", supportsFirstFrame: m.firstFrame !== false, referenceImageSlots: 8, supportsReferenceVideo: false, supportsCharacterReferences: true, supportsSettingReference: true, requiresCharacterReferences: false, requiresSettingReference: false }]);
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
      if (m.delayNextPatchMs) { const delay = m.delayNextPatchMs; m.delayNextPatchMs = 0; await new Promise(r => setTimeout(r, delay)); }
      if (m.bumpNextPatch) {
        m.bumpNextPatch = false; m.project.revision++;
        m.project.state.settings.width = 1600;
        m.project.state.story.scenes[0].action = "A background writer updated this scene.";
      }
      if (m.conflictNext || body.revision !== m.project.revision) { m.conflictNext = false; return json({ error: "Revision conflict" }, 409); }
      const st = m.project.state;
      m.project = { ...m.project, title: body.title, revision: m.project.revision + 1, updatedAt: now(), state: { ...st, ...body.state, settings: { ...st.settings, ...body.state.settings, imageModels: { ...st.settings?.imageModels, ...body.state.settings?.imageModels } }, story: { ...st.story, ...body.state.story } } };
      return json(m.project);
    }
    if (path === "/api/production-projects/prod-1/actions") {
      const body = req.postDataJSON();
      m.actions.push(body);
      if (body.action !== "cancel-story" && body.revision !== m.project.revision) return json({ error: "Revision conflict" }, 409);
      const st = structuredClone(m.project.state);
      if (body.action === "draft-story") st.story = { ...st.story, draftStatus: "READY", scenes };
      if (body.action === "cancel-story") { st.story.draftStatus = "CANCELLED"; if (st.story.progress) st.story.progress.active = false; st.tasks = st.tasks.map(t => t.type === "story" ? { ...t, status: "CANCELLED" } : t); }
      if (body.action === "import-character") st.characters.push({ id: "imported-mara", characterId: body.payload.characterId, name: "Saved Mara", description: "Mechanic", seed: 1, options: [{ assetId: "saved-image", mediaUrl: image }], selectedAssetId: "saved-image", referenceSheet: [{ assetId: "saved-image", mediaUrl: image }], locked: true, status: "LOCKED" });
      if (body.action === "import-place") st.places.push({ id: body.payload.settingId, name: "Shared lantern room", prompt: "Room", seed: 1, status: "READY", assetId: "shared-base", mediaUrl: image, variants: [{ id: "shared-dawn", name: "Dawn", prompt: "Dawn", assetId: "shared-dawn-image", mediaUrl: image, status: "READY" }] });
      if (body.action === "remove-place") st.places = st.places.filter(p => p.id !== body.payload.placeId);
      if (body.action === "remove-variant") st.places = st.places.map(p => p.id === body.payload.placeId ? { ...p, variants: p.variants.filter(v => v.id !== body.payload.id) } : p);
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
    const navigation = page.getByRole("navigation", { name: "Studio sections" });
    await expect(navigation.getByRole("link", { name: "Long-Form", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Queue & History", exact: true })).not.toBeVisible();
    await navigation.getByText("More", { exact: true }).click();
    await expect(navigation.getByRole("link", { name: "Queue & History", exact: true })).toBeVisible();
    await navigation.getByText("More", { exact: true }).click();
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
    await expect(page.getByTestId("badge-locked-pc-1")).toBeVisible();
    expect(mock.actions.at(-1)).toMatchObject({ action: "keep-look", payload: { id: "pc-1", assetId: "opt-2", modelId: "local-flux2-klein-4b", cloudConfirmed: false } });
    expect(mock.actions.find((a) => a.action === "add-character").payload).toMatchObject({ modelId: "local-flux2-klein-4b", cloudConfirmed: false });

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

    // A real revision race during Create -> Review is recovered without
    // sending stale scenes/settings back or replaying a generation action.
    await page.getByTestId("button-step-4").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Create");
    const actionCount = mock.actions.length;
    mock.bumpNextPatch = true;
    await page.getByTestId("button-step-next").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Review");
    expect(mock.patches.at(-1).state).toEqual({ step: 5 });
    expect(mock.project.state.settings.width).toBe(1600);
    expect(mock.project.state.story.scenes[0].action).toContain("background writer");
    expect(mock.actions.length).toBe(actionCount);
    await expect(page.getByTestId("alert-save-error")).toHaveCount(0);

    // Transient 409 automatically retries with a fresh revision.
    await page.getByTestId("button-step-0").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Story");
    await page.getByTestId("input-production-title").fill("Harrow Point (director's cut)");
    mock.conflictNext = true;
    await page.getByTestId("button-save-draft").click();
    await expect(page.getByTestId("status-save")).toContainText("Saved");
    expect(mock.project.title).toBe("Harrow Point (director's cut)");

    // Genuine same-field edits stay protected, with an explicit choice.
    await page.getByTestId("input-production-title").fill("My final title");
    mock.project = { ...mock.project, title: "Another editor's title", revision: mock.project.revision + 1 };
    await page.getByTestId("button-save-draft").click();
    await expect(page.getByTestId("alert-save-error")).toContainText("also edited elsewhere");
    await expect(page.getByTestId("input-production-title")).toHaveValue("My final title");
    await page.getByTestId("button-retry-save").click();
    await expect(page.getByTestId("alert-save-error")).toBeVisible();
    expect(mock.project.title).toBe("Another editor's title");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByTestId("button-load-server").click();
    await expect(page.getByTestId("input-production-title")).toHaveValue("My final title");
    page.once("dialog", dialog => dialog.accept());
    await page.getByTestId("button-keep-local-edits").click();
    await expect(page.getByTestId("status-save")).toContainText("Saved");
    expect(mock.project.title).toBe("My final title");
    expect(mock.project.state.settings.width).toBe(1600);

    // A successful older response must not erase typing made in flight.
    await page.getByTestId("input-production-title").fill("Submitted title");
    mock.delayNextPatchMs = 600;
    const sent = page.waitForRequest(r => r.method() === "PATCH");
    await page.getByTestId("button-save-draft").click();
    await sent;
    await page.getByTestId("input-production-title").fill("Typed while saving");
    await expect(page.getByTestId("button-save-draft")).toBeEnabled();
    await expect(page.getByTestId("input-production-title")).toHaveValue("Typed while saving");
    expect(mock.project.title).toBe("Submitted title");
    await page.getByTestId("button-save-draft").click();
    await expect(page.getByTestId("status-save")).toContainText("Saved");
    expect(mock.project.title).toBe("Typed while saving");
    const patchCount = mock.patches.length;
    await page.getByTestId("button-step-next").evaluate(button => { button.click(); button.click(); });
    await expect(page.getByTestId("text-step-label")).toContainText("Characters");
    expect(mock.patches.length - patchCount).toBe(1);
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
        progress: { stage: "Writing scene 2 of 5", model: "qwen3.8:27b-q8_0", target: "GB10 / Blackwell", startedAt: now(), active: true, gpuVerified: true },
      }, tasks: [{ id: "story-progress", type: "story", status: "RUNNING", index: 2 }], settings: { storyModel: "local" } },
    };
    await context.route("**/api/**", mock.handle);
    const page = await context.newPage();
    await page.goto(`${base}/productions/prod-1`);
    await expect(page.getByTestId("status-story-progress")).toContainText("Writing scene 2 of 5");
    await expect(page.getByTestId("status-story-progress")).toContainText("qwen3.8:27b-q8_0");
    await expect(page.getByTestId("status-story-progress")).toContainText("GPU model verified");
    await expect(page.getByTestId("button-draft-story")).toBeDisabled();
    await page.getByTestId("status-story-progress").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/gb10-writer-progress.png", fullPage: true });
    mock.project.state.story.progress = { ...mock.project.state.story.progress, active: false, gpuVerified: false, stage: "Waiting for GB10 GPU capacity" };
    mock.project.state.tasks[0].status = "QUEUED";
    mock.project.revision++;
    await expect(page.getByTestId("status-story-progress")).toContainText("Video jobs have priority", { timeout: 10000 });
    mock.project.state.story.draftStatus = "FAILED";
    mock.project.state.story.error = "The GB10 script writer timed out. Your input is saved.";
    mock.project.state.story.progress = { ...mock.project.state.story.progress, active: false, stage: "Writing stopped" };
    mock.project.state.tasks[0].status = "FAILED";
    mock.project.revision++;
    await expect(page.getByTestId("text-draft-error")).toContainText("timed out", { timeout: 10000 });
    await expect(page.getByTestId("button-draft-story")).toBeEnabled();
    // New controls never reach a real provider: this context mocks every API.
    mock.project.state.step = 0;
    mock.project.state.story.draftStatus = "RUNNING";
    mock.project.state.story.error = undefined;
    mock.project.state.story.progress = { stage: "Writing scene 3", model: "test-writer", target: "GPU", active: true, startedAt: now() };
    mock.project.state.tasks = [{ id: "writing", type: "story", status: "RUNNING", index: 2 }];
    await page.reload();
    await expect(page.getByTestId("button-cancel-writing")).toBeVisible();
    const patchesBeforeCancel = mock.patches.length;
    await page.getByTestId("input-production-title").fill("My unsaved title");
    await page.getByTestId("button-cancel-writing").click();
    await expect(page.getByTestId("button-cancel-writing")).toHaveCount(0);
    expect(mock.actions.at(-1).action).toBe("cancel-story");
    expect(mock.patches.length).toBe(patchesBeforeCancel);
    await expect(page.getByTestId("input-production-title")).toHaveValue("My unsaved title");
    mock.project.state.step = 1; mock.project.state.story.draftStatus = "READY"; mock.project.state.tasks = []; mock.project.state.characters = [];
    await page.reload();
    await page.getByTestId("button-import-character-saved-mara").click();
    await expect(page.getByTestId("card-character-imported-mara")).toBeVisible();
    await expect(page.getByTestId("badge-locked-imported-mara")).toBeVisible();
    await expect(page.getByTestId("button-import-character-saved-mara")).toBeDisabled();
    mock.project.state.step = 3;
    mock.project.state.places = [{ id: "remove-place", name: "Test set", prompt: "A set", seed: 1, status: "READY", mediaUrl: image, variants: [{ id: "remove-variant", name: "Night", prompt: "Night", mediaUrl: image, status: "READY" }] }];
    await page.reload();
    await page.screenshot({ path: "/tmp/production-controls-scenery.png", fullPage: true });
    page.on("dialog", dialog => void dialog.accept());
    await page.getByTestId("button-remove-variant-remove-variant").click();
    await expect(page.getByTestId("pill-variant-remove-variant")).toHaveCount(0);
    await page.getByTestId("button-remove-place-remove-place").click();
    await expect(page.getByTestId("card-place-remove-place")).toHaveCount(0);
    mock.project.state.step = 0; mock.project.state.story = { ...mock.project.state.story, sourceMode: "summary", summary: "A brief test.", script: "", draftStatus: "READY" };
    await page.reload();
    await page.getByTestId("input-target-minutes").fill("3");
    await expect(page.getByTestId("button-length-3")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("input-story-summary").fill("SCENE 1 — ROOM — DAY — 0:00–3:00\nA light glows.");
    await expect(page.getByTestId("text-script-timing")).toBeVisible();
    await expect(page.getByTestId("button-length-10")).toHaveCount(0);
    console.log("PASS: cancellation preserves unsaved edits; existing library import; scenery/variant removal; custom duration and authored-script timing");
    mock.project.state.step = 4;
    mock.project.state.story = { ...mock.project.state.story, draftStatus: "READY", scenes: [
      { ...scenes[0], sceneNumber: 1, location: "Lighthouse Lantern Room, Gull Point", timeOfDay: "Night" },
      { ...scenes[0], sceneNumber: 2, location: "Lantern Room", timeOfDay: "Pre-dawn" },
    ] };
    mock.project.state.places = [{ id: "room", name: "Lantern Room", prompt: "Existing approved room", seed: 1, status: "READY", assetId: "room-image", mediaUrl: image, variants: [{ id: "dawn", name: "Pre-dawn", prompt: "Existing dawn version", status: "READY", assetId: "dawn-image", mediaUrl: image }] }];
    mock.project.state.settings.sceneReferences = {};
    await page.reload();
    await expect(page.getByTestId("scene-scenery")).toHaveCount(0);
    await expect(page.getByTestId("alert-missing-scenery")).toContainText("1 scene needs scenery");
    await expect(page.getByTestId("details-advanced-settings")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("input-width")).toBeHidden();
    await expect(page.getByTestId("button-create-all")).toBeDisabled();
    await page.screenshot({ path: "/tmp/production-create-desktop.png", fullPage: true });
    await page.getByTestId("button-go-places").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Places");
    await expect(page.getByTestId("scene-scenery")).toHaveCount(1);
    await expect(page.getByTestId("scene-scenery")).toHaveAttribute("open", "");
    await expect(page.getByTestId("status-scene-scenery-1")).toContainText("Assign a ready reference");
    const actionsBeforeAssignment = mock.actions.length;
    await page.getByTestId("select-scene-scenery-1").selectOption("room");
    await page.getByTestId("select-scene-scenery-2").selectOption("room:dawn");
    await expect(page.getByTestId("status-scene-scenery-1")).toContainText("Ready: Lantern Room");
    await expect(page.getByTestId("status-scene-scenery-2")).toContainText("Ready: Lantern Room · Pre-dawn");
    await page.getByTestId("button-step-4").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Create");
    await expect(page.getByTestId("alert-missing-scenery")).toHaveCount(0);
    await expect(page.getByTestId("scene-scenery")).toHaveCount(0);
    await page.getByTestId("button-step-3").click();
    await expect(page.getByTestId("text-step-label")).toContainText("Places");
    expect(mock.project.state.settings.sceneReferences).toMatchObject({ "1": { placeId: "room" }, "2": { placeId: "room", variantId: "dawn" } });
    expect(mock.project.state.story.scenes[0].location).toBe("Lighthouse Lantern Room, Gull Point");
    expect(mock.actions.length).toBe(actionsBeforeAssignment);
    await page.reload();
    await expect(page.getByTestId("scene-scenery")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("text-scenery-summary")).toContainText("All 2 scenes assigned");
    await page.getByTestId("toggle-scene-scenery").click();
    await expect(page.getByTestId("select-scene-scenery-1")).toHaveValue("room");
    await expect(page.getByTestId("text-place-usage-room")).toContainText("Used in 2 scenes");
    await page.screenshot({ path: "/tmp/production-scene-scenery.png", fullPage: true });
    mock.project.state.places[0].variants = [];
    await page.reload();
    await expect(page.getByTestId("scene-scenery")).toHaveAttribute("open", "");
    await expect(page.getByTestId("select-scene-scenery-2")).toHaveValue("__missing__");
    await expect(page.getByTestId("status-scene-scenery-2")).toContainText("Assign a ready reference");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("button-step-4").click();
    await expect(page.getByTestId("alert-missing-scenery")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "/tmp/production-create-mobile.png", fullPage: true });
    console.log("PASS: differently named scenery and variants explicitly assigned, saved across navigation/reload, no image requests, and removed selections fail closed");
    await page.getByTestId("button-step-3").click();
    await page.getByTestId("button-add-place").click();
    await page.getByLabel("Use a saved location", { exact: true }).selectOption("library-room");
    await expect(page.getByText("Shared lantern room", { exact: true }).first()).toBeVisible();
    expect(mock.actions.at(-1)).toMatchObject({ action: "import-place", payload: { settingId: "library-room" } });
    const projectUrl = page.url();
    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", { name: "Locations & Scenery" })).toBeVisible();
    await page.getByText("Reference images (2)", { exact: true }).click();
    await expect(page.getByAltText("Dawn", { exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/scenery-library-mobile.png", fullPage: true });
    await page.goto(projectUrl);
    await expect(page.getByText("Shared lantern room", { exact: true }).first()).toBeVisible();
    console.log("PASS: shared location import, variants, library display and reload persistence");
    mock.firstFrame = false;
    mock.project.state.step = 4;
    await page.reload();
    await expect(page.getByText(/No active local workflow supports a starting frame/)).toBeVisible();
    await expect(page.getByTestId("button-create-all")).toBeDisabled();
    console.log("PASS: reference-only workflow cannot submit an exact-continuation render");
    await context.close();
  }
  console.log("production workflow browser checks passed");
} finally {
  await browser.close();
}
