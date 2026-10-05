# Task 005 — Phase 1 contract amendments

**Status:** DONE 2026-10-05. All three gaps closed and verified against the running stack.

Two gaps `frontend-dev` found in the phase 1 contract. Both are orchestrator errors:
the brief asked for behaviour the contract gave no way to implement. The agent
correctly stopped and reported rather than inventing a local type or calling a route
that does not exist.

## 1. No invite preview endpoint

`docs/TASKS/004-phase1-frontend.md` says the accept page should show the invite's
target email read-only, "so the person can see which address this is for". There is no
way to fetch it — `acceptInvite` is write-only and the raw token is all the client has.

Today the signed-out form omits the field entirely, which is a worse experience:
someone clicking a forwarded link cannot tell whose invite it is before setting a
password.

**Add:** `GET /v1/portal/invites/:token` -> `{ orgName, tenantDisplayName, email, accountExists }`

Safe to expose: the token is 256 bits, so possessing it already proves possession of
the emailed link. **Must keep the uniform failure rule** — bad, expired, revoked,
accepted or archived all return the same 404 as `acceptInvite`, or the preview becomes
the enumeration oracle the accept endpoint was carefully designed not to be.

`accountExists` lets the page show "Sign in to accept" instead of a password form,
which is the signed-out half of the dual-path flow.

## 2. No persisted invite expiry

`tenant` carries `portalAccess` and `portalEmail` but no expiry. `inviteCreated`
returns `expiresAt` once, so after a reload the landlord sees an `invited` tenant with
no idea whether the link is still live. The panel currently says "waiting to accept"
rather than fabricate a date.

**Add:** `inviteExpiresAt: z.string().datetime().nullable()` to `tenant`, non-null only
while `portalAccess === 'invited'`. Landlord-facing only; it appears in no portal
response.

## 3. `property.timezone` exists in the database and can never be set — fix this first

Found by `backend-dev`. The most consequential of the three, because the feature looks
implemented and silently is not.

`property.timezone` is `NOT NULL DEFAULT 'UTC'` in the schema, but
`createPropertyBody`, `updatePropertyBody` and `property` in the contract have no
`timezone` field. So no request can ever carry one and no response can return one.
**Every property stays 'UTC' forever.**

That quietly guts the date model the whole ledger rests on:

- `localToday(property.timezone)` always answers "today in UTC"
- Arrears flip at UTC midnight, which is the wrong local day for most of the world —
  a Perth landlord (UTC+8) sees rent marked overdue eight hours early, a Los Angeles
  one (UTC-8) sees it marked a day late
- Phase 4's reminders are scheduled on a `scheduled_for` date computed in the
  property's timezone, so they would go out on the wrong local day

Nothing fails. No test catches it. It is only visible as rent being overdue on the
wrong date, which looks like a billing bug rather than a missing field.

**Add to `packages/contract/src/property.ts`:**
- `timezone` (the `timezone` schema from `common.ts`) on `createPropertyBody`,
  required going forward
- the same on `updatePropertyBody` via `.partial()`
- `timezone` on the `property` response

Then the frontend's timezone field and the "confirm your timezone" banner — already in
the phase 1 frontend brief, and not buildable until this lands — can round-trip.

Do this one before 1 and 2: it is the only one of the three that is actively wrong
rather than merely missing.

## 4. Naming check, not a change

The plan describes separate `DELETE /v1/tenants/:id/invite` and
`DELETE /v1/tenants/:id/portal-access`. The contract exposes only the latter, so the UI
points both "Revoke invite" and "Revoke access" at it. That is fine — one endpoint that
revokes outstanding invites and unbinds the user is simpler and has no gap between the
two states. **Confirmed 2026-10-05:** `revokePortalAccess` unbinds `tenant.user_id` and calls
`revokeLiveInvites` in the same function. Verified live — after the call, the
outstanding token 404s through the preview endpoint and the tenant's `invitedEmail`
and `inviteExpiresAt` clear. The single endpoint genuinely covers both states, so the
plan's second endpoint is not needed and its reference has been removed.

## Scope

Small. Contract edit by the orchestrator, then one backend task and one frontend task.
Do not start until phase 1 is reviewed and merged.
