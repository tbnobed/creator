import { Router, type IRouter } from "express";
import { setTimeout as delay } from "node:timers/promises";
import { RequestPasswordResetBody, RedeemPasswordResetBody, AdminPasswordResetBody } from "@workspace/api-zod";
import { requireAuth, requireSiteAdmin } from "../middlewares/auth";
import { AUTH_COOKIE_NAME, authCookieSecure, normalizeEmail, verifyPassword } from "../lib/auth-service";
import { redeemPasswordReset, reserveResetAttempt, resetMailConfig, ResetMailUnavailable, sendPasswordReset } from "../lib/password-reset";

const router: IRouter = Router();
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.post("/auth/forgot-password", async (req, res) => {
  const started = Date.now();
  if (!await reserveResetAttempt("request-ip", req.ip ?? "unknown", 15)) {
    res.status(429).json({ error: "Too many requests. Try again in 15 minutes." }); return;
  }
  const parsed = RequestPasswordResetBody.safeParse(req.body);
  const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
  if (!email) { res.status(400).json({ error: "Enter a valid email address." }); return; }
  try { resetMailConfig(); } catch {
    res.status(503).json({ error: "Password reset email is not configured. Contact your site administrator." }); return;
  }
  try {
    if (await reserveResetAttempt("request-account", email, 3)) await sendPasswordReset(email);
  } catch (error) {
    if (!(error instanceof ResetMailUnavailable)) throw error;
    req.log.warn("Password reset delivery failed; check SendGrid configuration");
  }
  // Same content/status and response floor for unknown, throttled and real
  // accounts. Provider timeout is shorter than this floor to mask delivery timing.
  await delay(Math.max(0, 7_000 - (Date.now() - started)));
  res.sendStatus(204);
});

router.post("/auth/reset-password", async (req, res) => {
  if (!await reserveResetAttempt("redeem-ip", req.ip ?? "unknown", 30)) {
    res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." }); return;
  }
  const parsed = RedeemPasswordResetBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A valid reset link and a 12–128 character password are required." }); return; }
  if (!await redeemPasswordReset(parsed.data.token, parsed.data.password)) {
    res.status(400).json({ error: "This reset link is invalid, expired, or already used. Request a new link." }); return;
  }
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: authCookieSecure(), path: "/" });
  res.sendStatus(204);
});

router.post("/admin/password-reset", requireAuth, requireSiteAdmin, async (req, res) => {
  const admin = req.context!.user;
  if (!await reserveResetAttempt("admin-reset", admin.id, 10)) {
    res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." }); return;
  }
  const parsed = AdminPasswordResetBody.safeParse(req.body);
  const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
  if (!parsed.success || !email) { res.status(400).json({ error: "A valid email and your current password are required." }); return; }
  if (!admin.passwordHash || !await verifyPassword(parsed.data.currentPassword, admin.passwordHash)) {
    res.status(403).json({ error: "Your current administrator password is incorrect." }); return;
  }
  try {
    const targetUserId = await sendPasswordReset(email);
    if (!targetUserId) { res.status(404).json({ error: "No password-enabled account exists for this email." }); return; }
    req.log.info({ actorUserId: admin.id, targetUserId, action: "admin_password_reset_email" }, "Administrator requested password reset");
    res.sendStatus(204);
  } catch (error) {
    if (!(error instanceof ResetMailUnavailable)) throw error;
    res.status(503).json({ error: "Reset email could not be sent. Check SendGrid and PUBLIC_APP_URL configuration." });
  }
});
export default router;
