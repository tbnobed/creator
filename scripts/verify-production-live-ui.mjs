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
let temporaryProduction;
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
  if (characterId === "content" || characterId === "props" || characterId === "openings" || characterId === "openings-live") {
    const { rows: [original] } = await pool.query("SELECT state,title FROM obtv_production_projects WHERE id=$1", [projectId]);
    const state = original.state; state.step = 0; state.tasks = [];
    if(characterId==="openings-live" && original.title!=="Continuity verification — reviewed scene compositions")throw new Error("Live approval is restricted to the visually reviewed verification fixture.");
    if(characterId!=="openings-live") {
    temporaryProduction = randomUUID();
    await pool.query("INSERT INTO obtv_production_projects (id,tenant_id,created_by_user_id,title,state) VALUES ($1,$2,$3,'Content controls verification',$4)",
      [temporaryProduction, project.tenant_id, userId, JSON.stringify(state)]);
    }
    await page.goto(`/productions/${temporaryProduction ?? projectId}`);
    if (characterId === "openings" || characterId==="openings-live") {
      const createStep=page.getByTestId("button-step-4");
      await createStep.waitFor();
      if(await createStep.isEnabled())await createStep.click();
      assert(await page.getByRole("button",{name:/Create all scenes|Create remaining scenes/}).isDisabled());
      const openingPanel=page.locator("details").filter({has:page.getByText("Scene opening images",{exact:true})}).first();
      if(await openingPanel.getAttribute("open")===null)await page.getByText("Scene opening images",{exact:true}).click();
      for (const scene of state.story.scenes) await page.getByRole("button",{name:`Approve opening ${scene.sceneNumber}`,exact:true}).click();
      await page.waitForTimeout(500);
      assert(await page.getByRole("button",{name:/Create all scenes|Create remaining scenes/}).isEnabled(),"All approved scene compositions should permit rendering");
      await page.reload();
      const panel=page.locator("details").filter({has:page.getByText("Scene opening images",{exact:true})});
      if(!(await panel.getAttribute("open"))) await page.getByText("Scene opening images",{exact:true}).click();
      for(const scene of state.story.scenes)assert(await page.getByRole("button",{name:`Approve opening ${scene.sceneNumber}`,exact:true}).isDisabled(),"Approval must survive reload");
      await page.screenshot({path:"/tmp/scene-opening-approval-controls.png",fullPage:true});
      console.log("PASS scene opening review, explicit approvals, render gating and reload persistence; no render submitted.");
    } else if (characterId === "props") {
      await page.getByTestId("button-step-4").click();
      await page.getByText("Prop continuity · Optional",{exact:true}).click();
      await page.getByLabel("Prop appearance and relative size").fill("Test reference: preserve the exact wooden appearance and relative size.");
      await page.getByLabel("Upload prop reference").setInputFiles("artifacts/api-server/data/obtv-media/tenants/90b26d9c-35a6-44b9-b19d-a210890f8273/image-studio/afd030a8-90d9-42bc-86b7-202b90eddd74.png");
      await page.getByRole("button",{name:"Approve prop reference",exact:true}).click();
      await page.getByText("Prop continuity · Approved",{exact:true}).waitFor();
      await page.reload();
      await page.getByText("Prop continuity · Approved",{exact:true}).click();
      await page.getByLabel("Prop appearance and relative size").fill("Updated prop description and scale for review.");
      await page.getByRole("button",{name:"Save description for review",exact:true}).click();
      await page.getByText("Prop continuity · Needs review",{exact:true}).waitFor();
      assert(await page.getByRole("button",{name:/Create all scenes|Create remaining scenes/}).isDisabled(), "Unapproved prop changes must block rendering");
      await page.getByRole("button",{name:"Approve prop reference",exact:true}).click();
      await page.getByText("Prop continuity · Approved",{exact:true}).waitFor();
      await page.screenshot({path:"/tmp/prop-reference-controls.png",fullPage:true});
      await page.getByRole("button",{name:"Remove reference",exact:true}).click();
      await page.getByText("Prop continuity · Optional",{exact:true}).waitFor();
      console.log("PASS prop upload, explicit approval, reload persistence, and removal.");
    } else for (const step of [0,2,3,1]) {
      const stepButton = page.getByTestId(`button-step-${step}`);
      await stepButton.waitFor();
      if (await stepButton.isEnabled()) await stepButton.click();
      await page.screenshot({path:`/tmp/content-icons-${step}.png`,fullPage:true});
      await page.locator(`[data-testid^="content-edit-${step}-"]`).first().click();
      const dialog = page.getByRole("dialog");
      const label = step === 0 ? "Title" : "Name";
      await dialog.getByLabel(label, {exact:true}).fill(`Verified ${step}`);
      await dialog.getByRole("button", {name:"Save changes",exact:true}).click();
      await dialog.getByText(`Verified ${step}`,{exact:true}).waitFor();
      await page.screenshot({path:`/tmp/content-controls-${step}.png`,fullPage:true});
      await page.keyboard.press("Escape");
      await page.locator(`[data-testid^="content-remove-${step}-"]`).first().click();
      await dialog.getByRole("button", {name:"Confirm removal",exact:true}).click();
      await page.waitForTimeout(500);
      assert.equal(await dialog.getByText(`Verified ${step}`,{exact:true}).count(),0);
      await page.keyboard.press("Escape");
      console.log(`PASS live edit/save/remove for step ${step+1}`);
    }
    assert.equal(errors.length,0,errors.join("\\n"));
  } else if (characterId === "wardrobe") {
    const { rows: [original] } = await pool.query("SELECT state FROM obtv_production_projects WHERE id=$1", [projectId]);
    const state = original.state;
    state.step = 2;
    const outfit = state.wardrobes.at(-1);
    delete outfit.approvedAssetId;
    temporaryProduction = randomUUID();
    await pool.query("INSERT INTO obtv_production_projects (id,tenant_id,created_by_user_id,title,state) VALUES ($1,$2,$3,'Wardrobe UI verification',$4)",
      [temporaryProduction, project.tenant_id, userId, JSON.stringify(state)]);
    await page.goto(`/productions/${temporaryProduction}`);
    const card = page.getByTestId(`card-outfit-${outfit.id}`).locator("..");
    await card.getByRole("link", { name: "Inspect full image" }).waitFor();
    await card.getByRole("button", { name: "Approve outfit", exact: true }).click();
    await card.getByRole("button", { name: "Approved", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/wardrobe-native-controls.png", fullPage: true });
    await card.getByRole("button", { name: "Generate replacement" }).click();
    await page.getByTestId("button-generate-outfit").waitFor();
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS wardrobe full-image link, persisted approval and replacement form; isolated fixture only, no extra generation.");
  } else if (characterId) {
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
    if (i === 4) {
      await page.getByTestId("row-scene-1").locator("button").first().click();
      const previews = page.locator('[data-testid^="button-preview-shot-"]');
      assert(await previews.count() >= 2, "Both completed shots need preview controls");
      for (let n = 0; n < 2; n++) {
        const preview = previews.nth(n);
        const id = (await preview.getAttribute("data-testid")).replace("button-preview-shot-", "");
        await preview.click();
        const video = page.getByTestId(`video-shot-${id}`);
        await video.evaluate(async v => { v.muted = true; await v.play(); });
        await page.waitForTimeout(700);
        assert(await video.evaluate(v => v.currentTime > 0 && !v.error));
        await page.getByTestId(`button-correct-shot-${id}`).click();
        await page.getByTestId(`input-correction-${id}`).fill("Keep the ball small");
        assert(await video.isVisible(), "Preview must remain beside corrections");
        await page.screenshot({ path: `/tmp/shot-preview-${n}.png`, fullPage: true });
        await preview.click();
        assert.equal(await video.count(), 0, "Hiding preview must unmount and stop playback");
      }
      console.log("PASS individual shot playback, correction alongside preview, and closing players.");
    }
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
  if (temporaryProduction) await pool.query("DELETE FROM obtv_production_projects WHERE id=$1", [temporaryProduction]);
  await pool.query("DELETE FROM obtv_image_studio_assets WHERE created_by_user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_tenant_memberships WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.end();
}
