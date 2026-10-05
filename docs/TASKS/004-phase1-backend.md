# Task 004 (backend) — Phase 1: tenants and the two-actor permission spine

**Agent:** backend-dev · **Owns:** `apps/api/**` · **Contract:** FROZEN

Read `docs/PLAN-V1.md` §1 in full before writing anything. It contains the reasoning,
the attack table your route tests must reproduce, and the exact invite rules.

## Do this first: fix the guard, before any subdirectory exists

`apps/api/src/db/repo/tenancy.guard.test.ts` uses a **non-recursive** `readdirSync`.
This task creates `db/repo/portal/`, and the moment it exists those files are
unguarded and **nothing fails**.

- Make it recursive.
- Add an assertion that the discovered file count is at least a hardcoded floor, so a
  future refactor that empties the glob fails loudly instead of passing vacuously.
- Verify it catches a violation in a subdirectory before you move on.

## The permission model

A tenant user is **not** an organization member. `tenant.user_id` is a nullable FK to
Better Auth's `user`. One user may be pointed at by many tenant rows in many orgs.

Three repo directories, three rules:

```
db/repo/*.ts          landlord. First param `orgId: string` from session. UNCHANGED.
db/repo/portal/*.ts   tenant.   First param `scope: TenantScope`.          NEW guard.
```

```ts
type TenantScope = {
  userId: string;
  pairs: ReadonlyArray<{ orgId: string; tenantId: string }>;  // never empty
};
```

Write `portal-tenancy.guard.test.ts` asserting every exported query function under
`repo/portal/` takes `scope: TenantScope` first and references **both** `orgId` and
`tenantId`. The pair filter is strictly stronger than the orgId filter, not a
replacement for it.

**Verify-then-scope.** Resolve the parent through a scoped portal repo function, then
pass the resulting trusted `orgId` to an ordinary landlord repo function. This keeps
`repo/portal/` tiny — only `resolveScope` and `profile` in this phase.

## Middleware

| Middleware | Sets | Rejects |
|---|---|---|
| `requireSession` (new) | `userId` | no session -> 401 |
| `requireAuth` (unchanged) | `userId`, `orgId` | 401, or 403 with no active org / no member row |
| `requireTenant` (new) | `userId`, `tenantScope` | 401; zero live tenant rows -> 403 |

`requireTenant` re-resolves scope from the database on **every** request and excludes
archived and soft-deleted tenants, so revoking access is one UPDATE and takes effect
on the tenant's next request.

## Schema

- `tenant` — per `docs/PLAN-V1.md` §3, including `user_id` nullable FK, the partial
  unique indexes, and `notes` (landlord-private, must never appear in a portal response).
- `tenant_invite` — `token_hash` is the **only** lookup path. Store `sha256(token)`,
  never the raw token. Snapshot `email` on the invite; the account is created with
  that value, never one from the request body.
- `property.timezone` — `NOT NULL DEFAULT 'UTC'`, IANA, validated with the contract's
  `timezone` schema.

Generate the migration with `pnpm --filter api db:generate`. Commit the SQL.

## Routes

| Method | Path | Actor |
|---|---|---|
| GET | `/v1/me/context` | any signed-in user (`requireSession`) |
| GET POST | `/v1/tenants` | landlord |
| GET PATCH DELETE | `/v1/tenants/:id` | landlord |
| POST | `/v1/tenants/:id/invite` | landlord |
| DELETE | `/v1/tenants/:id/portal-access` | landlord |
| POST | `/v1/portal/invites/accept` | public, and signed-in |
| GET PATCH | `/v1/portal/:tenantId/profile` | tenant |

Inviting a tenant with no email is `400`, not a crash.

## Invite rules — these are security requirements, not preferences

- 32 bytes from `crypto.getRandomValues`, hex. Store only the SHA-256. Return the URL
  **once**, in the creation response.
- Look up by token hash only. **Every** failure — bad, expired, revoked, already
  accepted, tenant archived — returns an identical `404` with one identical message.
- Signed out: create the user with the **invite's** email. Signed in: bind the current
  user, ignore any account fields.
- Re-inviting revokes outstanding invites and issues a new one.
- Single use: set `accepted_at` and `accepted_user_id`.

## Email

Wire Resend for invites, and add Better Auth's `sendResetPassword` — password reset is
missing for landlords today. Read the key from the Env binding. If `RESEND_API_KEY` is
absent, log and continue rather than 500; local Docker has no key.

## Tests

Reproduce **the whole attack table** from `docs/PLAN-V1.md` §1 as route-level tests.
At minimum: a tenant hitting a landlord route gets 403 before any query runs; a tenant
resolving another tenant's record gets 404, not 403; a landlord inviting another org's
tenant gets 404; and `notes` appears in no portal response.

## Done when

`pnpm --filter api typecheck && lint && test` pass, and the recursive guard is proven
against a violation in a subdirectory.
