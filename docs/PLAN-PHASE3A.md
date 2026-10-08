# Phase 3a — Charge generation

> **Scope.** The `charge` table, the generator that materialises it, the scheduled job
> that runs it, and the landlord + tenant views of charges. **No payments, no FIFO
> allocation, no balances, no arrears** — those are 3b. §11 states exactly what 3a
> leaves in place for 3b and what is deliberately deferred.
>
> Corrects `docs/PLAN-V1.md` §3 (the charge table draft) and §3.5 (the API surface)
> where Phase 2 and the escalation revision changed the ground under them.

## 0. The ten decisions

| # | Decision | Why, in one sentence |
|---|---|---|
| 1 | **A charge row stores the whole of `PlannedCharge`**, not a subset. | The byte-identity test is then a projection, not a re-derivation — and a row that explains its own number is what a landlord needs when a tenant argues about proration. |
| 2 | **`charge_generation_uq` is a PLAIN unique index on `(lease_id, generation_key)`**, not partial. | Postgres treats NULLs as distinct, so manual charges (key `NULL`) are unconstrained for free, and `ON CONFLICT` needs no `targetWhere` — removing the single most likely implementation bug. |
| 3 | **The line is "has a row" vs "has no row"**, not "already due" vs "not yet due". | A charge written by the 31-day lookahead is exactly as frozen as one from last year; `ON CONFLICT DO NOTHING` already encodes this and no other rule can be made consistent with it. |
| 4 | **A charge has no mutable field at all.** Not even `description`. | A description is what the tenant sees on their statement; changing it changes the document. Tighter than `payment.note`, deliberately. |
| 5 | **The driving scan is `status IN ('active','ended','terminated')`**, not `'active'` alone. | A lease ended with a future `endDate` would otherwise silently never bill its last two months — the invisible under-charge PLAN-PHASE2 §9 names as the worst failure mode. |
| 6 | **`POST /charges/generate` takes no `through`.** | If a caller chooses the horizon, the row set stops being a function of (terms, today) and the manual kick can write further ahead than the cron. |
| 7 | **A correction is always `source='manual'`, `generation_key=NULL`.** | Otherwise it collides with the voided original's key — this is the rule that lets correction and idempotency coexist. |
| 8 | **No `chargeStatus` enum ships in 3a.** | Any 3a enum would have to be widened by 3b with `paid`/`partially_paid`; the 3a derivation is two comparisons the client already has the inputs for. |
| 9 | **The "charges need review" banner is a CLIENT-SIDE diff** between written rows and the current `buildSchedule` output. | No Phase 2 response shape changes, and the banner stays correct after any later edit instead of being a transient computed once at correction time. |
| 10 | **`activate` and `end` run the generator synchronously**, in addition to the cron. | A landlord who activates a lease expects the deposit and first rent charge on screen now, not tomorrow — and the generator being idempotent makes the extra run free. |

---

## 1. The charge table

### 1.1 Enums

```ts
export const chargeTypeEnum = pgEnum('charge_type', [
  'rent', 'deposit', 'opening_balance', 'late_fee', 'utility', 'other',
]);
export const chargeSourceEnum = pgEnum('charge_source', ['generated', 'manual']);
export const jobRunStatusEnum = pgEnum('job_run_status', ['running', 'ok', 'failed']);
```

All six charge types ship now even though 3a's generator only ever writes `rent`,
`deposit` and `opening_balance`. `ALTER TYPE … ADD VALUE` is awkward enough that
defining the full vocabulary once is cheaper than three migrations.

### 1.2 `charge`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `uuidv7()` |
| `org_id` | `text` NOT NULL FK → organization, **cascade** | |
| `lease_id` | `uuid` NOT NULL FK → lease, **`on delete restrict`** | **[CORRECTION]** PLAN-V1 did not name the action. Restrict, matching `lease_rent_step_correction`: a charge is a permanent financial record and must outlive any lease-deletion path. It is also what turns a mistaken `hardDeleteLease` into a constraint error rather than data loss. |
| `type` | `charge_type` NOT NULL | |
| `period_start` | `date` NULL | NULL for `deposit`, `opening_balance` and every manual non-periodic charge |
| `period_end` | `date` NULL | |
| `period_index` | `integer` NULL | **NEW.** `PlannedCharge.periodIndex` — anchored to the lease's first natural period, not an array index (pins fixture F9's `9`) |
| `occupied_start` | `date` NULL | **NEW.** The clipped window the amount was computed over |
| `occupied_end` | `date` NULL | **NEW.** |
| `days_occupied` | `integer` NULL | **NEW.** |
| `days_in_period` | `integer` NULL | **NEW.** |
| `due_date` | `date` NOT NULL | already clamped by `dueDateFor`; never day 31 in February |
| `amount_cents` | `bigint` NOT NULL | **CHECK `>= 0`, not `> 0`** — see §1.5 |
| `currency` | `text` NOT NULL | copied from `lease.currency` at write; immutable |
| `description` | `text` NULL | |
| `is_prorated` | `boolean` NOT NULL default false | |
| `source` | `charge_source` NOT NULL | |
| `generation_key` | `text` NULL | `'YYYY-MM-DD'` (the period start), `'deposit'`, or `'opening'`. **NULL for every manual charge, including every correction.** |
| `supersedes_charge_id` | `uuid` NULL FK → charge | correction chain |
| `voided_at` | `timestamptz` NULL | the only mutation this table ever accepts |
| `voided_reason` | `text` NULL | 10..500 chars, enforced by the contract |
| `voided_by_user_id` | `text` NULL FK → user | |
| `created_by_user_id` | `text` NULL FK → user | **NULL means the generator wrote it** — that is the audit signal, not a separate column |
| `created_at` | `timestamptz` NOT NULL default now | |

No `updated_at`. A table with no mutable field must not have one; its presence
would be an invitation.

**Not denormalised, deliberately:** `chain_id`, `unit_id`, `property_id`. Every
charge query already joins `lease` for `currency`/`status`, and at tens of units a
join is free. A denormalised `chain_id` would need a backfill the first time a lease
is re-chained.

### 1.3 Indexes

```ts
// THE CRON'S IDEMPOTENCY KEY. Plain, NOT partial — see §1.4.
uniqueIndex('charge_generation_uq').on(t.leaseId, t.generationKey),

// The ledger page, and 3b's FIFO ordering, which sorts by (due_date, id) exactly.
index('charge_lease_due_idx').on(t.orgId, t.leaseId, t.dueDate, t.id),

// "What is due / overdue across my portfolio this month" — the /v1/charges page.
index('charge_org_due_idx').on(t.orgId, t.dueDate).where(sql`${t.voidedAt} is null`),
```

`charge_generation_uq` carries **no `org_id`**, for the same reason
`lease_unit_active_uq` and `lease_rent_step_uq` do not: `lease_id` is already the
PK of an org-scoped table, so adding `org_id` would widen the key without changing
uniqueness. The one-column-narrower form is **stricter**, not a tenancy miss. Write
that in the schema comment — a reviewer will otherwise flag it.

**Deliberately not added yet:**
- `charge_due_idx on (due_date) where voided_at is null` — the cross-org reminder
  scan. Phase 4 owns it; 3a queries nothing that way.
- Any new index on `lease` for the cron's driving scan. PLAN-PHASE2 §3.6 already
  weighed and rejected this; tens of landlords, one sequential scan per day.

### 1.4 Why the unique index is plain, not partial

PLAN-V1 §3 drafted it as `unique (lease_id, generation_key) where generation_key is
not null`. **Drop the predicate.** Postgres treats NULLs as distinct in a unique
index by default (`NULLS DISTINCT`, and we never set `NULLS NOT DISTINCT`), so a
plain index already permits unlimited manual rows with a NULL key while enforcing
uniqueness on every non-NULL one. It is the same constraint with a smaller surface.

