import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  tenantInvitationsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import {
  AcceptTenantInvitationBody,
  AddTenantMemberBody,
} from "@workspace/api-zod";
import {
  createInvitationToken,
  digestInvitationToken,
  normalizeEmail,
} from "../lib/auth-service";

const router: IRouter = Router();
const tenantRoles = new Set(["OWNER", "ADMIN", "MEMBER"]);

class MembershipMutationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function tenantSummary(
  tenant: typeof tenantsTable.$inferSelect,
  membership: typeof tenantMembershipsTable.$inferSelect,
) {
  return { id: tenant.id, name: tenant.name, slug: tenant.slug, role: membership.role };
}

async function membershipFor(tenantId: string, userId: string) {
  return (await db.select().from(tenantMembershipsTable).where(and(
    eq(tenantMembershipsTable.tenantId, tenantId),
    eq(tenantMembershipsTable.userId, userId),
  )).limit(1))[0];
}

router.get("/session", (req, res): void => {
  const { user, tenant, membership } = req.context!;
  res.json({
    user: { id: user.id, email: user.email, displayName: user.displayName, siteRole: user.siteRole },
    activeTenant: tenant && membership ? tenantSummary(tenant, membership) : null,
  });
});

router.get("/tenants", async (req, res): Promise<void> => {
  const memberships = await db.select().from(tenantMembershipsTable)
    .where(eq(tenantMembershipsTable.userId, req.context!.user.id));
  const items = await Promise.all(memberships.map(async (membership) => {
    const tenant = (await db.select().from(tenantsTable)
      .where(eq(tenantsTable.id, membership.tenantId)).limit(1))[0];
    return tenant ? tenantSummary(tenant, membership) : null;
  }));
  res.json(items.filter(Boolean));
});

router.post("/tenants", async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 120) {
    res.status(400).json({ error: "Tenant name must be between 1 and 120 characters" });
    return;
  }
  const userId = req.context!.user.id;
  const created = await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenantsTable).values({
      name,
      slug: `studio-${crypto.randomUUID().slice(0, 12)}`,
      createdByUserId: userId,
    }).returning();
    const [membership] = await tx.insert(tenantMembershipsTable).values({
      tenantId: tenant.id,
      userId,
      role: "OWNER",
    }).returning();
    await tx.update(usersTable).set({ activeTenantId: tenant.id }).where(eq(usersTable.id, userId));
    return tenantSummary(tenant, membership);
  });
  res.status(201).json(created);
});

router.post("/tenants/:id/activate", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const membership = await membershipFor(id, req.context!.user.id);
  if (!membership) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const tenant = (await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1))[0];
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  await db.update(usersTable).set({ activeTenantId: id }).where(eq(usersTable.id, req.context!.user.id));
  res.json(tenantSummary(tenant, membership));
});

router.get("/tenants/:id/members", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const caller = await membershipFor(id, req.context!.user.id);
  if (!caller) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const members = await db.select({
    userId: usersTable.id,
    email: usersTable.email,
    displayName: usersTable.displayName,
    role: tenantMembershipsTable.role,
  }).from(tenantMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, tenantMembershipsTable.userId))
    .where(eq(tenantMembershipsTable.tenantId, id));
  res.json(members);
});

