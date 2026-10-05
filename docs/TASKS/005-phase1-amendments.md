# Task 005 — Phase 1 contract amendments

**Status:** queued, do after phase 1 lands and is reviewed.

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

## 3. Naming check, not a change

The plan describes separate `DELETE /v1/tenants/:id/invite` and
`DELETE /v1/tenants/:id/portal-access`. The contract exposes only the latter, so the UI
points both "Revoke invite" and "Revoke access" at it. That is fine — one endpoint that
revokes outstanding invites and unbinds the user is simpler and has no gap between the
two states. Confirm the backend implements it that way, then delete the plan's
reference to the second endpoint so the two documents agree.

## Scope

Small. Contract edit by the orchestrator, then one backend task and one frontend task.
Do not start until phase 1 is reviewed and merged.
