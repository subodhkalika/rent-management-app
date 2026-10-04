# Task 001 (backend) — Properties & Units CRUD

**Agent:** backend-dev · **Owns:** `apps/api/**` · **Contract:** FROZEN

## Goal

Implement the API for managing properties and the units inside them. This is the root
of the data model — leases, tenants and payments all hang off a unit — so get the
isolation and the shape right.

## Contract (already written, do not edit)

- `packages/contract/src/property.ts` — `createPropertyBody`, `updatePropertyBody`, `property`
- `packages/contract/src/unit.ts` — `createUnitBody`, `updateUnitBody`, `unit`
- `packages/contract/src/routes.ts` — the exact paths
- `packages/contract/src/common.ts` — `uuidv7()`, `apiError`, `paged()`, `pageQuery`

## Routes to build

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/properties` | Paginated via `pageQuery`. Returns `paged(property)`. |
| POST | `/v1/properties` | 201 + the created property |
| GET | `/v1/properties/:id` | 404 if absent **or** another org's |
| PATCH | `/v1/properties/:id` | Partial update |
| DELETE | `/v1/properties/:id` | Soft delete (set `deletedAt`) |
| GET | `/v1/properties/:propertyId/units` | Units of one property |
| POST | `/v1/properties/:propertyId/units` | 201 + the created unit |
| GET | `/v1/units/:id` | |
| PATCH | `/v1/units/:id` | |
| DELETE | `/v1/units/:id` | Soft delete |

All routes sit behind `requireAuth`.

## Requirements

- Repo functions in `apps/api/src/db/repo/property.ts` and `unit.ts`. First param
  `orgId`, always in the WHERE clause. `src/db/repo/tenancy.guard.test.ts` enforces
  this — run it.
- Soft-deleted rows (`deletedAt IS NOT NULL`) must never appear in any read.
- `property.unitCount` / `occupiedUnitCount` are computed, not stored. Use a single
  aggregate query — do not N+1 across properties.
- Map DB rows to contract types explicitly in `src/routes/*.ts` or a `mappers.ts`.
  Never spread a DB row into a response.
- Creating a unit whose `label` already exists in that property is a `409 conflict`,
  not a 500 from the unique index.
- Generate the migration: `pnpm --filter api db:generate`. Commit the SQL.
- Mount the routers in `src/index.ts` where the placeholder comment is.

## Tests

- The tenancy guard passes.
- Unit-test the mappers and any date/money conversion.
- Unit-test that `listProperties` and `listUnits` exclude soft-deleted rows.
- You have no database in CI. Do not write tests that need a live connection — test
  the pure logic (mappers, pagination cursor encode/decode, validation) and rely on
  the guard for isolation.

## Done when

`pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test` pass.
