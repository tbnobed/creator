import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = "http://localhost:80";
const userId = `server-order-test-${randomUUID()}`;
const tenantId = randomUUID();
const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
const token = randomBytes(32).toString("hex");
const digest = createHash("sha256").update(token).digest("hex");

async function api(path, options = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    ...options,
    headers: { origin, cookie: `obtv_session=${token}`, "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  await pool.query(
    "INSERT INTO obtv_users (id, display_name, site_role) VALUES ($1, 'Ordering test', 'SITE_ADMIN')",
    [userId],
  );
  await pool.query(
    "INSERT INTO obtv_tenants (id, name, slug) VALUES ($1, 'Ordering test', $2)",
    [tenantId, `order-test-${tenantId}`],
  );
  await pool.query(
    "INSERT INTO obtv_tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')",
    [tenantId, userId],
  );
  await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [tenantId, userId]);
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '10 minutes')",
    [digest, userId],
  );
  // Reverse insertion order and identical timestamps exercise the ID tie-breaker.
  for (const id of [...ids].reverse()) {
    await pool.query(
      `INSERT INTO obtv_comfy_servers
         (id,display_name,hostname,api_base_url,websocket_url,enabled,created_at)
       VALUES ($1,'Ordering test','192.0.2.1','http://192.0.2.1:8188/',
               'ws://192.0.2.1:8188/ws',false,'2020-01-01T00:00:00Z')`,
      [id],
    );
  }
  const before = await api("/servers");
  assert.deepEqual(before.filter(row => ids.includes(row.id)).map(row => row.id), ids);
  const order = before.map(row => row.id);
  for (const id of ids) {
    await api(`/servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: `Edited ${id}`, tags: ["ordering-test"] }),
    });
    await pool.query(
      "UPDATE obtv_comfy_servers SET last_heartbeat=NOW(), updated_at=NOW() WHERE id=$1",
      [id],
    );
    const after = await api("/servers");
    assert.deepEqual(after.map(row => row.id), order, "Editing or health updates moved a card");
    assert.equal(after.find(row => row.id === id).displayName, `Edited ${id}`);
  }
  console.log("PASS: worker order remains stable across edits and health updates, including timestamp ties");
} finally {
  await pool.query("DELETE FROM obtv_comfy_servers WHERE id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_tenant_memberships WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM obtv_users WHERE id=$1", [userId]);
  await pool.query("DELETE FROM obtv_tenants WHERE id=$1", [tenantId]);
  await pool.end();
}