The reason this matters is not elegance. To use a **partial** unique index as an
`ON CONFLICT` arbiter, Postgres requires the predicate to be restated in the
statement (`ON CONFLICT (lease_id, generation_key) WHERE generation_key IS NOT NULL`,
i.e. Drizzle's `targetWhere`). Omit it and the insert fails at runtime with
*"there is no unique or exclusion constraint matching the ON CONFLICT
specification"* — on the cron, at 09:00 UTC, writing nothing and telling nobody.
A plain index cannot be got wrong this way. **Put the NULL-distinctness reasoning in
the schema comment so a future reader does not "fix" it back into a partial index.**

### 1.5 `amount_cents >= 0`, not `> 0`

PLAN-V1 §3 says `> 0`. That is wrong and it would 500 the cron.

- `plannedCharge.amountCents` is `z.number().int().nonnegative()`.
- `lease.rent_cents` is `money`, which is `.nonnegative()` — a zero-rent caretaker
  or family lease is representable and `lease_money_ck` already permits it.
- `prorate(rentCents, 1, 31)` on a small rent rounds to `0`.

`buildSchedule` can therefore legitimately emit `amountCents: 0`, and a `> 0` CHECK
turns that into an unhandled SQLSTATE 23514 — which `lib/db-errors.ts` does not
recognise (it only knows 23505), so it surfaces as a 500. Use `>= 0`.

The generator still skips a **zero-amount deposit or opening balance** (§8),
because those are absences rather than obligations. A zero-amount *rent* charge is
written, because the period genuinely exists and the ledger must show it.

### 1.6 `job_run` — the one table with no `org_id`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `job` | `text` NOT NULL | `'daily'` today |
| `started_at` | `timestamptz` NOT NULL | |
| `finished_at` | `timestamptz` NULL | NULL = still running, or the Worker died |
| `status` | `job_run_status` NOT NULL | `running \| ok \| failed` |
| `stats` | `jsonb` NOT NULL default `'{}'` | `{ leasesScanned, chargesWritten, leasesFailed, errors: [...] }` |
| `error` | `text` NULL | |

Index: `job_run_job_started_idx on (job, started_at desc)` — the health endpoint's
only query, `LIMIT 1`.

**This table has no `org_id` and that is correct**: it describes the system, not a
tenant. Say so in a schema comment in the same words PLAN-V1 §4.5 uses, so the
reviewer's tenancy check reads it as a sanctioned exception rather than a miss.
`stats` is `jsonb` precisely so Phase 4's reminder counters need no migration.

### 1.7 Migration

One migration, `pnpm --filter api db:generate`. Entirely additive: three new enums,
two new empty tables, three new indexes. **No backfill, no multi-step, no change to
any existing table.** The widened rent-step guard (§3.4) and the `db.batch` fix
(§4.5) are code changes, not schema changes.

---

## 2. Byte-identity: how it is enforced, not hoped for

> *The number the tenant saw in the browser is the number they get billed.*

Four layers. Each one is a mechanism, not a convention.

### 2.1 Layer 1 — one function, called once

The generator's only arithmetic is a single call:

```ts
const planned = chargesDueForGeneration(terms, today);   // === buildSchedule(terms, generationHorizon(today))
```

`chargesDueForGeneration` already exists in `packages/contract/src/billing.ts` and
is already pinned by `generationFixtures` (F11, F12). **`apps/api` must contain no
other way to arrive at an amount or a due date.** The existing
`no-date-arithmetic.guard.test.ts` already enforces most of this; add one rule to it:

> **Rule 6.** `buildSchedule` may be called from `lib/schedule.ts` only. Everything
> else — routes, repo functions, jobs — calls `buildScheduleOrThrow` or
> `chargesDueForGeneration`. Grep: `buildSchedule(` outside `lib/schedule.ts` is a
> violation.

### 2.2 Layer 2 — one way to build the terms

`terms` comes from `billingTermsFor(...)` (`packages/contract/src/lease.ts`) and
nowhere else. It is already the one sanctioned adapter: `routes/leases.ts` and
`routes/portal-leases.ts` both use it, and the browser's preview
(`apps/web/src/features/leases/schedule-preview.ts`) uses it too.

The generator must call it with a row carrying **live** `moveOutBillingPolicy` and
`calendar` from `property` (Amendment A.3 — there is no column for either on
`lease`) and the **stored** ladder from `lease_rent_step`. That is exactly the shape
`repo/lease.ts`'s `LeaseRow` + `toRentSteps(...)` already produce, so the cron's
driving SELECT reuses the same column map.

**Add a second rule to the date guard:**

> **Rule 7.** No file in `apps/api/src` may construct an object literal satisfying
> `LeaseBillingTerms` other than `billingTermsFor`. Grep: a literal containing both
> `moveOutBillingPolicy:` and `rentSteps:`. *Two existing call sites violate this
> today* — `updateLease` and `replaceRentSteps` in `repo/lease.ts` hand-build a terms
> object to feed `validateBillingTerms`. Those are validation, not scheduling, and
> they must be refactored to `billingTermsFor` as part of 3a so the rule can be
> switched on with zero exemptions. An exemption list here would hollow out the rule.

### 2.3 Layer 3 — the mapping is a total projection

Two pure functions, no computation in either:

```ts
// apps/api/src/lib/charge-mapper.ts
plannedChargeToInsert(orgId, lease, planned: PlannedCharge): typeof charge.$inferInsert

// packages/contract/src/charge.ts  — in the CONTRACT, because the browser needs it too
plannedChargeFromCharge(c: Charge): PlannedCharge
```

Every one of `PlannedCharge`'s eleven fields lands in its own column and comes back
out of it. Nothing is derived on either side. Two tests:

1. **Round-trip** (pure, no DB): for every `scheduleFixtures` entry, every
   `expected` element satisfies
   `plannedChargeFromCharge(asCharge(plannedChargeToInsert(…, p))) === p`.
2. **Exhaustiveness**: the contract exports
   `PLANNED_CHARGE_KEYS: readonly (keyof PlannedCharge)[]`, and a test asserts
   `Object.keys(fixture.expected[0]).sort() === [...PLANNED_CHARGE_KEYS].sort()`
   **and** that `plannedChargeToInsert` reads every one of those keys. Adding a
   twelfth field to `PlannedCharge` then fails the build until a column exists for
   it — which is the only durable defence against a silently-dropped field.

### 2.4 Layer 4 — the conformance test (the one the phase exists for)

`apps/api/src/jobs/charge-conformance.integration.test.ts`, against live Postgres.

```
for each fixture in [...scheduleFixtures, ...bsScheduleFixtures]:
    seed org, property (timezone, calendar, moveOutBillingPolicy from the fixture),
         unit, tenant, lease (every billing column from fixture.terms),
         lease_rent_step rows from fixture.terms.rentSteps
    activate the lease
    today := addDays(fixture.through, -GENERATION_LOOKAHEAD_DAYS)   // 31
    run generateChargesForLease(orgId, db, leaseRow, steps, today)
    rows := SELECT * FROM charge
            WHERE org_id = … AND lease_id = … AND type = 'rent' AND source = 'generated'
            ORDER BY period_start
    expect(rows.map(plannedChargeFromCharge)).toEqual(fixture.expected)
```

Three things make this a real test rather than a restatement:

- **`today` is derived from the fixture**, not hand-chosen.
  `chargesDueForGeneration(terms, addDays(through, -31))` is by construction
  `buildSchedule(terms, through)`, so the expected array is the fixture's own
  `expected`, unedited. This simultaneously pins the horizon rule.
- **It goes through Postgres.** A `date` column that round-trips as a `Date` object,
  a `bigint` that comes back as a string, a timezone-shifted `date` — every one of
  those is a real way the number in the row stops being the number in the preview,
  and none of them is visible to a pure unit test.
- **It fails if a fixture changes.** The fixtures are the contract's; if someone
  re-baselines `expected`, this test and the browser's preview test fail together.
  Keep the escalation plan's CI check that **no `expected:` line in
  `billing.fixtures.ts` or `billing.bs.fixtures.ts` may change** in a PR that is not
  explicitly a re-baseline.

### 2.5 What this does NOT prove, stated plainly

It proves the generator writes what `buildSchedule` says **for the terms it read**.
It cannot prove the terms it read are the terms the landlord last saved — that is
§4.4's race, and the answer there is "the written row wins, and the drift banner
(§3.6) makes the disagreement visible", not "the write is retried".

---

## 3. Charges when the lease changes

### 3.1 The line, stated once

PLAN-V1 draws it as *"a charge already billed is money; a charge not yet due may be
regenerable."* **That line is wrong and cannot be made consistent.** The generator
writes 31 days ahead, so "not yet due" includes rows that already exist, and
`ON CONFLICT DO NOTHING` has no way to distinguish them.

The correct line, and the only one the mechanism can enforce:

> **A charge row, once written, is never updated and never deleted by any code path.
> The generator has exactly one verb: `INSERT … ON CONFLICT DO NOTHING`. The only
> mutation `charge` ever accepts is the void tombstone, set by an explicit landlord
> action carrying a reason.**
>
> **"Regenerable" therefore never means "rewritten". It means: a period with no row
> yet will be generated under the terms in force when it is generated. The moment a
> row exists for `(lease_id, generation_key)`, that period's terms are frozen
> forever.**

So the question is never "is this money yet?" — it is **"is there a row?"**. That is
decidable with a unique index, which is why it is the rule.

### 3.2 The table

| Event | Rows that exist | Rows that do not exist yet |
|---|---|---|
| `PATCH /leases/:id` — `billingDay`, `notes`, `endDate` extended | **Untouched.** | Next generation uses the new terms. A `billingDay` change moves future due dates only. |
| `PATCH` — `moveOutDate` set/corrected, property on `stop_at_move_out` | **Untouched**, including the final period if it is already written. | The schedule shortens; periods past `effectiveBillingEnd` are never generated. |
| `PATCH` — `moveOutDate` under `bill_full_term` | Untouched. | Nothing changes — I14 says output is independent of `moveOutDate` under this policy. |
| Property flips `move_out_billing_policy` or `calendar` | Untouched. | Next run. A flip to `bill_full_term` grows a stopped schedule back, self-healing by construction. |
| `POST /leases/:id/activate` | none exist | Generator runs **synchronously**: deposit, opening balance, and every period from `ledger_start_date` to the horizon. |
| `POST /leases/:id/end` (early, or with a future `endDate`) | Untouched. | Generator runs **synchronously** after the status write, so the final prorated charge is on screen immediately. Periods past `effectiveBillingEnd` are never generated. **The lease stays in the cron's scan** (§0 decision 5), so a future `endDate` still bills its remaining months. |
| `POST /leases/:id/cancel` | none by precondition — `cancel` is draft-only and a draft never generates | Never generated: `draft` and `cancelled` are outside the driving scan. |
| `DELETE /leases/:id` | **409 if any charge row exists**, voided or not. | — |
| `POST /leases/:id/renew` | Predecessor's charges untouched; they were written under the predecessor's rent and stay valid forever. | The successor is a separate lease and generates its own, from its own `start_date`. |
| `POST /rent-steps/:stepId/correct` (a step already in force) | **Untouched — never silently re-priced.** The drift banner (§3.6) surfaces them. | Re-priced on the next run, because `rentForPeriodStart` is a lookup over the stored steps. |
| `PUT /rent-steps` | Refused outright if it would touch a charged period (§3.4). | Free. |
| Tenant added / removed (`lease_tenant`) | Untouched. | Unaffected — liability is joint and several, so the charge is against the lease, never a tenant. |

### 3.3 `/end` and the cron's driving scan — the under-billing bug this closes

PLAN-V1 §4.5's pseudocode scans `where status = 'active'`. That silently under-bills
in a case that is not exotic: a landlord on 8 October ends a lease effective
31 December. The state machine has no "pending end" state, so `status` becomes
`ended` immediately — and under an `active`-only scan, November and December rent is
**never written**. Nobody notices rent that was never charged (PLAN-PHASE2 §9's own
words).

**Fix: the driving scan is**

```sql
SELECT … FROM lease
JOIN unit ON …  JOIN property ON …
WHERE lease.status IN ('active','ended','terminated')
  AND lease.deleted_at IS NULL
```

The schedule's own upper bound (`effectiveBillingEnd`) terminates generation; the
lease status does not have to. For a lease that ended two years ago,
`buildSchedule` returns the same finite set on every run and every row already
exists, so the insert writes zero. Correct, and free.

Excluded: `draft` (never billed anything) and `cancelled` (never will).

**No date floor on the scan.** It would be date arithmetic in SQL — the thing
`docs/DATES.md` exists to prevent — to save a sequential scan over a few thousand
rows. If it ever matters, the fix is a `lease_id > cursor` loop, not an interval
predicate.

### 3.4 Widening the rent-step mutability boundary

The escalation plan §6.5 item 3 already flags this and 3a must land it.

`validateStepReplacement` (`repo/lease.ts`) currently refuses any step with
`effective_from <= today`. Charges are written up to 31 days ahead, so a step 20 days
out is **already inside a written period** and editing it would make the ladder and
the charge disagree with nothing to say so.

**Change:** both `validateStepReplacement` and `correctRentStep` take a single shared
`boundary` instead of `today`:

```ts
// repo/charge.ts
export async function rentStepMutabilityBoundary(
  orgId: string, db: Database, leaseId: string, today: IsoDate,
): Promise<IsoDate> {
  const latest = await latestChargedPeriodStart(orgId, db, leaseId); // MAX(period_start) over
                                                                     // generated, non-voided rent charges
  return latest === null ? today : maxIsoDate(today, latest);
}
```

- `PUT /rent-steps` refuses any step at or before `boundary` → *"This increase is
  already billed. Use Correct, and tell us why."*
- `POST /rent-steps/:stepId/correct` refuses any step **after** `boundary` → *"This
  increase has not been billed yet — edit it directly."*

Using one boundary in both is what guarantees **exactly one of the two routes accepts
any given step**. Two independently-computed thresholds would leave a gap in which
neither route works — a landlord who cannot change a number at all is a support
ticket, and a silent mis-bill if someone later "fixes" it by loosening one side.

`maxIsoDate` comes from the contract. No local date arithmetic.

### 3.5 `hardDeleteLease` gains a zero-charge precondition

Today it blocks on *"has been active"*. Two reasons that is not enough once money
exists:

1. `charge.lease_id` is `ON DELETE RESTRICT`, so a lease with charges fails at the
   database with SQLSTATE 23503 — which `lib/db-errors.ts` does not recognise, so it
   surfaces as a 500 instead of the existing clean 409.
2. Manual charges are the only way a `draft` lease could acquire one. 3a therefore
   **refuses `POST /leases/:id/charges` on a `draft` or `cancelled` lease** (409), so
   the invariant holds by construction — and the explicit check stays anyway, because
   an invariant defended in only one place is one refactor from being defended in
   none.

### 3.6 The drift banner — the replacement for a server-computed "affected charges"

The escalation plan §6.5 item 2 and PLAN-PHASE2 Amendment A.5 both ask the server to
return *"N charges were written at the old rent and need review"* from
`POST /rent-steps/:stepId/correct` and from `PATCH /leases/:id`.

**Do not do that.** It would change the response shape of two routes Phase 2 already
froze and shipped, it computes a transient that is stale the moment anything else
changes, and it needs a bespoke server-side comparison that is a second
implementation of the thing §2 exists to prevent.

**Instead:** the client already has everything required. It holds the lease terms,
the ladder, `buildSchedule`, and (via a new route) the written charges. One contract
function does the comparison, and both ends assert it against shared fixtures:

```ts
// packages/contract/src/charge.ts
export type ChargeDriftKind = 'amount' | 'due_date' | 'missing' | 'unscheduled';
export interface ChargeDrift {
  generationKey: string;
  written: { chargeId: string; amountCents: number; dueDate: IsoDate } | null;
  planned: { amountCents: number; dueDate: IsoDate } | null;
  kind: ChargeDriftKind;
}
export function diffChargesAgainstSchedule(input: {
  charges: readonly Charge[];     // generated, non-voided, rent only
  planned: readonly PlannedCharge[];
}): ChargeDrift[];
```

- `amount` / `due_date` — a row exists and disagrees with the current schedule.
  **This is the "needs review" case**, rendered with a void-and-supersede link.
- `missing` — the schedule wants a period no row covers. Rendered as "run generation".
- `unscheduled` — a row exists for a period the schedule no longer contains (an
  `/end` that landed after the lookahead had already written past it). Rendered as
  "no longer scheduled — void it?".

This is strictly better than the server-side version: it stays correct after *any*
later edit rather than only the one that triggered it, it reuses the byte-identity
mechanism rather than paralleling it, and **it changes no Phase 2 response shape**.

Accepted limitation, named: a landlord who never opens the lease page never sees the
banner. 3a does not chase them. Phase 4's cron can count drift into `job_run.stats`
and raise it; that is a one-function addition, not a redesign.

---

## 4. Idempotency and self-healing

### 4.1 The shape of the generator

It never asks *"what is due today"*. It asks *"which periods should exist for this
lease, and which of them are missing"* — and it answers the second half with a
unique index rather than with application logic.

```ts
// repo/charge.ts — ORDINARY orgId-first repo function (see §6)
export async function generateChargesForLease(
  orgId: string,
  db: Database,
  lease: GeneratableLease,          // structural Pick, not an import from repo/lease.ts
  rentSteps: readonly RentStep[],
  today: IsoDate,                   // ALWAYS injected. This function never reads a clock.
): Promise<ChargeRow[]> {
  const terms   = billingTermsFor({ ...lease, rentSteps });
  const planned = chargesDueForGeneration(terms, today);   // === buildSchedule(terms, today + 31d)

  const rows = [
    ...nonPeriodicRows(orgId, lease),     // deposit + opening balance, §8
    ...planned.map((p) => plannedChargeToInsert(orgId, lease, p)),
  ];
  if (rows.length === 0) return [];

  return db.insert(charge).values(rows)
    .onConflictDoNothing({ target: [charge.leaseId, charge.generationKey] })
    .returning();                        // ONLY the rows actually inserted
}
```

Three properties fall straight out of that shape:

- **No read of `charge` anywhere.** There is no read-modify-write, so there is no
  lost update to lose.
- **One statement per lease.** Not a transaction — it does not need one.
- **`RETURNING` on `ON CONFLICT DO NOTHING` returns only the rows actually
  inserted**, so `created` counts and the `{ created: charge[] }` response are
  honest without a second query.

### 4.2 The four scenarios, walked

**Runs twice in a day (or twice in a second).** Both runs compute the identical
wanted set and both issue the identical insert. The unique index decides; the loser's
rows are dropped by `ON CONFLICT DO NOTHING`. Second run inserts zero and returns an
empty `created`. **The guarantee is the index, not application logic** — there is no
"have I already run today" flag to get wrong, and `job_run` is a heartbeat, never a
lock.

**Misses a day.** Nothing. `generationHorizon(today)` is 31 days wide, so a period
that would have been written on day *N* is written on day *N+1* with a byte-identical
`due_date` — because `due_date` is computed from the **period**, never from "today".
Nothing downstream can tell.

**Misses a week, or a month, or three.** The next run computes the full wanted set
from `max(start_date, ledger_start_date)` forward and inserts every missing period at
once, each with its correct historical due date. 3b's arrears then shows them overdue,
correctly, as of their real due dates. **There is no catch-up mode**, which is the
point: a catch-up path is a second code path, and a second code path is the bug.

**Runs concurrently with a lease edit.** Three interleavings, one answer:

| Interleaving | Outcome |
|---|---|
| Edit commits before the generator's lease SELECT | New terms used. |
| Edit commits after the generator's INSERT | Old terms written and frozen. Next run finds the row and does nothing. The drift banner shows it. |
| Edit commits between the SELECT and the INSERT | Identical to the row above. |

**This is the designed semantics, not a race to be eliminated:** a charge is a
snapshot of the terms at generation time, and the outcome is indistinguishable from
the generator having run one second earlier — which it was always free to do.
Serialising it would require a lock the Neon HTTP driver cannot hold, to buy a
guarantee that does not exist anyway (the cron and the landlord's save are genuinely
concurrent events).

### 4.3 The one interleaving that is NOT benign — and its fix

`replaceRentSteps` is `DELETE` then `INSERT`, two separate statements with no
transaction. Its own comment calls the gap *"visible and harmless"*. **It stops being
harmless the moment a cron writes money against it**: a generator that SELECTs the
ladder inside that window sees **zero steps**, and `rentForPeriodStart` falls back to
`terms.rentCents` — the base rent — writing a charge at the pre-escalation amount
and freezing it.

**Fix, and it is a 3a prerequisite:** wrap the pair in `db.batch([...])`. Confirmed
available on `drizzle-orm/neon-http` 0.45.3 (`driver.d.ts` exports
`batch<U extends BatchItem<'pg'>>`), and Neon's HTTP driver runs a batch as a single
transaction in one round trip. That closes the window properly, in one line, inside
backend-dev's own file.

```ts
await db.batch([
  db.delete(leaseRentStep).where(and(eq(leaseRentStep.orgId, orgId), eq(leaseRentStep.leaseId, leaseId))),
  db.insert(leaseRentStep).values(rows),
]);
```

(When `body.steps` is empty, issue the delete alone — `batch` requires a non-empty
tuple.)

`createLease`'s roster insert has the same two-statement shape and the same fix is
available, but it writes no money and is out of 3a's scope. Named, not done.

### 4.4 Why no transaction is needed anywhere else

The Neon HTTP driver has no interactive transactions. 3a never needs one:

| Multi-statement sequence | Why a torn state is safe |
|---|---|
| Generator: one INSERT per lease | Single statement. Atomic by definition. |
| `activate`: lease status → unit status → generate | Already-ordered so the lease row (the system of record) wins. If generation fails, the lease is active with no charges — visible, and the next cron run fixes it. **Self-healing is the transaction.** |
| `end`: lease status → unit status → generate | Same. If generation fails, the final charge appears tomorrow instead of now. |
| `correctCharge`: void original → insert successor | Ordered **void first**. A torn state leaves a voided charge with no successor — a visible hole the landlord can refill, and 3b's balance is *under*-stated rather than double-counting. The reverse order would momentarily double-bill, which is the error that reaches a tenant. |
| `job_run`: start row → work → finish row | A `running` row that never finishes IS the failure signal the health endpoint reads. |

The rule behind all of these, stated so it can be applied to the next one:
**order the writes so that the torn state under-states money rather than
over-stating it, and so that the next idempotent run repairs it.**

---

## 5. The runner: Cloudflare Cron Triggers

### 5.1 Wiring

`apps/api/wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["0 9 * * *"] }
```

`apps/api/src/index.ts` — the one structural change to that file:

```ts
export default { fetch: app.fetch, scheduled };   // was: export default app
```

`scheduled` lives in `apps/api/src/jobs/scheduled.ts` and does nothing but build a
`Database` from `env` and call `runDailyJob(db, new Date())`. **The run instant is
captured once, at the top, and passed down** — every lease in a run must see the same
clock, or two properties in the same zone could land on different civil dates within
one run.

`apps/api/src/jobs/daily.ts`:

```
runDailyJob(db, runAt):
  runId = await jobRunRepo.startRun(db, 'daily', runAt)
  leases = await systemChargeRepo.listLeasesForGeneration(db)    // cross-org, §6
  for each lease:
     today = localToday(lease.propertyTimezone, runAt)           // the ONLY clock read
     try:   created += await chargeRepo.generateChargesForLease(lease.orgId, db, lease, lease.rentSteps, today)
     catch: record { leaseId, orgId, message }; CONTINUE
  await jobRunRepo.finishRun(db, runId, status, stats)
```

**One lease's failure must never abort the run.** A Bikram Sambat lease running past
the data table throws `BsDateOutOfRangeError`; a `MAX_SCHEDULE_PERIODS` breach throws
`RangeError`. Both are caught per lease, counted into
`stats.errors`, and the other 400 leases still bill. An uncaught throw at lease 3 of
400 is an outage nobody sees until a tenant complains.

Workers' 30-second scheduled CPU budget is ample: one SELECT, N in-memory schedule
builds, N single-statement inserts. 3b/Phase 4 may batch the inserts; 3a does not
need to.

### 5.2 The health endpoint

`GET /v1/internal/cron/health` — **public**, added to `PUBLIC_PATHS` in
`middleware/auth-layer.ts` as an **exact string**, never a prefix (the file's own
comment explains why a prefix entry is the loosening it exists to prevent).

```json
{ "ok": true, "lastSuccessAt": "2026-10-08T09:00:12.000Z", "lastRunStatus": "ok", "ageSeconds": 3612 }
```

**Public, with no counts.** The alternative — a shared-secret header — buys nothing:
the response carries a timestamp and a status, and nothing else. Counts stay in
`job_run.stats` for an operator with database access. Shipping cross-org row counts
on an unauthenticated endpoint would be a (mild) business-metrics leak for no gain,
and shipping a secret would be an authenticated hole in the API that exists only
because a watcher is external — exactly the thing PLAN-V1 §4.5 rejected GitHub
Actions *as* the scheduler to avoid.

A **weekly** GitHub Actions job polls it and fails when `ageSeconds > 129600` (36
hours). That is the right use of GH Actions here: watching the cron, not being it.
`.github/**` is devops's boundary, not backend-dev's — raise it as a separate task.

### 5.3 Timezone: why one UTC hour serves UTC-11 to UTC+14

PLAN-V1 §4.4 justifies this as *"every property is evaluated exactly once per local
day, because the job keys idempotency on (charge, tenant, kind, local date)"*. **That
is Phase 4's reminder argument, and for charges it is both unnecessary and not quite
true.** The real argument is stronger:

**The charge generator has no per-day semantics at all.** It is not an event that
must fire once per local day. It is a convergence: it states which periods should
exist and inserts the missing ones. Therefore:

- **Running twice on the same local civil date inserts zero rows.** Harmless.
- **Skipping a local civil date entirely inserts the same rows one day later.** The
  horizon is 31 days wide and `due_date` is computed from the period, never from
  "today", so nothing observable changes except *when a lookahead row first appears*,
  by at most a day.

Both of those are reachable at the edges — at 09:00 UTC a UTC+14 property reads
23:00 local and a UTC-11 property reads 22:00 the previous day, so a DST transition
can make two samples 24h apart land on the same civil date or skip one. **It does not
matter, by construction.** That is the entire payoff of keying idempotency on
`(lease_id, generation_key)` rather than on the run or on the date.

Three rules that keep it true, each of which is already satisfied:

1. `today` is `localToday(property.timezone, runAt)` — the property's zone, never
   the server's, never the tenant's. `new Date().toISOString().slice(0,10)` is the
   bug this closes.
2. No arithmetic is ever performed on an instant. Everything is `date` values plus
   one timezone-aware "what day is it" lookup, so **DST is a non-issue: there is no
   23-hour day to get wrong because there are no hours.**
3. The tenant's own timezone is not stored. It affects nothing financial.

**Hour: 09:00 UTC, confirmed.** Nothing is ever generated on its own due date — the
31-day lookahead guarantees a month of slack — so the hour is not load-bearing and
should not be tuned.

---

## 6. `repo/system/` — the bounded cross-org exception

### 6.1 The split that keeps the exception tiny

Cron work is cross-org by nature. But **only one query actually needs to be** — the
driving scan. Everything that writes money stays under the ordinary `orgId`-first
rule and the guard that already covers it.

```
apps/api/src/db/repo/system/charges.ts     ONE exported function:
                                             listLeasesForGeneration(db): Promise<GeneratableLease[]>
                                           Cross-org SELECT. Writes nothing.

apps/api/src/db/repo/system/job-run.ts     startRun / finishRun / latestRun.
                                           The one table with no org_id at all.

apps/api/src/db/repo/charge.ts             ORDINARY. orgId first. generateChargesForLease
                                           lives HERE, not in system/, and is called by
                                           BOTH jobs/daily.ts and the routes.
```

This matters for a concrete reason beyond neatness: `POST /leases/:id/charges/generate`
is a route, and a route may not import `repo/system/`. If the generator lived there,
either the manual kick would need a duplicate implementation or the import rule would
need an exemption. With the split, the org-less surface is **one SELECT that writes
nothing**, and every INSERT in the phase is covered by `tenancy.guard.test.ts`.

### 6.2 The guard

New: `apps/api/src/db/repo/system/system-repo.guard.test.ts`, built on
`test/support/repoGuard.ts` exactly as the three existing guards are. `system/` is
already in `tenancy.guard.test.ts`'s `EXEMPT_PREFIXES`, so no edit there.

It asserts:

1. **Floor.** `MIN_SYSTEM_REPO_FILES = 2`. An empty glob must fail loudly — that is
   how the original non-recursive-guard bug went unnoticed.
2. **First parameter is `db: Database`.** There is no caller principal, and a
   function taking an `orgId` here belongs in the ordinary repo instead.
3. **Every `insert(` selects `orgId` as a literal column** — except in `job-run.ts`,
   the one allowed file, named explicitly by filename rather than by pattern.
4. **Every `select(` either names `orgId` or joins a table that provides it.**
5. **Import graph.** Walk every non-test `.ts` under `apps/api/src`, strip
   comments/strings, and regex for an import path containing `repo/system`. The
   importing file's path must start with `src/jobs/` or be a test colocated with the
   system repo. Anything under `src/routes/`, `src/middleware/`, or
   `src/db/repo/*.ts` is a failure.
6. **A deliberate-violation proof**, like `tenancy.guard.test.ts`'s recursion proof:
   write a throwaway fixture file that imports `repo/system/charges.js` from a fake
   `routes/` path and assert the detector catches it. A guard with no demonstrated
   failure mode is a guard nobody has tested.

### 6.3 What every system INSERT must still carry

There is exactly one INSERT under `system/` — `job_run` — and it is the one table
with no `org_id`. **Everything else the cron writes goes through
`repo/charge.ts`**, which takes `orgId` first and is covered by the ordinary tenancy
guard. The `orgId` it passes is read from the lease row the driving scan returned,
never from anything else.

That is the honest statement of the exception: *the cron does not write cross-org
rows. It reads a cross-org list of leases, then writes each lease's charges through
the same org-scoped function a landlord's own request uses.* The FIFO path in 3b
inherits the same shape.

---

## 7. Voided charges

**Confirmed, not challenged — with one amendment that makes it stricter.**

- A charge is immutable. The **only** permitted mutation is setting
  `voided_at` / `voided_reason` / `voided_by_user_id`, once, by an explicit landlord
  action with a 10–500 character reason.
- **No field is mutable at all — not even `description`.** `payment.note` is
  mutable in PLAN-V1 because it is private bookkeeping; a charge's `description` is
  the line the tenant reads on their statement, so changing it changes the document.
  If a description is wrong, correct the charge.
- A correction is a **superseding row**, never an edit: void the original, insert a
  new row with `supersedes_charge_id = <original>`.

### 7.1 Why a voided charge is never regenerated

`charge_generation_uq` is on `(lease_id, generation_key)` with **no predicate on
`voided_at`**. A voided row still occupies its key, so the next run's
`ON CONFLICT DO NOTHING` writes nothing for that period — forever.

**This is the thing to not get clever about.** A partial index
`… WHERE voided_at IS NULL` would be the natural-looking "fix" that makes the cron
silently re-create a charge the landlord deliberately voided, on the morning after
they voided it. Voiding March's rent is a decision, not a gap to refill. The schema
comment must say this in as many words.

### 7.2 The rule that lets correction and idempotency coexist

> **A correction always carries `source = 'manual'` and `generation_key = NULL`.**

If a correction reused the original's `generation_key`, it would collide with the
voided original on the unique index and the insert would be silently dropped. Setting
it to NULL is what makes the chain representable at all — and NULL keys are
unconstrained for free because the index is plain, not partial (§1.4). The two
decisions are load-bearing for each other; changing either alone breaks correction.

A landlord who genuinely wants the generator to rewrite a period has exactly one
supported path: void, then correct with the right number. There is no "regenerate
this period" affordance and there must not be one.

---

## 8. `ledger_start_date`, deposits and opening balances

Everything structural already exists; 3a only materialises it.

**`ledger_start_date`** — already a column, already enforced by `lease_ledger_ck` and
`validateBillingTerms`, and already honoured by `buildSchedule`
(`windowStart = max(startDate, ledgerStartDate)`), pinned by fixture **F9**, whose
`periodIndex` is `9` rather than `0`. The generator inherits all of it by calling
`chargesDueForGeneration`. **No new code and no new rule.** It is what stops the
generator backfilling a decade for an in-flight tenancy.

**Deposit**, written once:

| | |
|---|---|
| `type` | `deposit` |
| `generation_key` | `DEPOSIT_GENERATION_KEY` = `'deposit'` |
| `due_date` | `lease.start_date` |
| `amount_cents` | `lease.deposit_cents` |
| period columns | all NULL; `is_prorated = false` |
| written when | `deposit_cents > 0` |

**Opening balance**, written once:

| | |
|---|---|
| `type` | `opening_balance` |
| `generation_key` | `OPENING_BALANCE_GENERATION_KEY` = `'opening'` |
| `due_date` | `lease.ledger_start_date` |
| `amount_cents` | `lease.opening_balance_cents` |
| period columns | all NULL; `is_prorated = false` |
| written when | `opening_balance_cents > 0` |

Both keys are in the contract already. A period key is always `YYYY-MM-DD`, so
collision is impossible by construction — `billing.ts` says so in its own comment and
3a relies on it.

**A zero amount writes nothing.** A zero-amount deposit is the absence of a deposit;
a row for it is noise in the tenant's statement forever. (Contrast §1.5: a zero-amount
*rent* charge IS written, because the period genuinely exists.)

