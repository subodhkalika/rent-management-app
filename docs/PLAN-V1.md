# V1 Plan — Rent Management SaaS

> A **design record**: what was decided and why, at the time it was decided. Parts
> of it have since been superseded — superseded decisions are marked inline.
> For what the system does *now*, read [BEHAVIOUR.md](./BEHAVIOUR.md).

> Written by `architect`. This is a **plan**, not a contract. The orchestrator turns each
> phase's "Frozen contract" section into real files under `packages/contract/src/`, then
> dispatches a backend/frontend pair against it.
>
> Where this document and `docs/ARCHITECTURE.md` §6 disagree, this document wins — §6 was a
> scaffolding sketch and is wrong in three places (see §0.3).

---

## 0. Summary of decisions

### 0.1 The ten decisions that matter

| # | Decision | One-line reason |
|---|---|---|
| 1 | A tenant user is **NOT an organization member**. Separate principal, linked by `tenant.user_id`. | `requireAuth` only checks membership, so making tenants members fails **open** on every existing and future landlord route. |
| 2 | Tenant authorization scope is a **set of `(orgId, tenantId)` pairs** resolved from the session user, not a single pinned `orgId`. | A tenant renting from two landlords is one login with two scopes; pinning one org would force a landlord-switcher into the tenant UI. |
| 3 | Tenant accounts are created by **landlord-issued, single-use, hashed invite token** emailed to the tenant's address on file. | 256-bit token means nothing to enumerate; the email is taken from the invite row, never the request body, so nobody can attach an arbitrary address. |
| 4 | Charges are **materialised rows written by a daily cron**, idempotent on `(lease_id, generation_key)`. | Charges get voided, superseded and reminded-against; computed-on-read cannot carry a correction or a stable id. |
| 5 | **Cloudflare Cron Triggers**, not GitHub Actions cron. | Free on the Workers free plan, no inbound secret endpoint to protect, and GH Actions schedules are silently delayed/skipped under load. This overrides the stack note in ARCHITECTURE.md §2. |
| 6 | Payments are append-only. Corrections = **void + successor row** (`supersedes_id`). Only `note` is mutable. | A reference number is evidence; a note is not. |
| 7 | Charges follow the **same** void+supersede model as payments. | One audit story, one mental model, one UI affordance ("Edit" = void + recreate). |
| 8 | **No allocation table.** Payment→charge application is derived FIFO by `due_date` in one window-function query. | Deterministic, recomputable, zero drift, and a lease has tens of charges, not millions. |
| 9 | Billing periods are **calendar months**; due day is `min(billing_day, daysInMonth)`; proration is `round(rent * days / daysInMonth)`. | "March rent" is what landlords say; clamping is what they already do; actual-days proration is what a tenant computes themselves. |
| 10 | A rent change creates a **new lease row** chained by `renewed_from_lease_id`, with a stable `chain_id` for balance aggregation. | A lease term has one rent; superseding beats mutating, same as the money model. |

### 0.2 Two bugs in the existing code, found while reading

**A. The tenancy guard is not recursive — a subdirectory silently escapes it.**
`apps/api/src/db/repo/tenancy.guard.test.ts` line 19:

```ts
return readdirSync(REPO_DIR).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
);
```

`readdirSync` is non-recursive. The moment anyone adds `db/repo/portal/lease.ts` or
`db/repo/system/charges.ts` — both of which this plan requires — those files are unguarded
and nothing fails. **Fix this in Phase 1, before any subdirectory exists.** Use
`readdirSync(REPO_DIR, { recursive: true })` and add an assertion that the discovered file
count is greater than or equal to a hardcoded floor, so a future refactor that empties the
glob fails loudly instead of passing vacuously.

**B. A landlord who belongs to two orgs is reset to the first on every new session.**
`apps/api/src/lib/auth.ts` `databaseHooks.session.create.before` always picks the earliest
membership. `setActive` only mutates the current session, so the next sign-in silently
snaps back. Low severity today (one org per landlord), but it will be reported as a bug the
first time someone manages two portfolios. Default fix: persist last-active org on `user`
and prefer it in the hook. **Deferred — not in v1 scope, logged here.**

### 0.3 Where ARCHITECTURE.md §6 is wrong

| §6 says | Reality | Fix |
|---|---|---|
| `lease n---1 tenant` | A lease routinely has 2+ tenants, jointly and severally liable (couples, roommates). | `lease_tenant` join table with `added_on` / `removed_on`. |
| `* 1---n document` | Polymorphic owner with no FK = orphan rows and no referential integrity. | Five nullable FK columns + a CHECK that exactly one is non-null. |
| Entity list is complete | Missing `charge` (the entire ledger), `lease_tenant`, `tenant_invite`, `org_settings`, `reminder_log`, `maintenance_comment`. | See §2. |
| "Tenants may later get a limited portal login" | Tenants are a first-class actor in v1 with their own principal type. | §1. |

---

## 1. The two-actor permission model

### 1.1 Recommendation: tenant = separate principal, not an org member

**A tenant user has no `member` row.** The link is a nullable `tenant.user_id` pointing at
Better Auth's `user` table. A `tenant` row belongs to exactly one org; a `user` may be
pointed at by many `tenant` rows across many orgs. That is a plain many-to-one — no join
table needed for the link itself.

**Why, in one sentence:** `requireAuth` authorizes on nothing but "do you have a `member`
row for your active org", so the instant a tenant has one, every existing route
(`/v1/properties`, `/v1/units/:id`) and every route written in the next year is reachable
by that tenant unless someone remembers to add a `requireLandlord` decorator — a security
boundary that defaults to open.

**What breaks if you take the rejected option (tenant as a restricted org member):**

1. **Fail-open on all existing routes.** `properties.ts` and `units.ts` mount
   `requireAuth` and nothing else. A tenant with a `member` row reads and writes the
   landlord's entire property portfolio on day one. Retrofitting a role check onto every
   route means every future route is one forgotten decorator from a breach.
