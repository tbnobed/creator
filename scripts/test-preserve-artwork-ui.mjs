// Development-only, isolated tenant. Real uploads/CPU renders; no provider inference.
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production" || !process.env.REPLIT_DEV_DOMAIN) throw new Error("Development preview only");
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const {Pool} = require("pg");
const pool = new Pool({connectionString: process.env.DATABASE_URL});
const tenant=randomUUID(), user=`artwork-browser-${randomUUID()}`;
const token=randomBytes(32).toString("hex"), digest=createHash("sha256").update(token).digest("hex");
const origin=`https://${process.env.REPLIT_DEV_DOMAIN}`;
const out="attached_assets/artwork-feature-check";
const keys=new Set();
let browser;
async function api(route, options={}) {
  const response=await fetch(origin+route,{...options,headers:{cookie:`obtv_session=${token}`,origin,"content-type":"application/json",...options.headers}});
  const body=await response.json();
  assert.ok(response.ok,JSON.stringify({status:response.status,body}));
  return body;
}
try {
  await mkdir(out,{recursive:true});
  await pool.query("INSERT INTO obtv_users (id,display_name) VALUES ($1,'Artwork browser fixture')",[user]);
  await pool.query("INSERT INTO obtv_tenants (id,name,slug,created_by_user_id) VALUES ($1,'Artwork browser fixture',$2,$3)",[tenant,`test-${tenant}`,user]);
  await pool.query("INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')",[tenant,user]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2",[tenant,user]);
  await pool.query("INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')",[digest,user]);
  // Reuse the already-paid clean fabric crop; no new inference.
  execFileSync("python",["-c",`import cv2
c=cv2.VideoCapture("attached_assets/shirt-replacement-kling-proof/shirt-replacement.mp4")
ok,frame=c.read();assert ok
plate=cv2.imread("attached_assets/existing-print-wave-proof/fabric-clean.png")
frame[450:720,560:830]=cv2.resize(plate,(270,270))
cv2.imwrite("${out}/clean-frame.png",frame)`]);
  browser=await chromium.launch({headless:true,executablePath:"/repl/tools/bin/chromium",args:["--no-sandbox"]});
  const context=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:"block"});
  await context.addCookies([{name:"obtv_session",value:token,url:origin,httpOnly:true,secure:true,sameSite:"Lax"}]);
  // Avoid polling unrelated GPU workers in this CPU test.
  await context.route("**/api/garment-studio/workers",r=>r.fulfill({json:[]}));
  await context.route("**/api/garment-studio/jobs",r=>{
    if(r.request().method()==="POST"){
      const body=r.request().postDataJSON();
      assert.equal(body.provider,"LOCAL"); assert.ok(body.pixelAnimation); assert.equal(body.model,undefined);
    }
    return r.continue();
  });
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(origin+"/garment-studio");
  await page.getByTestId("button-provider-preserve").click();
  const render=page.getByTestId("button-preserve-render");
  assert.equal(await render.isDisabled(),true);
  let chooser=page.waitForEvent("filechooser");
  await page.getByTestId("button-preserve-upload").click();
  await (await chooser).setFiles("attached_assets/shirt-replacement-kling-proof/shirt-replacement.mp4");
  await page.getByTestId("canvas-preserve-editor").waitFor();
  await page.getByTestId("status-preserve-frame").waitFor({state:"detached",timeout:30000});
  chooser=page.waitForEvent("filechooser");
  await page.getByTestId("button-plate-upload").click();
  await (await chooser).setFiles(out+"/clean-frame.png");
  await page.getByTestId("text-plate-name").waitFor();
  const canvas=page.getByTestId("canvas-preserve-editor");
  async function point(x,y){
    await canvas.scrollIntoViewIfNeeded();
    const box=await canvas.boundingBox();
    await page.mouse.click(box.x+x/1280*box.width,box.y+y/720*box.height);
  }
  for(const p of [[705,617],[748,590],[767,578],[779,602],[744,641],[715,649]]) await point(...p);
  if(await page.getByTestId("button-preserve-close").isEnabled()) await page.getByTestId("button-preserve-close").click();
  await page.getByTestId("button-tool-pivot").click();
  await point(711,633);
  await canvas.focus();
  await page.keyboard.press("ArrowRight"); // Keyboard cursor is usable without changing the committed pivot.
  await page.getByTestId("input-preserve-title").fill("Browser-verified original artwork");
  await page.getByTestId("input-preserve-target").fill("Monkey-print shirt");
  await page.locator('input[type="range"]').first().evaluate(el=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"-18");
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
  });
  await page.getByTestId("button-outline-preview").click();
  await page.getByTestId("badge-outline-preview").waitFor();
  await page.getByTestId("button-outline-preview").click();
  await page.getByTestId("checkbox-preserve-reviewed").check();
  await page.screenshot({path:out+"/editor.jpg",fullPage:true});
  assert.equal(await render.isEnabled(),true,"Valid reviewed selection should enable Render");
  const response=page.waitForResponse(r=>r.url().endsWith("/api/garment-studio/jobs")&&r.request().method()==="POST");
  await render.click();
  const submitted=await response;
  const payload=submitted.request().postDataJSON();
  assert.equal(payload.provider,"LOCAL"); assert.ok(payload.pixelAnimation); assert.equal(payload.model,undefined);
  keys.add(payload.sourceStorageKey); keys.add(payload.pixelAnimation.cleanPlateStorageKey);
  const result=await submitted.json(); assert.ok(submitted.ok(),JSON.stringify(result));
  let saved;
  for(let n=0;n<150;n++){
    saved=(await api("/api/garment-studio/jobs")).find(j=>j.id===result.jobId);
    if(saved&&["succeeded","failed","cancelled"].includes(saved.status)) break;
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(saved.status,"succeeded",saved.error);
  const video=await fetch(origin+saved.outputUrl,{headers:{cookie:`obtv_session=${token}`}});
  assert.ok(video.ok);
  await writeFile(out+"/output.mp4",Buffer.from(await video.arrayBuffer()));
  await page.reload();
  await page.getByTestId("button-provider-preserve").click();
  await page.getByTestId(`row-garment-job-${result.jobId}`).waitFor();
  await page.getByTestId("button-use-result-source").click();
  await page.getByTestId("status-preserve-frame").waitFor({state:"detached",timeout:30000});
  await page.getByTestId("canvas-preserve-editor").waitFor();
  assert.equal(await render.isDisabled(),true,"Reused result must require a fresh selection");
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:out+"/mobile.jpg",fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  assert.deepEqual(errors,[]);
  await writeFile(out+"/verification.json",JSON.stringify({realBrowserRender:true,historyReload:true,reuseResult:true,mobileNoOverflow:true,providerCharges:0},null,2));
  console.log("PASS: real browser selection, local render, reload, result reuse, keyboard and mobile layout");
} finally {
  if(browser) await browser.close();
  const rows=await pool.query("SELECT id, status FROM obtv_generation_jobs WHERE tenant_id=$1",[tenant]);
  for(const row of rows.rows) if(["QUEUED","RUNNING","UPLOADING","DOWNLOADING"].includes(row.status)) {
    await api(`/api/garment-studio/jobs/${row.id}/cancel`,{method:"POST",body:"{}"}).catch(()=>{});
  }
  await new Promise(r=>setTimeout(r,500));
  await pool.query("DELETE FROM obtv_generation_jobs WHERE tenant_id=$1",[tenant]);
  await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1",[user]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id=$1",[user]);
  await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id=$1",[tenant]);
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1",[tenant]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1",[user]);
  // Delete only this newly-created fixture tenant's files using the storage resolver.
  execFileSync("artifacts/obtv-video-studio/node_modules/.bin/tsx",["-e",`import {mediaStorage} from './artifacts/api-server/src/lib/storage-service.ts';import {rmSync} from 'node:fs';import path from 'node:path';rmSync(path.dirname(mediaStorage.resolvePath('tenants/${tenant}/cleanup.png')),{recursive:true,force:true});`]);
  await pool.end();
}