**Both are already immutable by the time they can be charged.**
`openingBalanceCents` and `ledgerStartDate` are both in `illegalUpdateField`'s
`ALWAYS_IMMUTABLE` set, so neither can change once the lease leaves `draft` — which
is the only status from which it can reach a generating status. There is therefore no
"the opening balance changed, correct the charge" case to handle. `depositCents`
*is* editable on an active lease; a change after the deposit charge is written shows
up in the drift banner as an `amount` divergence like any other.

**The onboarding hazard, named and not solved server-side.** A landlord onboarding a
tenancy that started six months ago sets `ledger_start_date` six months back and
activates — and the synchronous generation pass writes seven charges at once, six of
them already overdue. That is **correct and intended**, and it is also the most
alarming thing a new user can do by accident. The only server-side bound is
`MAX_SCHEDULE_PERIODS` (600), which is deliberately not lowered. **The mitigation is
in the UI** (§10, frontend task 3): the activate dialog previews the exact count and
total before committing — *"Activating creates 7 charges totalling $7,000; 6 are
already overdue."*

---

## 9. API surface

Conventions unchanged: `/v1`, landlord routes behind `requireAuth`, tenant routes
under `/v1/portal/*` behind `requireTenant`, `404` for "absent or not yours" on both
actors. `401` and `500` are not repeated per row.

