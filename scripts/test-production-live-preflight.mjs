// Real HTTPS login and production API; isolated fixtures, no mocked API calls.
// Fails (rather than claiming end-to-end success) if rendering is blocked.
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { request } from "@playwright/test";
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const userId = `live-production-test-${randomUUID()}`;
const tenantId = randomUUID();
const password = randomBytes(32).toString("hex");
const email = `${userId}@example.invalid`;
let api;
try {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const hash = ["scrypt", "v1", 16384, 8, 1, salt.toString("base64url"), digest.toString("base64url")].join("$");
  await pool.query("INSERT INTO obtv_users (id,email,password_hash,display_name,site_role) VALUES ($1,$2,$3,'Live production test','USER')", [userId, email, hash]);
  await pool.query("INSERT INTO obtv_tenants (id,name,slug,created_by_user_id) VALUES ($1,'Live production test',$2,$3)", [tenantId, userId, userId]);
  await pool.query("INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenantId, userId]);
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  api = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  const login = await api.post("/api/auth/login", { data: { email, password } });
  assert.equal(login.status(), 204, await login.text());
  console.log("PASS real HTTPS login");
  const created = await api.post("/api/production-projects", { data: {
    title: "Live Long-Form verification — two shots",
    state: {
      story: { sourceMode: "script", script: "A lighthouse lamp turns on. The camera moves closer.", targetMinutes: 1,
        scenes: [{ sceneNumber: 1, title: "Lamp", location: "Lighthouse", timeOfDay: "Night", characters: [],
          action: "A lighthouse lamp turns on. The camera moves closer.", dialogue: "", durationSeconds: 10 }] },
      settings: { generationMode: "FIRST_LAST_FRAME_TO_VIDEO", videoProvider: "COMFYUI", width: 1280, height: 704, fps: 24, shotDurationSeconds: 5 },
    },
  } });
  assert.equal(created.status(), 201, await created.text());
  let project = await created.json();
  console.log("PASS create and save authored script");
  for (const step of [2, 3, 4, 5]) {
    const response = await api.patch(`/api/production-projects/${project.id}`, {
      data: { title: project.title, revision: project.revision, state: { step } },
    });
    assert.equal(response.status(), 200, await response.text());
    project = await response.json();
  }
  console.log("PASS save and navigate steps 2–5 (no asset generation)");
  const reloaded = await api.get(`/api/production-projects/${project.id}`);
  assert.equal(reloaded.status(), 200);
  assert.equal((await reloaded.json()).state.story.scenes.length, 1);
  console.log("PASS saved scene survives reload");
  const render = await api.post(`/api/production-projects/${project.id}/actions`, {
    data: { revision: project.revision, action: "prepare-render", payload: {} },
  });
  const result = await render.json();
  console.log(JSON.stringify({ stage: "prepare-render", httpStatus: render.status(), result }));
  if (!render.ok()) {
    console.log("BLOCKED: rendering, continuation, review and export were not reached. No GPU jobs submitted.");
    process.exitCode = 2;
  } else {
    // This diagnostic deliberately does not authorize an unbounded render batch.
    console.log("Preparation passed; a separate bounded render test is required.");
  }
} finally {
  await api?.dispose();
  await pool.query("DELETE FROM obtv_production_projects WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.end();
}
