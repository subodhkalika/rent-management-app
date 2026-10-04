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

## Getting started

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill in DATABASE_URL etc.
pnpm dev                                            # web :5173, api :8787
```

`pnpm check` runs typecheck, lint and tests across the workspace.

## How work gets done here

Agents have no shared memory, so the repo is their only common context:

1. **Plan** — `architect` proposes the data model, API surface and task split.
2. **Freeze the contract** — `packages/contract` is updated and committed. Neither
   dev agent may change it mid-task.
3. **Build in parallel** — `backend-dev` in `apps/api`, `frontend-dev` in `apps/web`,
   in separate git worktrees. Neither crosses into the other's directory.
4. **Review** — `reviewer` reads the merged diff, tenant isolation first.
5. **Ship** — `devops` only if CI, deploy or environment changed.

See `docs/ARCHITECTURE.md` for the rules agents must follow, especially section 5
on tenant isolation.