### 9.1 Landlord — `requireAuth`

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| `GET` | `/v1/leases/:id/charges` | `chargeListQuery` = `pageQuery` + `?from=&to=&type=&includeVoided=` (default `true`) | `paged(charge)`, ordered `due_date, id` | 404, 400 |
| `POST` | `/v1/leases/:id/charges` | `createChargeBody` = `{ type, amountCents, dueDate, periodStart?, periodEnd?, description? }` | `201 charge` | 404, **409** (lease is `draft`/`cancelled`), 422 |
| `POST` | `/v1/leases/:id/charges/generate` | **empty body** | `{ created: charge[] }` | 404, 409 (`draft`/`cancelled`), 422 (BS range / period cap) |
| `POST` | `/v1/leases/:leaseId/charges/:chargeId/void` | `voidChargeBody` = `{ reason }` (10..500) | `charge` | 404, 409 (already void), 422 |
| `POST` | `/v1/leases/:leaseId/charges/:chargeId/correct` | `correctChargeBody` = `{ amountCents, dueDate?, description?, reason }` | `201 charge` (the successor) | 404, 409 (already void), 422 |
| `GET` | `/v1/charges` | `chargeListQuery` + `?propertyId=&unitId=&overdueOnly=` | `paged(chargeWithLease)` | 400 |

