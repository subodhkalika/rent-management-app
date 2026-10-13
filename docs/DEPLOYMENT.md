# Deployment runbook

Everything here stays on a free tier. Steps marked **[one-time, manual]** are done
once by a human, outside CI, and are not repeated on every deploy.

## Layout

| Environment | Web | API | Deploys when |
|---|---|---|---|
| **local** | `localhost:5173` (Docker) | `localhost:8787` (Docker) | always on, unrelated to this doc — see `docs/DOCKER.md` |
| **staging** | `gharpages-stage.subodhk.com` | `api-stg.subodhk.com` | every push to `main` |
| **production** | `gharpages-prod.subodhk.com` | `api.subodhk.com` | a version tag (`v*`) is pushed |

Staging and production are two separate Cloudflare Workers, two separate Cloudflare
Pages projects, and (critically) two separate Wrangler secret stores. They share one
Neon **project** — staging's database is a **branch** of production's, not a
separate project — but the two Workers must never be pointed at the same
connection string. See "Neon Postgres" and "Wrangler (Worker) secrets" below.

CI/CD lives in:

- `.github/workflows/ci.yml` — PRs and pushes to main: install, typecheck, lint,
  test, build. No deploy. Also runnable as a reusable workflow (`workflow_call`),
  which `deploy-production.yml` uses so a tagged commit gets the identical gate.
- `.github/workflows/deploy-staging.yml` — after CI succeeds on a push to `main`:
  migrate the Neon staging branch, deploy the API Worker to `rms-api-staging`,
  build and deploy the web app to the `rms-web-staging` Pages project.
- `.github/workflows/deploy-production.yml` — after a `v*` tag is pushed: re-run
  CI against that exact commit, then migrate the production database, deploy the
  API Worker to `rms-api-production`, build and deploy the web app to the
  `rms-web-production` Pages project.

Read all three before changing any of them; they assume the exact npm script names
in `apps/api/package.json` and `apps/web/package.json`.

## 1. Domain and Cloudflare nameservers **[one-time, manual]**

The owner already owns `subodhk.com`. Point it at Cloudflare so the API's custom
domains and the Pages projects' custom domains can both attach to it:

1. Dashboard → **Add a site** → enter `subodhk.com` → pick the **Free** plan.
2. Cloudflare scans existing DNS and shows two nameservers (e.g.
   `aida.ns.cloudflare.com`, `walt.ns.cloudflare.com` — yours will differ).
3. At the domain registrar (wherever `subodhk.com` was bought), replace the
   existing nameservers with those two.
4. Wait for propagation (minutes to ~24h; Cloudflare emails when the zone goes
   active). Until then, skip ahead and come back — steps 2–5 below don't need the
   zone active yet, but the custom-domain attachments in steps 4 and 5 do.

No DNS records need to be created by hand for the subdomains used here
(`stg`, `api-stg`, `rent`, `api`) — attaching a Workers custom domain or a Pages
custom domain (steps 4 and 5) creates the necessary CNAME/proxy record for you.

## 2. Neon Postgres **[one-time, manual]**

One Neon **project**, two things living in it:

1. Create a free project at <https://console.neon.tech> — this holds production.
2. From the project's **Connection Details** panel, copy two connection strings
   for the **production** (default/`main`) branch:
   - **Pooled** (host ends `-pooler`) — the production Worker uses this at
     runtime via `@neondatabase/serverless`.
   - **Direct / unpooled** (no `-pooler`) — CI uses this to run migrations against
     production. `drizzle-kit migrate` opens a direct TCP connection; running DDL
     through the pgbouncer transaction-mode pooler can fail or behave oddly on
     some statements.
3. Create a **branch** for staging: Neon console → **Branches** → **Create
   branch** → branch from `main` (production), name it `staging`. This is a
   copy-on-write fork — cheap, isolated, and resettable without touching
   production.
4. From the **staging branch's** own Connection Details panel (not production's —
   branches have their own hostnames), copy its own **pooled** and **direct**
   connection strings.
