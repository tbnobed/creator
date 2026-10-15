import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { db, usersTable, authSessionsTable, passwordResetsTable, authRateLimitsTable } from "@workspace/db";
import { hashPassword, normalizeEmail } from "./auth-service";

export class ResetMailUnavailable extends Error {}
export const resetDigest = (token: string) => createHash("sha256").update(`obtv-reset:${token}`).digest("hex");
export function resetMailConfig(env = process.env) {
  try {
    const url = new URL(env.PUBLIC_APP_URL ?? "");
    const sender = normalizeEmail(env.SENDGRID_FROM_EMAIL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        !sender || !env.SENDGRID_API_KEY) throw new Error();
    return { base: url.href.replace(/\/$/, ""), sender, key: env.SENDGRID_API_KEY };
  } catch { throw new ResetMailUnavailable("Password reset email is not configured"); }
}

/** Persistent counters shared by API processes; keys contain only a digest. */
export async function reserveResetAttempt(scope: string, value: string, limit: number) {
  const key = resetDigest(`${scope}:${value}`);
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await db.delete(authRateLimitsTable).where(lt(authRateLimitsTable.expiresAt, new Date()));
  const [row] = await db.insert(authRateLimitsTable).values({ key, count: 1, expiresAt })
    .onConflictDoUpdate({ target: authRateLimitsTable.key, set: {
      count: sql`least(${authRateLimitsTable.count} + 1, ${limit + 1})`,
    }}).returning();
  return row.count <= limit;
}

export async function sendPasswordReset(email: string): Promise<string | null> {
  const config = resetMailConfig();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = resetDigest(token);
  // Lock the account to serialize issuance against redemption. Existing links
  // remain valid on delivery failure; successful redemption invalidates them all.
  const userId = await db.transaction(async tx => {
    const [user] = await tx.select().from(usersTable).where(and(
      eq(usersTable.email, email), isNotNull(usersTable.passwordHash),
    )).for("update").limit(1);
    if (!user) return null;
    await tx.delete(passwordResetsTable).where(lt(passwordResetsTable.expiresAt, new Date()));
    await tx.insert(passwordResetsTable).values({
      tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return user.id;
  });
  if (!userId) return null;
  const link = `${config.base}/reset-password#token=${token}`;
  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: config.sender, name: "OBTV CreatorAI" },
        subject: "Reset your OBTV CreatorAI password",
        content: [{ type: "text/plain", value: `A password reset was requested for your account.\n\nChoose a new password using this single-use link (expires in 30 minutes):\n${link}\n\nYour existing sessions will be signed out when the password is changed. If you did not request this, ignore this email. Your password has not changed.` }],
        tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
      }),
    });
    if (response.status !== 202) throw new Error("Mail not accepted");
    return userId;
  } catch {
    await db.delete(passwordResetsTable).where(eq(passwordResetsTable.tokenHash, tokenHash));
    // Never propagate provider errors, which may contain recipient or token data.
    throw new ResetMailUnavailable("Email provider could not accept the reset message");
  }
}

export async function redeemPasswordReset(token: string, password: string) {
  const tokenHash = resetDigest(token);
  const [candidate] = await db.select().from(passwordResetsTable).where(and(
    eq(passwordResetsTable.tokenHash, tokenHash), gt(passwordResetsTable.expiresAt, new Date()),
  )).limit(1);
  if (!candidate) return false;
  const passwordHash = await hashPassword(password);
  return db.transaction(async tx => {
    const [user] = await tx.select().from(usersTable)
      .where(eq(usersTable.id, candidate.userId)).for("update").limit(1);
    if (!user?.passwordHash) return false; // Never enroll legacy/passwordless users.
    const [consumed] = await tx.delete(passwordResetsTable).where(and(
      eq(passwordResetsTable.tokenHash, tokenHash), gt(passwordResetsTable.expiresAt, new Date()),
    )).returning();
    if (!consumed) return false;
    await tx.update(usersTable).set({ passwordHash, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    await tx.delete(authSessionsTable).where(eq(authSessionsTable.userId, user.id));
    await tx.delete(passwordResetsTable).where(eq(passwordResetsTable.userId, user.id));
    return true;
  });
}