**[CORRECTION] to PLAN-V1 §3.5, three of them:**

1. **Void and correct are nested under the lease**, not `/v1/charges/:id/void`. The
   resolve is then `(org_id, lease_id, id)` — the same shape
   `correctRentStep` already uses for `stepId`, for the same reason. One extra path
   segment, one extra conjunct, zero ambiguity about whether a bare id was scoped.
2. **`/charges/generate` takes no `through`.** PLAN-V1 drafted
   `{ through?: 'YYYY-MM' }`. If a caller picks the horizon, the written row set
   stops being a function of `(terms, today)` alone and the manual kick can write
   further ahead than the cron ever would — breaking the one property §2 depends on.
   The manual kick is *exactly* the cron's work for one lease.
3. **`/leases/:id/ledger` and `/leases/:id/balance` are NOT in 3a.** They need
   payments. `GET /leases/:id/charges` is their 3a stand-in and is a different thing.

`createChargeBody` is for `late_fee | utility | other | deposit`. The generator owns
`rent` and `opening_balance`; a manual `rent` charge would compete with a generation
key and is rejected `422`.

### 9.2 Tenant — `requireTenant`

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| `GET` | `/v1/portal/leases/:id/charges` | `pageQuery` + `?from=&to=` | `paged(portalCharge)` | 404 |

