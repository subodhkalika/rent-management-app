# Task 003 — Authentication UI

**Agent:** frontend-dev · **Owns:** `apps/web/**` · **Contract:** FROZEN

## Goal

Make the app usable. Today `apps/web/src/lib/auth-client.ts` exists and is imported by
nothing, `App.tsx` routes only `/properties`, and every API call sits behind
`requireAuth` — so the app 401s on first load with no way forward.

## The flow, including the part that is easy to get wrong

```
  /signup ──> account created, but user has NO organization
       │
       ▼
  /onboarding ──> create organization ──> MUST call organization.setActive()
       │
       ▼
  /properties
```

**Why `setActive` matters.** The API resolves tenancy from
`session.activeOrganizationId`. `apps/api/src/lib/auth.ts` has a session-create hook
that sets it from the user's earliest membership — but that hook runs at **session
creation**, i.e. sign-in. A user who signs up and creates an org inside the same
session still has `activeOrganizationId = null` until something sets it explicitly.
Call `organization.setActive({ organizationId })` right after creating the org, or the
user lands on a dashboard that 403s and looks broken.

## Screens

1. **`/signin`** — email + password. Link to sign up.
2. **`/signup`** — name, email, password. Link to sign in.
3. **`/onboarding`** — create the first organization (name; slug derived, editable).
   Only reachable when signed in with no organization.
4. **App shell** — persistent header for signed-in routes: app name, the current
   organization, and a user menu with sign out.

## Routing rules

- Unauthenticated at a protected route -> redirect to `/signin`, preserving the
  intended destination so sign-in returns there rather than always to `/properties`.
- Authenticated with no active organization -> redirect to `/onboarding`.
- Authenticated at `/signin` or `/signup` -> redirect to `/properties`.
- **A 403 `forbidden` from any API call** means the session lost its active org.
  Route to `/onboarding` rather than showing a raw error.
- **A 401 `unauthorized`** means the session expired. Route to `/signin`.
  `ApiClientError.isAuth` already distinguishes these.

## Requirements

- Use the existing `authClient` in `src/lib/auth-client.ts`. Do not build a second
  auth path or hand-roll fetch calls to `/api/auth/*`.
- Session state comes from `useSession()`. While it is loading, render nothing that
  flashes — no redirect to `/signin` before the session resolves, or a signed-in user
  sees a login flash on every refresh.
- Forms: react-hook-form + zodResolver, same as the property forms. Validation schemas
  for the auth forms are NOT in `packages/contract` (that covers the domain API, not
  Better Auth's endpoints) — define them locally in the auth feature.
- Auth errors are the one place users are most likely to be stuck: show the real
  reason ("Incorrect email or password", "An account with this email already exists"),
  never a generic failure. Map Better Auth's error codes rather than printing them.
- Do not reveal whether an email is registered on the sign-in path — a wrong password
  and an unknown account get the same message.
- Password field: minimum 8 characters, a show/hide toggle, and
  `autocomplete="current-password"` / `"new-password"` so password managers work.
- Accessibility: labels tied to inputs, errors in `aria-live`, the form submittable by
  Enter, and focus moved to the first invalid field on a failed submit.

## Tests

- Sign-in form shows a validation error for a malformed email and an empty password.
- A failed sign-in renders the mapped error message, not a generic one.
- The protected-route guard redirects an unauthenticated user to `/signin` and does
  not flash while the session is still loading.
- Creating an organization calls `setActive` before navigating. This is the bug most
  likely to ship silently — cover it explicitly.

## Done when

`pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test` pass,
and a user can go from a cold `docker compose up` to a populated properties page
without touching curl.
