# Local cost tracking and monthly allowances

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

## Local cost accounting

Estimated cost is reserved transactionally before provider submission. Concurrent
requests share the same allowance. Provider-confirmed completion initially becomes
estimated spending. Unknown submissions and uncertain cancellations retain their
hold: a local failure does not prove that the provider avoided a charge.

The app calculates costs from its checked-in USD rate card and stores them in
its existing database. The rate card and parameter adjustments are in
`artifacts/api-server/src/lib/spending-pricing.ts`. Rates do not update remotely.
The ledger shows completed, locally estimated costs separately from reservations.
No provider billing connection, billing API calls, pricing API calls, invoice
synchronization, or extra billing key is required.

Token- and compute-priced work uses conservative allowances. These are local
estimates, not exact invoices or guaranteed provider-side caps. Tracking starts
with new jobs; historical charges are not invented. Existing database columns
and migrations are retained for compatibility and to avoid deleting stored data.

## Docker updates

The running Docker installation does not change when workspace source changes.
Update its source and rebuild the API and web images using the normal deployment
procedure. The existing API startup migrator applies additive migrations
`0012_cute_ulik.sql` and `0013_unknown_wong.sql`. Back up the database before
updating. Development migration success does not imply production was migrated.

Keep the existing database and object storage; no new billing service or storage
provider is needed.

## Tenant boundary

These are per-membership, per-tenant limits. The existing tenant-creation policy
allows authenticated users to create another tenant and become its owner. That new
tenant can use shared Cloud credentials outside the original tenant's allowance.
An operator approval/funding policy for new tenants is a separate required control
if allowances must prevent that path. This update does not silently change
tenant-creation permissions.