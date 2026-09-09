import { and, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  authSessionsTable,
  db,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { AUTH_COOKIE_NAME, digestSessionToken } from "../lib/auth-service";

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

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== "string" || !token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const digest = digestSessionToken(token);
    const [result] = await db.select({
      session: authSessionsTable,
      user: usersTable,
    }).from(authSessionsTable)
      .innerJoin(usersTable, eq(usersTable.id, authSessionsTable.userId))
      .where(eq(authSessionsTable.id, digest))
      .limit(1);
    if (!result) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (result.session.expiresAt.getTime() <= Date.now()) {
      await db.delete(authSessionsTable).where(eq(authSessionsTable.id, digest));
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (Date.now() - result.session.lastSeenAt.getTime() >= 5 * 60 * 1000) {
      await db.update(authSessionsTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(authSessionsTable.id, digest));
    }
    const user = result.user;
    req.context = { user, tenant: null, membership: null };
    next();
  } catch (error) {
    req.log.error({ err: error }, "Could not resolve authenticated session");
    res.status(503).json({ error: "Authentication is temporarily unavailable" });
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