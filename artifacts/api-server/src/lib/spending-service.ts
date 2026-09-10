import { and, eq, sql } from "drizzle-orm";
import {
  db,
  spendingEntriesTable,
  spendingEventsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";

const MICROS_PER_USD = 1_000_000;
export const MAX_SPENDING_USD = 1_000_000;
const MAX_MICROS = MAX_SPENDING_USD * MICROS_PER_USD;
const sourceTypes = new Set(["image", "video"]);
const outcomes = new Set(["estimated", "released", "uncertain"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class SpendingServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type ReserveSpendInput = {
  tenantId: string;
  userId: string;
  sourceType: "image" | "video";
  sourceId: string;
  modelId: string;
  estimatedUsd: number;
  pricingNote: string;
};

export function usdToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_SPENDING_USD) {
    throw new SpendingServiceError(400, `USD amount must be between 0 and ${MAX_SPENDING_USD}`);
  }
  const micros = Math.round(value * MICROS_PER_USD);
  if (!Number.isSafeInteger(micros) || Math.abs(value * MICROS_PER_USD - micros) > 1e-7) {
    throw new SpendingServiceError(400, "USD amount may have at most 6 decimal places");
  }
  return micros;
}

export function microsToUsd(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Unsafe micro-USD value returned by the database");
  }
  return value / MICROS_PER_USD;
}

function validateIdentifier(value: string, label: string, maxLength = 256): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new SpendingServiceError(400, `${label} is invalid`);
  }
}

export function utcMonthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export async function reserveSpend({
  tenantId,
  userId,
  sourceType,
  sourceId,
  modelId,
  estimatedUsd,
  pricingNote,
}: ReserveSpendInput): Promise<void> {
  validateIdentifier(tenantId, "tenantId", 36);
  if (!uuidPattern.test(tenantId)) throw new SpendingServiceError(400, "tenantId is invalid");
  validateIdentifier(userId, "userId");
  validateIdentifier(sourceId, "sourceId");
  validateIdentifier(modelId, "modelId");
  validateIdentifier(pricingNote, "pricingNote", 2_000);
  if (!sourceTypes.has(sourceType)) throw new SpendingServiceError(400, "sourceType is invalid");
  const estimatedMicros = usdToMicros(estimatedUsd);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-source:${sourceType}:${sourceId}`}, 0
      ))
    `);
    const [existing] = await tx.select().from(spendingEntriesTable).where(and(
      eq(spendingEntriesTable.sourceType, sourceType),
      eq(spendingEntriesTable.sourceId, sourceId),
    )).limit(1);
    if (existing) {
      if (
        existing.tenantId !== tenantId
        || existing.userId !== userId
        || existing.modelId !== modelId
        || existing.estimatedMicros !== estimatedMicros
      ) {
        throw new SpendingServiceError(409, "Spending source key was already used for different work");
      }
      if (existing.outcome !== "reserved") {
        throw new SpendingServiceError(409, "Spending source was already submitted or settled");
      }
      return;
    }

    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-member:${tenantId}:${userId}`}, 0
      ))
    `);
    const [identity] = await tx.select({
      membership: tenantMembershipsTable,
      tenantName: tenantsTable.name,
      email: usersTable.email,
      displayName: usersTable.displayName,
    }).from(tenantMembershipsTable)
      .innerJoin(tenantsTable, eq(tenantsTable.id, tenantMembershipsTable.tenantId))
      .innerJoin(usersTable, eq(usersTable.id, tenantMembershipsTable.userId))
      .where(and(
        eq(tenantMembershipsTable.tenantId, tenantId),
        eq(tenantMembershipsTable.userId, userId),
      )).limit(1);
    if (!identity) throw new SpendingServiceError(403, "User is not a tenant member");

    const periodStart = utcMonthStart(new Date());
    const heldResult = await tx.execute(sql`
      select coalesce(sum(
        case when outcome = 'actual' then billed_micros else estimated_micros end
      ), 0)::text as held_micros
      from obtv_spending_entries
      where tenant_id = ${tenantId}
        and user_id = ${userId}
        and period_start = ${periodStart}::date
        and outcome <> 'released'
    `);
    const heldMicros = Number(heldResult.rows[0]?.held_micros ?? 0);
    if (!Number.isSafeInteger(heldMicros) || !Number.isSafeInteger(heldMicros + estimatedMicros)) {
      throw new Error("Unsafe monthly micro-USD total");
    }
    const limit = identity.membership.monthlyLimitMicros;
    if (limit !== null && (limit === 0 || heldMicros + estimatedMicros > limit)) {
      throw new SpendingServiceError(402, "Monthly spending limit exceeded");
    }

    const [entry] = await tx.insert(spendingEntriesTable).values({
      tenantId,
      tenantName: identity.tenantName,
      userId,
      userEmail: identity.email,
      userDisplayName: identity.displayName,
      memberRole: identity.membership.role,
      sourceType,
      sourceId,
      modelId,
      estimatedMicros,
      pricingNote,
      periodStart,
    }).returning({ id: spendingEntriesTable.id });
    await tx.insert(spendingEventsTable).values({
      spendingEntryId: entry.id,
      state: "reserved",
      note: "Estimate reserved before paid provider submission; provider invoice is not known.",
    });
  });
}

