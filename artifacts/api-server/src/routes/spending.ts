import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  spendingEntriesTable,
  tenantInvitationsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { UpdateTenantMemberSpendingLimitBody } from "@workspace/api-zod";
import {
  MAX_SPENDING_USD,
  microsToUsd,
  usdToMicros,
} from "../lib/spending-service";

const router: IRouter = Router();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class SpendingRouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function scalarQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseMonth(value: unknown): { month: string; start: Date; end: Date; periodStart: string; periodEnd: string } {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) {
    throw new SpendingRouteError(400, "month must use YYYY-MM");
  }
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  if (year < 2000 || year > 9999) throw new SpendingRouteError(400, "month is out of range");
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    month: value,
    start,
    end,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

function addSafe(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("Unsafe micro-USD report total");
  return sum;
}

type Access = {
  tenantId?: string;
  userId?: string;
  callerRole?: "OWNER" | "ADMIN" | "MEMBER";
  canViewAllTenants: boolean;
};

async function reportAccess(
  user: NonNullable<Express.Request["context"]>["user"],
  requestedTenantId: string | undefined,
): Promise<Access> {
  if (requestedTenantId && !uuidPattern.test(requestedTenantId)) {
    throw new SpendingRouteError(400, "tenantId is invalid");
  }
  if (user.siteRole === "SITE_ADMIN") {
    if (requestedTenantId) {
      const [tenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable)
        .where(eq(tenantsTable.id, requestedTenantId)).limit(1);
      if (!tenant) throw new SpendingRouteError(404, "Tenant not found");
    }
    return { tenantId: requestedTenantId, canViewAllTenants: true };
  }
  const tenantId = requestedTenantId ?? user.activeTenantId ?? undefined;
  if (!tenantId) throw new SpendingRouteError(403, "No tenant access");
  const [membership] = await db.select().from(tenantMembershipsTable).where(and(
    eq(tenantMembershipsTable.tenantId, tenantId),
    eq(tenantMembershipsTable.userId, user.id),
  )).limit(1);
  if (!membership) throw new SpendingRouteError(404, "Tenant not found");
  return {
    tenantId,
    userId: membership.role === "MEMBER" ? user.id : undefined,
    callerRole: membership.role,
    canViewAllTenants: false,
  };
}

function entryWhere(periodStart: string, access: Access, requestedUserId?: string): SQL {
  const conditions: SQL[] = [eq(spendingEntriesTable.periodStart, periodStart)];
  if (access.tenantId) conditions.push(eq(spendingEntriesTable.tenantId, access.tenantId));
  const effectiveUserId = access.userId ?? requestedUserId;
  if (effectiveUserId) conditions.push(eq(spendingEntriesTable.userId, effectiveUserId));
  return and(...conditions)!;
}

export function canManageMemberLimit(
  siteAdmin: boolean,
  callerUserId: string,
  callerRole: Access["callerRole"],
  targetUserId: string,
  targetRole: string,
): boolean {
  if (siteAdmin) return true;
  if (callerUserId === targetUserId) return false;
  if (callerRole === "OWNER") return true;
  return callerRole === "ADMIN" && targetRole === "MEMBER";
}

