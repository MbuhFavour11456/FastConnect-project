# FastConnect Cloudflare development app

## Deploying

From this directory, apply any pending D1 migrations and deploy the Worker:

```powershell
npx wrangler d1 migrations apply fastconnect-dev --remote
npx wrangler deploy
```

The existing PHP application is separate and is excluded from the Worker assets.
The development site does not connect to a live payment provider or router.
Its optional Fapshi integration is sandbox-only: the provider base URL is fixed
in code to `https://sandbox.fapshi.com`, and only Fapshi's documented test
phone numbers are accepted. It cannot be switched to Fapshi Live by
configuration.
The portal typography uses a self-hosted Manrope font; its SIL Open Font
License is included at `portal/public/assets/fonts/OFL-Manrope.txt`.

## Enabling administrator access

Before deploying admin access, configure two Worker secrets in this directory:

```powershell
npx wrangler secret put ADMIN_SESSION_SECRET
npx wrangler secret put ADMIN_SETUP_TOKEN
```

Enter a different cryptographically random value of at least 32 characters at
each prompt. Keep both values private and do not put them in source files,
command-line arguments, or chat. `ADMIN_SESSION_SECRET` must remain stable: rotating it invalidates existing
sessions and prevents future voucher-code verification. Admin sign-in and
first-admin setup return an explicit unavailable response if the required
secrets are missing.

After deploying and applying migrations, open
`https://fastconnect-dev.mbuhfavour9.workers.dev/admin/setup.html` and enter the
setup token to create the first admin. Use a unique password of at least 12
characters. Setup can create only one admin; subsequent attempts are rejected.
After creating the account, remove the setup secret:

```powershell
npx wrangler secret delete ADMIN_SETUP_TOKEN
```

Sign in at `/admin/login.html`. The family uses the same owner credentials to
access the portal. Share them only among trusted family members and change the
password if it is exposed.

The owner portal includes development views for devices, subscriptions,
payments, vouchers, and audit events. Device approval, live payment processing,
router access, and voucher redemption are not available. Metrics and records
come from the development database and do not represent live router or
payment-provider activity. Sign-out revokes the current admin's existing
sessions. Do not reuse a personal, email, or payment password for the admin
account.

After signing in, open `/admin/account.html` to change the shared owner
password. The current password is required, and a successful change revokes all
active sessions; sign in again with the new password and share it only with
trusted family members.

Open `/admin/plans.html` to create, update, or temporarily disable Wi-Fi plans.
Unavailable plans are hidden from the public plans page but retained for order
history. Changes apply to new orders; each order retains the price recorded
when it was created.

### Fapshi sandbox setup

The checkout can start a **sandbox-only** direct payment request after a router
supplies the customer's device MAC address. Configure sandbox credentials as
Worker secrets (never put them in source code or browser code):

```powershell
npx wrangler secret put FAPSHI_API_USER
npx wrangler secret put FAPSHI_API_KEY
npx wrangler secret put FAPSHI_WEBHOOK_SECRET
```

Use credentials for a Fapshi sandbox service only. In the Fapshi dashboard,
configure its webhook URL as
`https://fastconnect-dev.mbuhfavour9.workers.dev/api/payments/fapshi-webhook`
and set the webhook secret to the same value as `FAPSHI_WEBHOOK_SECRET`.
Payment status is verified server-to-server against Fapshi sandbox before it
is recorded. Repeated status checks are throttled to stay within Fapshi's
per-transaction request limit.

Only documented test numbers are allowed: MTN success `670000000`,
`670000002`, `650000000`; MTN failure `670000001`, `670000003`, `650000001`;
Orange success `690000000`, `690000002`, `656000000`; and Orange failure
`690000001`, `690000003`, `656000001`. Fapshi documents that other sandbox
numbers can have random outcomes, so this site rejects them. No real money is
involved in sandbox transactions. A sandbox success creates development
payment/subscription records but does not grant internet access while the
router integration is absent.

