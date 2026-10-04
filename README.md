# Rent Management App

Multi-landlord rent management SaaS. Each landlord is an organization with fully
isolated data: properties, units, tenants, leases, payments and maintenance.

## Stack

Every piece is on a permanent free tier that permits commercial use.

| Layer | Tech | Host |
|---|---|---|
| Web | Vite + React 19 + TS + Tailwind 4 + shadcn/ui | Cloudflare Pages |
| API | Hono | Cloudflare Workers |
| DB | Neon Postgres + Drizzle | Neon |
| Auth | Better Auth (`organization` plugin) | self-hosted in the Worker |
| Files | Cloudflare R2 | — |
| Email | Resend | — |
| CI/CD | GitHub Actions | — |

## Layout

```
apps/web         React SPA              frontend-dev owns
apps/api         Hono API on Workers    backend-dev owns
packages/contract  Zod schemas + types  the shared agreement, frozen per task
docs/ARCHITECTURE.md  read this first
.claude/agents/  the agent team
```

## Running it locally

Everything runs in Docker. You need nothing installed but Docker itself.

```bash
docker compose up
```

Then open **http://localhost:5173**.

The first run takes about five minutes — it pulls images and installs the workspace
inside the container. After that it starts in seconds, because dependencies and the
pnpm store persist in named volumes.

Services come up in order, gated on health checks rather than sleeps:

```
deps ──> db ──> migrate ──> api ──> web
```

| Service | Host port | |
|---|---|---|
| web | **5173** | Vite dev server, hot reload |
| api | **8787** | `wrangler dev`, the Worker runtime |
| db | **5433** | Postgres 17 |
| db-proxy | — | Neon HTTP proxy, internal only |

**The database is on 5433, not 5432**, so it cannot collide with a Postgres
container you may already be running.

**There is a proxy in front of Postgres** because the API speaks SQL over HTTP —
Workers cannot hold a TCP socket open between requests — while a stock Postgres
container only speaks TCP. Local dev therefore exercises the same driver path as
production. Migrations skip the proxy and connect over plain TCP, since drizzle-kit
uses a normal driver.

### First time through

There is no seed data. Open the app, sign up, create your organization when
prompted, and you land on an empty properties list.

### Checking it works

```bash
curl http://localhost:8787/health                     # {"ok":true,...}
docker compose exec db psql -U rms -d rms -c '\dt'    # 9 tables
```

### Everyday commands

```bash
docker compose up -d           # background
docker compose logs -f api     # follow one service
docker compose down            # stop, keep data
docker compose down -v         # stop and wipe the database
```

Editing anything under `apps/web/src` or `apps/api/src` hot-reloads — no rebuild.
After changing a dependency or the database schema, see
[docs/DOCKER.md](./docs/DOCKER.md), which also covers troubleshooting.

Credentials in the stack are dev-only: the auth secret is a hardcoded fake and the
database password is local. Production secrets are set with `wrangler secret put` —
see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

## Running on the host instead

Only worth it if you are already set up for it — it needs Node 22, pnpm 10, and a
database you provide yourself (a free Neon project, or the `db` service above).

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill in DATABASE_URL
pnpm dev                                            # web :5173, api :8787
```

Pointing `.dev.vars` at the Docker database means setting both `DATABASE_URL` and
`NEON_LOCAL_FETCH_ENDPOINT`, since the HTTP driver still needs the proxy.

## Checks

```bash
pnpm check     # typecheck, lint and tests across the workspace
pnpm build     # builds both apps
```

## How work gets done here

Agents have no shared memory, so the repo is their only common context:

1. **Plan** — `architect` proposes the data model, API surface and task split.
2. **Freeze the contract** — `packages/contract` is updated and committed. Neither
   dev agent may change it mid-task.
3. **Build in parallel** — `backend-dev` in `apps/api`, `frontend-dev` in `apps/web`.
   Directory ownership is what makes this safe: because neither agent can touch the
   other's files, they share one checkout and still never collide.
4. **Review** — `reviewer` reads the merged diff, tenant isolation first.
5. **Ship** — `devops` only if CI, deploy or environment changed.

See `docs/ARCHITECTURE.md` for the rules agents must follow, especially section 5
on tenant isolation.
