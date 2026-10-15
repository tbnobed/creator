---
name: Portable authentication enrollment
description: Security boundary between first-admin bootstrap, workspace invitations, and legacy credential enrollment.
---

First-administrator bootstrap requires a high-entropy, one-time operator credential independent of the configured email. Ordinary workspace invitations must never authorize setting a password on an existing passwordless identity; only a privileged enrollment invitation bound to that exact user ID may do so.

**Why:** Email addresses are public identifiers, and tenant-issued bearer invitations can otherwise be used to claim a legacy identity and inherit its unrelated tenant or site-administrator access.

**How to apply:** Keep bootstrap credentials out of URLs and persisted account data, close bootstrap after the first password account exists, and validate legacy-enrollment authority again when an invitation is redeemed.

Password-reset email delivery must not depend on Replit.

**Why:** The user requested self-service password reset and asked for SendGrid with “no replit dep.”

**How to apply:** Use a direct, portable email-provider integration for this flow rather than a Replit-managed email dependency.

Administrator password recovery belongs to site administrators, not workspace administrators; send a reset link to the existing account email rather than disclosing a token or choosing the user's password.

**Why:** One identity can belong to multiple workspaces, so granting workspace admins account-wide reset authority would allow cross-workspace takeover.

**How to apply:** Require site-admin authorization and current-password confirmation. Keep ordinary self-service recovery separate from enrollment of passwordless identities.