# Deployment runbook

Everything here stays on a free tier. Steps marked **[one-time, manual]** are done
once by a human, outside CI, and are not repeated on every deploy.

CI/CD lives in:

- `.github/workflows/ci.yml` — PRs and pushes to main: install, typecheck, lint, test, build.
- `.github/workflows/deploy.yml` — after CI succeeds on main: migrate, deploy API, deploy web.

Read both before changing either; they assume the exact npm script names in
`apps/api/package.json` and `apps/web/package.json`.

**Read §6 before the first deploy.** The API and web app end up on different domains
on the free tier, which affects whether login works in every browser — see below.

## 1. Neon Postgres **[one-time, manual]**

1. Create a free project at <https://console.neon.tech>.
2. From the project's **Connection Details** panel, copy two connection strings:
   - **Pooled** (host ends `-pooler`) — the Worker uses this at runtime via
     `@neondatabase/serverless`.
   - **Direct / unpooled** (no `-pooler`) — CI uses this to run migrations.
     `drizzle-kit migrate` opens a direct TCP connection; running DDL through the
     pgbouncer transaction-mode pooler can fail or behave oddly on some statements.
3. Keep both strings. You'll set them as two *different* secrets below — same
   shape, different host, different purpose.

## 2. Cloudflare API token **[one-time, manual]**

Create a token at <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token** → **Create Custom Token**. Grant exactly:

| Scope | Resource | Permission |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Cloudflare Pages | Edit |
| Account | Account Settings | Read |
| User | User Details | Read |

Narrower than this and `wrangler deploy` / `wrangler pages deploy` will 403.
Broader (e.g. "Edit all resources") works but over-grants — don't use the
default "Edit Cloudflare Workers" template as-is, it doesn't include Pages.

Also note your **Account ID** — it's on the right sidebar of any zone/account
Overview page in the dashboard. You'll need both values below.

## 3. Cloudflare Pages project **[one-time, manual]**

The web app deploys to a Pages project named **`rms-web`** — `deploy.yml` hardcodes
this name, so the project must exist under exactly this name before the first
deploy. Easiest from your machine with the token from step 2:

```bash
pnpm dlx wrangler pages project create rms-web --production-branch=main
```

(Or create it in the dashboard: **Workers & Pages → Create → Pages → Direct
Upload**, name it `rms-web`.) You do not need to configure a build step in the
Pages project itself — `deploy.yml` builds the app and pushes the static output
directly with `wrangler pages deploy`.

This also fixes the Pages project's `*.pages.dev` URL, which you need for step 5.
If the name `rms-web` is already taken globally on `pages.dev`, Cloudflare will
assign a different subdomain — check the dashboard for the actual URL and use
*that* in step 5, not the assumed one.

## 4. Bootstrap: create the Worker **[one-time, manual]**