2. **Better Auth's own org endpoints become reachable.** `/api/auth/organization/*` is
   handled by the plugin, not by our middleware. A member can call `getFullOrganization`
   (returns the full member list — every other tenant's email address), `listInvitations`,
   `leaveOrganization`, and with a mis-specified access-control statement set,
   `inviteMember` and `updateMemberRole`. Locking that down means authoring and maintaining
   a complete custom AC config and keeping it correct across every Better Auth upgrade —
   security that lives in a dependency's configuration rather than in our code.
3. **`membershipLimit: 20`** (`lib/auth.ts`) caps a landlord at 20 tenants.
4. **Multi-landlord becomes an org switcher.** A tenant with leases from two landlords
   would have to pick a landlord before seeing their rent — absurd UX for the one screen
   that should just say "here are your two tenancies".
5. **Session default-org hook misfires.** The `session.create.before` hook would set a
   tenant's `activeOrganizationId` to their landlord's org, which is exactly the value
   `requireAuth` trusts as the tenancy boundary.

**What the chosen option costs:** `requireAuth` 403s for a tenant (no active org), so the
web root guard must branch on actor type before routing — solved by `GET /v1/me/context`
(§3.1). And tenant-scoped repo functions cannot take a session `orgId` first, so the repo
invariant needs an explicit, narrow extension (§1.4). Both are small and both are in
Phase 1.

### 1.2 Multi-landlord: does the model survive? Walk it.

Scenario: Dana rents flat 2B from Alice Lettings (org `A`) and a garage from Bob Property
(org `B`).

```
user(id=u_dana, email=dana@example.com)
  ^                        ^
  | user_id                | user_id
tenant(id=t1, org_id=A)   tenant(id=t2, org_id=B)
  |                        |
lease_tenant -> lease(L1, org_id=A)   lease_tenant -> lease(L2, org_id=B)
```

- Dana has **one** login. No org switching, no second account.
- `requireTenant` resolves, from `u_dana` alone:
  `scope = [{orgId: A, tenantId: t1}, {orgId: B, tenantId: t2}]`.
- `GET /v1/portal/leases` returns L1 and L2 side by side, each labelled with its landlord's
  org name. Crossing orgs here is **correct**, because the authorization fact is "these are
  Dana's tenant identities", not "this is Dana's org".
- Alice never learns that Bob exists. Nothing in any landlord-facing response joins through
  `tenant.user_id` to another org's rows. The only place `user_id` is read on the landlord
  side is to render a boolean "portal access: active / invited / none".
- Dana's balance with Alice and her balance with Bob are separate numbers in separate
  currencies if need be. Nothing ever sums across orgs.
- If Alice archives `t1`, `t1` drops out of the scope set on Dana's next request. `t2` is
  untouched. No session invalidation needed, because the scope is resolved per request from
  the database, exactly like `requireAuth` re-checks `member` on every request today.

A deliberate consequence worth stating: **the same person can be a landlord and a tenant.**
Dana may also own a rental. She then has a `member` row for her own org `D` *and* tenant
rows in `A` and `B`. `GET /v1/me/context` returns both; the web app shows a top-level
switch between "My properties" and "My tenancies". Nothing conflicts, because the two
principals are resolved by different middleware from different tables.

### 1.3 How a tenant gets an account

**Landlord-issued, single-use, hashed invite token, delivered by email.**

Flow:

1. Landlord creates the `tenant` record with an email.
2. Landlord clicks "Invite to portal" → `POST /v1/tenants/:id/invite`.
   - Server generates 32 random bytes (`crypto.getRandomValues`), hex-encodes → raw token.
   - Stores **only** `sha256(token)` in `tenant_invite.token_hash`. Also stores
     `email` (snapshotted from the tenant row at issue time), `expires_at = now + 14 days`.
   - Emails the tenant a link: `{WEB_ORIGIN}/portal/accept?token=<raw>`.
   - Returns the full URL **once** in the response so the landlord can copy it if the email
     bounces. It is never retrievable again.
3. Tenant opens the link → `POST /v1/portal/invites/accept`.
   - **Unauthenticated path:** body is `{ token, name, password }`. Server looks the invite
     up by `sha256(token)` — never by email, never by tenant id. Creates the Better Auth
     user with **the email from the invite row**, not from the request. Sets
     `emailVerified = true` (possession of the emailed token proves the address). Binds
     `tenant.user_id`.
   - **Authenticated path:** body is `{ token }`. Binds the current session user. This is
     how Dana attaches her second landlord to her existing login.
4. Invite is marked `accepted_at` / `accepted_user_id`. Single use.

Why not the alternatives:

- **Self-signup with a code**: a human-typeable code is short enough to brute force, and
  the landlord has to transmit it out of band anyway — which is the same channel as a link,
  with less entropy.
- **Magic link per login**: Resend's free tier is 3,000 emails/month and that budget is
  already committed to rent reminders. Password auth costs zero emails after onboarding.
- **Open self-registration against a lease reference**: lets anyone with a street address
  and a unit number probe for valid tenancies. Disqualified.

Anti-enumeration rules, all mandatory:

- Lookup is by token hash only. There is no endpoint that takes a tenant id or an email and
  reports whether an invite exists.
- Every failure mode — bad token, expired, revoked, already accepted, tenant archived —
  returns an identical `404 not_found` with the message
  `"This invitation is no longer valid. Ask your landlord to send a new one."`
- If a user already exists for the invite's email, respond `409 conflict`:
  `"An account already exists for this email. Sign in first, then open the invite link again."`
  This does leak "an account exists for the address written on this invite" — but the
  caller already holds a 256-bit token tied to that address, so they knew.
- If `tenant.user_id` is already set to a different user → `409 conflict`.
- No rate limiting. A 256-bit token is not brute-forceable and Workers free tier has no
  durable counter worth the complexity. Stated deliberately, not forgotten.

Landlord controls: `DELETE /v1/tenants/:id/portal-access` revokes any pending invite;
`POST /v1/tenants/:id/invite` on a tenant with a live invite revokes the old one and issues
a new one (so "resend" is just "invite again"). `DELETE /v1/tenants/:id/portal-access`
unbinds `tenant.user_id` and revokes outstanding invites — the move-out kill switch.

Password reset for tenants uses Better Auth's `sendResetPassword`, wired to Resend in
Phase 1. It is also what landlords get, which is currently missing.

### 1.4 What the repo invariant becomes

The ARCHITECTURE.md §5 rule — *every repo function takes `orgId` first and filters on it* —
**survives unchanged for every landlord-facing function**. It is extended, not replaced, by
two narrow additions:

```
apps/api/src/db/repo/*.ts          landlord. First param `orgId: string` from the session.
                                   Guarded by tenancy.guard.test.ts. UNCHANGED.

apps/api/src/db/repo/portal/*.ts   tenant. First param `scope: TenantScope`.
                                   Guarded by portal-tenancy.guard.test.ts (new).

apps/api/src/db/repo/system/*.ts   cron. No caller principal. Writes org_id on every row.
                                   Guarded by system-repo.guard.test.ts (new).
```

`TenantScope` is resolved by `requireTenant` from the session user and nothing else:

```ts
type TenantScope = {
  userId: string;
  pairs: ReadonlyArray<{ orgId: string; tenantId: string }>;  // never empty
};
```

**The portal guard test asserts, for every exported function in `repo/portal/` that runs a
query:** first parameter is `scope: TenantScope`, and the body references both `orgId` and
`tenantId`. A `(org_id, tenant_id)` pair filter is strictly stronger than the `org_id`
filter it replaces — it is a conjunction, not a substitution.

**The verify-then-scope rule** (the part that keeps the blast radius small): a tenant route
that touches a child resource must first resolve the parent lease through the scope, then
use the `orgId` that resolution returns:

```ts
// routes/portal/ledger.ts
const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId);  // (org,tenant) pair filter
if (!resolved) throw notFound('Lease');
// `resolved.orgId` is now as trusted as a session orgId — it came out of a capability check.
const charges = await chargeRepo.listCharges(resolved.orgId, db, leaseId);  // ordinary repo fn
```

So **child-resource repo functions stay in the landlord directory with the ordinary
`(orgId, db, ...)` signature and the existing guard covers them.** Only the small set of
root-resolution functions lives under `repo/portal/`. Concretely that is five functions:
`resolveScope`, `listLeases`, `resolveLease`, `resolveMaintenanceRequest`,
`resolveDocument`. Everything else in the portal composes from those plus ordinary repo
calls.

`system/` is the cron's exception. Rules, enforced by a static test: files under
`db/repo/system/` may be imported **only** by `apps/api/src/jobs/**` and never by anything
under `src/routes/**`; every INSERT must include `org_id` as a literal column; every SELECT
must either select `org_id` or join a table that provides it. The test greps the import
graph — cheap and sufficient.

Hono context gains one variable:

```ts
Variables: {
  db, body, query,
  userId: string,
  orgId: string,          // set by requireAuth ONLY. Never set on a portal request.
  tenantScope: TenantScope, // set by requireTenant ONLY. Never set on a landlord request.
}
```

Middleware inventory after Phase 1:

| Middleware | Sets | Rejects when |
|---|---|---|
| `requireSession` (new) | `userId` | no session → `401 unauthorized` |
| `requireAuth` (unchanged) | `userId`, `orgId` | no session → 401; no active org → 403; no `member` row → 403 |
| `requireAdmin` (unchanged) | — | role not in owner/admin → 403 |
| `requireTenant` (new) | `userId`, `tenantScope` | no session → 401; zero live tenant rows → `403 forbidden` |

`requireTenant` excludes tenant rows that are `deleted_at IS NOT NULL` or
`status = 'archived'`, so revoking a tenant's access is a single UPDATE that takes effect on
their next request.

### 1.5 What a tenant may read and write

| Resource | Read | Write |
|---|---|---|
| Own profile (name, phone, emergency contact, reminder opt-out) | yes | yes |
| Password | — | yes (Better Auth) |
| Own leases, incl. ended ones, incl. leases they were removed from | yes | no |
| Co-tenants on a shared lease | **display name only** — no email, no phone | no |
| Charges on own leases | yes | no |
| Payments on own leases (all of them, incl. a co-tenant's) | yes | no |
| Balance on own leases | yes | no |
| Maintenance requests they raised, plus any on their current unit | yes | create + comment |
| Documents on own lease/unit with `visible_to_tenant = true`, plus own uploads | yes | upload (lease- or request-scoped only) |
| Property/unit detail | address, unit label, landlord org name only | no |
| Anything else in the org | **no** | **no** |

Rationale for the two judgement calls: co-tenants see each other's payments because they
are jointly liable for the same debt and already know what was paid; they do not see each
other's contact details because a landlord's tenant record is not a directory service.

A tenant **never** writes money. No payment claims in v1 (§7, open question). A tenant who
has paid attaches a receipt as a document on the lease; it surfaces to the landlord as an
unreviewed tenant upload.

### 1.6 Attack walk: "I am a tenant, authenticated, holding a UUID I should not have"

| Attempt | Result | Why |
|---|---|---|
| `GET /v1/properties` | `403 forbidden` | No `member` row → no `activeOrganizationId` → `requireAuth` rejects before any query. |
| `GET /v1/properties/{landlordA_property_uuid}` | `403` | Same, rejected at middleware. |
| Tenant creates their own org via Better Auth, then `GET /v1/properties` | `200 []` | `requireAuth` now passes for **their own empty org**; the repo filters on it. Zero reach into the landlord's org. |
| `GET /v1/portal/leases/{other_tenants_lease_uuid}` | `404 not_found` | `WHERE lease.id = $1 AND (org_id, tenant_id) IN scope.pairs` → zero rows. 404 not 403, so existence is not confirmed. |
| `GET /v1/portal/leases/{valid_own_lease}/charges` where the charge belongs elsewhere | n/a | Charges are listed by verified lease id, never fetched by charge id. |
| `POST /v1/portal/maintenance-requests { unitId: <someone elses> }` | — | **The route does not accept `unitId`.** It accepts `leaseId`, resolved through scope; unit, property and org are all derived server-side from the resolved lease. This is the single most important shape decision in the portal. |
| `GET /v1/portal/documents/{guessed_uuid}` | `404` | `resolveDocument(scope, ...)` requires the document's `org_id` + owner to resolve through a scoped lease/tenant/request. Plus `visible_to_tenant` for landlord uploads. |
| `GET /v1/exports/payments.csv` | `403` | Landlord route behind `requireAuth`. |
| `/api/auth/organization/get-full-organization` for the landlord's org | denied by Better Auth | Not a member. (Under the rejected model this **succeeds** and returns every tenant's email.) |
| Forged pagination cursor | `400 bad_request` | `decodeCursor` validates UUID shape, and `id > cursor` is always ANDed with the scope filter. |
| Replays a `?orgId=` query param on any portal route | ignored | No route reads an org id from the request. Grep-checkable; add it to the reviewer checklist. |
| Brute-forces `/v1/portal/invites/accept` | `404` forever | 2^256 keyspace, uniform error response. |
| Tenant is archived by the landlord mid-session | next request `403` | `requireTenant` re-resolves from the DB every request. |

And the landlord-vs-landlord walk, for completeness: **"I am landlord B holding landlord A's
tenant UUID."** `POST /v1/tenants/{A_tenant}/invite` → the repo filters `org_id = B` → no
row → `404`. Landlord B cannot mint an invite into landlord A's org, so the invite flow
does not become a lateral-movement primitive.

One residual risk, accepted and stated: **whoever possesses the raw invite token becomes
that tenant's portal user.** A forwarded invite email is an account takeover. Mitigations:
the link is only ever emailed to `tenant.email`; the landlord-visible copy is shown once;
expiry is 14 days; the landlord can revoke and can see `accepted_at` + the bound user's
email. This is the same risk profile as every email-invite system, including Better Auth's
own org invites.

---

## 2. Data model delta

Conventions unchanged: `snake_case` in PG via Drizzle `casing: 'snake_case'`, UUIDv7 PKs
from `uuidv7()`, money as `bigint({ mode: 'number' })` integer minor units, `date` for
day-precision, `timestamptz` for instants. **Every table below carries `org_id text not
null references organization(id) on delete cascade`** unless the row explicitly says
otherwise. There is exactly one table without `org_id` and it is called out.

### 2.1 Changes to existing tables

| Table | Change | Migration note |
|---|---|---|
| `property` | **add** `timezone text not null default 'UTC'` (IANA) | Safe single-step: `NOT NULL DEFAULT`. The contract makes it **required on create** going forward. **Flag:** if any real landlord data exists, `'UTC'` is wrong for arrears — the web app must show a one-time "confirm your timezone" banner on any property still at `'UTC'`. |
| `unit` | no column change; `status` semantics tighten | Lease activate/end now writes `unit.status`. `'unavailable'` stays landlord-set, and activating a lease on an `unavailable` unit is a `409`. |
| `session` | none | — |

### 2.2 New tables

**`tenant`** — a person known to one landlord.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK → organization, cascade | |
| `user_id` | `text` NULL FK → user, `on delete set null` | the portal link. NULL = no portal access. |
| `first_name` | `text` NOT NULL | |
| `last_name` | `text` NOT NULL | |
| `email` | `text` NULL | required to invite; nullable so a cash-only tenant can exist |
| `phone` | `text` NULL | |
| `emergency_contact_name` | `text` NULL | |
| `emergency_contact_phone` | `text` NULL | |
| `status` | `tenant_status` enum NOT NULL default `'active'` | `prospect \| active \| past \| archived` |
| `reminders_opted_out` | `boolean` NOT NULL default false | tenant-togglable |
| `notes` | `text` NULL | landlord-private, never returned to the portal |
| `deleted_at` | `timestamptz` NULL | |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | |

Indexes:
- `tenant_org_idx on (org_id, deleted_at)`
- `tenant_user_idx on (user_id) where user_id is not null` — **the hot path for `requireTenant`**
- `tenant_org_user_uq unique (org_id, user_id) where user_id is not null` — one portal identity per org per user
- `tenant_org_email_uq unique (org_id, lower(email)) where email is not null and deleted_at is null`

**`tenant_invite`** — single-use portal invite.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `tenant_id` | `uuid` NOT NULL FK → tenant, cascade | |
| `email` | `text` NOT NULL | snapshot at issue; the account is created with **this**, never the request body |
| `token_hash` | `text` NOT NULL | hex SHA-256 of a 32-byte random token. Raw token never stored. |
| `expires_at` | `timestamptz` NOT NULL | now + 14 days |
| `accepted_at` | `timestamptz` NULL | |
| `accepted_user_id` | `text` NULL FK → user | |
| `revoked_at` | `timestamptz` NULL | |
| `created_by_user_id` | `text` NOT NULL FK → user | |
| `created_at` | `timestamptz` NOT NULL | |

Indexes: `tenant_invite_token_uq unique (token_hash)` (the only lookup path for accept);
`tenant_invite_tenant_idx on (org_id, tenant_id)`.

**`lease`** — one term, one rent.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `unit_id` | `uuid` NOT NULL FK → unit | property/timezone reached via one join; **not** denormalised |
| `chain_id` | `uuid` NOT NULL | = `id` for a fresh lease, = predecessor's `chain_id` on renewal. Balances aggregate on this. |
| `renewed_from_lease_id` | `uuid` NULL FK → lease | |
| `start_date` | `date` NOT NULL | |
| `end_date` | `date` NULL | NULL = month-to-month/rolling. Inclusive when set. |
| `move_out_date` | `date` NULL | actual, may differ from `end_date` |
| `rent_cents` | `bigint` NOT NULL | |
| `currency` | `text` NOT NULL | inherited from unit at creation; immutable |
| `rent_frequency` | `rent_frequency` enum NOT NULL default `'monthly'` | **`monthly \| yearly`** per the 2026-10-05 decision. Immutable on an active lease: changing cadence means a new lease in the same `chain_id`, so already-generated charges keep the cadence they were written under. |
| `billing_day` | `smallint` NOT NULL | 1..31, clamped at use |
| `deposit_cents` | `bigint` NOT NULL default 0 | |
| `ledger_start_date` | `date` NOT NULL | generation never produces a period starting before this. Lets a landlord onboard an in-flight tenancy. |
| `status` | `lease_status` enum NOT NULL default `'draft'` | `draft \| active \| ended \| terminated \| cancelled` |
| `end_reason` | `text` NULL | |
| `notes` | `text` NULL | landlord-private |
| `deleted_at` | `timestamptz` NULL | only ever on a `draft`/`cancelled` lease (see §5.3) |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | |

Indexes:
- `lease_org_unit_idx on (org_id, unit_id, status)`
- `lease_chain_idx on (org_id, chain_id)`
- `lease_active_idx on (org_id, status, start_date)` — the cron's driving scan
- `lease_unit_active_uq unique (unit_id) where status = 'active'` — **one active lease per unit, enforced by the database.** This is the single most valuable constraint in the schema; without it a double-booked unit generates two sets of rent charges and nobody notices for a month.

**`lease_tenant`** — joint and several liability, with history.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `lease_id` | `uuid` NOT NULL FK → lease, cascade | |
| `tenant_id` | `uuid` NOT NULL FK → tenant | |
| `is_primary` | `boolean` NOT NULL default false | who reminders address; exactly one per lease, enforced in the repo |
| `added_on` | `date` NOT NULL | |
| `removed_on` | `date` NULL | roommate swap |
| `created_at` | `timestamptz` NOT NULL | |

Indexes: `lease_tenant_uq unique (lease_id, tenant_id)`;
`lease_tenant_tenant_idx on (org_id, tenant_id)` — **the portal's driving scan**.

**`charge`** — an obligation. Immutable except for the void tombstone.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `lease_id` | `uuid` NOT NULL FK → lease | |
| `type` | `charge_type` enum NOT NULL | `rent \| deposit \| late_fee \| utility \| opening_balance \| other` |
| `period_start` | `date` NULL | NULL for non-periodic charges |
| `period_end` | `date` NULL | |
| `due_date` | `date` NOT NULL | already clamped; never day 31 in February |
| `amount_cents` | `bigint` NOT NULL | > 0, CHECK |
| `currency` | `text` NOT NULL | copied from lease |
| `description` | `text` NULL | |
| `is_prorated` | `boolean` NOT NULL default false | drives the "part month" UI label |
| `source` | `charge_source` enum NOT NULL | `generated \| manual` |
| `generation_key` | `text` NULL | e.g. `'2026-03-01'` or `'2026-03-01:final'`. NULL for manual. |
| `supersedes_charge_id` | `uuid` NULL FK → charge | correction chain |
| `voided_at` | `timestamptz` NULL | the only mutation ever permitted |
| `voided_reason` | `text` NULL | |
| `voided_by_user_id` | `text` NULL FK → user | |
| `created_by_user_id` | `text` NULL FK → user | NULL when written by the cron |
| `created_at` | `timestamptz` NOT NULL | |

Indexes:
- `charge_generation_uq unique (lease_id, generation_key) where generation_key is not null` — **the cron's idempotency key**
- `charge_lease_due_idx on (org_id, lease_id, due_date)` — FIFO allocation + ledger page
- `charge_due_idx on (due_date) where voided_at is null` — the reminder scan, global across orgs (cron only)

**`payment`** — money received. Append-only.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `lease_id` | `uuid` NOT NULL FK → lease | |
| `kind` | `payment_kind` enum NOT NULL | `payment \| refund` — both stored positive, signed at read |
| `method` | `payment_method` enum NOT NULL | `bank_transfer \| cash \| cheque \| card_external \| other` |
| `amount_cents` | `bigint` NOT NULL | > 0, CHECK |
| `currency` | `text` NOT NULL | |
| `received_on` | `date` NOT NULL | landlord's local date |
| `reference` | `text` NULL | cheque no / bank ref — **immutable, it is evidence** |
| `note` | `text` NULL | **the only mutable field on this table** |
| `supersedes_payment_id` | `uuid` NULL FK → payment | correction chain |
| `voided_at` | `timestamptz` NULL | |
| `voided_reason` | `text` NULL | |
| `voided_by_user_id` | `text` NULL FK → user | |
| `recorded_by_user_id` | `text` NOT NULL FK → user | |
| `created_at` | `timestamptz` NOT NULL | |

Indexes: `payment_lease_idx on (org_id, lease_id, received_on)`;
`payment_org_received_idx on (org_id, received_on)` (income report + CSV export).

**`org_settings`** — one row per org. Created lazily on first read.

`org_id text PK FK → organization`, `reminders_enabled boolean default true`,
`reminder_lead_days smallint default 3`, `overdue_reminder_days smallint[] default '{1,7,14}'`,
`from_name text null`, `reply_to_email text null`, `default_currency text default 'USD'`,
`default_timezone text default 'UTC'`, `created_at`, `updated_at`.

**`reminder_log`** — what was sent, to whom, for which charge.

`id uuid PK`, `org_id`, `charge_id uuid FK`, `lease_id uuid FK`, `tenant_id uuid FK`,
`kind reminder_kind` (`upcoming | due_today | overdue`), `scheduled_for date` (the
**property-local** date the reminder was for), `status reminder_status`
(`sent | failed | skipped`), `to_email text`, `provider_message_id text null`,
`error text null`, `created_at`.

Index: `reminder_log_uq unique (charge_id, tenant_id, kind, scheduled_for)` — **the cron's
idempotency key; a double run sends nothing twice.** Plus
`reminder_log_lease_idx on (org_id, lease_id, created_at)` for the lease activity feed.

**`maintenance_request`**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `unit_id` | `uuid` NOT NULL FK → unit | always present |
| `lease_id` | `uuid` NULL FK → lease | NULL when the landlord raises one on a vacant unit |
| `reported_by_tenant_id` | `uuid` NULL FK → tenant | |
| `reported_by_user_id` | `text` NULL FK → user | |
| `title` | `text` NOT NULL | |
| `description` | `text` NOT NULL | |
| `category` | `maintenance_category` enum NOT NULL | `plumbing \| electrical \| heating \| appliance \| structural \| pest \| other` |
| `priority` | `maintenance_priority` enum NOT NULL default `'normal'` | `low \| normal \| high \| emergency` |
| `status` | `maintenance_status` enum NOT NULL default `'open'` | `open \| acknowledged \| in_progress \| resolved \| closed \| cancelled` |
| `reference` | `integer` NOT NULL | per-org human number ("#14") |
| `resolved_at`, `closed_at` | `timestamptz` NULL | |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | |

Indexes: `mr_org_status_idx on (org_id, status, created_at)`;
`mr_unit_idx on (org_id, unit_id)`; `mr_lease_idx on (org_id, lease_id)`;
`mr_reference_uq unique (org_id, reference)`.

**`maintenance_comment`** — the conversation. `id`, `org_id`, `request_id uuid FK cascade`,
`author_user_id text FK`, `author_tenant_id uuid null FK`,
`author_role` enum (`landlord | tenant`), `body text`,
`internal boolean not null default false` (landlord-only note, **never returned to the
portal — the single most likely information-leak bug in this feature**), `created_at`.
Index: `mc_request_idx on (org_id, request_id, created_at)`.

**`document`**

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK | |
| `property_id`, `unit_id`, `lease_id`, `tenant_id`, `maintenance_request_id` | nullable FKs | **CHECK: exactly one is non-null.** Discrete FKs, not a polymorphic `(owner_type, owner_id)` pair — the latter has no referential integrity. |
| `r2_key` | `text` NOT NULL UNIQUE | `org/{orgId}/{owner}/{ownerId}/{docId}` — never client-supplied, never guessable |
| `file_name` | `text` NOT NULL | original name, used for `Content-Disposition` |
| `content_type` | `text` NOT NULL | allowlist-validated |
| `size_bytes` | `bigint` NOT NULL | |
| `kind` | `document_kind` enum NOT NULL | `lease_agreement \| receipt \| id_document \| inspection \| photo \| other` |
| `visible_to_tenant` | `boolean` NOT NULL default false | **landlord uploads are private by default** |
| `uploaded_by_user_id` | `text` NOT NULL FK | |
| `uploaded_by_tenant_id` | `uuid` NULL FK | set when a tenant uploaded it |
| `deleted_at` | `timestamptz` NULL | |
| `created_at` | `timestamptz` NOT NULL | |

Indexes: one partial index per owner column, e.g.
`document_lease_idx on (org_id, lease_id) where lease_id is not null`, and the same for the
other four.

### 2.3 Migration risk

All of it is additive. There is no backfill and no multi-step migration **with one
exception**:

- **`property.timezone`.** Shipping as `NOT NULL DEFAULT 'UTC'` is a single safe statement,
  but `'UTC'` is semantically wrong for an existing US or AU landlord: arrears would flip
  at the wrong local midnight and reminders would land on the wrong day. Because the app is
  pre-launch this is almost certainly a non-event. **Required mitigation regardless:** the
  property form makes timezone required, and the properties list shows a dismissible banner
  on any property still at the default. If real data exists at migration time, do it as
  three steps — add nullable, prompt, then `SET NOT NULL`.

Everything else (`charge`, `payment`, `lease`, `tenant`, …) is a new empty table. Generate
one migration per phase with `pnpm --filter api db:generate`; never hand-edit a committed
migration.

---

## 3. API surface

Conventions: all paths under `/v1`. Landlord routes behind `requireAuth`. Tenant routes
under `/v1/portal/*` behind `requireTenant`. Errors are the existing
`{ error: { code, message, details? } }`. `404` is returned for "absent or not yours" on
**both** actor types — a `403` would confirm the row exists.

Every route below can return `401 unauthorized` (no session) and `500 internal`; those are
not repeated per row.

### 3.1 Identity

| Method | Path | Actor | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/v1/me/context` | **any signed-in user** (`requireSession`) | — | `meContext`: `{ user: {id,name,email}, landlord: { orgId, orgName, role } \| null, tenancies: [{ orgId, orgName, tenantId, displayName }] }` | 401 |

This single route is what lets the web root guard decide between `/properties` and
`/portal` without a 403 round trip. It replaces the current
`session.activeOrganizationId ? '/properties' : '/onboarding'` logic in
`apps/web/src/features/auth/guards.tsx`, which currently sends every tenant to an
onboarding page they must not see.

### 3.2 Tenants (landlord)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/tenants` | `pageQuery` + `?status=&q=&leaseStatus=` | `paged(tenant)` | 400 |
| POST | `/v1/tenants` | `createTenantBody` | `201 tenant` | 409 (duplicate email in org), 422 |
| GET | `/v1/tenants/:id` | — | `tenantDetail` (adds lease summaries + portal status) | 404 |
| PATCH | `/v1/tenants/:id` | `updateTenantBody` | `tenant` | 404, 409, 422 |
| DELETE | `/v1/tenants/:id` | — | `204` | 404, **409 if any lease is `active`** |
| POST | `/v1/tenants/:id/invite` | — | `201 { invite: tenantInvite, inviteUrl }` — `inviteUrl` returned **once** | 404, 409 (no email on file / already has portal access), 422 |
| DELETE | `/v1/tenants/:id/invite` | — | `204` | 404 |
| DELETE | `/v1/tenants/:id/portal-access` | — | `204` (unbinds `user_id`, revokes invites) | 404 |

### 3.3 Invite acceptance (public / any user)

| Method | Path | Actor | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/v1/portal/invites/:token` | none | — | `{ orgName, tenantDisplayName, email, accountExists: boolean }` | **404 for every invalid state** |
| POST | `/v1/portal/invites/accept` | none or signed-in | `acceptInviteBody` = `{ token, name?, password? }` | `200 { tenantId, orgId }` + session cookie if an account was created | 404, 409, 422 |

`name`/`password` are required only when no session is present. Email is **never** taken
from the body.

### 3.4 Leases (landlord)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/leases` | `pageQuery` + `?status=&unitId=&propertyId=&tenantId=` | `paged(leaseSummary)` | 400 |
| POST | `/v1/leases` | `createLeaseBody` = `{ unitId, tenantIds[], primaryTenantId, startDate, endDate?, rentCents, billingDay, depositCents, ledgerStartDate?, openingBalanceCents?, notes? }` | `201 lease` | 404 (unit/tenant), 409 (unit has an active lease / unit is `unavailable`), 422 |
| GET | `/v1/leases/:id` | — | `leaseDetail` (+ tenants, unit, property, balance once Phase 3 lands) | 404 |
| PATCH | `/v1/leases/:id` | `updateLeaseBody` (notes, endDate, billingDay, tenant roster) | `lease` | 404, 409, 422 |
| POST | `/v1/leases/:id/activate` | — | `lease` | 404, 409 |
| POST | `/v1/leases/:id/end` | `endLeaseBody` = `{ endDate, moveOutDate?, reason?, generateFinalCharge: boolean }` | `lease` | 404, 409, 422 |
| POST | `/v1/leases/:id/renew` | `renewLeaseBody` = `{ startDate, endDate?, rentCents, billingDay?, carryTenantIds? }` | `201 lease` (new row, same `chain_id`) | 404, 409, 422 |
| DELETE | `/v1/leases/:id` | — | `204` | 404, **409 unless status is `draft` or `cancelled` with no charges or payments** |
| GET | `/v1/leases/:id/schedule` | `?through=YYYY-MM` | `plannedCharge[]` — **computed preview, nothing written** | 404, 400 |

`PATCH` may **never** change `rentCents`, `startDate`, `unitId` or `currency` on an
`active` lease. Those go through `/renew`. Attempting it is `409 conflict` with a message
naming `/renew`.

### 3.5 Ledger (landlord)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/leases/:id/ledger` | `pageQuery` + `?from=&to=` | `{ entries: ledgerEntry[], balance: leaseBalance, nextCursor }` — interleaved charges and payments, newest first, each charge carrying its derived `appliedCents`/`status` | 404, 400 |
| GET | `/v1/leases/:id/balance` | — | `leaseBalance` = `{ currency, rentBalanceCents, depositBalanceCents, totalBalanceCents, chargedCents, paidCents, creditCents, oldestUnpaidDueDate \| null, daysOverdue }` — **signed**, negative = credit | 404 |
| POST | `/v1/leases/:id/charges` | `createChargeBody` = `{ type, amountCents, dueDate, periodStart?, periodEnd?, description? }` | `201 charge` | 404, 409 (lease not active/ended), 422 |
| POST | `/v1/charges/:id/void` | `voidChargeBody` = `{ reason }` | `charge` | 404, 409 (already void), 422 |
| POST | `/v1/charges/:id/correct` | `createChargeBody` | `201 charge` (voids the original, links `supersedes_charge_id`) | 404, 409, 422 |
| POST | `/v1/leases/:id/charges/generate` | `{ through?: 'YYYY-MM' }` | `{ created: charge[] }` — manual kick of the same idempotent generator | 404, 409 |
| POST | `/v1/leases/:id/payments` | `recordPaymentBody` = `{ kind, method, amountCents, receivedOn, reference?, note? }` | `201 payment` | 404, 409 (currency mismatch), 422 |
| GET | `/v1/leases/:id/payments` | `pageQuery` | `paged(payment)` | 404 |
| PATCH | `/v1/payments/:id` | `{ note }` — **the only mutable field** | `payment` | 404, 409 (any other field present), 422 |
| POST | `/v1/payments/:id/void` | `voidPaymentBody` = `{ reason }` | `payment` | 404, 409 |
| POST | `/v1/payments/:id/correct` | `recordPaymentBody` | `201 payment` (voids original, sets `supersedes_payment_id`) | 404, 409, 422 |
| GET | `/v1/arrears` | `?asOf=&propertyId=&minDaysOverdue=&currency=` + `pageQuery` | `paged(arrearsRow)` | 400 |

### 3.6 Reminders (landlord)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/settings/reminders` | — | `orgSettings` (lazily created) | — |
| PATCH | `/v1/settings/reminders` | `updateOrgSettingsBody` | `orgSettings` | 422 |
| GET | `/v1/leases/:id/reminders` | `pageQuery` | `paged(reminderLogEntry)` | 404 |
| POST | `/v1/leases/:id/reminders/send` | `{ kind }` | `202 { sent: n }` — manual nudge | 404, 409 (no overdue charge / opted out), 429 |

### 3.7 Maintenance

| Method | Path | Actor | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/v1/maintenance-requests` | landlord | `pageQuery` + `?status=&priority=&propertyId=&unitId=` | `paged(maintenanceRequest)` | 400 |
| POST | `/v1/maintenance-requests` | landlord | `createMaintenanceRequestBody` (**takes `unitId`**) | `201` | 404, 422 |
| GET | `/v1/maintenance-requests/:id` | landlord | — | `maintenanceRequestDetail` (incl. `internal` comments) | 404 |
| PATCH | `/v1/maintenance-requests/:id` | landlord | `updateMaintenanceRequestBody` (status, priority, category, assignee note) | `maintenanceRequest` | 404, 409, 422 |
| POST | `/v1/maintenance-requests/:id/comments` | landlord | `createMaintenanceCommentBody` = `{ body, internal }` | `201 maintenanceComment` | 404, 422 |
| GET | `/v1/portal/maintenance-requests` | tenant | `pageQuery` + `?status=` | `paged(portalMaintenanceRequest)` | — |
| POST | `/v1/portal/maintenance-requests` | tenant | `createPortalMaintenanceRequestBody` = `{ leaseId, title, description, category, priority }` — **never `unitId`** | `201` | 404, 409 (lease ended), 422 |
| GET | `/v1/portal/maintenance-requests/:id` | tenant | — | `portalMaintenanceRequestDetail` — **`internal` comments filtered out in the repo query, not in the mapper** | 404 |
| POST | `/v1/portal/maintenance-requests/:id/comments` | tenant | `{ body }` — no `internal` flag in the schema at all | `201` | 404, 409 (closed), 422 |

### 3.8 Documents

| Method | Path | Actor | Request | Response | Errors |
|---|---|---|---|---|---|
| POST | `/v1/documents` | landlord | `multipart/form-data`: `file` + `{ owner: {type,id}, kind, visibleToTenant }` | `201 document` | 404, 413, 415, 422 |
| GET | `/v1/documents?ownerType=&ownerId=` | landlord | — | `document[]` | 404 |
| GET | `/v1/documents/:id/content` | landlord | — | the bytes, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` | 404 |
| PATCH | `/v1/documents/:id` | landlord | `{ kind?, visibleToTenant? }` | `document` | 404, 422 |
| DELETE | `/v1/documents/:id` | landlord | — | `204` (soft-delete row, hard-delete the R2 object) | 404 |
| GET | `/v1/portal/documents?leaseId=` | tenant | — | `document[]` — only `visible_to_tenant = true` or own uploads | 404 |
| POST | `/v1/portal/documents` | tenant | multipart + `{ leaseId \| maintenanceRequestId, kind }` | `201 document` | 404, 413, 415, 422 |
| GET | `/v1/portal/documents/:id/content` | tenant | — | bytes | 404 |

Serving rules: bytes stream through the Worker from the `DOCS` R2 binding. **No presigned
URLs and no public bucket** — R2 presigning needs SigV4, and the API origin is already not
the app origin, so `Content-Disposition: attachment` + `nosniff` contains any crafted file.
Allowlist: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/heic`. Max
10 MB, enforced in the contract and re-checked server-side.

### 3.9 Reports and export (landlord)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/reports/dashboard` | — | `dashboardSummary`: units occupied/vacant, active leases, expected rent this month, collected this month, total arrears, open maintenance, upcoming lease expiries | — |
| GET | `/v1/reports/rent-roll` | `?month=YYYY-MM&propertyId=` | `rentRollRow[]` | 400 |
| GET | `/v1/reports/income` | `?from=&to=&groupBy=month\|property` | `incomeRow[]` | 400 |
| GET | `/v1/exports/payments.csv` | `?from=&to=&propertyId=` | `text/csv` | 400, **409 if > 10,000 rows** |
| GET | `/v1/exports/charges.csv` | same | `text/csv` | same |
| GET | `/v1/exports/arrears.csv` | `?asOf=` | `text/csv` | same |

Reports **deliberately include soft-deleted properties and units**, flagged
`archived: true`. This is a scoped, documented exception to the "soft-deleted rows never
appear in any read" rule in `docs/TASKS/001-properties-backend.md` — a landlord who sold a
building still needs last year's income from it. The exception lives only in
`db/repo/reports.ts` and must be commented there.

CSV is produced by the same serializer the JSON report uses, so the two can never disagree.
The web app fetches CSV with `credentials: 'include'`, gets a Blob and triggers a download
from an object URL — not a bare `<a download>` — so a 403 renders as a toast rather than a
browser-saved error page.

### 3.10 Portal (tenant)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/portal/me` | — | `portalProfile` = `{ name, email, phone, emergencyContact, remindersOptedOut, tenancies: [...] }` | — |
| PATCH | `/v1/portal/me` | `updatePortalProfileBody` (phone, emergency contact, `remindersOptedOut`) — **not email, not name-on-lease** | `portalProfile` | 422 |
| GET | `/v1/portal/leases` | — | `portalLease[]` across **all** orgs the caller is a tenant in | — |
| GET | `/v1/portal/leases/:id` | — | `portalLeaseDetail` — rent, dates, unit label, property address, landlord org name + reply-to email, co-tenant **display names only** | 404 |
| GET | `/v1/portal/leases/:id/ledger` | `pageQuery` | `{ entries, balance }` — same shapes as the landlord ledger minus `note`, `recordedBy`, `voidedReason` | 404 |
| GET | `/v1/portal/leases/:id/balance` | — | `portalBalance` | 404 |

---

## 4. Billing: the rules, stated precisely

These live as **pure functions in `packages/contract/src/billing.ts`** so the lease form's
"next charge" preview and the cron that writes the row compute the identical number. One
definition, both ends — the same argument as the Zod schemas.

### 4.1 Periods

- A period is a **calendar month**: `[first of month, last of month]`.
- The charge for March 2026 has `period_start = 2026-03-01`, `period_end = 2026-03-31`,
  `generation_key = '2026-03-01'`.

### 4.2 Due date

```
dueDate(year, month, billingDay) = date(year, month, min(billingDay, daysInMonth(year, month)))
```

`billing_day = 31` in February 2026 → `2026-02-28`. In 2028 → `2028-02-29`. This is the
"day 31 in February" bug, closed by construction, with a unit test per month of a leap year
and a non-leap year.

### 4.3 Proration

```
prorate(rentCents, daysOccupied, daysInMonth) = Math.round(rentCents * daysOccupied / daysInMonth)
```

Single rounding step on an integer expression. Actual days in **that** month — not a
30-day convention — because that is the number a tenant computes themselves and argues
about otherwise.

- **First period**, when `start_date` is not the 1st: covers `start_date .. endOfMonth`,
  prorated, `is_prorated = true`, and **`due_date = start_date`**. You do not let someone
  take the keys on the 28th and owe nothing until the 5th.
- **Last period**, when the lease ends mid-month: covers `firstOfMonth .. min(end_date,
  move_out_date)`, prorated, `due_date = min(clampedDueDate, periodEnd)`.
- A lease starting on the 1st and ending on the last day of a month has no prorated
  charges at all — the common case stays simple.

### 4.4 Timezone and DST

- **All lease dates are `date` with no time component. The only time-zone-sensitive
  question in the whole system is "what is today".**
- "Today" is evaluated in **`property.timezone`** (the unit's property), via
  `Intl.DateTimeFormat(tz, {...}).formatToParts(new Date())`. Never `new Date()
  .toISOString().slice(0,10)`.
- A charge is overdue when `due_date < localToday(propertyTimezone)`.
- **DST is a non-issue by construction**, because no arithmetic is ever performed on an
  instant — only on `date` values plus one timezone-aware "what day is it" lookup. There is
  no 23-hour day to get wrong because there are no hours.
- The tenant's own timezone is **not stored**. It affects nothing financial; it would only
  shift the hour an email arrives, and that is not worth a column in v1.
- The daily cron fires at a fixed UTC hour (09:00). Every property, from UTC-11 to UTC+14,
  is evaluated exactly once per local day, because the job keys idempotency on
  *(charge, tenant, kind, local date)* rather than on the run.

### 4.5 Charge generation: a cron that materialises rows

**Decision: materialise. Defence:**

1. A charge is a document, not a derivation. It gets voided, superseded, annotated, and
   referenced by a reminder. A computed row cannot carry any of that.
2. Reminders need a stable `charge_id` for the idempotency key. Computed charges have no id.
3. Exports must be reproducible. If the formula changes, computed-on-read silently rewrites
   last year's invoices.
4. A rent change must not retroactively alter history. With materialised rows, March's
   charge is March's rent forever.

**The generator does not ask "what is due today". It asks "for each lease, which periods
should exist, and which are missing".** Pseudocode:

```
for each lease where status = 'active':
  periods = monthlyPeriodsBetween(
              max(lease.start_date, lease.ledger_start_date),
              min(lease.end_date ?? +inf, lease.move_out_date ?? +inf, endOfNextMonth(localToday(tz)))
            )
  wanted  = periods.map(p => { key: p.start, dueDate: clamp(...), amount: prorate-or-full })
  INSERT ... ON CONFLICT (lease_id, generation_key) DO NOTHING
```

- **Runs twice in a day:** second run inserts zero rows. The unique index is the guarantee,
  not application logic.
- **Misses a day, or a week, or a month:** the next run computes the full wanted set and
  inserts everything missing. **Self-healing by construction** — there is no "catch-up
  mode" to get wrong.
- **Never backfills a decade:** `ledger_start_date` floors it. For an in-flight tenancy the
  landlord sets `ledger_start_date` to the current month and supplies
  `openingBalanceCents`, which writes a single `type = 'opening_balance'` charge.
- **Horizon:** end of **next** calendar month, so a tenant always sees one month ahead and

> **SUPERSEDED 2026-10-10.** Charges are now created on the FIRST DAY of their own
> period; `GENERATION_LOOKAHEAD_DAYS` is `0`. Billing a period early is a deliberate
> landlord action (`chargesThroughNextPeriod`), not the default. The reasoning below
> is kept because it explains why the horizon was once wide — but it no longer
> describes the system. See `docs/BEHAVIOUR.md`.

  the "upcoming rent" reminder has a row to point at.
- **A voided charge is never regenerated**, because `ON CONFLICT` keys on
  `generation_key` regardless of `voided_at`. Correct: voiding March's rent is a decision,
  not a gap to refill. A landlord who wants it back uses `/correct`.

**Runner: Cloudflare Cron Triggers.** Add `"triggers": { "crons": ["0 9 * * *"] }` to
`wrangler.jsonc` and change `apps/api/src/index.ts` from `export default app` to
`export default { fetch: app.fetch, scheduled }`. This overrides the GitHub Actions cron in
ARCHITECTURE.md §2 because (a) it is free on the Workers free plan, (b) GH Actions
schedules are routinely delayed 10–30 minutes and are silently dropped under load, and
(c) a GH-Actions runner needs an inbound `/v1/internal/cron/run` endpoint plus a shared
secret — an authenticated hole in the API that exists only because the scheduler is
external. Keep a **weekly** GitHub Actions job that calls
`GET /v1/internal/cron/health` and fails if the last successful run is older than 36 hours.
That is the right use of GH Actions here: watching the cron, not being it.

Cron work per run, in order, all inside `apps/api/src/jobs/daily.ts`:

1. `generateCharges()` — one SELECT of active leases joined to unit→property for the
   timezone; compute in TS; one multi-row `INSERT ... ON CONFLICT DO NOTHING`.
2. `sendUpcomingReminders()` — charges where `due_date = localToday + lead_days`.
3. `sendOverdueReminders()` — charges where `localToday - due_date ∈ overdue_reminder_days`
   **and** still has an unpaid remainder under FIFO.
4. Write a `cron_run` heartbeat row (reuse `org_settings`? No — one tiny table
   `job_run(id, job, started_at, finished_at, status, stats jsonb)`, **the one table with
   no `org_id`**, because it describes the system, not a tenant. Call that out explicitly
   in the schema comment so the reviewer does not flag it).

Workers' 30-second scheduled CPU budget is ample: this is a handful of bulk statements over
tens of landlords. If it ever is not, the fix is a `lease_id > cursor` loop, not a queue.

### 4.6 The ledger: FIFO allocation, derived, never stored

No allocation table. For one lease:

```sql
WITH paid AS (
  SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END), 0) AS total
  FROM payment WHERE org_id = $1 AND lease_id = $2 AND voided_at IS NULL
),
ordered AS (
  SELECT c.*,
         COALESCE(SUM(c.amount_cents) OVER (ORDER BY c.due_date, c.id
                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior
  FROM charge c
  WHERE c.org_id = $1 AND c.lease_id = $2 AND c.voided_at IS NULL
)
SELECT o.*,
       GREATEST(0, LEAST(o.amount_cents, (SELECT total FROM paid) - o.prior)) AS applied_cents
FROM ordered o ORDER BY o.due_date, o.id;
```

One window function, exact FIFO by due date, fully recomputable, zero drift, nothing to
reconcile. Derived `status` per charge: `void` (stored) → `paid` (applied = amount) →
`partially_paid` (0 < applied < amount) → `overdue` (applied < amount and `due_date <
localToday`) → `unpaid`.

This closes every money edge case **without a special case**:

| Situation | What happens |
|---|---|
| Partial payment | Oldest charge goes `partially_paid`; later charges untouched. |
| Overpayment | `total > Σ charges` → balance negative → UI says "Credit of $X". |
| Payment arrives before its charge | The credit sits there; the next generated charge is immediately `paid`. No "unapplied payments" queue. |
| Refund | `kind='refund'` row subtracts from `total`; charges reopen in reverse FIFO automatically. |
| Wrong amount recorded | `/payments/:id/correct` → original voided, successor linked. Both visible in the ledger, the void struck through. |
| Bounced cheque | `/payments/:id/void` with no successor. |
| Wrong charge amount | `/charges/:id/correct` → same pattern. |
| Deposit vs rent | FIFO runs across all charge types in due-date order (oldest debt first), but the balance response splits `rentBalanceCents` / `depositBalanceCents` / `totalBalanceCents`, and the arrears report uses `rentBalanceCents`. |
| Rent changes mid-tenancy | New lease row, same `chain_id`. Balances aggregate on `chain_id`, so a $200 shortfall carried from the old lease still shows as arrears. |
| Mixed currencies | Arithmetic never crosses currencies; `lease.currency` is immutable; reports **group by** currency rather than summing. |

**`money` in the contract is `.nonnegative().max(1_000_000_00)`.** Balances can be negative
(credit) and lifetime report totals exceed $1 M. Add `moneyDelta` (signed, same cap) and
`moneyTotal` (non-negative, cap raised to `1_000_000_000_00`). Reusing `money` for a
balance would make every credit fail response validation in `apps/web/src/lib/api.ts`.
**This is the most likely day-one Phase 3 bug.**

---

## 5. Lifecycle rules

### 5.1 Lease state machine

```
draft ──activate──► active ──end──► ended
  │                   │
  │                   └──end(reason=breach/eviction)──► terminated
  └──delete──► (hard delete, only while draft and charge-free)
active ──renew──► new lease (same chain_id), predecessor ends the day before
```

- `activate` requires: unit not `unavailable`, no other `active` lease on the unit
  (`lease_unit_active_uq` also enforces this in the DB), at least one tenant, a primary
  tenant. Sets `unit.status = 'occupied'`.
- `end` sets `status`, `end_date`, `move_out_date`, and if `generateFinalCharge` is true,
  writes the prorated final charge **immediately** rather than waiting for the cron.
  Sets `unit.status = 'vacant'` **only if** no other active lease exists on the unit and the
  unit is not `unavailable`.
- `renew` creates a new lease with `chain_id = predecessor.chain_id`,
  `renewed_from_lease_id = predecessor.id`, and `start_date = predecessor.end_date + 1 day`
  (enforced; a gap or overlap is `409`). Both rows exist forever; the charge history on each
  is explained by that row's rent.

### 5.2 Tenant lifecycle

- **Move-out:** `end` the lease. The tenant's `status` becomes `past` once they have no
  active lease. **Portal access is retained** — they can still see their final balance and
  download their payment history, which is the single most-requested thing after moving out.
  The landlord can cut it explicitly with `DELETE /v1/tenants/:id/portal-access`.
- **Roommate swap:** set `lease_tenant.removed_on` for the departing tenant and insert a row
  for the arriving one. The lease, charges and payments are untouched.
  **A removed tenant keeps read-only access to the whole lease, including its full history**
  — they were jointly liable for it, so there is nothing on it they did not already have —
  but loses the ability to raise maintenance requests.
- **Archive:** `DELETE /v1/tenants/:id` soft-deletes and sets `status='archived'`. Blocked
  (409) while any lease is `active`. Drops the tenant out of `requireTenant`'s scope on
  their next request.

### 5.3 Deletion and financial history

| Target | Rule |
|---|---|
| `property` | Soft delete. **409 if any unit has an active lease.** Cascades `deleted_at` to units (already implemented). **Never** cascades to leases, charges or payments. Reports still read it, flagged `archived`. |
| `unit` | Soft delete. **409 if it has an active lease.** |
| `lease` | Hard delete allowed **only** while `draft`/`cancelled` with zero charges and zero payments. Otherwise `409` — `end` it instead. |
| `charge` | Never deleted. Voided. |
| `payment` | Never deleted. Voided. |
| `tenant` | Soft delete + archive. |
| `document` | Soft-delete the row, **hard-delete the R2 object** — bytes are not the system of record and the free tier is 10 GB. |
| `maintenance_request` | Never deleted. `cancelled` status. |

Hard delete for GDPR erasure is **not** in v1 — it is a manual, audited DB operation. Stated
so nobody assumes otherwise.

---

## 6. Phasing

Each phase ships independently, has one frozen contract, and splits into exactly one
backend task and one frontend task that touch **no common file**. The shared surface is
always and only `packages/contract/**`, written and frozen by the orchestrator before
either agent is dispatched.

Ordering principle: **the permission model is Phase 1, because it is the decision that is
most expensive to change and it is load-bearing for every phase after it.**

---

### Phase 1 — Tenants and the two-actor permission spine

**Why first:** this proves the whole identity architecture end to end — invite, accept,
tenant login, cross-org scope, fail-closed on landlord routes — against the smallest
possible feature. Everything downstream assumes it.

**Independently useful:** the landlord gets a real tenant directory (contacts, emergency
contacts, portal status) and tenants get working logins. Password reset lands for landlords
too, which is missing today.

**Frozen contract:** `tenant.ts`, `invite.ts`, `me.ts`, `portal.ts` (profile shapes only),
`routes.ts` (+ `tenants`, `portal`, `me` namespaces), `common.ts` (+ `isoDate`, `timezone`).

**backend-dev** (`apps/api/**`)
- `tenant`, `tenant_invite` tables + migration; `property.timezone` column.
- **Fix the tenancy guard to recurse** (§0.2 A) before creating `repo/portal/`.
- `repo/tenant.ts` (landlord), `repo/portal/scope.ts` + `repo/portal/profile.ts`.
- New `portal-tenancy.guard.test.ts` asserting `scope: TenantScope` first + both `orgId`
  and `tenantId` in the body.
- `middleware/auth.ts`: add `requireSession`, `requireTenant`. Do not touch `requireAuth`.
- Routes §3.1, §3.2, §3.3, and `GET/PATCH /v1/portal/me`.
- Resend wiring: `lib/email.ts`, invite template, Better Auth `sendResetPassword`.
- Tests: cross-org isolation per repo fn; the full §1.6 attack table as route tests;
  invite accept covering expired / revoked / reused / wrong-email / already-bound.

**frontend-dev** (`apps/web/**`)
- Tenants list + detail + create/edit dialogs, portal-status badge, invite/revoke actions
  with a copy-link affordance for the one-time URL.
- Rewrite `features/auth/guards.tsx` to branch on `GET /v1/me/context` instead of
  `session.activeOrganizationId` — **the current logic sends every tenant to `/onboarding`.**
- `/portal` shell + nav, `/portal/accept?token=` page (signed-out and signed-in paths),
  `/portal/profile`.
- Forgot-password / reset-password screens.
- Timezone field on the property form + the "confirm your timezone" banner.

**They share:** the contract files above, and nothing else.

---

### Phase 2 — Leases

**Independently useful:** a complete tenancy register — who is in which unit, on what terms,
until when — and a tenant who can see their own lease.

**Frozen contract:** `lease.ts`, `billing.ts` (pure date/money helpers), `portal.ts`
(+ `portalLease`, `portalLeaseDetail`), `routes.ts` (+ `leases`, `portal.leases`).

**backend-dev**
- `lease`, `lease_tenant` tables + enums + the `lease_unit_active_uq` partial unique index.
- `repo/lease.ts`, `repo/portal/lease.ts` (`listLeases`, `resolveLease`).
- Routes §3.4 and the portal lease routes in §3.10.
- The lifecycle state machine (§5.1) including `unit.status` coupling and `chain_id`.
- `GET /v1/leases/:id/schedule` built **from the contract's `billing.ts`** — no second
  implementation of the date math.

**frontend-dev**
- Lease list, lease detail, create wizard (unit → tenants → terms → review with a live
  charge-schedule preview computed client-side from `billing.ts`).
- End-lease and renew dialogs.
- Lease card on the unit and tenant pages.
- `/portal/leases` and `/portal/leases/:id`.

**They share:** the contract, **including `billing.ts` as executable shared logic**. This is
the phase where the contract stops being only types. Call it out in both task files: the
preview the tenant sees and the row the cron writes must be the same number.

---

### Phase 3 — Rent ledger

**Independently useful:** this is the product. Charges, payments, balances, arrears.

**Frozen contract:** `ledger.ts`, `arrears.ts`, `common.ts` (+ `moneyDelta`, `moneyTotal`),
`portal.ts` (+ `portalCharge`, `portalPayment`, `portalBalance`), `routes.ts`.

**backend-dev**
- `charge`, `payment`, `job_run` tables; the `charge_generation_uq` partial unique index.
- `repo/ledger.ts` with the FIFO window query (§4.6) as **one** function reused by the
  lease ledger, the balance endpoint, the arrears report and the cron.
- `repo/system/charges.ts` + `jobs/daily.ts` + `scheduled` export + `wrangler.jsonc` trigger.
- `system-repo.guard.test.ts` (import-graph check: nothing under `src/routes/` imports
  `repo/system/`).
- Routes §3.5 and the portal ledger routes.
- Tests: FIFO allocation table-driven (partial, over, refund, void, supersede, pre-paid,
  deposit-then-rent); generator idempotency (run twice → zero new rows); generator
  catch-up (skip 3 days → exact backfill, no duplicates); due-date clamping across a leap
  and a non-leap February; proration arithmetic summing to the exact month.

**frontend-dev**
- Lease ledger view (interleaved charges and payments, running balance, struck-through
  voids with their successor linked).
- Record-payment dialog, void and correct flows with mandatory reason.
- Manual charge dialog.
- Arrears page with filters, sort by days overdue, per-currency grouping.
- Balance chips on lease, tenant and unit cards.
- `/portal/leases/:id` payment history + balance + "credit" state.

**They share:** the contract. The orchestrator must pin the **worked examples** (a table of
charges + payments + expected `appliedCents` and balance) in the contract as exported test
fixtures so both sides assert against identical numbers.

---

### Phase 4 — Automated email reminders

**Independently useful:** rent gets chased without the landlord doing anything.

**Frozen contract:** `reminders.ts`, `routes.ts` (+ `settings`, `leases.reminders`).

**backend-dev**
- `org_settings`, `reminder_log` tables + the `reminder_log_uq` idempotency index.
- `jobs/daily.ts` reminder passes, using `localToday(property.timezone)`.
- Resend send + failure capture; `to_email`, `provider_message_id`, `error` recorded.
- Routes §3.6.
- Guardrails: respect `tenant.reminders_opted_out`; cap at 3 overdue reminders per charge;
  never remind on a charge with no remaining balance under FIFO; never remind a tenant with
  no email.
- Tests: double-run sends nothing twice; a UTC+13 and a UTC-11 property each get exactly
  one evaluation per local day; opt-out and cap are honoured.

**frontend-dev**
- Reminder settings screen (lead days, overdue cadence, from-name, reply-to, master switch).
- Reminder history on the lease timeline, with failures surfaced.
- "Send reminder now" button with its 409 states handled.
- Tenant opt-out toggle in `/portal/profile`.

**Devops prerequisite, blocking:** Resend requires a **verified sending domain**. Until one
exists, Resend's sandbox address only delivers to the account owner, so reminders will
appear to send and silently never arrive. Verify the domain before this phase is dispatched,
not during it.

**Budget check:** 3,000 emails/month free. ≤ 4 per lease-month (1 upcoming + ≤ 3 overdue)
→ ~750 lease-months/month. Comfortable, and worth a counter on the settings screen.

---

### Phase 5 — Maintenance requests and documents

**Independently useful:** tenants report problems in the app instead of by text message,
with photos; leases get their signed PDF attached.

**Frozen contract:** `maintenance.ts`, `document.ts`, `routes.ts`.

**backend-dev**
- `maintenance_request`, `maintenance_comment`, `document` tables; the exactly-one-owner
  CHECK; per-org `reference` counter.
- R2: `DOCS` binding in `wrangler.jsonc`, upload/stream/delete.
- `repo/portal/maintenance.ts`, `repo/portal/document.ts` resolvers.
- Routes §3.7, §3.8.
- **The one test that must exist:** a tenant fetching a request with internal comments gets
  zero internal comments, asserted at the **repo query** level, not the mapper.

**frontend-dev**
- Landlord: request list with status/priority filters, detail with comment thread and an
  internal-note toggle that is visually unmistakable, status transitions.
- Tenant: raise a request (lease picker, not unit picker), photo upload, comment thread.
- Document upload/list/delete on property, unit, lease, tenant and request; the
  "visible to tenant" toggle with an explicit confirm.
- `/portal/documents`.

---

### Phase 6 — Reports, CSV export, dashboard

**Independently useful:** the landlord's month-end and their accountant's year-end.

**Frozen contract:** `reports.ts`, `routes.ts` (+ `reports`, `exports`).

**backend-dev**
- `repo/reports.ts`, including the documented soft-delete exception (§3.9).
- Routes §3.9; shared CSV serializer driven by the same row shapes as the JSON responses.
- 10,000-row cap returning `409 conflict` with a message naming a narrower date range.

**frontend-dev**
- Dashboard as the landlord's new home route.
- Rent-roll and income report screens with date-range and property filters.
- Download buttons using the Blob approach so 403s render as toasts.
- Empty, loading and error states for all of it.

---

## 7. Risks and open questions

### 7.1 Risks I am confident about

| Risk | Mitigation |
|---|---|
| **The repo guard does not recurse** — any `db/repo/portal/` or `db/repo/system/` file is silently unguarded. | Fix in Phase 1 before the directory exists. Plus a floor assertion so an empty glob fails. |
| **A tenant route that accepts a `unitId` or `propertyId`** instead of deriving it from a scoped lease. | The contract has no portal body schema containing `unitId`. Add "no portal request body carries an org-owned id other than one that is scope-resolved" to the reviewer checklist. |
| **`internal` maintenance comments leaking to the portal.** | Filter in the repo query, never the mapper; a dedicated test. |
| **`money` is `.nonnegative()`** — every credit balance would fail client-side response validation. | `moneyDelta` / `moneyTotal` in Phase 3's contract. |
| **The Neon HTTP driver has no interactive transactions** (`db/index.ts`). Lease activation writes `lease` then `unit`; renewal writes two leases. A mid-sequence failure leaves a torn state. | Order writes so the torn state is safe (write the row the unique index protects **first**), use `db.batch()` where Drizzle's neon-http supports it, and add a daily consistency check in the cron that reports — not silently repairs — any unit whose `status` disagrees with its leases. |
| **Charge generation and reminders run without a caller org.** The reviewer will flag it as a tenancy violation. | The explicit `repo/system/` exception in §1.4, documented in ARCHITECTURE.md and enforced by an import-graph test. |
| **Resend's unverified sandbox domain silently swallows tenant email.** | Blocking devops prerequisite on Phase 4. |
| **`property.timezone` defaulting to `'UTC'`** makes arrears flip at the wrong midnight. | Required in the create form + a banner on any property still at the default. |
| **A tenant can create their own organization** (`allowUserToCreateOrganization: true`) and become a landlord. | Harmless — they reach only their own empty org — but their `activeOrganizationId` becomes set, so `/v1/me/context` must return both principals and the web app must not assume "has an org ⇒ not a tenant". Covered by Phase 1's guard rewrite. |
| **Possessing a forwarded invite link = account takeover for that tenant.** | Email only to `tenant.email`, 14-day expiry, landlord-visible revoke, `accepted_at` + bound-user email shown. Same profile as every email-invite system. Accepted. |
| **Cron and reminders are cross-org by nature**, so a bug there leaks across every landlord at once rather than between two. | Every system query selects `org_id` and every insert writes it; the FIFO function is shared with the user-facing path, so it is exercised by ordinary use before the cron ever runs it. |

### 7.2 Open questions — my default answer for each

Everything here is decided by default. None of it blocks Phase 1. Flag only if you disagree.

| Question | **Default** |
|---|---|
| Rent frequency? | **DECIDED 2026-10-05: `monthly` and `yearly`.** Not weekly, not fortnightly. Periods are therefore *calendar periods*, not calendar months — a yearly lease generates one charge per year. Proration generalises to `amount * daysOccupied / daysInPeriod`, where `daysInPeriod` comes from the period itself rather than `daysInMonth`. Due-day clamping still applies to monthly; a yearly period's due date defaults to its `period_start`. `billing.ts` must be written period-agnostic in Phase 2 — that is the only place this distinction bites. |
| Automatic late fees? | **No.** Manual `type='late_fee'` charge only. Late-fee rules are jurisdictional and automating them is a legal exposure, not a feature. |
| Tenant-submitted payment claims ("I paid on the 3rd")? | **No.** The tenant uploads a receipt document against the lease; it surfaces to the landlord as an unreviewed tenant upload. A claim queue is a reconciliation workflow and a v2 feature. |
| Deposit held in a trust/escrow account with interest? | **No.** The deposit is a `type='deposit'` charge in the ledger, reported as a separate balance line. Regulated deposit schemes (UK TDS, etc.) are out of scope. |
| Do co-tenants see each other's email and phone? | **No — display name only.** They do see each other's payments, because they share the liability. |
| Can a tenant self-register without an invite? | **No.** Ever. |
| Does the landlord learn a tenant rents elsewhere? | **No.** Nothing joins through `tenant.user_id` to another org. |
| Multi-user landlord orgs (a property manager with staff)? | **Yes, already works** — every `member` is a full landlord user. Granular staff roles are v2; `requireAdmin` exists if you need to gate something. |
| GDPR hard-delete of a tenant? | **Not in v1.** Archive only; erasure is a manual, audited DB operation. |
| CSV row cap? | **10,000**, returning `409` with a "narrow the date range" message. A landlord with tens of units will never see it. |
| Receipt emails to the tenant when a payment is recorded? | **No**, it spends the Resend budget on something the portal already shows. Reconsider once a paid email tier exists. |
| Cron hour? | **09:00 UTC daily.** One run, idempotent, self-healing. |