5. Keep all four strings. They become four *different* secrets below — same
   shape, different host, different purpose. Mixing up a staging string and a
   production string is the one mistake that would make "two environments
   generating against the same database" (see `apps/api/wrangler.jsonc`'s
   `env.staging` comment) stop being hypothetical.

**Resetting staging from production:** when staging needs realistic data, reset
the `staging` branch from Neon's console (**Branches → staging → Reset from
parent**) or `neon branches reset` via the Neon CLI. This replaces staging's data
with a fresh copy of production's at the moment of reset — it does **not** change
connection strings, so nothing in GitHub Secrets or Worker secrets needs updating
afterward.

## 3. Cloudflare API token **[one-time, manual]**

Create a token at <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token** → **Create Custom Token**. Grant exactly:

| Scope | Resource | Permission |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Cloudflare Pages | Edit |
| Account | Account Settings | Read |
| Zone (`subodhk.com`) | Workers Routes | Edit |
| Zone (`subodhk.com`) | Zone | Read |
| User | User Details | Read |

The two **Zone**-scoped rows are new since the custom-domain routes
(`api-stg.subodhk.com`, `api.subodhk.com` in `apps/api/wrangler.jsonc`) are
zone-attached resources — the account-only scopes from before (Workers Scripts,
Pages) were enough when the API lived on `*.workers.dev`, but are not enough to
attach a Workers custom domain to a zone. **I could not verify the exact minimal
zone permission name against a live account** — if `wrangler deploy --env staging`
403s specifically on the `routes` step, the fix is almost certainly widening this
zone grant (e.g. to "Zone: Workers Routes: Edit" plus "Zone: Zone Settings: Read")
rather than anything in this repo's config.

Also note your **Account ID**. It is a 32-character hex string — not your email,
not the API token. Three ways to find it, easiest first:

- **The dashboard URL.** `https://dash.cloudflare.com/<account-id>/...` — it is the
  segment straight after the host.
- **Workers & Pages** in the sidebar, then *Account details* on the right, with a
  copy button.
- **From the CLI**, which also proves the value is the account you think it is:

  ```bash
  cd apps/api && pnpm exec wrangler whoami
  ```

It is not a secret by itself — it appears in your own URL bar and does nothing
without a token — but it is stored as a GitHub Secret alongside one, so treat it as
configuration rather than something to paste into a chat window.
Overview page in the dashboard. You'll need both values below.

## 4. Bootstrap: create both Workers **[one-time, manual]**

`deploy-staging.yml` and `deploy-production.yml` only ever run `wrangler deploy
--env <env>` (update an existing Worker) and rely on `wrangler secret put --env
<env>` having already been run by hand — neither creates a Worker from scratch
non-interactively. Something has to create `rms-api-staging` and
`rms-api-production` once each, by hand, before secrets can be set on them or the
automated pipelines can touch them.

From the repo root, with dependencies installed (`pnpm install`, once):

```bash
cd apps/api
CLOUDFLARE_API_TOKEN=<token from step 3> CLOUDFLARE_ACCOUNT_ID=<account id from step 3> \
  pnpm dlx wrangler deploy --env staging
CLOUDFLARE_API_TOKEN=<token from step 3> CLOUDFLARE_ACCOUNT_ID=<account id from step 3> \
  pnpm dlx wrangler deploy --env production
```

Each command deploys with whatever's checked in `apps/api/wrangler.jsonc` for that
environment — including its real `WEB_ORIGIN` and its real custom-domain route —
which is fine, since both get redeployed for real the first time CI runs anyway.
Its only job here is to make each Worker exist (and, as a side effect, attach each
custom domain route — give this a minute to propagate before testing it).

## 5. Cloudflare Pages projects **[one-time, manual]**

Two projects, one per environment — `deploy-staging.yml` and
`deploy-production.yml` hardcode these names, so both must exist under exactly
these names before the first deploy:

```bash
pnpm dlx wrangler pages project create rms-web-staging --production-branch=main
pnpm dlx wrangler pages project create rms-web-production --production-branch=main
```

(Or create them in the dashboard: **Workers & Pages → Create → Pages → Direct
Upload**, named exactly `rms-web-staging` and `rms-web-production`.) Neither needs
a build step configured in the Pages project itself — the deploy workflows build
the app and push the static output directly with `wrangler pages deploy`.