That is the whole tenant surface for 3a. No totals — a total without payments is a
number that will change meaning in 3b, and showing a tenant "you owe $4,500" when
they have paid $4,500 is worse than showing nothing.

**What `portalCharge` drops from `charge`, and why each:**

| Field | In portal? | Reasoning |
|---|---|---|
| `voidedReason` | **No** | Landlord bookkeeping ("duplicate — my error"); may be unflattering or reference another tenancy. |
| `voidedAt` | **As `isVoided: boolean`** | The tenant must see that a line was cancelled or their statement does not add up. The timestamp adds nothing. |
| `voidedByUserId`, `createdByUserId` | **No** | Landlord staff identity. |
| `source`, `generationKey`, `periodIndex` | **No** | Internal mechanics. |
| `supersedesChargeId` | **Yes** | They need the link to understand "$1,000 was replaced by $900". |
| `periodStart`, `periodEnd`, `isProrated`, `daysOccupied`, `daysInPeriod` | **Yes** | The prorated first and last months are the single most disputed numbers in rent. "17 of 31 days" settles it without an email. |
| `description`, `type`, `dueDate`, `amountCents`, `currency` | **Yes** | It is their statement. |

### 9.3 Internal

| Method | Path | Actor | Response |
|---|---|---|---|
| `GET` | `/v1/internal/cron/health` | **public** (§5.2) | `{ ok, lastSuccessAt, lastRunStatus, ageSeconds }` |

### 9.4 The tenant attack walk — new routes only

I am an authenticated tenant holding a UUID I should not have.

