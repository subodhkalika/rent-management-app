# Running the whole stack locally

One command, nothing installed on your machine but Docker.

```bash
docker compose up
```

Then open **http://localhost:5173**.

First run takes ~5 minutes: it pulls images and installs the workspace into the
container. Later runs start in seconds — dependencies and the pnpm store live in
named volumes and are reused.

## What comes up

| Service | Host port | What it is |
|---|---|---|
| `web` | **5173** | Vite dev server, hot reload |
| `api` | **8787** | `wrangler dev`, the Worker runtime |
| `db` | **5433** | Postgres 17 |
| `db-proxy` | — | Neon HTTP proxy, internal only |
| `deps` | — | One-shot `pnpm install` |
| `migrate` | — | One-shot `drizzle-kit migrate` |

Startup is ordered, not raced: `deps` and `db` finish, then `migrate` runs to
completion, then `api` becomes healthy, then `web` starts.

### Why port 5433 and not 5432

Because you are probably already running a Postgres container on 5432. This stack
deliberately avoids it. Inside the compose network the database is still reached as
`db:5432` — the 5433 remap only matters for connecting from your machine.

### Why there is a proxy in front of Postgres

The API uses `@neondatabase/serverless`, which speaks **SQL over HTTP**, because
Cloudflare Workers cannot hold a TCP socket open between requests. A stock Postgres
container only speaks TCP. The proxy bridges the two so local dev exercises the same
driver path as production.

Migrations skip the proxy — `drizzle-kit` uses a normal TCP driver and talks to `db`
directly. Same database, two paths in, by design.

`.github/workflows/ci.yml` reproduces this exact pair (a `postgres:17-alpine` service
container plus the same proxy image) so `apps/api`'s live-Postgres integration tests
run in CI instead of skipping. If you're touching that workflow: migrations there hit
the Postgres service container directly over TCP, same as `migrate` above; the
integration tests go through the proxy, same as `api` above. Mixing the two up — e.g.
pointing migrations at the proxy, or the tests at bare Postgres — is the most likely
way that job breaks.

## First time through the app

There is no seed data. Create an account:

1. Open http://localhost:5173 — you will be redirected to `/signin`
2. Click through to sign up and create an account
3. Create your organization when prompted
4. You land on an empty properties list — add one

## Checking it works

```bash
curl http://localhost:8787/health          # {"ok":true,...}
curl -I http://localhost:5173              # 200

# The 9 tables should exist
docker compose exec db psql -U rms -d rms -c '\dt'
```

Connect a GUI client to the database with:
host `localhost`, port `5433`, user `rms`, password `rms_dev_password`, database `rms`.

## Everyday commands

```bash
docker compose up -d           # background
docker compose logs -f api     # follow one service
docker compose restart api     # after changing wrangler.jsonc
docker compose down            # stop, keep data
docker compose down -v         # stop and wipe the database
```

Editing anything under `apps/web/src` or `apps/api/src` hot-reloads. No rebuild.

After changing a **dependency** (`package.json`), just restart the service:

```bash
docker compose restart web     # or api
```

`api` and `web` each run `pnpm install --frozen-lockfile` before starting, so a
package added on the host is picked up on the next restart. This exists because the
container keeps its own `node_modules` in a named volume — the host's is macOS/arm64
and would break a Linux container — so a host-side install is otherwise invisible
inside. Without it you get `Failed to resolve import "<pkg>"` only when you navigate
to the screen that needs it.

After changing the **database schema**, generate the migration on the host, then
re-run the migrate service:

```bash
pnpm --filter api db:generate
docker compose up migrate
```

## Troubleshooting

**Port already allocated** — something else holds 5173, 8787 or 5433. Find it with
`lsof -nP -iTCP:5433 -sTCP:LISTEN`, or change the left-hand number in the compose
file's `ports:` entry.

**Hot reload not firing** — the stack already sets `CHOKIDAR_USEPOLLING=true`,
because filesystem events do not cross a macOS-to-Linux bind mount. If it still
misses changes, `docker compose restart web`.

**`api` never becomes healthy** — `docker compose logs api`. Most likely the proxy
is not up; check `docker compose logs db-proxy`.

**Reset everything** — `docker compose down -v` then `docker compose up`. This wipes
the database, including any account you created.

## This is dev only

`BETTER_AUTH_SECRET` here is a hardcoded, obviously-fake value, and the database
password is `rms_dev_password`. Neither is used anywhere but this stack. Production
secrets are set with `wrangler secret put` — see [DEPLOYMENT.md](./DEPLOYMENT.md).
