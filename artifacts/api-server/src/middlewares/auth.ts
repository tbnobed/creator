import { clerkClient, getAuth } from "@clerk/express";
import { and, eq, ne, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";

export type RequestContext = {
  user: typeof usersTable.$inferSelect;
  tenant: typeof tenantsTable.$inferSelect | null;
  membership: typeof tenantMembershipsTable.$inferSelect | null;
};

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext;
    }
  }
}

function personalTenantName(displayName: string): string {
  return `${displayName.trim() || "My"} Studio`;
}

async function clerkProfile(userId: string): Promise<{ email: string | null; displayName: string }> {
  const remote = await clerkClient.users.getUser(userId);
  const email = remote.primaryEmailAddress?.emailAddress?.trim().toLowerCase()
    ?? remote.emailAddresses[0]?.emailAddress?.trim().toLowerCase()
    ?? null;
  const displayName = remote.fullName?.trim()
    || remote.username?.trim()
    || email?.split("@")[0]
    || "OBTV User";
  return { email, displayName: displayName.slice(0, 160) };
}

async function provisionUser(userId: string) {
  const existing = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  if (existing) return existing;
  const profile = await clerkProfile(userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('obtv:first-user'))`);
    const concurrent = await tx.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
    if (concurrent) return concurrent;
    const [priorUser] = await tx.select({ id: usersTable.id })
      .from(usersTable)
      .where(ne(usersTable.id, "__obtv_legacy__"))
      .limit(1);
    const first = !priorUser;
    const [created] = await tx.insert(usersTable).values({
      id: userId,
      email: profile.email,
      displayName: profile.displayName,
      siteRole: first ? "SITE_ADMIN" : "USER",
    }).returning();
    let tenant = first
      ? (await tx.select().from(tenantsTable).where(eq(tenantsTable.isDefault, true)).limit(1))[0]
      : undefined;
    if (!tenant) {
      [tenant] = await tx.insert(tenantsTable).values({
        name: first ? "OBTV" : personalTenantName(profile.displayName),
        slug: `${first ? "obtv" : "studio"}-${crypto.randomUUID().slice(0, 8)}`,
        isDefault: first,
        createdByUserId: userId,
      }).returning();
    } else if (!tenant.createdByUserId || tenant.createdByUserId === "__obtv_legacy__") {
      [tenant] = await tx.update(tenantsTable)
        .set({ createdByUserId: userId })
        .where(eq(tenantsTable.id, tenant.id))
        .returning();
    }
    await tx.insert(tenantMembershipsTable).values({
      tenantId: tenant.id,
      userId,
      role: "OWNER",
    }).onConflictDoNothing();
    const [updated] = await tx.update(usersTable)
      .set({ activeTenantId: tenant.id })
      .where(eq(usersTable.id, userId))
      .returning();
    return updated ?? created;
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = getAuth(req);
  const claimedUserId = auth?.sessionClaims?.userId;
  const userId = typeof claimedUserId === "string" ? claimedUserId : auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const user = await provisionUser(userId);
    req.context = { user, tenant: null, membership: null };
    next();
  } catch (error) {
    req.log.error({ err: error, clerkUserId: userId }, "Could not provision authenticated user");
    res.status(503).json({ error: "Account provisioning is temporarily unavailable" });
  }
}

export async function requireTenant(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.context?.user;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let membership = user.activeTenantId
    ? (await db.select().from(tenantMembershipsTable).where(and(
      eq(tenantMembershipsTable.userId, user.id),
      eq(tenantMembershipsTable.tenantId, user.activeTenantId),
    )).limit(1))[0]
    : undefined;
  if (!membership) {
    membership = (await db.select().from(tenantMembershipsTable)
      .where(eq(tenantMembershipsTable.userId, user.id))
      .limit(1))[0];
  }
  if (!membership) {
    res.status(403).json({ error: "No tenant access" });
    return;
  }
  const tenant = (await db.select().from(tenantsTable)
    .where(eq(tenantsTable.id, membership.tenantId))
    .limit(1))[0];
  if (!tenant) {
    res.status(403).json({ error: "No tenant access" });
    return;
  }
  if (user.activeTenantId !== tenant.id) {
    await db.update(usersTable).set({ activeTenantId: tenant.id }).where(eq(usersTable.id, user.id));
  }
  req.context = { user: { ...user, activeTenantId: tenant.id }, tenant, membership };
  next();
}

export function requireSiteAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.context?.user.siteRole !== "SITE_ADMIN") {
    res.status(403).json({ error: "Site administrator access required" });
    return;
  }
  next();
}