| Attempt | Result | Why |
|---|---|---|
| `GET /v1/portal/leases/{neighbours_lease}/charges` | `404` | `resolveLease(scope, …)` runs **first**; its filter is `lease.id = $1 AND (lease.org_id, lease_tenant.tenant_id) IN scope.pairs`. Same org, different tenant → zero rows → 404, never 403. |
| `GET /v1/portal/leases/{other_orgs_lease}/charges` | `404` | Same filter, same zero rows. Existence is never confirmed. |
| `GET /v1/portal/leases/{my_lease}/charges` where a charge belongs to another lease | n/a | **Charges are listed by verified lease id. There is no portal route that takes a charge id.** This is the shape decision, not a filter. |
| `POST /v1/leases/{my_lease}/charges` | `403` | Landlord path; `authLayer` falls through to `requireAuth`, which rejects before any query — a tenant has no `member` row. |
| `POST /v1/leases/…/charges/…/void` | `403` | Same. A tenant never writes money, and never writes an obligation either. |
| `GET /v1/charges` | `403` | Same. |
| Tenant creates their own org, then `GET /v1/charges` | `200 { items: [] }` | `requireAuth` passes for *their own empty org*; the repo filters on it. Zero reach into the landlord's org. |
| `?orgId=` on any portal route | ignored | No route reads an org id from a request. The `orgId` used for the charge query is `resolved.orgId` — it came out of a capability check, so it is as trusted as a session `orgId`. |
| Forged pagination cursor | `400` | `decodeCursor` validates UUID shape and `id > cursor` is always ANDed with the scope filter. |
| Tenant archived mid-session, then any portal charge route | `403` | `requireTenant` re-resolves scope from the database on every request. |

**The verify-then-scope shape, written out so it is copied rather than reinvented:**

```ts
// routes/portal-charges.ts
const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId);  // (org, tenant) pair filter
if (!resolved) throw notFound('Lease');
const rows = await chargeRepo.listCharges(resolved.orgId, db, leaseId, query);  // ordinary repo fn
```

`listCharges` therefore stays in the **landlord** repo with the ordinary
`(orgId, db, …)` signature and the existing tenancy guard covers it. **No new file
under `repo/portal/` is needed for 3a** — the five root resolvers PLAN-V1 §1.4 names
already cover everything, and `resolveLease` is one of them.

Landlord-vs-landlord, for completeness: *"I am landlord B holding landlord A's
charge UUID."* `POST /v1/leases/{A_lease}/charges/{A_charge}/void` → the lease
resolve filters `org_id = B` → no row → `404` before the charge id is even read.
Both path ids are scoped; neither alone is sufficient.

---

## 10. Contract additions, file by file

**The headline: `billing.ts` does not change. At all.** Every fixture, every
invariant, every pinned number stays exactly as frozen. If 3a needs a change to
`billing.ts`, 3a is wrong.

### New: `packages/contract/src/charge.ts`

- `chargeType` enum + `chargeTypeLabels`
- `chargeSource` enum
- `charge` — the landlord response shape
- `chargeWithLease` — `charge` + `{ leaseId, unitLabel, propertyName, propertyTimezone, primaryTenantName }` for `GET /v1/charges`
- `createChargeBody`, `voidChargeBody`, `correctChargeBody`, `chargeListQuery`
- `PLANNED_CHARGE_KEYS: readonly (keyof PlannedCharge)[]` — the exhaustiveness pin (§2.3)
- `plannedChargeFromCharge(c: Charge): PlannedCharge` — throws on a non-generated or non-periodic charge
- `chargeOverdue(dueDate: IsoDate, today: IsoDate): boolean` — **not** a status enum (§0 decision 8)
- `ChargeDrift`, `ChargeDriftKind`, `diffChargesAgainstSchedule(...)` (§3.6)

### New: `packages/contract/src/charge.fixtures.ts`

- `chargeDriftFixtures` — worked examples for all four drift kinds, asserted by both apps
- `generationPlanFixtures` — for each `scheduleFixture`, the derived `today`
  (`addDays(through, -GENERATION_LOOKAHEAD_DAYS)`), the expected rent keys, and the
  expected non-periodic keys (`'deposit'`, `'opening'`) given a deposit and opening
  balance. **This is the file the API's conformance test and the web's preview test
  both import**, so neither can drift from the other.

### Edited (additive only)

- `portal.ts` — `+ portalCharge`. It goes here, not in `charge.ts`, because
  `portal.ts`'s module comment is the place a reviewer looks to answer "what does a
  tenant see", and the whole answer should be in one file.
- `routes.ts` — `+ leases.charges`, `leases.generateCharges`, `leases.voidCharge`,
  `leases.correctCharge`; `+ charges.list`; `+ portal.leaseCharges`;
  `+ internal.cronHealth`.
- `index.ts` — export the two new files.

### Confirmed no change needed

- `common.ts` — `moneyDelta` and `moneyTotal` already shipped. PLAN-V1 §4.6 flagged
  their absence as *"the most likely day-one Phase 3 bug"*; it is already closed.
  3a uses plain `money` for `amountCents` (always non-negative) and needs neither.
- `lease.ts` — unchanged. §3.6 is specifically how 3a avoids editing a frozen Phase 2
  response shape.
- `billing.ts`, `billing.fixtures.ts`, `billing.bs.fixtures.ts` — unchanged, and the
  CI check that no `expected:` line may change stays on.

---

## 11. Task split

Both agents run in parallel against the frozen contract. **The only shared surface is
`packages/contract/**`**, written and frozen by the orchestrator before either is
dispatched. Neither agent edits it; if it is wrong, stop and report upward.

### The paragraph that goes verbatim in both task files

> *The number the browser previews and the number in the charge row are produced by
> the same call to `buildSchedule`, through the same `billingTermsFor` adapter. There
> is no second implementation and there must never be one. If they ever disagree, the
> charge row is right and the preview is stale — never the other way round. A charge
> row, once written, is never updated and never deleted; the only mutation is the
> void tombstone, and a correction is a superseding row.*

### backend-dev — `apps/api/**`

1. Migration: `charge_type` / `charge_source` / `job_run_status` enums, `charge` and
   `job_run` tables, the three indexes. One `pnpm --filter api db:generate`.
2. `db/repo/charge.ts` — `listCharges`, `listChargesForOrg`, `resolveCharge`,
   `createManualCharge`, `voidCharge`, `correctCharge`, `generateChargesForLease`,
   `latestChargedPeriodStart`, `rentStepMutabilityBoundary`. All `orgId`-first.
   **Must not import `repo/lease.ts`** — take a structural `GeneratableLease`.
3. `db/repo/system/charges.ts` (one function) and `db/repo/system/job-run.ts`.
4. `lib/charge-mapper.ts` — `plannedChargeToInsert`, the total projection (§2.3).
5. `jobs/daily.ts`, `jobs/scheduled.ts`, the `export default { fetch, scheduled }`
   change in `index.ts`, the `triggers` block in `wrangler.jsonc`.
6. Routes: `routes/charges.ts` (six landlord routes), `routes/portal-charges.ts`
   (one, mounted **before** `portal`, same footgun as `portal-leases`),
   `routes/internal.ts`; the `PUBLIC_PATHS` entry in `middleware/auth-layer.ts`.
7. **Lease-repo changes:** widen `validateStepReplacement` + `correctRentStep` to the
   shared boundary (§3.4); `replaceRentSteps` → `db.batch` (§4.3); `activateLease`
   and `endLease` call the generator (§3.2); `hardDeleteLease` zero-charge check
   (§3.5); refactor the two hand-built `LeaseBillingTerms` literals to
   `billingTermsFor` so date-guard Rule 7 lands with zero exemptions (§2.2).
