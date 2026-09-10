---
name: Local cost tracking scope
description: Cost tracking is an in-app ledger, not a provider billing integration.
---

Keep billing/cost tracking local to the application: estimate job costs from a local rate card, store usage by tenant and user, and enforce monthly allowances. Do not add provider billing synchronization, live pricing lookups, invoice reconciliation, or billing credentials without an explicit new request.

**Why:** The user explicitly rejected provider billing integration as an unauthorized expansion of their request for local tracking and spending limits.

**How to apply:** Improve the local ledger, reports, and allowance controls rather than connecting accounting to external billing APIs. “Local tracking” describes where accounting happens; it does not change the earlier Cloud/API-only scope to include local GPU costs.