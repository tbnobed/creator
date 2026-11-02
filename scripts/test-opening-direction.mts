// Real HTTPS browser + real API, no route mocks, auth bypass, or forged sessions.
// Run: artifacts/obtv-video-studio/node_modules/.bin/tsx scripts/test-opening-direction.mts
// Only fixture rows are seeded/removed. Missing media UUIDs deliberately prevent
// image dispatch, so this checks review/queue behavior, not GPU render quality.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { chromium, expect, type Page } from "@playwright/test";
import { emptyProduction } from "../artifacts/api-server/src/lib/production-types";
import { openingInputs, openingGenerationInputs } from "../artifacts/api-server/src/lib/production-openings";

assert.notEqual(process.env.NODE_ENV, "production", "Development fixtures only");
assert(process.env.REPLIT_DEV_DOMAIN, "A real HTTPS preview is required");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const userId = `opening-review-${randomUUID()}`;
const tenantId = randomUUID();
const email = `${userId}@example.invalid`;
const password = randomBytes(32).toString("hex");
const salt = randomBytes(16);
const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const hash = ["scrypt", "v1", 16384, 8, 1, salt.toString("base64url"), digest.toString("base64url")].join("$");
const ids = { portrait: randomUUID(), alternate: randomUUID(), wardrobe: randomUUID(), set: randomUUID(), old: randomUUID() };
const image = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="${color}"/></svg>`)}`;
const portraitUrl = image("purple"), wardrobeUrl = image("blue");
const original = "Subject waits beside the entrance.";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let lock: any;
let lockedId: string | undefined;
const passed: string[] = [];
function pass(name: string) { passed.push(name); console.log(`PASS ${name}`); }

function fixture(wardrobe = false) {
  const state = emptyProduction();
  state.step = 4;
  state.characters = [{
    id: "subject", name: "Subject", description: "Unapproved appearance prose", seed: 1,
    locked: true, selectedAssetId: ids.portrait, status: "LOCKED", referenceSheet: [],
    options: [
      { assetId: ids.alternate, mediaUrl: image("red") },
      { assetId: ids.portrait, mediaUrl: portraitUrl },
    ],
  }];
  if (wardrobe) state.wardrobes = [{
    id: "outfit", characterId: "subject", name: "Approved blue coat", prompt: "Blue coat",
    fromScene: 1, toScene: 1, status: "READY",
    assetId: ids.wardrobe, approvedAssetId: ids.wardrobe, mediaUrl: wardrobeUrl,
  }];
  state.places = [{ id: "set", name: "Entrance", prompt: "Entrance", seed: 1, status: "READY", assetId: ids.set, variants: [] }];
  state.story.scenes = [{
    sceneNumber: 1, title: "Entrance", location: "Entrance", timeOfDay: "Day", characters: ["Subject"],
    action: "Original story action", dialogue: "", shots: [{ prompt: original, dialogue: "Keep this dialogue", durationSeconds: 5 }],
  }];
  const scene = state.story.scenes[0];
  scene.opening = { assetId: ids.old, approvedAssetId: ids.old, mediaUrl: image("green"), status: "READY", sourceKey: openingInputs(state, scene).sourceKey };
  scene.openingHistory = [{ ...scene.opening }];
  return state;
}