Then attach each project's custom domain — **wrangler's CLI has no `pages domain`
command**, this is dashboard-only: **Workers & Pages → \<project\> → Custom
domains → Set up a domain**.

- `rms-web-staging` → `gharpages-stage.subodhk.com`
- `rms-web-production` → `gharpages-prod.subodhk.com`

The zone from step 1 must be active before this will succeed.

## 6. Resolved: cookies are first-party, not cross-site

Phase 1 ran the API on `*.workers.dev` and the web app on `*.pages.dev` — two
different registrable domains, making the session cookie third-party, which risked
browsers silently dropping it (Safari ITP, Chrome's third-party-cookie
phase-out) regardless of any `SameSite`/`Secure` attribute fix. The fix on the
table then was a Pages Function proxy to force same-origin.

With `subodhk.com` now in hand, that problem doesn't exist. **Verified, not just
asserted:**

- "Site," for both `SameSite` cookie enforcement and every browser's third-party-
  cookie blocking, means *scheme + registrable domain (eTLD+1)* — not full
  hostname. This is "schemeful same-site," shipped and stable in every evergreen
  browser engine.
- `gharpages-prod.subodhk.com` and `api.subodhk.com` are different **origins** (different
  hostnames) but the same **site**: both `https://`, both under the registrable
  domain `subodhk.com`.
- The `SameSite` attribute only restricts a cookie on **cross-site** requests. For
  a **same-site** request — even cross-origin, even a `fetch(..., { credentials:
  'include' })`, even `POST` — the restriction does not apply at all. Better
  Auth's default session cookie (`SameSite=Lax`, no override currently set in
  `apps/api/src/lib/auth.ts`) is sent exactly as if it were first-party.
- Browsers' third-party-cookie blocking (Safari ITP, Chrome's phase-out) is
  defined over the same "site" boundary. Two subdomains of one registrable domain
  are first-party to each other by that definition, in every one of those
  browsers — this is the sanctioned case, not an edge case that might regress.
- The cookie's own `Domain` attribute (host-only vs. explicit) governs which of
  `api.subodhk.com`'s own subdomains it's replayed to — irrelevant here, since the
  browser only ever needs to send it back to `api.subodhk.com` itself, which is
  exactly where it was set.

**Net result:** no proxy, no `SameSite=None; Secure`, nothing to future-proof.
CORS (`Access-Control-Allow-Origin` echoing the exact `WEB_ORIGIN`,
`Access-Control-Allow-Credentials: true`) is still required and already handled —
see `apps/api/src/index.ts` — but that's an orthogonal, already-solved concern;
it has nothing to do with `SameSite`.

If the project is ever deployed under a setup where the web app and API are *not*
same-site again (a different domain for one of them, a white-label domain, etc.),
re-open this question from scratch — don't assume the reasoning above still holds.

## 7. GitHub Secrets

Settings → Secrets and variables → Actions → **Secrets** tab → **New repository
secret**. There are no repository **Variables** anymore — `WEB_ORIGIN` and the
web app's API base URL used to live there (`--var WEB_ORIGIN:...` at deploy time);
both are now plain, non-secret, checked-in values (`apps/api/wrangler.jsonc`'s
`env.staging`/`env.production`, and the `VITE_API_URL` lines in
`deploy-staging.yml`/`deploy-production.yml`), since the domains are fixed and
public. If you still see a `WEB_ORIGIN` or `VITE_API_URL` repository Variable from
before this change, it's dead and can be deleted.

| Secret | Used by | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | both deploy workflows (API + Pages deploy) | Token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | both deploy workflows (API + Pages deploy) | Account ID from step 3 |
| `STAGING_DATABASE_URL` | deploy-staging.yml (migrate step only) | Neon **staging branch**, direct/unpooled string (step 2.4) |
| `PRODUCTION_DATABASE_URL` | deploy-production.yml (migrate step only) | Neon **production**, direct/unpooled string (step 2.2) |