router.post("/tenants/:id/members", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = AddTenantMemberBody.safeParse(req.body);
  const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
  const role = parsed.success ? parsed.data.role : "";
  if (!parsed.success || !email || !tenantRoles.has(role)) {
    res.status(400).json({ error: "A valid recipient email and role are required" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from obtv_tenants where id = ${id} for update`);
      if (locked.rowCount !== 1) throw new MembershipMutationError(404, "Tenant not found");
      const [caller] = await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, id),
        eq(tenantMembershipsTable.userId, req.context!.user.id),
      )).limit(1);
      if (!caller) throw new MembershipMutationError(404, "Tenant not found");
      if (!["OWNER", "ADMIN"].includes(caller.role)) {
        throw new MembershipMutationError(403, "Tenant administrator access required");
      }
      if (role === "OWNER" && caller.role !== "OWNER") {
        throw new MembershipMutationError(403, "Only owners can invite another owner");
      }
      const [existingUser] = await tx.select({
        id: usersTable.id,
        passwordHash: usersTable.passwordHash,
      })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      const [target] = existingUser
        ? await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, id),
          eq(tenantMembershipsTable.userId, existingUser.id),
        )).limit(1)
        : [];
      if (target && existingUser?.passwordHash) {
        throw new MembershipMutationError(409, "That account is already a workspace member");
      }
      if (existingUser && !existingUser.passwordHash && req.context!.user.siteRole !== "SITE_ADMIN") {
        throw new MembershipMutationError(
          403,
          "Only a site administrator can issue a password-enrollment invitation for a legacy member",
        );
      }
      const invitationRole = target?.role ?? role as "OWNER" | "ADMIN" | "MEMBER";

      await tx.delete(tenantInvitationsTable).where(and(
        eq(tenantInvitationsTable.tenantId, id),
        eq(tenantInvitationsTable.email, email),
      ));
      const token = createInvitationToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await tx.insert(tenantInvitationsTable).values({
        tenantId: id,
        email,
        role: invitationRole,
        tokenHash: digestInvitationToken(token),
        targetUserId: existingUser?.passwordHash ? null : existingUser?.id,
        allowsPasswordEnrollment: Boolean(existingUser && !existingUser.passwordHash),
        invitedByUserId: req.context!.user.id,
        expiresAt,
      });
      return { email, role: invitationRole, token, expiresAt };
    });
    res.status(201).json({
      email: result.email,
      role: result.role,
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof MembershipMutationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/tenant-invitations/accept", async (req, res): Promise<void> => {
  const parsed = AcceptTenantInvitationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid invitation token is required" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [invitation] = await tx.select().from(tenantInvitationsTable)
        .where(eq(tenantInvitationsTable.tokenHash, digestInvitationToken(parsed.data.token)))
        .limit(1)
        .for("update");
      if (!invitation) throw new MembershipMutationError(400, "Invitation is invalid or expired");
      if (invitation.expiresAt.getTime() <= Date.now()) {
        await tx.delete(tenantInvitationsTable).where(eq(tenantInvitationsTable.id, invitation.id));
        throw new MembershipMutationError(400, "Invitation is invalid or expired");
      }
      if (!req.context!.user.email || req.context!.user.email !== invitation.email) {
        throw new MembershipMutationError(403, "Invitation belongs to another account");
      }
      const [tenant] = await tx.select().from(tenantsTable)
        .where(eq(tenantsTable.id, invitation.tenantId))
        .limit(1);
      if (!tenant) throw new MembershipMutationError(400, "Invitation is invalid or expired");
      const [membership] = await tx.insert(tenantMembershipsTable).values({
        tenantId: invitation.tenantId,
        userId: req.context!.user.id,
        role: invitation.role,
      }).onConflictDoNothing().returning();
      const effectiveMembership = membership ?? (await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, invitation.tenantId),
        eq(tenantMembershipsTable.userId, req.context!.user.id),
      )).limit(1))[0];
      if (!effectiveMembership) throw new MembershipMutationError(409, "Could not accept invitation");
      await tx.update(usersTable)
        .set({ activeTenantId: invitation.tenantId })
        .where(eq(usersTable.id, req.context!.user.id));
      await tx.delete(tenantInvitationsTable).where(eq(tenantInvitationsTable.id, invitation.id));
      return tenantSummary(tenant, effectiveMembership);
    });
    res.json(result);
  } catch (error) {
    if (error instanceof MembershipMutationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.delete("/tenants/:id/members/:userId", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  try {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from obtv_tenants where id = ${id} for update`);
      if (locked.rowCount !== 1) throw new MembershipMutationError(404, "Tenant not found");
      const [caller] = await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, id),
        eq(tenantMembershipsTable.userId, req.context!.user.id),
      )).limit(1);
      const [target] = await tx.select().from(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, id),
        eq(tenantMembershipsTable.userId, targetUserId),
      )).limit(1);
      if (!caller || !target) throw new MembershipMutationError(404, "Tenant or member not found");
      if (!["OWNER", "ADMIN"].includes(caller.role)) {
        throw new MembershipMutationError(403, "Tenant administrator access required");
      }
      if (caller.role === "ADMIN" && target.role === "OWNER") {
        throw new MembershipMutationError(403, "Administrators cannot remove an owner");
      }
      if (target.role === "OWNER") {
        const owners = await tx.select({ userId: tenantMembershipsTable.userId })
          .from(tenantMembershipsTable)
          .where(and(eq(tenantMembershipsTable.tenantId, id), eq(tenantMembershipsTable.role, "OWNER")));
        if (owners.length <= 1) {
          throw new MembershipMutationError(409, "The final tenant owner cannot be removed");
        }
      }
      await tx.delete(tenantMembershipsTable).where(and(
        eq(tenantMembershipsTable.tenantId, id),
        eq(tenantMembershipsTable.userId, targetUserId),
      ));
    });
    res.sendStatus(204);
  } catch (error) {
    if (error instanceof MembershipMutationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

export default router;