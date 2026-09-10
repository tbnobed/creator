// Run only after the development UI is ready: node scripts/test-spending-ui.mjs
// Uses isolated synthetic database fixtures and never submits generation jobs.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

if (process.env.NODE_ENV === "production") throw new Error("Development test only");
if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const require = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const chromiumPath = "/repl/tools/bin/chromium";
const runId = randomUUID();
const month = new Date().toISOString().slice(0, 7);
const periodStart = `${month}-01`;
const tenantIds = [];
const userIds = [];
let browser;

function tokenAndDigest() {
  const token = randomBytes(32).toString("hex");
  return { token, digest: createHash("sha256").update(token).digest("hex") };
}

async function createUser(label, { siteAdmin = false, email = true } = {}) {
  const userId = `spending-ui-${runId}-${label}`;
  const address = email ? `${label.toLowerCase()}.${runId}@spending-ui.test` : null;
  const { token, digest } = tokenAndDigest();
  await pool.query(
    `INSERT INTO obtv_users
       (id,email,password_hash,display_name,site_role)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, address, "synthetic-test-password-hash", `Spending ${label}`, siteAdmin ? "SITE_ADMIN" : "USER"],
  );
  await pool.query(
    "INSERT INTO obtv_auth_sessions (id,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '2 hours')",
    [digest, userId],
  );
  userIds.push(userId);
  return { userId, email: address, token, label };
}

async function createTenant(label, members) {
  const tenantId = randomUUID();
  const name = `Spending UI ${label} ${runId.slice(0, 8)}`;
  await pool.query(
    "INSERT INTO obtv_tenants (id,name,slug,created_by_user_id) VALUES ($1,$2,$3,$4)",
    [tenantId, name, `spending-ui-${label}-${runId}`, members[0].account.userId],
  );
  tenantIds.push(tenantId);
  for (const member of members) {
    await pool.query(
      `INSERT INTO obtv_tenant_memberships
         (tenant_id,user_id,role,monthly_limit_micros)
       VALUES ($1,$2,$3,$4)`,
      [tenantId, member.account.userId, member.role, member.limitMicros ?? null],
    );
    await pool.query("UPDATE obtv_users SET active_tenant_id=$1 WHERE id=$2", [
      tenantId,
      member.account.userId,
    ]);
  }
  return { tenantId, name };
}

async function seedEntry(tenant, account, role, {
  amountMicros,
  outcome,
  sourceType = "image",
  label,
}) {
  await pool.query(
    `INSERT INTO obtv_spending_entries
      (tenant_id,tenant_name,user_id,user_email,user_display_name,member_role,
       source_type,source_id,model_id,estimated_micros,pricing_note,period_start,
       outcome,settlement_note,settled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
       CASE WHEN $13='reserved' THEN NULL ELSE NOW() END)`,
    [
      tenant.tenantId, tenant.name, account.userId, account.email,
      `Spending ${account.label}`, role, sourceType,
      `spending-ui-${runId}-${label}`, "synthetic-no-provider-model", amountMicros,
      "Synthetic regression fixture; no provider request", periodStart, outcome,
      outcome === "reserved" ? null : "Synthetic settlement",
    ],
  );
}

async function api(account, path, options = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    ...options,
    headers: {
      cookie: `obtv_session=${account.token}`,
      origin,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const text = response.status === 204 ? "" : await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${path} (${response.status})`);
    }
  }
  return { status: response.status, body };
}

function expectOnlyUsers(report, expectedIds) {
  assert.deepEqual(
    report.rows.map((row) => row.userId).sort(),
    [...expectedIds].sort(),
  );
}

async function contextFor(account, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{
    name: "obtv_session",
    value: account.token,
    url: origin,
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  }]);
  return context;
}

function guardPaidJobRoutes(page, attempts) {
  page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST"
      && (/(?:^|\/)jobs(?:\/|$)/u.test(pathname) || /(?:^|\/)generate(?:\/|$)/u.test(pathname))
    ) {
      attempts.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 418,
        contentType: "application/json",
        body: JSON.stringify({ error: "Spending regression harness blocks paid jobs" }),
      });
      return;
    }
    await route.continue();
  });
}