`deploy.yml` only ever runs `wrangler deploy` (update an existing Worker) and
`wrangler secret put` (set a secret on an existing Worker) — neither creates a
Worker from scratch non-interactively. Something has to create `rms-api` once,
by hand, before step 9's `wrangler secret put` commands or the automated
pipeline in step 10 can touch it. (Running `wrangler secret put` against a
Worker that doesn't exist yet prompts "No worker named rms-api found — create
one?", which has no TTY to answer in CI and will hang or fail there too.)

From the repo root, with dependencies installed (`pnpm install`, once):

```bash
cd apps/api
CLOUDFLARE_API_TOKEN=<token from step 2> CLOUDFLARE_ACCOUNT_ID=<account id from step 2> \
  pnpm dlx wrangler deploy
```

This deploys `rms-api` with whatever's checked in — including the default,
localhost `WEB_ORIGIN` from `wrangler.jsonc` — which is fine, since nothing
depends on this deploy working correctly. Its only job is to make the Worker
exist. The command's output prints the live `*.workers.dev` URL; copy it down
for step 5. (Steps 9 and 10 will immediately deploy real secrets and the real
`WEB_ORIGIN` over this placeholder.)

## 5. GitHub Actions variables

Settings → Secrets and variables → Actions → **Variables** tab (not Secrets —
these are public URLs, not sensitive). Read by `deploy.yml`:

| Variable | Used by | Value |
|---|---|---|
| `VITE_API_URL` | Build-web step | The API Worker's URL from step 4, e.g. `https://rms-api.<your-subdomain>.workers.dev` — **no trailing slash** (`apps/web/src/lib/api.ts` concatenates it directly onto each request path) |
| `WEB_ORIGIN` | Deploy-API step | The Pages project's URL from step 3, e.g. `https://rms-web.pages.dev` — **no trailing slash** |

Both are baked in at deploy time, not read at runtime:

- `VITE_API_URL` is a Vite env var — it's inlined into the static JS bundle when
  `vite build` runs, so it must be set as a build-step env, not a Worker var.
  (This was missing before: the build ran with it unset, so the deployed bundle
  shipped with `BASE = ''` and every API call resolved against the Pages domain,
  which serves no API.)
- `WEB_ORIGIN` is passed to `wrangler deploy --var WEB_ORIGIN:...` so the checked-in
  `apps/api/wrangler.jsonc` can keep `http://localhost:5173` as the default for
  local `wrangler dev`, while production gets the real Pages origin. The API
  sends CORS with `credentials: true`, which forbids a wildcard origin, so this
  must be the exact Pages URL or the browser rejects every cross-origin response.

Set both now. There is no working order in which you reach step 10 before these
are set: `deploy.yml`'s first step, "Verify required deploy variables are set",
fails the job immediately with an `::error::` annotation if either is empty —
by design, so an empty `VITE_API_URL` or `WEB_ORIGIN` can never deploy silently
broken config (see §10 and the step's comments in `deploy.yml` for exactly what
breaks if it didn't).

## 6. Known limitation: cross-site session cookies

On the free tier, the API (`*.workers.dev`) and the web app (`*.pages.dev`) are
different registrable domains — there is no way around this without a custom
domain. That makes the session cookie **third-party** in production, which has
two consequences beyond CORS:

1. **Needs an explicit cookie fix in `apps/api/src/lib/auth.ts` (backend-dev's
   file — not changed here).** Better Auth's session cookie currently uses
   whatever default `sameSite`/`secure` Better Auth picks. A cross-site
   `fetch(..., { credentials: 'include' })` only attaches a cookie if it's set
   with `SameSite=None; Secure`. Without that change, login will appear to work
   (the Worker sets the cookie) but the browser will silently drop it on the
   *next* request, so every "logged in" user immediately looks logged out.
   This needs fixing regardless of which option below is chosen, and is required
   before production login works at all.
2. **Browsers increasingly block third-party cookies outright**, even with the
   attributes above set correctly (Safari ITP blocks them by default today;
   Chrome has been phasing out third-party cookies). A `SameSite=None` fix alone
   is not guaranteed future-proof.

Two ways to make the cookie first-party instead of patching around it:

| Option | How | Tradeoff |
|---|---|---|
| **(a) Custom domains** | `api.yourdomain.com` + `app.yourdomain.com`, same registrable domain → same-site cookie | Needs a domain you own. Domain registration is not free, so this breaks the all-free-tier constraint unless the team already owns a domain to reuse. |
| **(b) Proxy through the Pages app** | Serve the API under the web app's own origin, e.g. a Cloudflare Pages Function at `apps/web/functions/api/[[path]]` (or similar, for every path the API currently serves — see the Vite dev proxy in `apps/web/vite.config.ts` for the exact path list) that forwards to the Worker, ideally via a service binding so the hop never leaves Cloudflare's network. Cookie becomes first-party; `VITE_API_URL` becomes unnecessary (same-origin, `BASE = ''` works again, both in dev and prod). | Stays free. Adds a thin proxy layer and one more moving part to keep in sync with the API's route list. |

**Picked: (b).** It's the only option that holds the free-tier constraint without
relying on the team happening to already own a domain. **This is not implemented
yet** — it requires a change inside `apps/web` (a Pages Function or equivalent),
which is `frontend-dev`'s code, not devops config, so it's out of scope for this
pass. Flagging as a required follow-up:

- [ ] `frontend-dev`: add the Pages Function proxy described above.
- [ ] `backend-dev`: set `sameSite: 'none', secure: true` on the session cookie
      in `apps/api/src/lib/auth.ts` regardless — needed as an interim fix even
      before the proxy lands, and harmless once same-origin makes it moot.
- [ ] `devops` (follow-up task): once the proxy exists, `VITE_API_URL` in step 5
      can be dropped and `apps/web/vite.config.ts`'s proxy paths become the
      source of truth for what the Pages Function needs to forward.

**Until the proxy lands:** login may work in some browsers (current Chrome, with
the cookie fix above applied) and silently fail in others (Safari, Firefox
private browsing, future Chrome). Don't treat a successful login in one browser
during testing as proof this is fixed.

## 7. Cloudflare R2 bucket **[one-time, manual, when document storage lands]**

Not needed until the API actually uses R2. When it does:

```bash
pnpm dlx wrangler r2 bucket create rms-documents
```

Then uncomment the `r2_buckets` binding in `apps/api/wrangler.jsonc`. A binding
needs no secret — the Worker talks to R2 through the binding, not an API key.
If the app later needs presigned URLs via R2's S3-compatible API, that needs its
own `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` Worker secrets (create an R2 API
token for those from the R2 dashboard) — add them here when that lands.

## 8. GitHub Secrets

Settings → Secrets and variables → Actions → **Secrets** tab → **New repository
secret**. These are read by the workflows in `.github/workflows/`:

| Secret | Used by | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy.yml (API + Pages deploy) | Token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | deploy.yml (API + Pages deploy) | Account ID from step 2 |
| `DATABASE_URL` | deploy.yml (migrate step only) | Neon **direct/unpooled** string from step 1 |

CI (`ci.yml`) needs none of these secrets, and never touches the real database.
It does now run a **throwaway Postgres** (a `postgres:17-alpine` service
container, same image as `docker-compose.yml`'s `db`, plus the same Neon HTTP
proxy sidecar) so `apps/api/src/db/repo/lease.integration.test.ts` and
`.../portal/lease.integration.test.ts` run instead of silently skipping — see
that database's own comment block in `ci.yml` for why both pieces are needed.
Its credentials are hardcoded directly in the workflow file (`rms` /
`rms_ci_password`), not a GitHub secret: the database exists only for the
lifetime of one job, is never reachable from outside it, and holds nothing
real. Nothing to set by hand here.
(See step 5 above for the two non-secret **variables** deploy.yml also needs.)

## 9. Wrangler (Worker) secrets

These are runtime secrets for the deployed Worker, set once directly against
Cloudflare (not GitHub) with `wrangler secret put <NAME>` from `apps/api/`.
Safe to run now — step 4 already created `rms-api`, so this sets secrets on an
existing Worker instead of hitting the create-a-placeholder prompt:

```bash
cd apps/api
pnpm dlx wrangler secret put DATABASE_URL        # Neon POOLED string
pnpm dlx wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
pnpm dlx wrangler secret put RESEND_API_KEY       # from resend.com → API Keys
```

| Secret | Where to get it |
|---|---|
| `DATABASE_URL` | Neon dashboard — the **pooled** connection string (step 1). Different value from the GitHub secret of the same name. |
| `BETTER_AUTH_SECRET` | Generate locally: `openssl rand -base64 32`. Not derived from anything — just a random value only the Worker and whoever rotates it knows. |
| `RESEND_API_KEY` | <https://resend.com> → API Keys, after verifying a sending domain. |

A Worker secret set with `wrangler secret put` persists across deploys — `deploy.yml`
never sets these, it only runs `wrangler deploy`, which leaves existing secrets alone.

## 10. First deploy

Once steps 1–9 are done:

1. Push to `main` (or merge a PR into it).
2. `CI` runs: typecheck, lint, test, build.
3. On success, `Deploy` runs: a variables check, then migrate → deploy API
   Worker → build and deploy web to Pages.
   - If step 5's variables aren't set, this fails immediately at "Verify
     required deploy variables are set" with an `::error::` saying which one —
     go set it, then re-run the workflow from the Actions tab (or push again).
     Nothing downstream (migrations included) runs until both are set.
4. Check **Actions** tab for both workflows green, then hit the Worker's
   `*.workers.dev` URL and the Pages `*.pages.dev` URL to confirm.
5. Remember §6: a successful page load does not mean login works in every browser.

## 11. Rolling back a bad deploy

**API Worker** — Cloudflare keeps every deployed version:

```bash
cd apps/api
pnpm dlx wrangler deployments list      # find the last-good version ID
pnpm dlx wrangler rollback <version-id>
```

This reverts traffic instantly without a rebuild. Do this first if the bad
deploy is live and user-facing.

**Web (Pages)** — every deploy is a preserved, immutable release:

- Dashboard → **Workers & Pages → rms-web → Deployments** → find the last-good
  one → **⋮ → Rollback to this deployment**.
- Or redeploy from the last-good commit: `git checkout <good-sha> -- apps/web && pnpm --filter web run build && pnpm dlx wrangler pages deploy apps/web/dist --project-name=rms-web`.
  (Set `VITE_API_URL` in your shell first — see step 5 — since this bypasses `deploy.yml`.)

**Database migration** — there is no automatic down-migration. Because
migrations must be forward-compatible (see `docs/ARCHITECTURE.md` §8 and
`.claude/agents/devops.md`), a bad migration should almost never require a
schema rollback — roll back the API Worker to the version that matches the
*previous* schema instead, and fix the migration forward in a new PR. Only hand-write
a corrective migration if data was actually corrupted; never edit a migration
file that has already run in production.

## Secrets summary — who can regenerate what

| Secret | Regenerate by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Re-create in Cloudflare dashboard (step 2); update the GitHub secret |
| `CLOUDFLARE_ACCOUNT_ID` | Not sensitive — visible in any dashboard page; static |
| `DATABASE_URL` (both forms) | Neon dashboard → Connection Details; rotating requires updating both the GitHub secret and the Worker secret |
| `BETTER_AUTH_SECRET` | Generate a new random value; rotating invalidates all existing sessions |
| `RESEND_API_KEY` | Resend dashboard → API Keys → revoke and reissue |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 dashboard → Manage API Tokens (only if/when presigned URLs are added) |
