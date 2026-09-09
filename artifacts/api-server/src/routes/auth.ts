import { createHash } from "node:crypto";
import { Router, type IRouter } from "express";
import { LoginBody, RegisterBody } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import {
  AUTH_COOKIE_NAME,
  authCookieSecure,
  BootstrapRegistrationError,
  deleteSession,
  DuplicateEmailError,
  InvalidInvitationError,
  loginUser,
  normalizeEmail,
  openRegistrationEnabled,
  performDummyPasswordVerification,
  registerUser,
  RegistrationDisabledError,
} from "../lib/auth-service";

const router: IRouter = Router();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_IP_LOGIN_ATTEMPTS = 30;
const MAX_ACCOUNT_LOGIN_ATTEMPTS = 10;
const MAX_REGISTRATIONS = 5;
const ipLoginAttempts = new Map<string, { count: number; startedAt: number }>();
const accountLoginAttempts = new Map<string, { count: number; startedAt: number }>();
const registrations = new Map<string, { count: number; startedAt: number }>();

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: authCookieSecure(),
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

function reserveAttempt(
  attempts: Map<string, { count: number; startedAt: number }>,
  key: string,
  limit: number,
  now: number,
): boolean {
  if (attempts.size > 10_000) {
    for (const [candidateKey, candidate] of attempts) {
      if (now - candidate.startedAt >= WINDOW_MS) attempts.delete(candidateKey);
    }
  }
  const entry = attempts.get(key);
  if (!entry || now - entry.startedAt >= WINDOW_MS) {
    attempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

function releaseAttempt(
  attempts: Map<string, { count: number; startedAt: number }>,
  key: string,
): void {
  const entry = attempts.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) attempts.delete(key);
}

function consumeRegistrationAttempt(ip: string, now: number): boolean {
  return reserveAttempt(registrations, ip, MAX_REGISTRATIONS, now);
}

function accountAttemptKey(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

router.get("/auth/config", async (_req, res): Promise<void> => {
  const [passwordUser] = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(isNotNull(usersTable.passwordHash))
    .limit(1);
  res.json({
    registrationEnabled: openRegistrationEnabled(),
    bootstrapAvailable: !passwordUser,
  });
});

router.post("/auth/register", async (req, res): Promise<void> => {
  const now = Date.now();
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (!consumeRegistrationAttempt(ip, now)) {
    res.status(429).json({ error: "Too many registration attempts" });
    return;
  }
  const parsed = RegisterBody.safeParse(req.body);
  const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
  const displayName = parsed.success ? parsed.data.displayName.trim() : "";
  if (!parsed.success || !email || !displayName) {
    res.status(400).json({ error: "A valid email, display name, and 12-128 character password are required" });
    return;
  }
  try {
    const token = await registerUser({
      email,
      password: parsed.data.password,
      displayName,
      invitationToken: parsed.data.invitationToken,
      bootstrapToken: parsed.data.bootstrapToken,
      priorToken: req.cookies?.[AUTH_COOKIE_NAME],
    });
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof DuplicateEmailError) {
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }
    if (error instanceof BootstrapRegistrationError) {
      res.status(403).json({ error: "Initial administrator registration is restricted by server configuration" });
      return;
    }
    if (error instanceof InvalidInvitationError) {
      res.status(400).json({ error: "The workspace invitation is invalid, expired, or belongs to another email" });
      return;
    }
    if (error instanceof RegistrationDisabledError) {
      res.status(403).json({ error: "Public account registration is disabled" });
      return;
    }
    throw error;
  }
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const now = Date.now();
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (!reserveAttempt(ipLoginAttempts, ip, MAX_IP_LOGIN_ATTEMPTS, now)) {
    res.status(429).json({ error: "Too many authentication attempts" });
    return;
  }
  const parsed = LoginBody.safeParse(req.body);
  const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
  if (!parsed.success || !email) {
    if (parsed.success) await performDummyPasswordVerification(parsed.data.password);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  const accountKey = accountAttemptKey(email);
  if (!reserveAttempt(accountLoginAttempts, accountKey, MAX_ACCOUNT_LOGIN_ATTEMPTS, now)) {
    res.status(429).json({ error: "Too many authentication attempts" });
    return;
  }
  const token = await loginUser(
    email,
    parsed.data.password,
    req.cookies?.[AUTH_COOKIE_NAME],
  );
  if (!token) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  releaseAttempt(ipLoginAttempts, ip);
  releaseAttempt(accountLoginAttempts, accountKey);
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
  res.sendStatus(204);
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: authCookieSecure(),
    path: "/",
  });
  await deleteSession(req.cookies?.[AUTH_COOKIE_NAME]);
  res.sendStatus(204);
});

export default router;
