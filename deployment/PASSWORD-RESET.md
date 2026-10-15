# Password recovery (direct SendGrid)

This implementation calls SendGrid's HTTPS API directly. There is no Replit
connector, managed email service, or Replit runtime requirement.

Configure these on the **API server** using your deployment's private environment:

- `SENDGRID_API_KEY`: a SendGrid API key with Mail Send permission.
- `SENDGRID_FROM_EMAIL`: a verified SendGrid sender address.
- `PUBLIC_APP_URL`: the canonical HTTPS application URL, including any app base
  path, without a query or fragment. Do not use the API-only URL.

Docker Compose forwards all three settings to the API container. Keep the key
out of Git and browser/VITE variables. Restart/redeploy the API after configuring.
The normal Docker startup runs the versioned migration automatically.

## User flow

Sign In → Forgot password → email link → choose and confirm a 12–128 character
password. Links expire after 30 minutes, are single-use, and invalidate all other
reset links and all existing sessions when redeemed. The user then signs in again.

The public endpoint gives the same accepted response for known and unknown
accounts. This is not a guarantee of inbox delivery. Unconfigured email returns
an explicit unavailable error for everyone; configured provider failures are
logged without exposing account existence. Check provider delivery logs for
bounces or suppression. Neither email opens nor link clicks are tracked.

Reset tokens are hashed in PostgreSQL. Links carry tokens in the URL fragment,
which is removed by the reset page and is not sent in HTTP URLs or referrers.
Refreshing after the fragment has been removed requires reopening the email link.
Passwordless legacy users cannot enroll through this flow.

## Administrator flow

Studio Admin → Send Password Reset. A **site administrator**, not a workspace
owner/admin, enters the target email and confirms their own current password.
Site administrators can also use **Account & Workspace → Members → Reset
password** beside a member; this prefills that member's email.
The recipient chooses their own password through the same email flow.
Admins never see a reset token or set a shared/temporary password.
Existing passwords and sessions are unchanged until redemption succeeds.
This protects cross-workspace identities from workspace-level account takeover.

## Operational limits

PostgreSQL-backed limits survive restarts and are shared between API replicas:
15 public reset requests per IP per 15 minutes, 3 emails per target account per
15 minutes, 30 redemption attempts per IP per 15 minutes, and 10 admin actions
per admin per 15 minutes. Configure trusted reverse-proxy forwarding correctly.
Do not trust arbitrary client-supplied forwarding headers.

Tests mock SendGrid (no real email) and use disposable accounts in development.
Live sender verification, inbox delivery and the signed-in admin UI need a
configured deployment. Never run the integration test against production data.