8. Tests:
   - `charge-conformance.integration.test.ts` — **the one that matters** (§2.4)
   - `system-repo.guard.test.ts` with its deliberate-violation proof (§6.2)
   - date-guard Rules 6 and 7, each proven against a deliberate violation
   - idempotency: run twice → second returns `[]`, row count unchanged
   - catch-up: advance `today` by 40 days with no intervening run → exact backfill,
     correct historical `due_date`s, zero duplicates
   - void-then-regenerate: void a charge, run the generator, assert **nothing** is
     written for that key
   - correction keeps `generation_key = NULL` and a later run writes nothing
   - the boundary: a step inside the lookahead is refused by `PUT` and accepted by
     `/correct`, and the complement
   - `/end` with a future `endDate` still bills the remaining months
   - cross-org isolation for every new repo function
   - the §9.4 attack table as route tests

### frontend-dev — `apps/web/**`

1. `features/charges/` — a **Charges** tab on `LeaseDetailPage`: the written rows,
   ordered by due date, overdue highlighted via `chargeOverdue(dueDate,
   localToday(propertyTimezone))`, voids struck through with their successor linked.
2. Void / correct dialogs with a mandatory reason (10–500 chars, same validation the
   rent-step correction dialog already uses), and a manual-charge dialog.
3. The **drift banner** on lease detail, from `diffChargesAgainstSchedule` — all four
   kinds, each with the right call to action (§3.6). Asserted against
   `chargeDriftFixtures`.
4. `ActivateLeaseDialog` gains the generation preview: *"Activating creates N charges
   totalling X; M are already overdue"*, computed client-side from `buildSchedule`
   (§8). This is the onboarding guard-rail.
5. `/charges` — a portfolio-wide page with property/unit/date filters and an
   overdue-only toggle, grouped by currency (never summed across).
6. `/portal/leases/:id` gains the charge list: prorated rows show "17 of 31 days",
   voided rows are struck through, no totals.
7. Loading, empty and error states for all six.

### They share

`packages/contract/src/charge.ts`, `charge.fixtures.ts`, the `portalCharge` addition
to `portal.ts`, and `routes.ts`. Nothing else. No file is touched by both agents.

---

## 12. What 3a leaves in place for 3b, and what it defers

### Left in place, deliberately

| For 3b | Already there after 3a |
|---|---|
| FIFO allocation ordering | `charge_lease_due_idx on (org_id, lease_id, due_date, id)` is **exactly** the window function's `ORDER BY c.due_date, c.id`. No new index. |
| FIFO's filter | `voided_at IS NULL` is already the only liveness predicate on the table. |
| Correction chains in the ledger | `supersedes_charge_id` is written from day one, so 3b renders the chain with no migration and no backfill. |
| Chain-level balances | `lease.chain_id` exists; 3b aggregates on it. 3a deliberately does **not** denormalise it onto `charge`. |
| Signed balances | `moneyDelta` / `moneyTotal` already in `common.ts`. |
| Paid / partially-paid vocabulary | **No `chargeStatus` enum shipped**, so 3b defines it once, complete, instead of widening a 3a enum. |
| Deposit vs rent balance split | `charge.type` already distinguishes them; the balance response splits on it. |
| Phase 4's reminder counters | `job_run.stats` is `jsonb` — no migration. |
| Phase 4's reminder scan | The index it needs is named in §1.3 and deliberately not created yet. |

### Deferred explicitly — not in 3a

- The `payment` table and every payment route.
- FIFO allocation, `GET /leases/:id/ledger`, `GET /leases/:id/balance`.
- `GET /v1/arrears` and the arrears CSV.
- Balance chips on lease / tenant / unit cards; the "credit" state.
- `portalBalance` and any total on the tenant's charge list.
- `charge_due_idx on (due_date) where voided_at is null` — Phase 4.
- Reminders of any kind — Phase 4.
- Automatic late fees. Not deferred: **never** (PLAN-V1 §7.2 — jurisdictional, a
  legal exposure rather than a feature).

### The one thing 3a does that 3b would otherwise have to redo

`POST /charges/:id/void` and `/correct` ship **in 3a**, not 3b. Without them, §3's
entire answer — *"the generator never un-writes; the landlord corrects it"* — has no
remedy behind it, and both Phase 2 plans already promise that remedy in writing
(PLAN-PHASE2 Amendment A.3, escalation §6.5 item 2). They are charge-side, not
payment-side. They belong here.

---

## 13. Risks, assumptions, and what I am unsure about

### Risks I am confident about

| Risk | Mitigation |
|---|---|
| **`ON CONFLICT` against a partial unique index** throws *"no unique or exclusion constraint matching"* at runtime if `targetWhere` is omitted — on the cron, writing nothing, telling nobody. | The index is plain, not partial (§1.4). The failure mode is unreachable. |
| **A `> 0` CHECK on `amount_cents`** 500s the cron on a zero-rent lease or a rounded-to-zero proration. | `>= 0` (§1.5), with a test that generates a zero-rent lease. |
| **A voided charge regenerated the next morning** by someone "fixing" the index into a partial one. | The schema comment states the reasoning (§7.1) and a test asserts it (void → generate → zero rows). |
| **A correction colliding with its voided original's generation key.** | `generation_key = NULL` on every manual charge; test asserts it (§7.2). |
| **`/end` with a future `endDate` silently never billing the remaining months.** | Driving scan includes `ended`/`terminated` (§3.3), with a dedicated test. |
| **`replaceRentSteps`' delete/insert window** letting the cron write a charge at base rent. | `db.batch` (§4.3) — confirmed available on neon-http 0.45.3. |
| **One lease's exception aborting the whole run** (BS range, period cap). | Per-lease try/catch, errors counted into `job_run.stats` (§5.1). |
| **The reviewer flagging `repo/system/` and the missing `org_id` on `job_run`** as tenancy violations. | Both are documented exceptions with named guards and schema comments (§1.6, §6). |
| **A landlord onboarding a backdated tenancy and creating 6 overdue charges in one click.** | Activate-dialog preview (§8, frontend task 4). Not solved server-side, by choice. |
| **The drift banner being invisible to a landlord who never opens the lease page.** | Accepted for 3a. Named as a Phase 4 cron addition, not a redesign. |

### Assumptions I made

1. **Postgres `ON CONFLICT DO NOTHING … RETURNING` returns only the rows actually
   inserted.** True, and the `{ created: [] }` honesty depends on it. Verify in the
   first integration test rather than reading it here.
2. **`db.batch()` on neon-http runs its statements in one server-side transaction.**
   Verified present in the type definitions; **backend-dev must confirm the
   transactional semantics against the local Neon HTTP proxy before relying on it for
   §4.3.** If it turns out not to be transactional, the fallback is to make
   `replaceRentSteps` insert the new ladder with a higher-precedence marker before
   deleting the old — a redesign, so find out early.
3. **`date` columns round-trip through the Neon HTTP driver as `YYYY-MM-DD`
   strings**, as `lease.startDate` already does in `LeaseRow`. The conformance test
   is the proof.
4. **Tens of landlords, hundreds of leases.** Every "do not index that" and "a
   sequential scan is fine" in this document assumes it. At 10,000 leases the driving
   scan wants a cursor loop; nothing else changes.

### Where I would want input — with my default

| Question | **Default I would ship** |
|---|---|
| Should `GET /v1/charges` (portfolio-wide) land in 3a at all, or wait for the 3b arrears page it will sit next to? | **Ship it.** It is one repo function and one page, and without it a landlord's only view of charges is lease-by-lease, which makes 3a hard to evaluate as a shipped feature. |
| Should the generator run on `PATCH /leases/:id` too, so a `billingDay` change shows its effect immediately? | **No.** Three synchronous call sites (activate, end, manual kick) is already the limit of what is explicable; a fourth on a general-purpose PATCH makes "when does a charge get written" unanswerable. The landlord presses *Generate* or waits a day. |
| Should a landlord be able to void a charge that 3b will later show as paid? | **Yes, with no extra guard in 3a** — 3b's FIFO recomputes over live charges, so voiding a paid charge turns the payment into a credit, which is the correct and already-designed behaviour. Revisit only if 3b finds otherwise. |
| `includeVoided` default on `GET /charges` | **`true`.** A ledger with silently-hidden rows is how a landlord loses an hour. The UI strikes them through; it does not drop them. |

---
