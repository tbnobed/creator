---
name: Paid provider job recovery
description: Defines durable lifecycle rules for paid asynchronous generation providers.
---

Persist the exact queue endpoints returned when a paid provider accepts a job. Reuse them for monitoring, cancellation, restart recovery, and result retrieval. Transient network failures must back off and retry within the overall job timeout rather than immediately abandoning the upstream render.

**Why:** A provider may continue billing and rendering while the application temporarily loses connectivity. Reconstructing endpoints or marking the local job failed too early can orphan a paid result.

**How to apply:** Validate provider-returned endpoints before storing them, add request deadlines, distinguish transient from permanent errors, protect terminal states with conditional updates, and retain a recovery path after the overall timeout.