Fapshi says IP allowlisting applies to transaction creation. Cloudflare
Workers do not provide a fixed outbound IP by default; if Fapshi requires an IP
allowlist for the sandbox service, confirm a compatible setup before expecting
initiation to work. Without configured sandbox secrets, payment initiation
returns an explicit unavailable response and creates no payment request.

See Fapshi's official [sandbox environment and test-number
guide](https://docs.fapshi.com/en/api-reference/preliminary-knowledge/environment),
[direct payment endpoint](https://docs.fapshi.com/en/api-reference/endpoint/direct-pay),
[payment status endpoint](https://docs.fapshi.com/en/api-reference/endpoint/payment-status),
and [webhook guide](https://docs.fapshi.com/en/api-reference/endpoint/webhook)
for current provider details.

The Payments and Audit log pages can filter the latest 100 development records
by status/actor and date, then export the currently matching records as CSV.
Payment exports include only the last two phone-number digits.

### Subscription expiry

A Worker Cron Trigger runs hourly and marks active subscriptions expired when
their recorded `expires_at` time has passed. For each expiry it records an
audit event and queues a router revocation command. A grant that is still
pending when its subscription expires is failed instead of being granted;
already claimed grants are followed by the queued revocation. These commands
remain queued until a router is connected and configured. This lifecycle
updates development records but does not itself enable or change Wi-Fi access.

### Cash vouchers

The owner can create an unused voucher for an active plan after recording a
cash payment, add an optional tenant/room note, search/filter the latest 100
vouchers by status and date, export the filtered list as CSV, and cancel an
unused voucher. Voucher exports contain plan, amount, note, status, and
timestamps, but never voucher codes. Codes are generated with a cryptographic
random source, shown only in the creation response, and stored as keyed hashes;
they cannot be recovered from the dashboard later. Voucher history snapshots
the plan name, duration, and price, so creating a voucher locks that plan's
name and duration while still allowing its price/description/availability to
change for future use.

Voucher redemption is deliberately disabled until the router arrives and is
integrated. Creating or recording a voucher does not create a subscription or
grant network access. A voucher code should not be handed to a customer as
redeemable until the redemption flow is enabled and tested.


## Customer accounts foundation (migration 0008)

The customer-account foundation introduces a separate customer identity model alongside the existing development checkout. It adds password-hashed accounts, hashed opaque session tokens, HttpOnly session cookies, login throttling, and account audit events. The public account page is available at `/account.html`.

The migration also establishes tables for household memberships, access entitlements, guest passes, and network-session tracking. These are schema foundations, not yet an enabled access-control product: household approval endpoints, guest-pass redemption, email verification/recovery, paid-order ownership, and live router session transfer still need implementation and integration tests. Existing orders and subscriptions are retained; their new `customer_id` columns are nullable so this migration does not invent owners for historical records.

A successful customer login revokes the account's prior browser session. The database also has a partial unique index intended to prevent more than one active network session per customer. That index is a safety guard, not a substitute for router-side enforcement. The MikroTik adapter must disconnect the old session and confirm the result before a new one is considered active.

Apply the migration to a disposable local database first, then run:

```sh
npm test
```

Do not deploy the customer account page as a production sign-in system until email verification, password recovery, abuse controls, account lifecycle flows, privacy terms, and the household/router authorization endpoints are completed and tested.


### Administrator-managed household access

The admin portal's `/admin/households.html` page uses these endpoints:

- `GET /api/admin/customers`: list customer account records without password hashes.
- `GET /api/admin/households`: list households and active/pending membership counts.
- `POST /api/admin/households`: create a household for an existing customer; the owner membership is approved immediately.
- `POST /api/admin/households/:id/members`: add an existing customer as a pending family member.
- `GET /api/admin/household-memberships`: review membership status.
- `POST /api/admin/household-memberships/:id/approve`: approve a pending member and create a non-expiring household entitlement.
- `POST /api/admin/household-memberships/:id/revoke`: revoke the membership and household entitlement.

Every mutating admin endpoint checks the signed administrator session and request origin. Membership changes are recorded in the account audit log. These records do not yet drive live router access; MikroTik enforcement and reconciliation must be completed before free household access is operational.
