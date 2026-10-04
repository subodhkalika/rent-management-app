#!/bin/sh
# Entrypoint for the `migrate` service in docker-compose.yml only. Not used by
# CI or production — `.github/workflows/deploy.yml` runs
# `pnpm --filter api run db:migrate` directly on the runner, never through this
# script.
set -e

cd /workspace/apps/api

# drizzle-kit auto-detects a Postgres driver by walking node_modules for the
# first of 'pg', 'postgres', '@vercel/postgres', '@neondatabase/serverless' it
# can resolve (see drizzle-kit/bin.cjs), then dynamically imports
# 'drizzle-orm/node-postgres', which itself imports 'pg'. Neither drizzle-kit
# nor drizzle-orm's node-postgres driver are dependencies of apps/api — they
# live in their own directories deep in pnpm's content-addressable store —
# so apps/api declaring `pg` would not even make it visible to them; pnpm's
# whole point is that isolation, each package only resolves what it actually
# depends on. Left alone, drizzle-kit falls through to
# '@neondatabase/serverless' — the Worker runtime's driver, which only knows
# how to reach a *remote* Neon/Vercel/Supabase endpoint over a websocket, and
# hangs when pointed at our plain-TCP `db` container instead.
#
# Fix: install `pg` into an isolated scratch package (so npm never sees
# apps/api's `workspace:*` dependency on @rms/contract, which it can't parse),
# then place it directly under /workspace/node_modules — the one node_modules
# directory that is an ancestor of every pnpm store path, so Node's
# directory-walk module resolution finds it from anywhere in the workspace,
# including both of the above. No pnpm involved, nothing added to
# package.json or pnpm-lock.yaml — this only touches a Docker-only named
# volume, never package.json, the lockfile, or anything CI/production
# migrations read.
if [ ! -e /workspace/node_modules/pg ]; then
  work="$(mktemp -d)"
  echo '{}' > "$work/package.json"
  (cd "$work" && npm install pg --no-fund --no-audit --silent)
  cp -r "$work"/node_modules/* /workspace/node_modules/
  rm -rf "$work"
fi

exec pnpm run db:migrate
