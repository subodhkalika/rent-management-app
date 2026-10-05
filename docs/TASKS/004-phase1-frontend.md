# Task 004 (frontend) — Phase 1: tenants, portal shell, actor-aware routing

**Agent:** frontend-dev · **Owns:** `apps/web/**` · **Contract:** FROZEN

Read `docs/PLAN-V1.md` §1 for the model. Build against the contract; backend-dev is
writing these endpoints in parallel.

## Do this first: the routing is currently wrong for tenants

`apps/web/src/features/auth/guards.tsx` assumes one actor type. `RequireAuth` sends
anyone without an organization to `/onboarding` — so **every tenant who signs in gets
asked to create a landlord organization**. Rewrite it to branch on
`GET /v1/me/context`.

The client must never infer actor type from "has an organization":

- A tenant can create their own empty organization. Better Auth allows it, it reaches
  nothing, but it sets `activeOrganizationId` — so "has an org" does not mean landlord.
- One person can be a landlord **and** another landlord's tenant. Both lists in
  `MeContext` can be non-empty at once.

Use the contract's `primaryActor(ctx)` for the default landing decision. Where both
actors exist, offer a way to move between "My properties" and "My tenancies" — a
switcher in the app shell is enough; do not build a second shell.

## Screens — landlord

1. **`/tenants`** — list: name, email, phone, status badge, portal-access badge.
   Primary action: Add tenant.
2. **`/tenants/:id`** — detail with edit and delete, and a portal-access panel.
3. **Add/edit tenant** — dialog, fields per `createTenantBody`.
4. **Portal access panel** — the states are `none`, `invited`, `active`, `revoked`:
   - `none` — "Invite to portal", disabled with an explanation when the tenant has no
     email on file, since the server rejects that.
   - after inviting — **show the returned URL once**, with a copy button and an
     unmistakable warning that it will not be shown again. This is the only time it
     exists client-side.
   - `invited` — show expiry, offer Resend (which revokes and reissues) and Revoke.
   - `active` — show the bound login email and offer Revoke, with a confirm that says
     plainly the tenant will lose access immediately.

## Screens — tenant portal

5. **`/portal/accept?token=...`** — both paths:
   - signed out: name + password, creates the account
   - signed in: a confirm button that binds the current login
   The email is **not** an input — it comes from the invite. Show it read-only so the
   person can see which address this is for.
   Every failure returns the same 404; render it as "This invitation is no longer
   valid. Ask your landlord to send a new one." Do not invent more specific copy —
   the sameness is deliberate.
6. **`/portal`** — shell with the landlord's organization name, and the tenancy
   switcher when the user has more than one.
7. **`/portal/profile`** — view, and edit the fields in `updatePortalProfileBody`
   (phone, emergency contact, reminder opt-out). Name and email are read-only.

## Auth gaps to close

8. **`/forgot-password` and `/reset-password`** — missing today, and a landlord who
   forgets their password currently has no recovery path at all.

## Requirements

- Types from `@rms/contract`. URLs from `routes.*`. No literal paths.
- Four states on every screen: loading skeleton, empty, error with retry, loaded.
- The invite URL is sensitive: do not log it, do not put it in a query string, and do
  not leave it in component state after the dialog closes.
- A tenant has no organization, so nothing in the portal may call a landlord endpoint
  or read `useActiveOrganization`.
- Accessibility as before: labels tied to inputs, errors in `aria-live`, dialogs trap
  focus, the copy button announces success to a screen reader.

## Tests

- The guard sends a tenant-only user to `/portal`, a landlord to `/properties`, and a
  user with neither to `/onboarding` — and does not flash while the session loads.
- A user with **both** actors gets a working switcher.
- The invite URL renders once and is gone after the dialog closes.
- Invite acceptance renders the generic failure copy on a 404.
- "Invite to portal" is disabled when the tenant has no email.

## Done when

`pnpm --filter web typecheck && lint && test` pass, and a tenant can go from an invite
link to their profile page without ever seeing a landlord screen.