`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are shared across both workflows —
one Cloudflare account, one token, scoped broadly enough (step 3) to deploy both
environments. The two `*_DATABASE_URL` secrets are **not** shared — that's the
whole point of having two of them. Get this backwards (staging's secret holding
production's string) and a migration meant for the throwaway branch runs against
real data instead.

CI (`ci.yml`) needs none of these secrets, and never touches the real database. It
runs a throwaway Postgres service container with hardcoded, disposable credentials
— see that file's own comments for why. Nothing to set by hand for CI itself.

## 8. Wrangler (Worker) secrets — two stores, not one

`wrangler secret put --env staging` and `wrangler secret put --env production`
write to **two completely separate secret stores** — one per Worker
(`rms-api-staging`, `rms-api-production`). Setting a secret on one does nothing
for the other. **Run every command below twice, once per environment, with the
right value each time** — this is the obvious mistake to avoid, not a hypothetical
one.

```bash
cd apps/api

# Staging — point DATABASE_URL at the Neon STAGING BRANCH's pooled string (step 2.4)
pnpm dlx wrangler secret put DATABASE_URL --env staging
pnpm dlx wrangler secret put BETTER_AUTH_SECRET --env staging   # openssl rand -base64 32
pnpm dlx wrangler secret put RESEND_API_KEY --env staging       # from resend.com → API Keys

# Production — point DATABASE_URL at Neon PRODUCTION's pooled string (step 2.2)
pnpm dlx wrangler secret put DATABASE_URL --env production
pnpm dlx wrangler secret put BETTER_AUTH_SECRET --env production
pnpm dlx wrangler secret put RESEND_API_KEY --env production
```

| Secret | Where to get it |
|---|---|
| `DATABASE_URL` (staging) | Neon dashboard → staging branch → Connection Details → **pooled**. Different value from `DATABASE_URL` (production) and from both GitHub secrets. |
| `DATABASE_URL` (production) | Neon dashboard → production (`main`) branch → Connection Details → **pooled**. |
| `BETTER_AUTH_SECRET` | Generate locally: `openssl rand -base64 32`. Use a **different** random value for each environment — staging and production sessions should not be forgeable from one secret. Not derived from anything else. |
| `RESEND_API_KEY` | <https://resend.com> → API Keys, after verifying a sending domain. Using the same key for both environments is fine (Resend doesn't have an environment concept) as long as you're comfortable with staging sending real email — consider a Resend sandbox/test key for staging if not. |

A Worker secret set with `wrangler secret put` persists across deploys — neither
deploy workflow ever sets these, they only run `wrangler deploy --env <env>`,
which leaves existing secrets on that environment's Worker alone.

## 9. Cloudflare R2 bucket **[one-time, manual, when document storage lands]**

Not needed until the API actually uses R2. When it does, create one bucket per
environment (same reasoning as the database split — a staging upload should never
be able to touch a production bucket):

```bash
pnpm dlx wrangler r2 bucket create rms-documents-staging
pnpm dlx wrangler r2 bucket create rms-documents-production
```

Then add an `r2_buckets` binding under each of `env.staging` and
`env.production` in `apps/api/wrangler.jsonc` (not the top level — bindings are
not inherited between environments), pointing at the matching bucket. A binding
needs no secret — the Worker talks to R2 through the binding, not an API key. If
the app later needs presigned URLs via R2's S3-compatible API, that needs its own
`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` Worker secrets per environment (create
an R2 API token for those from the R2 dashboard) — add them to step 8 when that
lands.

## 10. Release flow

**Staging — automatic, on every push to `main`:**

1. Push to `main` (or merge a PR into it).
2. `CI` runs: typecheck, lint, test, build.
3. On success, `Deploy (staging)` runs: a secrets check, then migrate the Neon
   staging branch → deploy `rms-api-staging` → build and deploy
   `rms-web-staging`.
4. Check the **Actions** tab for both workflows green, then hit
   `https://gharpages-stage.subodhk.com` to confirm.

**Production — manual, on a version tag:**

1. Decide what's on `main` right now is what should go to production (it should
   already be green in staging — that's the point of staging).
