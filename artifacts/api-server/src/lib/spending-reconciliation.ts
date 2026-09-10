import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, generationJobsTable, imageStudioJobsTable, spendingEntriesTable } from "@workspace/db";
import { attachSpendReceipt, settleActualSpend } from "./spending-service";
import { billingCorrectionCutoff, CloudBillingError, fetchCloudBill } from "./cloud-billing";
import { logger } from "./logger";

let running = false;
let afterId: string | undefined;
let receiptAfterId: string | undefined;
let retryAfter = 0;

async function backfillReceipts(): Promise<void> {
  const entries = await db.select().from(spendingEntriesTable).where(and(
    isNull(spendingEntriesTable.billingRequestId),
    receiptAfterId ? gt(spendingEntriesTable.id, receiptAfterId) : undefined,
  )).orderBy(asc(spendingEntriesTable.id)).limit(20);
  receiptAfterId = entries.length === 20 ? entries.at(-1)!.id : undefined;
  for (const entry of entries) {
    // Ledger source IDs are text; the image/video job tables use UUID keys.
    // An unrelated/imported source must not abort reconciliation for every user.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.sourceId)) continue;
    const table = entry.sourceType === "image" ? imageStudioJobsTable : generationJobsTable;
    const [job] = await db.select({
      requestId: table.providerRequestId,
      metadata: table.providerTaskMetadata,
    }).from(table).where(and(eq(table.id, entry.sourceId), eq(table.tenantId, entry.tenantId))).limit(1);
    const metadata = job?.metadata as Record<string, unknown> | null;
    const endpoint = metadata?.endpoint ?? (entry.sourceType === "video" ? entry.modelId : undefined);
    if (job?.requestId && typeof endpoint === "string") {
      try {
        const canonical = endpoint.startsWith("https://") ? endpoint : `https://queue.fal.run/${endpoint}`;
        await attachSpendReceipt(entry.sourceType, entry.sourceId, job.requestId, canonical);
      } catch {
        logger.warn({ spendingEntryId: entry.id }, "Cloud billing receipt repair deferred.");
      }
    }
  }
}

export async function reconcileCloudSpending(): Promise<void> {
  if (running || Date.now() < retryAfter) return;
  running = true;
  try {
    await backfillReceipts();
    // Rotate over unresolved entries and recent billed entries. Rechecking recent
    // receipts picks up later billing events without double-counting prior ones.
    const entries = await db.select().from(spendingEntriesTable).where(and(
      isNotNull(spendingEntriesTable.billingRequestId),
      or(sql`${spendingEntriesTable.outcome} <> 'actual'`,
        gt(spendingEntriesTable.submittedAt, billingCorrectionCutoff())),
      afterId ? gt(spendingEntriesTable.id, afterId) : undefined,
    )).orderBy(asc(spendingEntriesTable.id)).limit(20);
    afterId = entries.length === 20 ? entries.at(-1)!.id : undefined;
    for (const entry of entries) {
      if (!entry.billingRequestId || !entry.providerEndpoint) continue;
      try {
        const bill = await fetchCloudBill({
          requestId: entry.billingRequestId,
          endpoint: entry.providerEndpoint,
          submittedAt: entry.submittedAt,
        });
        if (bill) await settleActualSpend(entry.sourceType, entry.sourceId, bill.actualUsd, bill.reference);
      } catch (error) {
        if (error instanceof CloudBillingError && [401, 403].includes(error.statusCode)) {
          retryAfter = Date.now() + 15 * 60_000;
          logger.warn("Cloud billing access unavailable; configure an admin-scoped CLOUD_BILLING_API_KEY. Spending estimates remain in effect.");
          break;
        }
        // Do not expose provider bodies, credentials, or another tenant's data.
        logger.warn({ spendingEntryId: entry.id }, "Cloud bill reconciliation deferred; existing reservation or estimate retained.");
      }
    }
  } catch {
    logger.warn("Cloud spending reconciliation deferred; accounting remains unchanged.");
  } finally {
    running = false;
  }
}

export function startSpendingReconciliation(): void {
  void reconcileCloudSpending();
  setInterval(() => void reconcileCloudSpending(), 60_000).unref();
}