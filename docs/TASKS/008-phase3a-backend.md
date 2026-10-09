# Task 008 (backend) — Phase 3a: charge generation

**Agent:** backend-dev · **Owns:** `apps/api/**` · **Contract:** FROZEN at 335e5ed

Read `docs/PLAN-PHASE3A.md` in full first. It is detailed and most of the hard
judgements are already made; where it corrects PLAN-V1, the correction is reasoned and
I have verified it against the source.

> The number the browser previews and the number in the charge row are produced by
> the same call to `buildSchedule`, through the same `billingTermsFor` adapter. There
> is no second implementation and there must never be one. If they ever disagree, the
> charge row is right and the preview is stale — never the other way round.
>
> A charge row, once written, is never updated and never deleted. The only mutation
> `charge` accepts is the void tombstone, and a correction is a superseding row.

## Fix these four defects in existing code — they are prerequisites, not cleanup

The plan found all four and I confirmed each one myself.

1. **`endLease` flips status immediately**, even when `endDate` is months away. So the
   driving scan must be `status IN ('active','ended','terminated')`, not `'active'`
   alone — otherwise a lease ended in October effective 31 December never bills
   November or December. Rent that is never charged is not a bug anyone reports.
2. **`replaceRentSteps` deletes then inserts across two awaits with no transaction.**
   Harmless until a cron reads the ladder inside that window, sees no steps, and
   freezes a charge at the pre-escalation base rent. Wrap it in `db.batch([...])`.
   **Confirm the transactional semantics against the local Neon HTTP proxy before
   relying on it** — if a batch is not atomic there, stop and report rather than
   assuming.
3. **`amount_cents` must be CHECK `>= 0`, not `> 0`.** A prorated rent can round to
   zero, and `lib/db-errors.ts` only recognises 23505 — a 23514 would surface as a 500
   on the cron at 09:00 UTC. A zero-amount *rent* charge is written; a zero deposit or
   opening balance is skipped, because that is an absence.
4. **Two call sites hand-build `LeaseBillingTerms`** to feed `validateBillingTerms`.
   Route them through `billingTermsFor` so the new date-guard rule lands with zero
   exemptions. An exemption list hollows the rule out.

## The unique index

Plain on `(lease_id, generation_key)`, **not partial**. NULLs are distinct in
Postgres, so manual charges are unconstrained for free. A partial index used as an
`ON CONFLICT` arbiter needs its predicate restated, and getting that wrong fails at
runtime on the cron while telling nobody.

It carries no `org_id`, deliberately — `lease_id` is already the PK of an org-scoped
table, so the narrower key is **stricter**. Say so in a schema comment or a reviewer
will flag it.

**No predicate on `voided_at` either.** A voided row keeps its key, so the generator
never re-creates a charge the landlord deliberately voided. A partial index is the
natural-looking "fix" that would silently resurrect it the next morning.

## What to build

Per the plan §§1, 4, 5, 6, 9: the migration, `repo/charge.ts` (orgId-first),
`repo/system/` (one cross-org SELECT that writes nothing, plus `job_run`),
`lib/charge-mapper.ts`, the cron and its health endpoint, and the routes.

Mount `portal-charges` **before** `portal`, the same footgun as `portal-leases`.
Add the health endpoint to `PUBLIC_PATHS` as an **exact string**, never a prefix.

## Tests

The conformance test (§2.4) is the one this phase exists for: drive every schedule
fixture through the real generator against live Postgres and compare to the fixture's
own unedited expectations. `generationPlanFixtures` in the contract already derives
the `today` for each — all 29 reproduce exactly, verified before you started.

Also: the system-repo guard with a deliberate-violation proof; idempotency (twice ->
`[]`); catch-up (advance 40 days -> exact backfill with correct historical due dates);
void-then-regenerate writes nothing; a correction keeps `generation_key = NULL`; the
rent-step boundary complement; `/end` with a future `endDate` bills the remaining
months; and the §9.4 attack table.

## Done when

typecheck, lint and tests pass, and the live-Postgres run has nothing skipped.
