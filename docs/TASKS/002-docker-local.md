# Task 002 — One-command local stack in Docker

**Goal:** `docker compose up` brings up the database, the API and the web app, with
hot reload, and nothing else installed on the host.

## Why this is not just "add a Dockerfile"

The API talks to Postgres through `@neondatabase/serverless`, which speaks **HTTP**,
not TCP — Cloudflare Workers cannot hold a socket open between requests. A stock
`postgres` container speaks TCP only. So the stack needs a **Neon HTTP proxy**
sidecar in front of Postgres, and the API must point its fetch endpoint at it when
running locally.

Keep production untouched: on Workers the driver must still talk to real Neon over
its default endpoint. The local override is a dev-only branch keyed off an env var.

## Services

| Service | What it is | Notes |
|---|---|---|
| `db` | `postgres:17-alpine` | Host port **5433** — the user already runs their own Postgres on 5432. Must not clash. |
| `db-proxy` | Neon HTTP proxy | Fronts `db`, speaks the HTTP protocol `@neondatabase/serverless` expects |
| `migrate` | one-shot | Runs `drizzle-kit migrate` and exits 0. `api` waits for it to complete. Connects to `db` over plain TCP — drizzle-kit uses a normal pg driver, not the HTTP one. |
| `api` | `wrangler dev` | Bind `--ip 0.0.0.0 --port 8787`. Must run fully offline — no Cloudflare login. |
| `web` | `vite dev` | Bind `--host 0.0.0.0 --port 5173`. Proxies `/v1` and `/api/auth` to `api`. |

## Requirements

- **One command.** `docker compose up` from the repo root, on a clean machine with
  only Docker installed. No prior `pnpm install` on the host.
- **Hot reload both apps.** Bind-mount the source; keep `node_modules` inside the
  container (named volume or anonymous mount) so the host's platform-specific
  binaries never leak in. `workerd` and `esbuild` are native — a macOS host
  `node_modules` will break a Linux container.
- **Correct startup order.** `db` healthy → `migrate` completes → `api` up → `web` up.
  Use `depends_on` with `condition: service_healthy` / `service_completed_successfully`,
  not a sleep.
- **Ports on the host:** web 5173, api 8787, db 5433. Nothing else exposed.
- **No secrets committed.** Generate or default `BETTER_AUTH_SECRET` for local dev
  only, with an obvious dev-only value. Document that it is not for production.
- **Teardown must be clean.** `docker compose down -v` returns to zero.
- Add `.dockerignore` so build context excludes `node_modules`, `dist`, `.git`,
  `.wrangler`.

## Out of scope

Production deployment is unchanged — this touches nothing in `.github/workflows/`
except documentation. Do not alter how the Worker reaches real Neon in production.

## Done when

- `docker compose up` on a clean checkout serves the web app on :5173
- The API answers `GET http://localhost:8787/health` with `{"ok":true}`
- Migrations have run: the 9 tables exist in the container's database
- Editing a file in `apps/web/src` or `apps/api/src` hot-reloads without a rebuild
- `docs/DOCKER.md` explains the commands, the ports, and how to reset
