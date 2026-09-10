// Development-only: PROMPT_ONLY_RENDER=1 enables one short local GPU render.
// Never submits paid Cloud work or creates a password account.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production" || !process.env.REPLIT_DEV_DOMAIN) {
  throw new Error("Run only against the Replit development preview");
}
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const userId = `prompt-only-test-${randomUUID()}`;
const tenantId = randomUUID();
const token = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(token).digest("hex");
let browser;

async function api(path, options = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    ...options,
    headers: { origin, cookie: `obtv_session=${token}`, "content-type": "application/json" },
  });
  const body = response.status === 204 ? null : await response.json();
  assert(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  await pool.query("INSERT INTO obtv_users(id,display_name) VALUES($1,'Prompt-only test')", [userId]);
  await pool.query("INSERT INTO obtv_tenants(id,name,slug) VALUES($1,'Prompt-only test',$2)", [tenantId, `test-${tenantId}`]);
  await pool.query("INSERT INTO obtv_tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  await pool.query("INSERT INTO obtv_auth_sessions(id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 hour')", [digest, userId]);
  const capabilities = await api("/generation-capabilities");
  const h3 = capabilities.filter(cap => cap.modelFamily === "MiniMax H3" && !cap.supportsReferenceVideo);
  assert(h3.length > 0);
  assert(h3.every(cap => cap.supportsCharacterReferences && !cap.requiresCharacterReferences && !cap.requiresSettingReference));

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  await context.addCookies([{ name: "obtv_session", value: token, url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}/studio`);
  await page.getByRole("tab", { name: "3. Write Shot" }).click();
  await page.getByPlaceholder(/^Paste the complete shot prompt here/).fill(
    "A cinematic wide shot of an ancient stone courtyard at dawn. Slow dolly forward. No speech.",
  );
  const renderButton = page.getByRole("button", { name: /SEND TO RENDER/i });
  await renderButton.waitFor();
  assert(await renderButton.isEnabled(), "Prompt-only rendering must be enabled without cast, environment, or video");
  await page.screenshot({ path: "/tmp/prompt-only-composer.jpg", fullPage: true });
  console.log("PASS: H3 capabilities and real HTTPS composer allow prompt-only video");

  if (process.env.PROMPT_ONLY_RENDER === "1") {
    // Do not queue test work behind someone else's render on the shared workers.
    const { rows: workers } = await pool.query(
      "SELECT api_base_url FROM obtv_comfy_servers WHERE enabled=true AND status='ONLINE' AND tags @> ARRAY['minimax-h3']::text[]",
    );
    assert(workers.length > 0);
    for (const worker of workers) {
      const queue = await (await fetch(new URL("queue", worker.api_base_url), { signal: AbortSignal.timeout(10000) })).json();
      assert.equal((queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0), 0, "Shared GPU is busy; do not submit test work");
    }
    const job = await api("/generations", {
      method: "POST",
      body: JSON.stringify({
        provider: "COMFYUI", generationMode: h3[0].generationMode,
        prompt: "A cinematic wide shot of an ancient stone courtyard at dawn. Slow dolly forward. No speech.",
        width: 512, height: 512, durationSeconds: 1, fps: 24,
        qualityPreset: "DRAFT", seedMode: "FIXED", seed: 8173, voiceCloningEnabled: false,
      }),
    });
    console.log("Submitted one local prompt-only render without any reference assets");
    const deadline = Date.now() + 12 * 60 * 1000;
    let state = job;
    let previousStatus;
    while (!["COMPLETED", "FAILED", "CANCELLED"].includes(state.status) && Date.now() < deadline) {
      if (state.status !== previousStatus) console.log(`Render status: ${state.status}`);
      previousStatus = state.status;
      await new Promise(resolve => setTimeout(resolve, 5000));
      state = await api(`/generations/${job.id}`);
    }
    assert.equal(state.status, "COMPLETED", state.errorMessage || "Render did not complete in time");
    assert(state.outputUrl);
    const output = await fetch(new URL(state.outputUrl, origin), { headers: { cookie: `obtv_session=${token}` } });
    assert(output.ok);
    assert((await output.arrayBuffer()).byteLength > 1024, "Generated video must not be empty");
    console.log("PASS: real prompt-only local video completed and its output is downloadable");
  }
} finally {
  await browser?.close();
  const { rows: jobs } = await pool.query("SELECT id,status FROM obtv_generation_jobs WHERE tenant_id=$1", [tenantId]);
  for (const job of jobs) {
    if (["UPLOADING", "QUEUED", "RUNNING", "DOWNLOADING"].includes(job.status)) {
      await api(`/generations/${job.id}/cancel`, { method: "POST", body: "{}" });
    }
    await api(`/generations/${job.id}`, { method: "DELETE" });
  }
  await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_tenant_memberships WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [tenantId]);
  await pool.end();
}