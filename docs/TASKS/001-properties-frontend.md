# Task 001 (frontend) — Properties & Units UI

**Agent:** frontend-dev · **Owns:** `apps/web/**` · **Contract:** FROZEN

## Goal

Screens for a landlord to manage their properties and the units inside them.

**Build against the contract, not a running server.** The backend agent is writing
those endpoints in parallel right now. The types are the agreement; a 404 while you
work is expected.

## Contract (already written, do not edit)

- `packages/contract/src/property.ts` — schemas, `propertyTypeLabels`, `formatAddress`
- `packages/contract/src/unit.ts` — schemas, `unitStatusLabels`
- `packages/contract/src/routes.ts` — build every URL from here, never a literal
- `packages/contract/src/common.ts` — `formatMoney`

## Screens

1. **`/properties`** — list. Each row: name, formatted address, type, `3 of 4 occupied`.
   Click through to detail. Primary action: Add property.
2. **`/properties/:id`** — detail. Property header with edit and delete. Below it, the
   units table: label, beds/baths, sq ft, market rent, status badge. Primary action:
   Add unit.
3. **Add/edit property** — dialog. Fields per `createPropertyBody`.
4. **Add/edit unit** — dialog. Fields per `createUnitBody`.
5. **Delete** — confirm dialog. Say what is being deleted by name.

## Requirements

- `src/features/properties/` and `src/features/units/`. Co-locate hooks, components
  and tests with the feature.
- Data access through `src/lib/api.ts` + TanStack Query. No bare `fetch`.
- Forms: react-hook-form + `zodResolver` with the **contract schema**. Do not write a
  second validation schema.
- **Money is cents in the API, currency in the UI.** The rent input accepts `1,850.00`
  and sends `185000`. Get this conversion right and unit-test it — a float round-trip
  bug here silently corrupts rent amounts.
- Server validation errors come back as `ApiClientError.details` keyed by field name.
  Map them onto the matching form fields with `setError`, do not just toast them.
- Every screen gets its loading skeleton, empty state and error state.
- Add shadcn components as needed:
  `pnpm --filter web dlx shadcn@latest add button table dialog form input select badge skeleton sonner alert-dialog`

## Tests

- Rent input ↔ cents conversion, including `0`, a value with no decimals, and one with
  a thousands separator.
- The property form shows a validation error on an empty required field.
- The list renders its empty state when the API returns no items.

## Done when

`pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test` pass.