router.get("/spending", async (req, res): Promise<void> => {
  try {
    const period = parseMonth(req.query.month);
    const access = await reportAccess(req.context!.user, scalarQuery(req.query.tenantId));
    const entries = await db.select().from(spendingEntriesTable)
      .where(entryWhere(period.month + "-01", access));

    const membershipConditions: SQL[] = [];
    if (access.tenantId) membershipConditions.push(eq(tenantMembershipsTable.tenantId, access.tenantId));
    if (access.userId) membershipConditions.push(eq(tenantMembershipsTable.userId, access.userId));
    const memberships = await db.select({
      tenantId: tenantMembershipsTable.tenantId,
      tenantName: tenantsTable.name,
      userId: tenantMembershipsTable.userId,
      userEmail: usersTable.email,
      userDisplayName: usersTable.displayName,
      role: tenantMembershipsTable.role,
      monthlyLimitMicros: tenantMembershipsTable.monthlyLimitMicros,
    }).from(tenantMembershipsTable)
      .innerJoin(tenantsTable, eq(tenantsTable.id, tenantMembershipsTable.tenantId))
      .innerJoin(usersTable, eq(usersTable.id, tenantMembershipsTable.userId))
      .where(membershipConditions.length ? and(...membershipConditions) : undefined)
      .orderBy(asc(tenantsTable.name), asc(usersTable.displayName));

    type Aggregate = {
      tenantId: string; tenantName: string; userId: string; userEmail: string | null;
      userDisplayName: string; role: string; membershipActive: boolean;
      monthlyLimitMicros: number | null; reservedMicros: number; estimatedMicros: number;
      actualMicros: number;
    };
    const rows = new Map<string, Aggregate>();
    for (const member of memberships) {
      rows.set(`${member.tenantId}\0${member.userId}`, {
        ...member,
        membershipActive: true,
        reservedMicros: 0,
        estimatedMicros: 0,
        actualMicros: 0,
      });
    }
    for (const entry of entries) {
      const key = `${entry.tenantId}\0${entry.userId}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          tenantId: entry.tenantId,
          tenantName: entry.tenantName,
          userId: entry.userId,
          userEmail: entry.userEmail,
          userDisplayName: entry.userDisplayName,
          role: entry.memberRole,
          membershipActive: false,
          monthlyLimitMicros: null,
          reservedMicros: 0,
          estimatedMicros: 0,
          actualMicros: 0,
        };
        rows.set(key, row);
      }
      if (entry.outcome === "actual") {
        if (entry.billedMicros === null) throw new Error("Actual spending entry has no billed amount");
        row.actualMicros = addSafe(row.actualMicros, entry.billedMicros);
      } else if (entry.outcome === "estimated") {
        row.estimatedMicros = addSafe(row.estimatedMicros, entry.estimatedMicros);
      } else if (entry.outcome !== "released") {
        row.reservedMicros = addSafe(row.reservedMicros, entry.estimatedMicros);
      }
    }

    let totalReserved = 0;
    let totalEstimated = 0;
    let totalActual = 0;
    const responseRows = [...rows.values()].map((row) => {
      totalReserved = addSafe(totalReserved, row.reservedMicros);
      totalEstimated = addSafe(totalEstimated, row.estimatedMicros);
      totalActual = addSafe(totalActual, row.actualMicros);
      const total = addSafe(addSafe(row.reservedMicros, row.estimatedMicros), row.actualMicros);
      const remaining = row.monthlyLimitMicros === null
        ? null
        : Math.max(0, row.monthlyLimitMicros - total);
      return {
        ...row,
        monthlyLimitMicros: undefined,
        reservedMicros: undefined,
        estimatedMicros: undefined,
        actualMicros: undefined,
        monthlyLimitUsd: row.monthlyLimitMicros === null ? null : microsToUsd(row.monthlyLimitMicros),
        reservedUSD: microsToUsd(row.reservedMicros),
        estimatedUSD: microsToUsd(row.estimatedMicros),
        actualUSD: microsToUsd(row.actualMicros),
        totalUSD: microsToUsd(total),
        remainingUSD: remaining === null ? null : microsToUsd(remaining),
        canManageLimit: row.membershipActive && canManageMemberLimit(
          access.canViewAllTenants,
          req.context!.user.id,
          access.callerRole,
          row.userId,
          row.role,
        ),
      };
    });

    const invitationConditions: SQL[] = [gte(tenantInvitationsTable.expiresAt, new Date())];
    if (access.tenantId) invitationConditions.push(eq(tenantInvitationsTable.tenantId, access.tenantId));
    const canSeeInvitations = access.canViewAllTenants || access.callerRole === "OWNER" || access.callerRole === "ADMIN";
    const invitations = canSeeInvitations
      ? await db.select().from(tenantInvitationsTable).where(and(...invitationConditions))
      : [];
    res.json({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      currency: "USD",
      scope: { tenantId: access.tenantId ?? null, userId: access.userId ?? null },
      totals: {
        reservedUSD: microsToUsd(totalReserved),
        estimatedUSD: microsToUsd(totalEstimated),
        actualUSD: microsToUsd(totalActual),
        totalUSD: microsToUsd(addSafe(addSafe(totalReserved, totalEstimated), totalActual)),
      },
      rows: responseRows,
      pendingInvitations: invitations.map((invitation) => ({
        id: invitation.id,
        tenantId: invitation.tenantId,
        email: invitation.email,
        role: invitation.role,
        monthlyLimitUsd: invitation.monthlyLimitMicros === null
          ? null
          : microsToUsd(invitation.monthlyLimitMicros),
        expiresAt: invitation.expiresAt.toISOString(),
        canManageLimit: access.canViewAllTenants
          || access.callerRole === "OWNER"
          || (access.callerRole === "ADMIN" && invitation.role === "MEMBER"),
      })),
      permissions: { canViewAllTenants: access.canViewAllTenants },
    });
  } catch (error) {
    if (error instanceof SpendingRouteError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/spending/entries", async (req, res): Promise<void> => {
  try {
    const period = parseMonth(req.query.month);
    const access = await reportAccess(req.context!.user, scalarQuery(req.query.tenantId));
    const requestedUserId = scalarQuery(req.query.userId);
    if (req.query.userId !== undefined && !requestedUserId) {
      throw new SpendingRouteError(400, "userId is invalid");
    }
    if (access.userId && requestedUserId && requestedUserId !== access.userId) {
      throw new SpendingRouteError(403, "Members may only view their own entries");
    }
    const pageText = scalarQuery(req.query.page) ?? "1";
    const pageSizeText = scalarQuery(req.query.pageSize) ?? "50";
    if (!/^[1-9]\d*$/u.test(pageText) || !/^[1-9]\d*$/u.test(pageSizeText)) {
      throw new SpendingRouteError(400, "page and pageSize must be positive integers");
    }
    const page = Number(pageText);
    const pageSize = Number(pageSizeText);
    if (!Number.isSafeInteger(page) || pageSize > 100) {
      throw new SpendingRouteError(400, "Pagination is out of range");
    }
    const where = entryWhere(period.month + "-01", access, requestedUserId);
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` })
      .from(spendingEntriesTable).where(where);
    const entries = await db.select().from(spendingEntriesTable).where(where)
      .orderBy(desc(spendingEntriesTable.submittedAt), desc(spendingEntriesTable.id))
      .limit(pageSize).offset((page - 1) * pageSize);
    res.json({
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      currency: "USD",
      page,
      pageSize,
      total: countRow?.count ?? 0,
      entries: entries.map((entry) => ({
        id: entry.id,
        tenantId: entry.tenantId,
        userId: entry.userId,
        userEmail: entry.userEmail,
        userDisplayName: entry.userDisplayName,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        modelId: entry.modelId,
        pricingNote: entry.pricingNote,
        reservedUSD: microsToUsd(entry.estimatedMicros),
        actualUSD: entry.billedMicros === null ? null : microsToUsd(entry.billedMicros),
        hasReceipt: entry.billingRequestId !== null && entry.providerEndpoint !== null,
        outcome: entry.outcome,
        note: entry.settlementNote,
        submittedAt: entry.submittedAt.toISOString(),
        settledAt: entry.settledAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof SpendingRouteError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.put("/tenants/:tenantId/members/:userId/spending-limit", async (req, res): Promise<void> => {
  const tenantId = Array.isArray(req.params.tenantId) ? req.params.tenantId[0] : req.params.tenantId;
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const parsed = UpdateTenantMemberSpendingLimitBody.safeParse(req.body);
  if (!uuidPattern.test(tenantId) || !targetUserId || !parsed.success) {
    res.status(400).json({ error: `monthlyLimitUsd must be null or between 0 and ${MAX_SPENDING_USD}` });
    return;
  }
  try {
    const limitMicros = parsed.data.monthlyLimitUsd === null
      ? null
      : usdToMicros(parsed.data.monthlyLimitUsd);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(
          ${`obtv:spending-member:${tenantId}:${targetUserId}`}, 0
        ))
      `);
      const [target] = await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, tenantId),
        eq(tenantMembershipsTable.userId, targetUserId),
      )).limit(1);
      if (!target) throw new SpendingRouteError(404, "Tenant or member not found");
      let callerRole: Access["callerRole"];
      if (req.context!.user.siteRole !== "SITE_ADMIN") {
        const [caller] = await tx.select().from(tenantMembershipsTable).where(and(
          eq(tenantMembershipsTable.tenantId, tenantId),
          eq(tenantMembershipsTable.userId, req.context!.user.id),
        )).limit(1);
        if (!caller) throw new SpendingRouteError(404, "Tenant not found");
        callerRole = caller.role;
      }
      if (!canManageMemberLimit(
        req.context!.user.siteRole === "SITE_ADMIN",
        req.context!.user.id,
        callerRole,
        target.userId,
        target.role,
      )) throw new SpendingRouteError(403, "You cannot manage this member's spending limit");
      await tx.update(tenantMembershipsTable).set({ monthlyLimitMicros: limitMicros }).where(and(
        eq(tenantMembershipsTable.tenantId, tenantId),
        eq(tenantMembershipsTable.userId, targetUserId),
      ));
      return { tenantId, userId: targetUserId, monthlyLimitUsd: parsed.data.monthlyLimitUsd };
    });
    res.json({ ...result, canManageLimit: true });
  } catch (error) {
    if (error instanceof SpendingRouteError || (
      typeof error === "object" && error !== null && "statusCode" in error
    )) {
      const status = error instanceof SpendingRouteError ? error.status : Number(error.statusCode);
      res.status(status).json({ error: error instanceof Error ? error.message : "Invalid spending limit" });
      return;
    }
    throw error;
  }
});

export default router;