try {
  await pool.query("INSERT INTO obtv_users (id,email,password_hash,display_name,site_role) VALUES ($1,$2,$3,'Opening review test','USER')", [userId, email, hash]);
  await pool.query("INSERT INTO obtv_tenants (id,name,slug,created_by_user_id) VALUES ($1,'Opening review test',$2,$3)", [tenantId, userId, userId]);
  await pool.query("INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenantId, userId]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium", headless: true });
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block", viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByTestId("input-sign-in-email").fill(email);
  await page.getByTestId("input-sign-in-password").fill(password);
  const login = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/login" && r.request().method() === "POST");
  await page.getByTestId("button-sign-in-submit").click();
  assert.equal((await login).status(), 204, "Normal browser-origin login must succeed");
  await page.waitForURL(/\/(?:studio|characters|generate|projects)/);
  pass("normal sign-in through HTTPS preview");

  const api = context.request;
  async function create(state = fixture()) {
    const response = await api.post("/api/production-projects", { headers: { Origin: origin }, data: { title: "Opening review browser fixture", state: {} } });
    assert.equal(response.status(), 201);
    const { id } = await response.json();
    await pool.query("UPDATE obtv_production_projects SET state=$1::jsonb, revision=revision+1 WHERE id=$2 AND tenant_id=$3", [JSON.stringify(state), id, tenantId]);
    return id;
  }
  async function stored(id: string) {
    return (await pool.query("SELECT state, revision FROM obtv_production_projects WHERE id=$1 AND tenant_id=$2", [id, tenantId])).rows[0];
  }
  async function open(id: string, target: Page = page) {
    await target.goto(`/productions/${id}`);
    const section = target.locator("details").filter({ has: target.locator(":scope > summary", { hasText: /^Scene opening images$/ }) }).first();
    await expect(section).toBeVisible();
    if (!(await section.getAttribute("open"))) {
      // Boolean HTML attributes serialize as an empty string, so inspect the property.
      if (!(await section.evaluate(el => (el as HTMLDetailsElement).open))) await section.locator(":scope > summary").click();
    }
    await target.getByRole("button", { name: "Generate opening 1", exact: true }).click();
    await expect(target.getByLabel("Opening direction", { exact: true })).toHaveValue(original);
  }
  async function confirm(target = page) {
    const response = target.waitForResponse(r => r.url().includes("/actions") && r.request().method() === "POST");
    await target.getByRole("button", { name: "Confirm direction & generate", exact: true }).click();
    return response;
  }
  async function hold(id: string) {
    lock ??= await pool.connect();
    const result = await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [`production:${id}`]);
    assert(result.rows[0].locked, "Could not isolate queued fixture from background processing");
    lockedId = id;
  }
  async function release() {
    if (lockedId) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`production:${lockedId}`]);
    lockedId = undefined;
  }

  const cancelId = await create();
  await open(cancelId);
  const preview = page.getByRole("img", { name: "Subject approved reference", exact: true });
  await expect(preview).toHaveAttribute("src", portraitUrl);
  assert(await preview.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0));
  const before = await stored(cancelId);
  await page.getByLabel("Opening direction", { exact: true }).fill("Discard this edit");
  let mutations = 0;
  const countMutation = (request: any) => { if (request.url().includes(`/production-projects/${cancelId}`) && ["POST", "PATCH", "DELETE"].includes(request.method())) mutations++; };
  page.on("request", countMutation);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveCount(0);
  assert.deepEqual(await stored(cancelId), before);
  assert.equal(mutations, 0);
  page.off("request", countMutation);
  pass("selected approved portrait renders; cancel sends no mutation");

  const editId = await create();
  await open(editId);
  const edited = "Subject sits beside the entrance without invented anatomy.";
  await page.getByLabel("Opening direction", { exact: true }).fill(edited);
  await page.getByLabel("Versions per generation").selectOption("3");
  const result = await confirm();
  assert.equal(result.status(), 200);
  const saved = await result.json();
  assert.equal(saved.state.story.scenes[0].shots[0].prompt, edited);
  assert.equal(saved.state.story.scenes[0].shots[0].dialogue, "Keep this dialogue");
  assert.equal(saved.state.story.scenes[0].action, "Original story action");
  assert.equal(saved.state.tasks.length, 3);
  assert(saved.state.tasks.every((t: any) => t.type === "opening" && t.status === "QUEUED"));
  assert.equal(saved.state.story.scenes[0].openingHistory.length, 4);
  assert.equal(saved.state.story.scenes[0].opening.approvedAssetId, undefined);
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveCount(0);
  await hold(editId);
  await page.reload();
  await page.getByText("Scene opening images", { exact: true }).click();
  await expect(page.getByText("Versions (4) — preview and approve", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate opening 1", exact: true })).toBeDisabled();
  assert.equal((await stored(editId)).state.story.scenes[0].shots[0].prompt, edited);
  // Simulate terminal queue state in this isolated fixture, then reopen the saved
  // direction in the rendered UI (not just a database assertion).
  await pool.query("UPDATE obtv_production_projects SET state=jsonb_set(state,'{tasks}','[]'), revision=revision+1 WHERE id=$1 AND tenant_id=$2", [editId, tenantId]);
  await page.reload();
  await page.getByText("Scene opening images", { exact: true }).click();
  await page.getByRole("button", { name: "Generate opening 1", exact: true }).click();
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveValue(edited);
  pass("confirm persists replacement, queues three versions, invalidates old approval, and survives reload");
  pass("queued work disables generation controls after reload");
  await release();

  const staleId = await create();
  const tab = await context.newPage();
  await open(staleId, tab);
  await tab.getByLabel("Opening direction", { exact: true }).fill("Stale tab edit must remain visible");
  await open(staleId);
  await page.getByLabel("Opening direction", { exact: true }).fill("Fresh direction from the other tab");
  assert.equal((await confirm()).status(), 200);
  const rejected = await confirm(tab);
  assert.equal(rejected.status(), 400);
  assert.match((await rejected.json()).error, /current opening direction/);
  await expect(tab.getByLabel("Opening direction", { exact: true })).toHaveValue("Stale tab edit must remain visible");
  await expect(tab.getByText(/generate-scene-opening:.*current opening direction/)).toBeVisible();
  assert.equal((await stored(staleId)).state.story.scenes[0].shots[0].prompt, "Fresh direction from the other tab");
  pass("stale tab rejected by real API; error and draft retained");
  await tab.close();

  const queuedId = await create();
  await open(queuedId);
  await page.getByLabel("Opening direction", { exact: true }).fill("Cannot replace queued direction");
  // Populate the queue in another session after the review was opened.
  const current = await stored(queuedId);
  const queued = await api.post(`/api/production-projects/${queuedId}/actions`, {
    headers: { Origin: origin }, data: { revision: current.revision, action: "generate-scene-opening", payload: { sceneNumber: 1, expectedDirection: original, direction: original, count: 1 } },
  });
  assert.equal(queued.status(), 200);
  const blocked = await confirm();
  assert.equal(blocked.status(), 400);
  assert.match((await blocked.json()).error, /queued openings/);
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveValue("Cannot replace queued direction");
  assert.equal((await stored(queuedId)).state.story.scenes[0].shots[0].prompt, original);
  pass("same-scene queue rejects changed direction without replacing the draft");

  const errorId = await create();
  await open(errorId);
  const retained = "Keep this edited direction after a failed request.";
  await page.getByLabel("Opening direction", { exact: true }).fill(retained);
  const beforeFailure = await stored(errorId);
  await hold(errorId);
  const failed = await confirm();
  assert.equal(failed.status(), 409);
  await expect(page.getByText(/generate-scene-opening:.*being updated/)).toBeVisible();
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveValue(retained);
  assert.deepEqual(await stored(errorId), beforeFailure);
  await release();
  assert.equal((await confirm()).status(), 200);
  assert.equal((await stored(errorId)).state.story.scenes[0].shots[0].prompt, retained);
  await expect(page.getByLabel("Opening direction", { exact: true })).toHaveCount(0);
  pass("failed request retains draft without mutation; retry persists it");

  const correctionId = await create(fixture(true));
  await open(correctionId);
  await expect(page.getByRole("img", { name: "Subject approved reference", exact: true })).toHaveAttribute("src", wardrobeUrl);
  assert(await page.getByRole("img", { name: "Subject approved reference", exact: true }).evaluate(img => (img as HTMLImageElement).naturalWidth > 0));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Correct opening", { exact: true }).click();
  await page.getByLabel("Opening correction 1").fill("Widen the framing.");
  await page.getByRole("button", { name: "Review correction", exact: true }).click();
  await expect(page.getByText("Additional correction: Widen the framing.", { exact: true })).toBeVisible();
  await mkdir("generated-artifacts/opening-direction", { recursive: true });
  await page.screenshot({ path: "generated-artifacts/opening-direction/signed-in-review.png", fullPage: true });
  await page.getByLabel("Opening direction", { exact: true }).fill("Subject stands by the entrance in the approved coat.");
  const correctionResponse = await confirm();
  assert.equal(correctionResponse.status(), 200);
  const corrected = (await correctionResponse.json()).state;
  const task = corrected.tasks.at(-1);
  assert.equal(task.openingCorrection, "Widen the framing.");
  // The shared dispatch builder consumes exactly this persisted browser result.
  const dispatch = openingGenerationInputs(corrected, corrected.story.scenes[0], task.openingCorrection);
  assert.deepEqual(dispatch.ids, [ids.set, ids.wardrobe]);
  assert(!dispatch.ids.includes(ids.old) && !dispatch.ids.includes(ids.alternate));
  assert(dispatch.prompt.includes(corrected.story.scenes[0].shots[0].prompt));
  assert(dispatch.prompt.includes("Widen the framing."));
  pass("approved wardrobe preview renders; correction dispatch uses approved originals, not prior opening");

  const jobs = await pool.query("SELECT count(*)::int AS count FROM obtv_image_studio_jobs WHERE tenant_id=$1", [tenantId]);
  assert.equal(jobs.rows[0].count, 0, "Fixture must not submit GPU/provider jobs");
  console.log(`Completed ${passed.length} authenticated browser checks; no GPU/provider jobs submitted.`);
} finally {
  await browser?.close();
  // Remove projects before releasing a held lock; background runtime re-reads rows.
  await pool.query("DELETE FROM obtv_production_projects WHERE tenant_id=$1", [tenantId]);
  if (lockedId) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [`production:${lockedId}`]);
  lock?.release();
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.end();
}
