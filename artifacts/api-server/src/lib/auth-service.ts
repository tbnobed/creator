import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import {
  authSessionsTable,
  db,
  tenantInvitationsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";

const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const HASH_LENGTH = 64;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_COOKIE_NAME = "obtv_session";

const dummyHashPromise = hashPassword("OBTV dummy password verification");

export class DuplicateEmailError extends Error {}
export class BootstrapRegistrationError extends Error {}
export class InvalidInvitationError extends Error {}
export class RegistrationDisabledError extends Error {}

export function openRegistrationEnabled(): boolean {
  const configured = process.env.AUTH_ALLOW_REGISTRATION;
  return configured === undefined ? true : configured.trim().toLowerCase() === "true";
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length === 0 || email.length > 320 || /[\s\u0000-\u001f\u007f]/u.test(email)) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length === 0 || domain.length > 255) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const labels = domain.split(".");
  if (labels.some((label) =>
    label.length === 0
    || label.length > 63
    || label.startsWith("-")
    || label.endsWith("-")
    || !/^[a-z0-9-]+$/u.test(label)
  )) return null;
  return email;
}

function derivePassword(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, HASH_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    "v1",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const cost = Number(parts[2]);
  const blockSize = Number(parts[3]);
  const parallelization = Number(parts[4]);
  if (
    cost !== SCRYPT_COST
    || blockSize !== SCRYPT_BLOCK_SIZE
    || parallelization !== SCRYPT_PARALLELIZATION
  ) return false;
  try {
    const salt = Buffer.from(parts[5], "base64url");
    const expected = Buffer.from(parts[6], "base64url");
    if (salt.length !== 16 || expected.length !== HASH_LENGTH) return false;
    const actual = await derivePassword(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function performDummyPasswordVerification(password: string): Promise<void> {
  await verifyPassword(password, await dummyHashPromise);
}

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestInvitationToken(token: string): string {
  return createHash("sha256").update(`obtv-invitation:${token}`).digest("hex");
}

async function createSession(
  executor: Pick<typeof db, "insert" | "delete">,
  userId: string,
  priorToken?: string,
): Promise<string> {
  await executor.delete(authSessionsTable)
    .where(lt(authSessionsTable.expiresAt, new Date()));
  if (priorToken) {
    await executor.delete(authSessionsTable)
      .where(eq(authSessionsTable.id, digestSessionToken(priorToken)));
  }
  const token = randomBytes(32).toString("base64url");
  await executor.insert(authSessionsTable).values({
    id: digestSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  return token;
}

function personalTenantName(displayName: string): string {
  return `${displayName.trim() || "My"} Studio`;
}

export async function registerUser(input: {
  email: string;
  password: string;
  displayName: string;
  invitationToken?: string;
  bootstrapToken?: string;
  priorToken?: string;
}): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('obtv:first-user'))`);
      const [priorPasswordUser] = await tx.select({ id: usersTable.id })
        .from(usersTable)
        .where(isNotNull(usersTable.passwordHash))
        .limit(1);
      const first = !priorPasswordUser;
      const configuredInitialAdmin = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL ?? "");
      const configuredBootstrapToken = process.env.AUTH_BOOTSTRAP_TOKEN ?? "";
      const suppliedBootstrapToken = input.bootstrapToken ?? "";
      const validBootstrapToken = configuredBootstrapToken.length >= 32
        && timingSafeEqual(
          createHash("sha256").update(configuredBootstrapToken).digest(),
          createHash("sha256").update(suppliedBootstrapToken).digest(),
        );
      if (
        first
        && (
          (process.env.NODE_ENV === "production" && !configuredInitialAdmin)
          || (configuredInitialAdmin && configuredInitialAdmin !== input.email)
          || (process.env.NODE_ENV === "production" && !validBootstrapToken)
          || (configuredBootstrapToken && !validBootstrapToken)
        )
      ) {
        throw new BootstrapRegistrationError();
      }

      let invitation: typeof tenantInvitationsTable.$inferSelect | undefined;
      if (input.invitationToken) {
        [invitation] = await tx.select().from(tenantInvitationsTable)
          .where(eq(tenantInvitationsTable.tokenHash, digestInvitationToken(input.invitationToken)))
          .limit(1);
        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
          if (invitation) {
            await tx.delete(tenantInvitationsTable).where(eq(tenantInvitationsTable.id, invitation.id));
          }
          throw new InvalidInvitationError();
        }
        if (invitation.email !== input.email) throw new InvalidInvitationError();
      }
      if (!first && !invitation && !openRegistrationEnabled()) {
        throw new RegistrationDisabledError();
      }

      const [existing] = await tx.select().from(usersTable)
        .where(eq(usersTable.email, input.email))
        .limit(1);
      if (existing?.passwordHash) throw new DuplicateEmailError();
      if (
        existing
        && !first
        && (
          !invitation
          || !invitation.allowsPasswordEnrollment
          || invitation.targetUserId !== existing.id
        )
      ) throw new DuplicateEmailError();

      const userId = existing?.id ?? randomUUID();
      const [user] = existing
        ? await tx.update(usersTable).set({
          passwordHash,
          displayName: input.displayName,
          ...(first ? { siteRole: "SITE_ADMIN" as const } : {}),
        }).where(eq(usersTable.id, existing.id)).returning()
        : await tx.insert(usersTable).values({
          id: userId,
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          siteRole: first ? "SITE_ADMIN" : "USER",
        }).returning();

      let tenant = first
        ? (await tx.select().from(tenantsTable).where(eq(tenantsTable.isDefault, true)).limit(1))[0]
        : undefined;
      if (!tenant && existing?.activeTenantId) {
        const [existingMembership] = await tx.select().from(tenantMembershipsTable).where(and(
          eq(tenantMembershipsTable.userId, userId),
          eq(tenantMembershipsTable.tenantId, existing.activeTenantId),
        )).limit(1);
        if (existingMembership) {
          [tenant] = await tx.select().from(tenantsTable)
            .where(eq(tenantsTable.id, existingMembership.tenantId))
            .limit(1);
        }
      }
      if (!tenant && invitation) {
        [tenant] = await tx.select().from(tenantsTable)
          .where(eq(tenantsTable.id, invitation.tenantId))
          .limit(1);
      }
      if (!tenant) {
        [tenant] = await tx.insert(tenantsTable).values({
          name: first ? "OBTV" : personalTenantName(input.displayName),
          slug: `${first ? "obtv" : "studio"}-${randomUUID().slice(0, 8)}`,
          isDefault: first,
          createdByUserId: userId,
        }).returning();
      } else if (!tenant.createdByUserId || tenant.createdByUserId === "__obtv_legacy__") {
        [tenant] = await tx.update(tenantsTable)
          .set({ createdByUserId: userId })
          .where(eq(tenantsTable.id, tenant.id))
          .returning();
      }
      const primaryMembership = {
        tenantId: tenant.id,
        userId,
        role: first || !invitation ? "OWNER" as const : invitation.role,
      };
      if (first) {
        await tx.insert(tenantMembershipsTable).values(primaryMembership).onConflictDoUpdate({
          target: [tenantMembershipsTable.tenantId, tenantMembershipsTable.userId],
          set: { role: "OWNER" },
        });
      } else {
        await tx.insert(tenantMembershipsTable).values(primaryMembership).onConflictDoNothing();
      }
      if (invitation) {
        await tx.insert(tenantMembershipsTable).values({
          tenantId: invitation.tenantId,
          userId,
          role: invitation.role,
        }).onConflictDoNothing();
        await tx.delete(tenantInvitationsTable).where(eq(tenantInvitationsTable.id, invitation.id));
      }
      await tx.update(usersTable)
        .set({ activeTenantId: tenant.id })
        .where(eq(usersTable.id, user.id));
      return createSession(tx, userId, input.priorToken);
    });
  } catch (error) {
    if (
      error instanceof DuplicateEmailError
      || error instanceof BootstrapRegistrationError
      || error instanceof InvalidInvitationError
      || error instanceof RegistrationDisabledError
    ) throw error;
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "23505"
      && "constraint" in error
      && error.constraint === "obtv_users_email_unique"
    ) throw new DuplicateEmailError();
    throw error;
  }
}

export async function loginUser(
  email: string,
  password: string,
  priorToken?: string,
): Promise<string | null> {
  const [user] = await db.select().from(usersTable).where(and(
    eq(usersTable.email, email),
    isNotNull(usersTable.passwordHash),
  )).limit(1);
  if (!user?.passwordHash) {
    await performDummyPasswordVerification(password);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return db.transaction((tx) => createSession(tx, user.id, priorToken));
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(authSessionsTable).where(eq(authSessionsTable.id, digestSessionToken(token)));
}

export function authCookieSecure(): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "true") return true;
  if (process.env.AUTH_COOKIE_SECURE === "false") return false;
  return process.env.NODE_ENV === "production";
}
