# Architecture — Rent Management SaaS

> **This file is the shared brain.** Every agent starts with an empty context window.
> If a decision is not written here or in `packages/contract/`, the agent does not know it.
> Read this file in full before writing code.

## 1. What this is

Multi-landlord rent management SaaS. Each landlord is an **organization** with fully
isolated data. Landlords manage properties, units, tenants, leases, payments and
maintenance requests. Tenants may later get a limited portal login.

## 2. Stack (all free tier, commercial use permitted)

| Layer | Choice | Why |
|---|---|---|
| Web | Vite + React 19 + TS + Tailwind + shadcn/ui | No vendor lock, static output |
| API | Hono on Cloudflare Workers | 100k req/day free, no cold-sleep, commercial OK |
| DB | Neon Postgres + Drizzle ORM | 0.5 GB free, HTTP driver works on Workers |
| Auth | Better Auth + `organization` plugin | Multi-tenancy built in, self-hosted |
| Files | Cloudflare R2 | 10 GB free, zero egress |
| Email | Resend | 3,000/month free |
| CI/CD | GitHub Actions | Free (2,000 min/mo private) |

**Hard constraint:** Workers run on the edge runtime. No Node built-ins (`fs`, `net`,
`crypto` as Node module), no TCP database drivers. Use `@neondatabase/serverless`
(HTTP) and Web Crypto only.

## 3. Repo layout

```
apps/
  web/        Vite React SPA        -> Cloudflare Pages    [frontend-dev owns]
  api/        Hono API              -> Cloudflare Workers  [backend-dev owns]
packages/
  contract/   Zod schemas + types   -> THE CONTRACT        [orchestrator owns]
docs/
  ARCHITECTURE.md   this file
  TASKS/            one md file per in-flight task
```

### Ownership rules — do not cross these lines

- `frontend-dev` edits **only** `apps/web/**`.
- `backend-dev` edits **only** `apps/api/**`.
- **Neither agent edits `packages/contract/**`.** It is frozen for the duration of a
  task. If the contract is wrong, STOP and report it upward — do not patch around it.
- `devops` edits only `.github/**`, `wrangler.jsonc`, deploy config.

This is what lets frontend and backend run in parallel without clobbering each other.

## 4. The contract

`packages/contract` is the single source of truth shared by both apps. It exports:

- **Zod schemas** for every request body and response payload
- **TypeScript types** inferred from those schemas (`z.infer`)
- **Route descriptors** — path, method, request schema, response schema

The API validates every input against the contract schema. The web app imports the
same schema for form validation. One definition, both ends. If they drift, the build
breaks — which is the point.

The Drizzle table definitions live in `apps/api/src/db/schema.ts` and are **not** the
contract. API responses are explicitly mapped from DB rows to contract types, so an
internal column rename never leaks to the client.

## 5. Multi-tenancy — the rule that matters most

Every org-owned table carries a non-null `org_id`. **A missing `org_id` filter is a
data breach, not a bug.**

Enforcement is layered:

1. **Auth middleware** resolves the caller's `orgId` from the session and puts it on
   the Hono context. Routes never read `orgId` from the request body or query string —
   a client could forge it.
2. **All DB access for org-owned tables goes through `apps/api/src/db/repo/*.ts`.**
   Every repo function takes `orgId` as its first argument and includes it in the
   `WHERE` clause of every read, update and delete.
3. **Route handlers never import `db` directly.** They call repo functions.
4. The `reviewer` agent treats any violation of 1-3 as a blocking finding.

```ts
// correct
export async function listUnits(orgId: string, propertyId: string) {
  return db.select().from(units)
    .where(and(eq(units.orgId, orgId), eq(units.propertyId, propertyId)));
}

// WRONG — missing orgId, leaks every landlord's data
export async function listUnits(propertyId: string) {
  return db.select().from(units).where(eq(units.propertyId, propertyId));
}
```

We use app-level scoping rather than Postgres RLS: the Neon HTTP driver is stateless,
so per-connection session variables (which RLS needs) are unreliable here.

## 6. Data model

```
organization 1---n property 1---n unit 1---n lease n---1 tenant
                                        lease 1---n payment
                                        unit  1---n maintenance_request
                                        *     1---n document (R2)
```

- **property** — an address. Has one or more units.
- **unit** — the rentable thing. A single-family house is a property with one unit.
- **tenant** — a person. May hold leases over time; not tied to one unit.
- **lease** — unit + tenant(s), date range, rent amount, due day, deposit, status.
- **payment** — money received against a lease. Never edited, only superseded.
- **maintenance_request** — raised against a unit, has status and priority.

Money is stored as **integer minor units** (cents) in a `bigint`. Never float.
Dates with no time component use `date`; timestamps use `timestamptz`.

## 7. Conventions

- **Errors** — API returns `{ error: { code, message, details? } }` with a correct
  HTTP status. Codes are a union in the contract, never free-form strings.
- **IDs** — UUID v7 (`crypto.randomUUID()` is v4; use the `uuidv7` helper in contract).
- **Naming** — `snake_case` in Postgres, `camelCase` in TS. Drizzle maps between them.
- **Tests** — Vitest both sides. Every repo function gets a test proving it filters by
  `orgId`. Every form gets a test for its validation failure path.
- **No secrets in the repo.** Local dev uses `.dev.vars` (gitignored); CI and prod use
  GitHub Secrets and Wrangler secrets.

## 8. Definition of done

A task is done when all of these hold:

- [ ] `pnpm typecheck` passes at the repo root
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes, including a cross-org isolation test for new repo functions
- [ ] No `org_id`-less query on an org-owned table
- [ ] Contract unchanged, or the change was requested upward and approved
- [ ] Loading, empty and error states exist for every new screen
