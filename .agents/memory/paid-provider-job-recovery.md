---
name: Paid provider job recovery
description: Defines durable lifecycle rules for paid asynchronous generation providers.
---

Persist the exact queue endpoints returned when a paid provider accepts a job. Reuse them for monitoring, cancellation, restart recovery, and result retrieval. Transient network failures must back off and retry within the overall job timeout rather than immediately abandoning the upstream render.

**Why:** A provider may continue billing and rendering while the application temporarily loses connectivity. Reconstructing endpoints or marking the local job failed too early can orphan a paid result.

**How to apply:** Validate provider-returned endpoints before storing them, add request deadlines, distinguish transient from permanent errors, protect terminal states with conditional updates, and retain a recovery path after the overall timeout.

Treat provider submission as an uncertain side effect until its receipt is persisted. Keep a tenant-scoped client request key across transport retries, and never automatically resubmit a job whose acceptance outcome is unknown.

**Why:** A local idempotency key prevents duplicate application requests, but cannot guarantee exactly-once billing when the provider accepts work just before the API loses the response or crashes. Retrying such a submission can charge twice.

**How to apply:** Persist submission intent before dispatch, reuse known provider receipts for polling, and explicitly surface an unknown submission outcome when no receipt can be recovered. Persist cancellation intent before calling the provider so restart recovery does not resume ordinary rendering.

Do not treat a failed local job, timeout, cancellation acknowledgement, or deleted result as proof that a Cloud charge was avoided. Unknown submissions retain their spending reservation; confirmed provider completion consumes the estimated allowance even if downloading or storing the output subsequently fails.

**Why:** Application status and provider billing outcome are different facts. Releasing an allowance on every local failure would allow repeated paid work to bypass spending limits.

**How to apply:** Release only on affirmative evidence of non-billable execution. Keep accounting idempotent across restarts and polling, retain attribution after job deletion, and distinguish budget estimates from provider-invoiced charges.