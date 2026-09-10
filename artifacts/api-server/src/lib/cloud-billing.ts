import { createHash } from "node:crypto";

export class CloudBillingError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export type BillingReceipt = { requestId: string; endpoint: string; submittedAt: Date };
export const BILLING_CORRECTION_WINDOW_MS = 90 * 24 * 60 * 60_000;
export function billingCorrectionCutoff(now = Date.now()): Date {
  return new Date(now - BILLING_CORRECTION_WINDOW_MS);
}

// Billing events, unlike the aggregate usage endpoint, identify individual requests.
// Never infer a zero charge from missing events or denied billing permissions.
export async function fetchCloudBill(
  receipt: BillingReceipt,
  request: typeof fetch = fetch,
): Promise<{ actualUsd: number; reference: string } | null> {
  const key = process.env.CLOUD_BILLING_API_KEY?.trim() || process.env.FAL_KEY?.trim();
  if (!key) throw new CloudBillingError(503, "Cloud billing credentials are not configured.");
  const endpointUrl = new URL(receipt.endpoint);
  if (endpointUrl.protocol !== "https:" || endpointUrl.hostname !== "queue.fal.run"
    || endpointUrl.username || endpointUrl.password || endpointUrl.search || endpointUrl.hash) {
    throw new CloudBillingError(503, "Cloud billing receipt endpoint is invalid.");
  }
  const endpointId = endpointUrl.pathname.replace(/^\/|\/$/g, "");
  const now = Date.now();
  let start = new Date(receipt.submittedAt.getTime() - 24 * 60 * 60_000);
  let end = new Date(Math.min(now, start.getTime() + BILLING_CORRECTION_WINDOW_MS));
  if (!Number.isFinite(start.getTime()) || start >= end) {
    throw new CloudBillingError(503, "Cloud billing receipt date is invalid.");
  }
  let cursor: string | undefined;
  let nanos = 0;
  let found = false;
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({
      request_id: receipt.requestId,
      start: start.toISOString(),
      end: end.toISOString(),
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const response = await request(`https://api.fal.ai/v1/models/billing-events?${query}`, {
      headers: { Authorization: `Key ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new CloudBillingError(response.status, response.status === 401 || response.status === 403
        ? "Cloud billing access requires an admin-scoped billing key. Estimates remain in effect."
        : "Cloud billing is temporarily unavailable. Estimates remain in effect.");
    }
    const body = await response.json() as {
      billing_events?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };
    if (!Array.isArray(body.billing_events) || typeof body.has_more !== "boolean") {
      throw new CloudBillingError(503, "Cloud billing returned an invalid response.");
    }
    for (const event of body.billing_events) {
      if (event.request_id !== receipt.requestId || event.endpoint_id !== endpointId
        || typeof event.cost_total !== "number" || !Number.isFinite(event.cost_total) || event.cost_total < 0
        || typeof event.cost_estimate_nano_usd !== "number" || !Number.isSafeInteger(event.cost_estimate_nano_usd)
        || event.cost_estimate_nano_usd < 0
        || Math.abs(event.cost_total - event.cost_estimate_nano_usd / 1e9) > 1e-8) {
        throw new CloudBillingError(503, "Cloud billing returned an invalid or mismatched charge.");
      }
      nanos += event.cost_estimate_nano_usd;
      if (!Number.isSafeInteger(nanos) || nanos > 1_000_000 * 1e9) {
        throw new CloudBillingError(503, "Cloud billing charge exceeds the supported range.");
      }
      found = true;
    }
    if (!body.has_more) {
      // The provider caps each query interval at 90 days, not the whole receipt
      // history. Adjacent exclusive-end windows retain the original charge when
      // a later correction falls beyond the first window.
      if (end.getTime() < now) {
        start = end;
        end = new Date(Math.min(now, start.getTime() + BILLING_CORRECTION_WINDOW_MS));
        cursor = undefined;
        cursors.clear();
        continue;
      }
      if (!found) return null;
      return {
        actualUsd: Math.round(nanos / 1000) / 1_000_000,
        reference: createHash("sha256").update(`${receipt.requestId}|${endpointId}`).digest("hex"),
      };
    }
    if (!body.next_cursor || cursors.has(body.next_cursor)) {
      throw new CloudBillingError(503, "Cloud billing pagination was incomplete.");
    }
    cursor = body.next_cursor;
    cursors.add(cursor);
  }
  throw new CloudBillingError(503, "Cloud billing pagination exceeded the safe limit.");
}