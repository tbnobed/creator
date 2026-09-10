# Cloud spending and monthly allowances

The Spending page tracks paid Cloud image and video work. Local GPU, Ollama,
prompt guidance, and local voice generation are not charged to these allowances.

## Visibility and limits

- Site admins can report across all tenants or select one tenant.
- Tenant owners/admins see tenant-wide usage; members see their own usage.
- Eligible admins can edit invited members' monthly limits. Admins cannot edit
  their own limit. Tenant admins cannot edit owner/admin allowances.
- A blank allowance is unlimited; zero blocks Cloud submissions.
- Invitation allowances transfer on acceptance without overwriting an existing
  membership's allowance.
- Allowances use USD and UTC calendar months, attributed to the submission date.

## Reservations, estimates, and billed costs

Estimated cost is reserved transactionally before provider submission. Concurrent
requests share the same allowance. Provider-confirmed completion initially becomes
estimated spending. Unknown submissions and uncertain cancellations retain their
hold: a local failure does not prove that the provider avoided a charge.

The ledger separates **Reserved**, **Estimated**, and **Billed**. Billed records
replace estimates rather than adding another charge. They are reconciled from
per-request provider billing events, including explicit zero-cost events. Missing
events or billing access errors never mean a zero charge.

Pricing uses live USD rates and documented parameter adjustments. Token-priced
images include conservative allowances, and compute-priced operations reserve
conservative runtime allowances. These are not exact invoices or a guaranteed
provider-side hard cap. A later bill can exceed an estimate; it is recorded
honestly and reduces the allowance for future submissions.

Tracking starts with jobs submitted after this update. Historical jobs are not
assigned invented charges. Recent billed receipts are checked for additional
events/corrections for 90 days; this is not an account-wide invoice/refund
reconciliation system.

## Billing access

The inference credential may not have permission to read billing events. Set the
optional server-only `CLOUD_BILLING_API_KEY` to an ADMIN-scoped key for the same
Cloud provider account. Keep it in secrets, never client configuration or source
control. If absent, the server tries the existing inference credential. Denied
billing access leaves estimates and reservations in effect and logs a safe warning.

Billing reconciliation runs in the API process once per minute, with a 15-minute
backoff after denied access. Restart the API after changing credentials.

## Docker updates

The running Docker installation does not change when workspace source changes.
Update its source and rebuild the API and web images using the normal deployment
procedure. The existing API startup migrator applies additive migrations
`0012_cute_ulik.sql` and `0013_unknown_wong.sql`. Back up the database before
updating. Development migration success does not imply production was migrated.

The compose file forwards the optional billing key to the API. Keep the existing
database and object storage; no migration to a different storage provider is needed.

## Tenant boundary

These are per-membership, per-tenant limits. The existing tenant-creation policy
allows authenticated users to create another tenant and become its owner. That new
tenant can use shared Cloud credentials outside the original tenant's allowance.
An operator approval/funding policy for new tenants is a separate required control
if allowances must prevent that path. This update does not silently change
tenant-creation permissions.