2. Tag it and push the tag:
   ```bash
   git tag v2026.01.15
   git push origin v2026.01.15
   ```
   Any `v*` tag works; pick a scheme and stay consistent (a date-based tag like
   above, or semver — either is fine, this isn't a published package).
3. `Deploy (production)` runs: CI again (against this exact commit, not
   whatever `main` is by the time this runs) → a secrets check → migrate
   production → deploy `rms-api-production` → build and deploy
   `rms-web-production`.
4. Check the **Actions** tab, then hit `https://gharpages-prod.subodhk.com` to confirm.
5. The tag itself is now the precise rollback target (step 11).

If step 7 or step 8's secrets aren't set, the relevant workflow fails immediately
at "Verify required deploy secrets are set" with an `::error::` saying which one —
set it, then re-run the workflow from the Actions tab (or push the branch/tag
again). Nothing downstream (migrations included) runs until they're set.

## 11. Rolling back a bad deploy

**API Worker** — Cloudflare keeps every deployed version, per environment:

```bash
cd apps/api
pnpm dlx wrangler deployments list --env production      # find the last-good version ID
pnpm dlx wrangler rollback <version-id> --env production
```

(Swap `--env production` for `--env staging` to roll back the other one.) This
reverts traffic instantly without a rebuild. Do this first if the bad deploy is
live and user-facing.

**Web (Pages)** — every deploy is a preserved, immutable release, per project:

- Dashboard → **Workers & Pages → rms-web-production (or rms-web-staging) →
  Deployments** → find the last-good one → **⋮ → Rollback to this deployment**.
- Or redeploy from the last-good tag:
  ```bash
  git checkout <last-good-tag> -- apps/web
  VITE_API_URL=https://api.subodhk.com pnpm --filter web run build
  pnpm dlx wrangler pages deploy apps/web/dist --project-name=rms-web-production
  ```
  (Use `https://api-stg.subodhk.com` and `rms-web-staging` for staging. This
  bypasses the deploy workflow, so do it only when the workflow itself is the
  thing that's broken.)

**Production specifically — the tag is the rollback target:** find the last tag
that was good (`git tag --sort=-creatordate | head`), re-push it as a new tag
pointing at the same commit if you deleted the old one, or just re-run
`deploy-production.yml` from the Actions tab against the old tag's already-recorded
workflow run. Either way, you're never guessing which commit was last good —
that's the reason production only moves on a tag.

**Database migration** — there is no automatic down-migration. Because
migrations must be forward-compatible (see `docs/ARCHITECTURE.md` §8 and
`.claude/agents/devops.md`), a bad migration should almost never require a schema
rollback — roll back the API Worker to the version that matches the *previous*
schema instead, and fix the migration forward in a new PR/tag. Only hand-write a
corrective migration if data was actually corrupted; never edit a migration file
that has already run against production. For staging specifically, a Neon branch
reset (step 2's "Resetting staging from production") is also always an option if
staging's data gets into a state that isn't worth fixing forward.

## Secrets summary — who can regenerate what

| Secret | Regenerate by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Re-create in Cloudflare dashboard (step 3); update the GitHub secret |
| `CLOUDFLARE_ACCOUNT_ID` | Not sensitive — visible in any dashboard page; static |
| `STAGING_DATABASE_URL` / `PRODUCTION_DATABASE_URL` | Neon dashboard → the matching branch → Connection Details; rotating requires updating the GitHub secret (this is the migrate-time string; see the Worker's own `DATABASE_URL` below for the runtime one) |
| `DATABASE_URL` (Worker, staging) | Neon dashboard → staging branch → Connection Details (pooled); `wrangler secret put DATABASE_URL --env staging` |
| `DATABASE_URL` (Worker, production) | Neon dashboard → production branch → Connection Details (pooled); `wrangler secret put DATABASE_URL --env production` |
| `BETTER_AUTH_SECRET` (either environment) | Generate a new random value; rotating invalidates all existing sessions **on that environment only** |
| `RESEND_API_KEY` | Resend dashboard → API Keys → revoke and reissue |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 dashboard → Manage API Tokens (only if/when presigned URLs are added; one pair per environment) |
