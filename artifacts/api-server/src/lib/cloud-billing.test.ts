import assert from "node:assert/strict";
import { test } from "node:test";
import { billingCorrectionCutoff, CloudBillingError, fetchCloudBill } from "./cloud-billing";

process.env.CLOUD_BILLING_API_KEY ||= "billing-unit-test";
const receipt = {
  requestId: "unit-test-request",
  endpoint: "https://queue.fal.run/fal-ai/nano-banana-2",
  submittedAt: new Date(Date.now() - 60_000),
};
const event = (cost: number) => ({
  request_id: receipt.requestId,
  endpoint_id: "fal-ai/nano-banana-2",
  timestamp: new Date().toISOString(),
  cost_total: cost,
  cost_estimate_nano_usd: Math.round(cost * 1e9),
});
const mock = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;

test("missing billing events and denied access never become a zero charge", async () => {
  assert.equal(await fetchCloudBill(receipt, mock({ billing_events: [], has_more: false })), null);
  await assert.rejects(fetchCloudBill(receipt, mock({}, 403)), (error: unknown) =>
    error instanceof CloudBillingError && error.statusCode === 403);
  const explicitZero = await fetchCloudBill(receipt, mock({ billing_events: [event(0)], has_more: false }));
  assert.equal(explicitZero?.actualUsd, 0);
});

test("billing events sum all pages and retain stable receipt identity for corrections", async () => {
  let calls = 0;
  const bill = await fetchCloudBill(receipt, (async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, "api.fal.ai");
    assert.equal(parsed.searchParams.get("request_id"), receipt.requestId);
    return Response.json(calls++ === 0
      ? { billing_events: [event(0.03)], has_more: true, next_cursor: "page2" }
      : { billing_events: [event(0.02)], has_more: false });
  }) as typeof fetch);
  assert.equal(bill?.actualUsd, 0.05);
  assert.equal(calls, 2);
  const corrected = await fetchCloudBill(receipt, mock({ billing_events: [event(0.04)], has_more: false }));
  assert.equal(bill?.reference, corrected?.reference);
});

test("foreign receipts, corrupt amounts, incomplete pages and unknown hosts fail closed", async () => {
  for (const invalid of [
    { ...event(0.03), request_id: "someone-else" },
    { ...event(0.03), endpoint_id: "wrong-model" },
    { ...event(0.03), cost_total: -1 },
    { ...event(0.03), cost_estimate_nano_usd: 9 },
  ]) {
    await assert.rejects(fetchCloudBill(receipt, mock({ billing_events: [invalid], has_more: false })));
  }
  await assert.rejects(fetchCloudBill(receipt, mock({ billing_events: [], has_more: true })));
  await assert.rejects(fetchCloudBill({ ...receipt, endpoint: "https://evil.example/model" }, mock({})));
});

test("billed receipts remain eligible after day seven and late correction windows retain earlier charges", async () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  assert(thirtyDaysAgo > billingCorrectionCutoff());
  let priorEnd: string | undefined;
  let calls = 0;
  const bill = await fetchCloudBill({
    ...receipt,
    submittedAt: new Date(Date.now() - 89.5 * 24 * 60 * 60_000),
  }, (async (url) => {
    const query = new URL(String(url)).searchParams;
    if (priorEnd) assert.equal(query.get("start"), priorEnd);
    priorEnd = query.get("end")!;
    return Response.json({ billing_events: [event(calls++ === 0 ? 0.03 : 0.02)], has_more: false });
  }) as typeof fetch);
  assert.equal(calls, 2);
  assert.equal(bill?.actualUsd, 0.05);
});