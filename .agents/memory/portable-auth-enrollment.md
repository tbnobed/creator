---
name: Portable authentication enrollment
description: Security boundary between first-admin bootstrap, workspace invitations, and legacy credential enrollment.
---

First-administrator bootstrap requires a high-entropy, one-time operator credential independent of the configured email. Ordinary workspace invitations must never authorize setting a password on an existing passwordless identity; only a privileged enrollment invitation bound to that exact user ID may do so.

**Why:** Email addresses are public identifiers, and tenant-issued bearer invitations can otherwise be used to claim a legacy identity and inherit its unrelated tenant or site-administrator access.

**How to apply:** Keep bootstrap credentials out of URLs and persisted account data, close bootstrap after the first password account exists, and validate legacy-enrollment authority again when an invitation is redeemed.