try {
  const [siteAdmin, owner, admin, member, outsider, invited] = await Promise.all([
    createUser("SiteAdmin", { siteAdmin: true }),
    createUser("Owner"),
    createUser("Admin"),
    createUser("Member"),
    createUser("Outsider"),
    createUser("Invited"),
  ]);
  const tenant = await createTenant("Tenant", [
    { account: owner, role: "OWNER" },
    { account: admin, role: "ADMIN" },
    { account: member, role: "MEMBER", limitMicros: 10_000_000 },
  ]);
  const foreignTenant = await createTenant("Foreign", [
    { account: outsider, role: "OWNER", limitMicros: 8_000_000 },
  ]);
  // Existing authenticated accounts need a current workspace to reach the
  // invitation-acceptance endpoint, so give the invitee an isolated home.
  await createTenant("InviteeHome", [
    { account: invited, role: "OWNER" },
    { account: siteAdmin, role: "MEMBER" },
  ]);

  await seedEntry(tenant, owner, "OWNER", {
    amountMicros: 1_000_000, outcome: "reserved", label: "owner-reserved",
  });
  await seedEntry(tenant, member, "MEMBER", {
    amountMicros: 2_500_000, outcome: "estimated", label: "member-estimated", sourceType: "video",
  });
  await seedEntry(tenant, admin, "ADMIN", {
    amountMicros: 9_000_000, outcome: "released", label: "admin-released",
  });
  await seedEntry(foreignTenant, outsider, "OWNER", {
    amountMicros: 4_000_000, outcome: "uncertain", label: "foreign-uncertain",
  });

  // API visibility and negative permission queries.
  const ownerReport = await api(owner, `/spending?month=${month}`);
  assert.equal(ownerReport.status, 200);
  assert.equal(ownerReport.body.scope.tenantId, tenant.tenantId);
  expectOnlyUsers(ownerReport.body, [owner.userId, admin.userId, member.userId]);
  assert.equal(ownerReport.body.totals.totalUSD, 3.5);
  assert(!ownerReport.body.rows.some((row) => row.userId === outsider.userId));

  const adminReport = await api(admin, `/spending?month=${month}`);
  assert.equal(adminReport.status, 200);
  expectOnlyUsers(adminReport.body, [owner.userId, admin.userId, member.userId]);
  assert.equal(
    (await api(admin, `/spending?month=${month}&tenantId=${foreignTenant.tenantId}`)).status,
    404,
  );
  assert.equal(
    (await api(admin, `/spending/entries?month=${month}&tenantId=${foreignTenant.tenantId}`)).status,
    404,
  );

  const memberReport = await api(member, `/spending?month=${month}`);
  assert.equal(memberReport.status, 200);
  assert.equal(memberReport.body.scope.userId, member.userId);
  expectOnlyUsers(memberReport.body, [member.userId]);
  assert.equal(memberReport.body.totals.totalUSD, 2.5);
  assert.equal(
    (await api(member, `/spending/entries?month=${month}&userId=${admin.userId}`)).status,
    403,
  );
  const ownEntries = await api(member, `/spending/entries?month=${month}`);
  assert.equal(ownEntries.status, 200);
  assert.equal(ownEntries.body.total, 1);
  assert(ownEntries.body.entries.every((entry) => entry.userId === member.userId));

  const outsiderReport = await api(outsider, `/spending?month=${month}`);
  assert.equal(outsiderReport.status, 200);
  expectOnlyUsers(outsiderReport.body, [outsider.userId]);
  assert.equal(outsiderReport.body.totals.totalUSD, 4);

  const globalReport = await api(siteAdmin, `/spending?month=${month}`);
  assert.equal(globalReport.status, 200);
  assert.equal(globalReport.body.permissions.canViewAllTenants, true);
  assert.equal(globalReport.body.scope.tenantId, null);
  for (const fixtureUserId of [owner.userId, admin.userId, member.userId, outsider.userId]) {
    assert(globalReport.body.rows.some((row) => row.userId === fixtureUserId));
  }
  assert(
    Math.abs(
      globalReport.body.totals.totalUSD
      - globalReport.body.rows.reduce((sum, row) => sum + row.totalUSD, 0)
    ) < 0.000001,
    "Global administrator totals must cover all visible tenants",
  );
  assert.equal(
    globalReport.body.rows
      .filter((row) => tenantIds.includes(row.tenantId))
      .reduce((sum, row) => sum + row.totalUSD, 0),
    7.5,
  );

  assert.equal(
    (await api(owner, `/tenants/${tenant.tenantId}/members/${owner.userId}/spending-limit`, {
      method: "PUT", body: JSON.stringify({ monthlyLimitUsd: 1 }),
    })).status,
    403,
  );
  assert.equal(
    (await api(admin, `/tenants/${tenant.tenantId}/members/${owner.userId}/spending-limit`, {
      method: "PUT", body: JSON.stringify({ monthlyLimitUsd: 1 }),
    })).status,
    403,
  );
  assert.equal(
    (await api(admin, `/tenants/${foreignTenant.tenantId}/members/${outsider.userId}/spending-limit`, {
      method: "PUT", body: JSON.stringify({ monthlyLimitUsd: 1 }),
    })).status,
    404,
  );

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ["--no-sandbox"],
  });

  // Owner browser path: scoped view and both zero-blocking/unlimited edit states.
  const ownerContext = await contextFor(owner);
  const ownerPage = await ownerContext.newPage();
  const ownerErrors = [];
  const paidAttempts = [];
  ownerPage.on("pageerror", (error) => ownerErrors.push(error.message));
  guardPaidJobRoutes(ownerPage, paidAttempts);
  await ownerPage.goto(`${origin}/spending`);
  await ownerPage.getByRole("heading", { name: "Spending & Limits" }).waitFor();
  await ownerPage.getByText(member.email, { exact: true }).waitFor();
  assert.equal(await ownerPage.getByText(outsider.email, { exact: true }).count(), 0);
  await ownerPage.waitForTimeout(700);
  await ownerPage.screenshot({ path: "/tmp/spending-tenant.png", fullPage: true });

  const memberRow = ownerPage.getByRole("row").filter({ hasText: member.email });
  await memberRow.getByRole("button").click();
  let dialog = ownerPage.getByRole("dialog", { name: "Edit Monthly Limit" });
  await dialog.getByRole("spinbutton").fill("0");
  const zeroResponse = ownerPage.waitForResponse((response) =>
    response.request().method() === "PUT"
    && response.url().includes(`/members/${encodeURIComponent(member.userId)}/spending-limit`)
    && response.status() === 200);
  await dialog.getByRole("button", { name: "Save Limit" }).click();
  await zeroResponse;
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await api(owner, `/spending?month=${month}`)).body.rows
      .find((row) => row.userId === member.userId).monthlyLimitUsd,
    0,
    "A zero UI limit must persist and represent a complete block",
  );

  await memberRow.getByRole("button").click();
  dialog = ownerPage.getByRole("dialog", { name: "Edit Monthly Limit" });
  await dialog.getByRole("spinbutton").fill("");
  const unlimitedResponse = ownerPage.waitForResponse((response) =>
    response.request().method() === "PUT"
    && response.url().includes(`/members/${encodeURIComponent(member.userId)}/spending-limit`)
    && response.status() === 200);
  await dialog.getByRole("button", { name: "Save Limit" }).click();
  await unlimitedResponse;
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await api(owner, `/spending?month=${month}`)).body.rows
      .find((row) => row.userId === member.userId).monthlyLimitUsd,
    null,
    "A blank UI limit must persist as unlimited",
  );

  // Owner account invitation UI, then authenticated acceptance and propagation.
  await ownerPage.goto(`${origin}/account`);
  await ownerPage.getByRole("heading", { name: "Account & Workspace" }).waitFor();
  await ownerPage.getByRole("button", { name: "Invite User" }).click();
  const inviteDialog = ownerPage.getByRole("dialog", { name: "Invite Workspace Member" });
  await inviteDialog.getByLabel("Email Address").fill(invited.email);
  await inviteDialog.getByLabel("Monthly Spending Limit (USD)").fill("12.34");
  const invitationResponsePromise = ownerPage.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith(`/api/tenants/${tenant.tenantId}/members`)
    && response.status() === 201);
  await inviteDialog.getByRole("button", { name: "Create Invitation" }).click();
  const invitationBody = await (await invitationResponsePromise).json();
  assert.equal(invitationBody.monthlyLimitUsd, 12.34);
  await ownerPage.getByRole("dialog", { name: "Invitation Ready" })
    .getByText("$12.34", { exact: false }).waitFor();
  const accepted = await api(invited, "/tenant-invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token: invitationBody.token }),
  });
  assert.equal(accepted.status, 200, accepted.body?.error || "Invitation acceptance failed");
  const invitedMembership = await pool.query(
    `SELECT monthly_limit_micros
       FROM obtv_tenant_memberships WHERE tenant_id=$1 AND user_id=$2`,
    [tenant.tenantId, invited.userId],
  );
  assert.equal(Number(invitedMembership.rows[0].monthly_limit_micros), 12_340_000);

  // Site administrator browser path: cross-tenant total and ledger visibility.
  const siteContext = await contextFor(siteAdmin);
  const sitePage = await siteContext.newPage();
  const siteErrors = [];
  sitePage.on("pageerror", (error) => siteErrors.push(error.message));
  guardPaidJobRoutes(sitePage, paidAttempts);
  await sitePage.goto(`${origin}/spending`);
  await sitePage.getByRole("heading", { name: "Spending & Limits" }).waitFor();
  await sitePage.getByText(`$${globalReport.body.totals.totalUSD.toFixed(2)}`, { exact: true }).last().waitFor();
  await sitePage.getByText(tenant.name, { exact: true }).first().waitFor();
  await sitePage.getByText(foreignTenant.name, { exact: true }).first().waitFor();
  await sitePage.waitForTimeout(700);
  await sitePage.screenshot({ path: "/tmp/spending-admin.png", fullPage: true });
  await sitePage.getByRole("tab", { name: "Ledger Entries" }).click();
  await sitePage.getByText("synthetic-no-provider-model", { exact: true }).first().waitFor();

  await ownerPage.goto(`${origin}/spending`);
  await ownerPage.getByRole("heading", { name: "Spending & Limits" }).waitFor();
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  await ownerPage.getByText(member.email, { exact: true }).waitFor();
  await ownerPage.waitForTimeout(700);
  await ownerPage.screenshot({ path: "/tmp/spending-mobile.png", fullPage: true });
  assert.equal(
    await ownerPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2),
    false,
    "Mobile spending page must not overflow horizontally",
  );
  assert.deepEqual(ownerErrors, []);
  assert.deepEqual(siteErrors, []);
  assert.deepEqual(paidAttempts, [], "The spending harness must never attempt a paid job");
  await ownerContext.close();
  await siteContext.close();
  console.log("PASS: spending API scopes, limits, invitation propagation, UI, and responsive layout");
} finally {
  await browser?.close();
  try {
    if (tenantIds.length) {
      await pool.query(
        `DELETE FROM obtv_spending_events
         WHERE spending_entry_id IN
           (SELECT id FROM obtv_spending_entries WHERE tenant_id = ANY($1::uuid[]))`,
        [tenantIds],
      );
      await pool.query("DELETE FROM obtv_spending_entries WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM obtv_tenant_invitations WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("DELETE FROM obtv_tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [tenantIds]);
      await pool.query("UPDATE obtv_users SET active_tenant_id=NULL WHERE id = ANY($1::text[])", [userIds]);
      await pool.query("DELETE FROM obtv_tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
    }
    if (userIds.length) {
      await pool.query("DELETE FROM obtv_auth_sessions WHERE user_id = ANY($1::text[])", [userIds]);
      await pool.query("DELETE FROM obtv_users WHERE id = ANY($1::text[])", [userIds]);
    }
  } catch {
    console.error(`Fixture cleanup failed for isolated spending UI run ${runId}`);
  }
  await pool.end();
}