export async function settleSpend(
  sourceType: "image" | "video",
  sourceId: string,
  outcome: "estimated" | "released" | "uncertain",
  note?: string,
): Promise<void> {
  if (!sourceTypes.has(sourceType)) throw new SpendingServiceError(400, "sourceType is invalid");
  validateIdentifier(sourceId, "sourceId");
  if (!outcomes.has(outcome)) throw new SpendingServiceError(400, "outcome is invalid");
  if (note !== undefined && (typeof note !== "string" || note.length > 2_000)) {
    throw new SpendingServiceError(400, "Settlement note is invalid");
  }
  if (outcome === "released" && (!note || note.trim().length === 0)) {
    throw new SpendingServiceError(400, "A definitive never-billed reason is required to release funds");
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-source:${sourceType}:${sourceId}`}, 0
      ))
    `);
    const [entry] = await tx.select().from(spendingEntriesTable).where(and(
      eq(spendingEntriesTable.sourceType, sourceType),
      eq(spendingEntriesTable.sourceId, sourceId),
    )).limit(1);
    if (!entry) throw new SpendingServiceError(404, "Spending reservation not found");
    if (entry.outcome === outcome) return;
    if (entry.outcome === "estimated" || entry.outcome === "released" || entry.outcome === "actual") {
      throw new SpendingServiceError(409, "A final spending outcome is already recorded");
    }
    await tx.update(spendingEntriesTable).set({
      outcome,
      settlementNote: note ?? null,
      settledAt: new Date(),
    }).where(eq(spendingEntriesTable.id, entry.id));
    await tx.insert(spendingEventsTable).values({
      spendingEntryId: entry.id,
      state: outcome,
      note: note ?? (
        outcome === "estimated"
          ? "Reserved estimate retained; this is not an actual provider invoice."
          : "Billing remains uncertain; reserved estimate continues to be held."
      ),
    }).onConflictDoNothing();
  });
}

export async function attachSpendReceipt(
  sourceType: "image" | "video",
  sourceId: string,
  providerRequestId: string,
  endpoint: string,
): Promise<void> {
  if (!sourceTypes.has(sourceType)) throw new SpendingServiceError(400, "sourceType is invalid");
  validateIdentifier(sourceId, "sourceId");
  validateIdentifier(providerRequestId, "providerRequestId", 512);
  validateIdentifier(endpoint, "endpoint", 2_000);
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new SpendingServiceError(400, "endpoint is invalid");
  }
  if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password) {
    throw new SpendingServiceError(400, "endpoint must be an HTTPS URL without credentials");
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-source:${sourceType}:${sourceId}`}, 0
      ))
    `);
    const [entry] = await tx.select().from(spendingEntriesTable).where(and(
      eq(spendingEntriesTable.sourceType, sourceType),
      eq(spendingEntriesTable.sourceId, sourceId),
    )).limit(1);
    if (!entry) throw new SpendingServiceError(404, "Spending reservation not found");
    if (entry.billingRequestId !== null || entry.providerEndpoint !== null) {
      if (entry.billingRequestId === providerRequestId && entry.providerEndpoint === endpoint) return;
      throw new SpendingServiceError(409, "A different provider receipt is already attached");
    }
    await tx.update(spendingEntriesTable).set({
      billingRequestId: providerRequestId,
      providerEndpoint: endpoint,
    }).where(eq(spendingEntriesTable.id, entry.id));
    await tx.insert(spendingEventsTable).values({
      spendingEntryId: entry.id,
      state: "receipt_attached",
      note: "Immutable provider billing receipt identity attached.",
    });
  });
}

export async function settleActualSpend(
  sourceType: "image" | "video",
  sourceId: string,
  actualUsd: number,
  billingReference: string,
): Promise<void> {
  if (!sourceTypes.has(sourceType)) throw new SpendingServiceError(400, "sourceType is invalid");
  validateIdentifier(sourceId, "sourceId");
  validateIdentifier(billingReference, "billingReference", 512);
  const billedMicros = usdToMicros(actualUsd);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-source:${sourceType}:${sourceId}`}, 0
      ))
    `);
    const [entry] = await tx.select().from(spendingEntriesTable).where(and(
      eq(spendingEntriesTable.sourceType, sourceType),
      eq(spendingEntriesTable.sourceId, sourceId),
    )).limit(1);
    if (!entry) throw new SpendingServiceError(404, "Spending reservation not found");
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(
        ${`obtv:spending-member:${entry.tenantId}:${entry.userId}`}, 0
      ))
    `);
    if (entry.billingReference !== null && entry.billingReference !== billingReference) {
      throw new SpendingServiceError(409, "Actual cost was reconciled with a different billing reference");
    }
    if (
      entry.outcome === "actual"
      && entry.billedMicros === billedMicros
      && entry.billingReference === billingReference
    ) return;
    const amountChanged = entry.billedMicros !== billedMicros;
    await tx.update(spendingEntriesTable).set({
      billedMicros,
      billingReference,
      outcome: "actual",
      settlementNote: "Provider-reconciled billed amount.",
      settledAt: new Date(),
    }).where(eq(spendingEntriesTable.id, entry.id));
    if (amountChanged) {
      await tx.insert(spendingEventsTable).values({
        spendingEntryId: entry.id,
        state: "actual",
        billedMicros,
        billingReference,
        note: "Provider-reconciled billed amount; supersedes the reserved estimate.",
      });
    }
  });
}