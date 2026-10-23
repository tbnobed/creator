// Real login and real HTTPS application; no route interception or auth bypass.
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectId = process.argv[2];
const userId = `ui-verification-${randomUUID()}`;
const email = `${userId}@example.invalid`, password = randomBytes(32).toString("hex");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
let browser;
try {
  const { rows: [project] } = await pool.query("SELECT tenant_id FROM obtv_production_projects WHERE id=$1", [projectId]);
  if (!project) throw new Error("Verification project missing");
  // Provision a separate test member, never impersonate the existing creator.
  const salt = randomBytes(16);
  const hash = ["scrypt", "v1", 16384, 8, 1, salt.toString("base64url"),
    scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64*1024*1024 }).toString("base64url")].join("$");
  await pool.query("INSERT INTO obtv_users (id,email,password_hash,display_name,site_role,active_tenant_id) VALUES ($1,$2,$3,'UI verification member','USER',$4)",
    [userId, email, hash, project.tenant_id]);
  await pool.query("INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'MEMBER')", [project.tenant_id, userId]);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  const response = await context.request.post("/api/auth/login", { headers: { Origin: origin }, data: { email, password } });
  assert.equal(response.status(), 204, await response.text());
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const characterId = process.argv[3];
  if (characterId) {
    const dossierResponse = await context.request.get(`/api/characters/${characterId}/dossier`);
    assert.equal(dossierResponse.status(), 200);
    const dossier = await dossierResponse.json();
    assert(dossier.assets.length >= 6, "Selected look, four views and wardrobe must be visible");
    assert(dossier.wardrobes.length >= 1, "Outfit must be in shared dossier");
    assert(dossier.assets.some(a => a.id === dossier.wardrobes[0].referenceAssetId), "Outfit must link to a visible asset");
    await page.goto("/characters");
    await page.getByTestId(`button-edit-character-${characterId}`).click();
    await page.getByRole("tab", { name: "Visual References" }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "/tmp/production-character-references.png", fullPage: true });
    await page.getByRole("tab", { name: "Wardrobe", exact: true }).click();
    await page.locator('input[value="Blue vest"]').waitFor();
    await page.screenshot({ path: "/tmp/production-character-wardrobe.png", fullPage: true });
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS authenticated shared-library API, references tab and wardrobe tab.");
  } else {
  await page.goto(`/productions/${projectId}`);
  await page.getByTestId("nav-steps").waitFor({ timeout: 30000 });
  const directory = `/tmp/production-ui-${projectId}`;
  await mkdir(directory, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const button = page.getByTestId(`button-step-${i}`);
    if (await button.isEnabled()) await button.click();
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${directory}/step-${i+1}.png`, fullPage: true });
    assert.equal(errors.length, 0, errors.join("\n"));
    const text = await page.locator("body").innerText();
    if (/This production changed on the server|This project changed\.|Not saved/.test(text)) throw new Error(`Save conflict visible on step ${i+1}`);
    console.log(`PASS live UI step ${i+1}; screenshot ${directory}/step-${i+1}.png`);
  }
  const finalVideo = page.getByTestId("video-final-cut");
  if (await finalVideo.count()) {
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-testid="video-final-cut"]');
      return video && video.readyState >= 2 && video.duration > 0;
    }, { timeout: 30000 });
    const playback = await finalVideo.evaluate(async video => {
      video.muted = true;
      await video.play();
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, src: video.currentSrc };
    });
    await page.waitForTimeout(1200);
    assert(await finalVideo.evaluate(video => video.currentTime > 0 && !video.error), "Final cut must actually play");
    const downloaded = await context.request.get(playback.src);
    assert.equal(downloaded.status(), 200);
    assert((await downloaded.body()).length > 10000, "Export must contain video bytes");
    console.log("PASS assembled video playback and authenticated download:", JSON.stringify(playback));
    await page.screenshot({ path: `${directory}/final-playing.png`, fullPage: true });
  }
  }
} finally {
  await browser?.close();
  await pool.query("DELETE FROM obtv_tenant_memberships WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.end();
}
