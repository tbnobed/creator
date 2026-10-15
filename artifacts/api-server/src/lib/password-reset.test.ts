import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, usersTable, authSessionsTable, passwordResetsTable, authRateLimitsTable } from "@workspace/db";
import app from "../app";
import { hashPassword, verifyPassword } from "./auth-service";
import { resetDigest, resetMailConfig, sendPasswordReset, redeemPasswordReset, reserveResetAttempt } from "./password-reset";

test("portable password reset security and HTTP flow", async () => {
  const originalFetch = globalThis.fetch;
  const envNames = ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "PUBLIC_APP_URL"] as const;
  const originalEnv = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
  const id = randomUUID(), adminId = randomUUID(), legacyId = randomUUID();
  const email = `${id}@example.test`, adminEmail = `${adminId}@example.test`;
  const password = "Test fixture password 123!";
  const nextPassword = "Replacement fixture 456!";
  const deliveries: any[] = [];
  let providerFailure = false;
  // This test never contacts SendGrid. Credentials and sender are fixture-only.
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.sendgrid.com/v3/mail/send") {
      if (providerFailure) return new Response("", { status: 503 });
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }
    return originalFetch(input, init);
  };
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const post = (path: string, body: unknown, cookie?: string) => originalFetch(`http://127.0.0.1:${port}/api${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
  });
  const tokenFromLastMail = () => {
    const text = deliveries.at(-1).content[0].value as string;
    const match = text.match(/#token=([A-Za-z0-9_-]{43})/);
    assert.ok(match); return match[1];
  };
  try {
    const passwordHash = await hashPassword(password);
    await db.insert(usersTable).values([
      { id, email, passwordHash, displayName: "Reset test user" },
      { id: adminId, email: adminEmail, passwordHash, displayName: "Reset test admin", siteRole: "SITE_ADMIN" },
      { id: legacyId, email: `${legacyId}@example.test`, displayName: "Passwordless test" },
    ]);
    delete process.env.SENDGRID_API_KEY;
    assert.equal((await post("/auth/forgot-password", { email })).status, 503);
    process.env.SENDGRID_API_KEY = "test-not-a-real-key";
    process.env.SENDGRID_FROM_EMAIL = "noreply@example.test";
    process.env.PUBLIC_APP_URL = "https://studio.example.test";
    assert.throws(() => resetMailConfig({ PUBLIC_APP_URL: "http://evil.test", SENDGRID_API_KEY: "fake", SENDGRID_FROM_EMAIL: email }));

    const login = await post("/auth/login", { email, password });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const adminLogin = await post("/auth/login", { email: adminEmail, password });
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await post("/admin/password-reset", { email, currentPassword: password })).status, 401);
    assert.equal((await post("/admin/password-reset", { email, currentPassword: password }, cookie)).status, 403);
    assert.equal((await post("/admin/password-reset", { email, currentPassword: "wrong" }, adminCookie)).status, 403);
    assert.equal((await post("/admin/password-reset", { email, currentPassword: password }, adminCookie)).status, 204);
    const firstToken = tokenFromLastMail();
    assert.equal(deliveries.at(-1).tracking_settings.click_tracking.enable, false);
    const [stored] = await db.select().from(passwordResetsTable).where(eq(passwordResetsTable.userId, id));
    assert.equal(stored.tokenHash, resetDigest(firstToken));
    assert.notEqual(stored.tokenHash, firstToken);
    // Unknown accounts and known accounts receive identical public status/body.
    const known = await post("/auth/forgot-password", { email });
    const unknown = await post("/auth/forgot-password", { email: `${randomUUID()}@example.test` });
    assert.equal(known.status, 204); assert.equal(unknown.status, known.status);
    assert.equal(await known.text(), await unknown.text());
    const secondToken = tokenFromLastMail();
    assert.notEqual(firstToken, secondToken);
    assert.equal(await sendPasswordReset(`${legacyId}@example.test`), null);
    providerFailure = true;
    await assert.rejects(sendPasswordReset(email));
    providerFailure = false;
    assert.equal((await db.select().from(passwordResetsTable).where(eq(passwordResetsTable.userId, id))).length, 2);
    assert.equal((await post("/auth/reset-password", { token: firstToken, password: "short" })).status, 400);
    assert.equal((await post("/auth/reset-password", { token: firstToken, password: nextPassword })).status, 204);
    assert.equal(await redeemPasswordReset(firstToken, password), false);
    assert.equal(await redeemPasswordReset(secondToken, password), false);
    assert.equal((await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, id))).length, 0);
    assert.equal((await post("/auth/login", { email, password })).status, 401);
    assert.equal((await post("/auth/login", { email, password: nextPassword })).status, 204);
    // Two different valid tokens cannot both redeem across concurrent requests.
    await sendPasswordReset(email); const a = tokenFromLastMail();
    await sendPasswordReset(email); const b = tokenFromLastMail();
    const races = await Promise.all([redeemPasswordReset(a, password), redeemPasswordReset(b, password)]);
    assert.equal(races.filter(Boolean).length, 1);
    await sendPasswordReset(email); const expired = tokenFromLastMail();
    await db.update(passwordResetsTable).set({ expiresAt: new Date(0) }).where(eq(passwordResetsTable.tokenHash, resetDigest(expired)));
    assert.equal(await redeemPasswordReset(expired, nextPassword), false);
    assert.equal(await reserveResetAttempt("test", id, 1), true);
    assert.equal(await reserveResetAttempt("test", id, 1), false);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(await verifyPassword(password, user.passwordHash!), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envNames) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    await db.delete(usersTable).where(inArray(usersTable.id, [id, adminId, legacyId]));
    await db.delete(authRateLimitsTable).where(inArray(authRateLimitsTable.key, [
      resetDigest(`test:${id}`), resetDigest(`admin-reset:${adminId}`), resetDigest(`request-account:${email}`),
      resetDigest("request-ip:127.0.0.1"), resetDigest("redeem-ip:127.0.0.1"),
    ]));
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await pool.end();
  }
});
