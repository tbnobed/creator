import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  spendingEntriesTable,
  spendingEventsTable,
  tenantMembershipsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";

import {
  attachSpendReceipt,
  reserveSpend,
  settleActualSpend,
  settleSpend,
  SpendingServiceError,
} from "./spending-service";

test("real database serializes concurrent reservations and preserves settlement audit state", {
  skip: process.env.RUN_SPENDING_DB_TESTS !== "true" ? "set RUN_SPENDING_DB_TESTS=true" : false,
}, async () => {
  const userId = `spending-test-${randomUUID()}`;
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const releasedSource = randomUUID();
  const [tenant] = await db.insert(tenantsTable).values({
    name: "Spending concurrency fixture",
    slug: `spending-fixture-${randomUUID()}`,
  }).returning();
  try {
    await db.insert(usersTable).values({
      id: userId,
      email: `${randomUUID()}@spending.test`,
      displayName: "Spending fixture user",
    });
    await db.insert(tenantMembershipsTable).values({
      tenantId: tenant.id,
      userId,
      role: "MEMBER",
      monthlyLimitMicros: 1_000_000,
    });
    const reservation = (sourceId: string) => reserveSpend({
      tenantId: tenant.id,
      userId,
      sourceType: "video",
      sourceId,
      modelId: "integration-test-provider-model",
      estimatedUsd: 0.6,
      pricingNote: "Integration-test estimate; not an actual invoice.",
    });
    const attempts = await Promise.allSettled([reservation(sourceA), reservation(sourceB)]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    const rejection = attempts.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert(rejection?.reason instanceof SpendingServiceError);
    assert.equal(rejection.reason.statusCode, 402);

    const acceptedSource = attempts[0]?.status === "fulfilled" ? sourceA : sourceB;
    await reservation(acceptedSource);
    await settleSpend("video", acceptedSource, "uncertain", "Provider outcome still unknown.");
    await settleSpend("video", acceptedSource, "uncertain", "Idempotent retry.");
    await settleSpend("video", acceptedSource, "estimated", "Estimate retained, not actual billed cost.");
    await attachSpendReceipt(
      "video",
      acceptedSource,
      "provider-request-fixture",
      "https://provider.invalid/v1/models/usage",
    );
    await attachSpendReceipt(
      "video",
      acceptedSource,
      "provider-request-fixture",
      "https://provider.invalid/v1/models/usage",
    );
    await assert.rejects(
      attachSpendReceipt(
        "video",
        acceptedSource,
        "different-provider-request",
        "https://provider.invalid/v1/models/usage",
      ),
      (error: unknown) => error instanceof SpendingServiceError && error.statusCode === 409,
    );
    await settleActualSpend("video", acceptedSource, 0.7, "billing-record-fixture");
    await settleActualSpend("video", acceptedSource, 0.7, "billing-record-fixture");
    await settleActualSpend("video", acceptedSource, 0.71, "billing-record-fixture");
    await settleActualSpend("video", acceptedSource, 0.71, "billing-record-fixture");
    await assert.rejects(
      settleSpend("video", acceptedSource, "uncertain", "Late generic poll."),
      (error: unknown) => error instanceof SpendingServiceError && error.statusCode === 409,
    );
    await db.update(tenantMembershipsTable).set({ monthlyLimitMicros: 2_000_000 }).where(and(
      eq(tenantMembershipsTable.tenantId, tenant.id),
      eq(tenantMembershipsTable.userId, userId),
    ));

    await reserveSpend({
      tenantId: tenant.id,
      userId,
      sourceType: "image",
      sourceId: releasedSource,
      modelId: "integration-test-image-model",
      estimatedUsd: 0.4,
      pricingNote: "Integration-test estimate; not an actual invoice.",
    });
    await assert.rejects(
      settleSpend("image", releasedSource, "released"),
      (error: unknown) => error instanceof SpendingServiceError && error.statusCode === 400,
    );
    await settleSpend("image", releasedSource, "released", "Provider confirmed submission was never billed.");
    await settleActualSpend("image", releasedSource, 0, "zero-cost-billing-record");

    const entries = await db.select().from(spendingEntriesTable)
      .where(eq(spendingEntriesTable.userId, userId));
    assert.equal(entries.length, 2);
    assert(entries.every((entry) => entry.outcome === "actual"));
    assert.deepEqual(new Set(entries.map((entry) => entry.billedMicros)), new Set([0, 710_000]));
    const acceptedEntry = entries.find((entry) => entry.sourceId === acceptedSource)!;
    const actualEvents = await db.select().from(spendingEventsTable).where(and(
      eq(spendingEventsTable.spendingEntryId, acceptedEntry.id),
      eq(spendingEventsTable.state, "actual"),
    ));
    assert.equal(actualEvents.length, 2);

    for (const state of ["uncertain", "estimated", "released", "actual"] as const) {
      const sourceId = randomUUID();
      await reserveSpend({
        tenantId: tenant.id,
        userId,
        sourceType: "image",
        sourceId,
        modelId: `state-${state}`,
        estimatedUsd: 0.05,
        pricingNote: "State retry fixture estimate.",
      });
      if (state === "actual") {
        await settleActualSpend("image", sourceId, 0.05, `billing-${sourceId}`);
      } else {
        await settleSpend(
          "image",
          sourceId,
          state,
          state === "released" ? "Provider proved request was never billed." : "State fixture.",
        );
      }
      await assert.rejects(
        reserveSpend({
          tenantId: tenant.id,
          userId,
          sourceType: "image",
          sourceId,
          modelId: `state-${state}`,
          estimatedUsd: 0.05,
          pricingNote: "State retry fixture estimate.",
        }),
        (error: unknown) => error instanceof SpendingServiceError && error.statusCode === 409,
      );
    }
  } finally {
    const entries = await db.select({ id: spendingEntriesTable.id }).from(spendingEntriesTable)
      .where(eq(spendingEntriesTable.userId, userId));
    for (const entry of entries) {
      await db.delete(spendingEventsTable).where(eq(spendingEventsTable.spendingEntryId, entry.id));
    }
    await db.delete(spendingEntriesTable).where(eq(spendingEntriesTable.userId, userId));
    await db.delete(tenantMembershipsTable).where(eq(tenantMembershipsTable.tenantId, tenant.id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
});