# Plan — Rent escalation clauses

> Written by `architect`. A **plan**, not a contract. The orchestrator turns §3 into real
> contract files, freezes them, then dispatches the §4 backend and frontend tasks in
> parallel.
>
> Builds on `docs/PLAN-PHASE2.md` (including Amendment A) and `docs/DATES.md`. Where this
> file and PLAN-PHASE2 disagree, this one wins for anything touching the per-period rent;
> everything else in PLAN-PHASE2 stands unchanged.

---

## 0. The requirement, and what it is not

> *"the aggrement consists of 10% rent increase every year or every two year… this needs
> to be implemented in the same lease. its the same tenanat, its the same lease but its
> leased for about 5 years or so."*

**This is ONE lease.** A five-year agreement with a 10%-per-year clause is a single signed
document with a single tenant. Modelling it as a renewal chain would fabricate four
tenancies that never happened and make `leaseDetail.chain` lie about the timeline. The
clause belongs on the lease.

**The consequence for the engine:** `lease.rentCents` stops being a constant for the term
and becomes a function of which period you are in. `buildSchedule` must apply it.
`packages/contract/src/billing.ts` is the single definition the browser preview and
Phase 3's charge generator both use, so this is the most load-bearing change since the
calendar seam.

---

## 1. Decisions that matter, in one table

| # | Decision | One-line reason |
|---|---|---|
| 1 | The clause is **four columns on `lease`**, not a chain, not a child table. | One signed agreement is one row; a child table would invite per-period overrides, which is a different feature. |
| 2 | Rate is **integer basis points** (`10% = 1000`), never a float percentage. | Same discipline as integer cents: `7.35 * 100 === 734.9999999999999` in IEEE754, and a rate that feeds a money calculation cannot be allowed to carry that. |
| 3 | The escalation interval is **in years**, independent of `rent_frequency`. | A monthly-billed lease escalating annually is the dominant real case; tying the interval to the billing cadence would make it unexpressible. |
| 4 | **Compound by default**, with `simple` expressible on the lease. | "10% every year" in a signed agreement is almost always applied to last year's rent; `simple` exists because some agreements say "of the original rent" and both must be representable. |
| 5 | An escalated rent **rounds to the nearest whole major unit** (100 minor units), half-up, and the next cycle compounds from the **rounded** value. | A quoted rent repeats on twelve receipts; ₹5,866.30 is noise no landlord writes down, and compounding from the rounded value keeps every step's input an exact integer that the tenant can reproduce. |
| 6 | **The base rent is never rounded.** `rentForPeriodStart` returns `terms.rentCents` *exactly* for cycle 0. | Rounding cycle 0 would silently re-price the lease's own stated rent. |
| 7 | Anniversaries anchor on **`lease.start_date`** and are computed as `calendar.addYears(startDate, k * intervalYears)` — always from the original start, never iteratively. | Identical rule to the yearly cadence's period anchor (PLAN-PHASE2 §1.2), so there is no cumulative drift and no second convention to learn. |
| 8 | The anniversary uses **the lease's own calendar** (`terms.calendar`), via `Calendar.addYears`. | A Bikram Sambat property escalates on a BS anniversary; `addYears` is already the calendar-generic anchor function, so this costs zero new date arithmetic. |
| 9 | **A billing period takes the rent in force on its `periodStart`.** No period is ever split. | One period = one charge = one `generationKey` = one amount; splitting breaks I3 and doubles every anniversary month's invoice count. |
| 10 | A monthly anniversary falling mid-month therefore **takes effect at the next period start** — the straddling month bills at the OLD rent. | Of the two whole-period options, the one that errs in the tenant's favour for at most one period per cycle is the defensible one. |
| 11 | **`PlannedCharge` gains no field.** | The brief's hard requirement is byte-identical output for a no-clause lease; any new field breaks that for every lease. The one thing the UI loses is recovered by calling `rentForPeriodStart`. |
| 12 | The clause is **frozen once the lease has been active**, with a dedicated `POST /correct-escalation` route for a typo. | It is a term of the signed agreement exactly as `rentCents` is — but `/renew` is the wrong escape hatch here, because the user explicitly rejected renewal as the model. |
| 13 | `rateBps` is capped at **5000** (50% per step). | The cheapest place to catch the 100%-instead-of-10% typo is the input boundary, before it ever reaches a charge. |
| 14 | **Ship this before Phase 3.** | Changing the rent-per-period rule after the generator exists turns a pure-function change into a data migration. |

---

## 2. Data model delta

Conventions unchanged: `casing: 'snake_case'`, UUIDv7 PKs, money as integer minor units,
`date` for civil dates, `timestamptz` for instants, `org_id text not null references
organization(id) on delete cascade` on every org-owned table.

### 2.1 New enums

```ts
export const rentEscalationModeEnum = pgEnum('rent_escalation_mode', ['none', 'percent']);
export const rentEscalationCompoundingEnum = pgEnum('rent_escalation_compounding', ['compound', 'simple']);
```

`'none'` exists so the column can be `NOT NULL` with a default and the migration is a
semantic no-op. **The contract does not use `'none'` on a lease response** — it uses
`escalation: null`. The mapper translates. One nullable object beats four nullable fields
and four "is it set" checks at every call site.

`'percent'` is the only clause type today. The enum absorbs `'fixed_amount'` (₹2,000 more
each year, a real clause) without a schema-and-contract break. **We are not adding it.**

### 2.2 `lease` — four new columns

| Column | Type | Notes |
|---|---|---|
| `escalation_mode` | `rent_escalation_mode` NOT NULL default `'none'` | |
| `escalation_rate_bps` | `integer` NULL | Basis points. `1000` = 10%. NULL iff mode is `'none'`. |
| `escalation_interval_years` | `smallint` NULL | 1 or 2 in practice; 1..10 allowed. NULL iff mode is `'none'`. |
| `escalation_compounding` | `rent_escalation_compounding` NULL | NULL iff mode is `'none'`. |

```sql
lease_escalation_ck CHECK (
  (escalation_mode = 'none'
     AND escalation_rate_bps       IS NULL
     AND escalation_interval_years IS NULL
     AND escalation_compounding    IS NULL)
  OR
  (escalation_mode = 'percent'
     AND escalation_rate_bps       BETWEEN 1 AND 5000
     AND escalation_interval_years BETWEEN 1 AND 10
     AND escalation_compounding    IS NOT NULL)
)
```

One all-or-nothing CHECK, so a **half-written clause is unrepresentable**. A rate with no
interval is the shape that would silently escalate on the wrong clock.

**Four typed columns, not one JSONB.** The range CHECK above is expressible on columns and
not on JSONB without a function, and a money-adjacent number deserves a typed column.

**No index.** You never query leases *by* escalation rate, and a landlord has tens of
units (PLAN-PHASE2 §3.2's own reasoning).

### 2.3 `lease_escalation_correction` — new table, append-only

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK → organization, cascade | |
| `lease_id` | `uuid` NOT NULL FK → lease, **restrict** | |
| `old_mode` | `rent_escalation_mode` NOT NULL | |
| `old_rate_bps`, `old_interval_years` | `integer` / `smallint` NULL | |
| `old_compounding` | `rent_escalation_compounding` NULL | |
| `new_mode` | `rent_escalation_mode` NOT NULL | |
| `new_rate_bps`, `new_interval_years` | `integer` / `smallint` NULL | |
| `new_compounding` | `rent_escalation_compounding` NULL | |
| `reason` | `text` NOT NULL | 10..500 chars, enforced in the contract |
| `corrected_by_user_id` | `text` NOT NULL FK → user | |
| `created_at` | `timestamptz` NOT NULL | |

```sql
lease_escalation_correction_lease_idx (org_id, lease_id)
```

- **Append-only.** No `updated_at`, no `deleted_at`, no status. Changing the rent on a
  signed agreement without a record of who did it and why is the thing you regret.
- **`on delete restrict` on `lease_id`.** Unreachable in practice: the correction route
  refuses a `draft` (PATCH handles those) and a `draft`/`cancelled` lease is the only one
  that can be hard-deleted. Restrict is the correct posture for a financial record anyway.
- This is deliberately a small table, not a general audit log. Phase 3 will want a sibling
  for charge corrections; it should be a sibling, not a generalisation of this one.

### 2.4 Migration

**Entirely additive. No backfill, no multi-step migration, no data at risk, and
semantically a no-op** — every existing lease gets `escalation_mode = 'none'` and produces
byte-identical schedules. Two new enums, four new columns on `lease`, one new table, one
new CHECK, one new index.

Same two things to verify in the generated SQL that PLAN-PHASE2 §3.5 already requires:

1. enum casts in any predicate Drizzle emits untyped;
2. that the installed `drizzle-orm` emits `check()` — if not, append the `ALTER TABLE …
   ADD CONSTRAINT` to the *generated, uncommitted* migration.

---

## 3. The engine — `packages/contract/src/billing.ts`

### 3.1 How the clause reaches `buildSchedule`

`LeaseBillingTerms` gains **one** field:

```ts
export const leaseBillingTerms = z.object({
  /* …nine existing fields, unchanged… */
  /** NULL = a constant rent for the whole term. The no-clause fast path. */
  escalation: rentEscalation.nullable().default(null),
});
```

Nested nullable object, not four nullable fields: one thing to check, one early return,
and the DB's all-or-nothing CHECK has a direct analogue in the type.

### 3.2 New exported surface

```ts
/* ---------- the clause ---------- */
export const rentEscalationMode: z.ZodEnum<['none', 'percent']>;
export const rentEscalationCompounding: z.ZodEnum<['compound', 'simple']>;
export const rentEscalationModeLabels: Record<RentEscalationMode, string>;
export const rentEscalationCompoundingLabels: Record<RentEscalationCompounding, string>;
//   compound -> 'Compounds on the previous rent'
//   simple   -> 'Always on the original rent'

export const BPS_SCALE = 10_000;                   // 100% in basis points
export const MAX_ESCALATION_RATE_BPS = 5_000;      // 50% per step — the typo ceiling
export const MAX_ESCALATION_INTERVAL_YEARS = 10;
export const MAX_ESCALATION_CYCLES = 100;          // loop bound, unreachable in practice
export const ESCALATION_ROUNDING_UNIT = 100;       // one major unit

export const rentEscalation = z.object({
  mode: z.literal('percent'),
  rateBps: z.number().int().min(1).max(MAX_ESCALATION_RATE_BPS),
  intervalYears: z.number().int().min(1).max(MAX_ESCALATION_INTERVAL_YEARS),
  compounding: rentEscalationCompounding,
});
export type RentEscalation = z.infer<typeof rentEscalation>;

/* ---------- the three functions ---------- */

/** How many escalations have taken effect on or before `on`. 0 before the first
 *  anniversary. Returns 0 immediately when `terms.escalation === null`. */
export function escalationCyclesElapsed(terms: LeaseBillingTerms, on: IsoDate): number;

/** THE function. The rent in force for a period beginning on `periodStart`.
 *  Returns `terms.rentCents` by EARLY RETURN when `terms.escalation === null`. */
export function rentForPeriodStart(terms: LeaseBillingTerms, periodStart: IsoDate): number;

/** The rent ladder: `[r0, r1, … rN]`. For the lease form's live read-back and the
 *  lease detail's "what this costs over the term". `[rentCents]` when no clause. */
export function escalationStepRents(terms: LeaseBillingTerms, cycles: number): number[];

/** The next increase strictly after `from`, snapped to a period start, bounded by
 *  `effectiveBillingEnd`. `null` when no clause, or none remains in the term. */
export function nextEscalationOnOrAfter(
  terms: LeaseBillingTerms,
  from: IsoDate,
): { effectiveFrom: IsoDate; rentCents: number } | null;
```

### 3.3 The arithmetic, in full

```
escalateOnce(cents, bps):
  raw = (cents * (BPS_SCALE + bps)) / BPS_SCALE
  return Math.round(raw / ESCALATION_ROUNDING_UNIT) * ESCALATION_ROUNDING_UNIT

rentAtCycle(terms, k):
  if terms.escalation === null  -> return terms.rentCents
  if k === 0                    -> return terms.rentCents      # EXACT. Never rounded.
  if compounding === 'compound':
      r = terms.rentCents
      repeat k times: r = escalateOnce(r, rateBps)
      return r
  # simple
  return Math.round(terms.rentCents * (BPS_SCALE + k * rateBps) / BPS_SCALE
                    / ESCALATION_ROUNDING_UNIT) * ESCALATION_ROUNDING_UNIT

escalationCyclesElapsed(terms, on):
  if terms.escalation === null -> return 0
  calendar = calendarForSystem(terms.calendar)
  k = 0
  while k < MAX_ESCALATION_CYCLES:
      try:   next = calendar.addYears(terms.startDate, (k + 1) * intervalYears)
      catch RangeError: break      # see 3.6 — not representable means not reachable
      if compareIsoDate(next, on) > 0: break
      k += 1
  return k

rentForPeriodStart(terms, periodStart):
  if terms.escalation === null -> return terms.rentCents        # EARLY RETURN, line 1
  return rentAtCycle(terms, escalationCyclesElapsed(terms, periodStart))
```

**Worked: 10% a year, compound, from ₹5,333.00** (`533300` cents) — fixture `E-R1`:

| cycle | exact | ÷100 | rounded | rent |
|---|---|---|---|---|
| 0 | — | — | — | `533300` (₹5,333.00, untouched) |
| 1 | `586630` | `5866.30` | `5866` | `586600` (₹5,866) |
| 2 | `645260` | `6452.60` | `6453` | `645300` (₹6,453) |
| 3 | `709830` | `7098.30` | `7098` | `709800` (₹7,098) |
| 4 | `780780` | `7807.80` | `7808` | `780800` (₹7,808) |
| 5 | `858880` | `8588.80` | `8589` | `858900` (₹8,589) |

**The no-drift claim, precisely.** Every step takes an exact integer in and returns an
exact integer out, so the ladder is reproducible byte-for-byte from
`(rentCents, rateBps, intervalYears, compounding, k)` alone — it does not depend on which
periods were walked, on `through`, or on evaluation order. That is the property Phase 3's
regeneration needs (I18). The *deviation from the ideal real-number compound* after five
steps is `858900 − 858885 = 15` cents, ₹0.15, and it is bounded, not accumulating, because
each step re-rounds from an exact integer rather than from a running float.

**Same base, `simple`** — fixture `E-R2`: `533300, 586600, 640000, 693300, 746600, 800000`.
Cycle 5 is `799950 → 7999.5 → 8000` and therefore **pins half-up at the exact .5
boundary**; banker's rounding would give `799900`.

**Overflow.** Worst case `1e8 × 15000 = 1.5e12` at cycle 1, and after ten 50% compounds
`5.8e9 × 15000 ≈ 8.6e13` — still two orders of magnitude inside `Number.MAX_SAFE_INTEGER`
(`9.007e15`), so every intermediate is exactly representable and `Math.round` is the only
place a fraction exists. Identical guarantee to `prorate`'s, stated for the same reason.

### 3.4 The one line that changes in `buildSchedule`

```diff
  const daysInPeriod = daysBetweenInclusive(p.start, p.end);
  const daysOccupied = daysBetweenInclusive(occupiedStart, occupiedEnd);
+ const periodRent   = rentForPeriodStart(terms, p.start);
  const amountCents =
-   daysOccupied === daysInPeriod ? terms.rentCents : prorate(terms.rentCents, daysOccupied, daysInPeriod);
+   daysOccupied === daysInPeriod ? periodRent : prorate(periodRent, daysOccupied, daysInPeriod);
```

Nothing else in the function moves. `effectiveBillingEnd`, the period walk, the due-date
clamp, the generation key, `isProrated` — all untouched. **Proration now applies to the
escalated rent for that period**, which is the only coherent reading and which restates
I7 (see §3.8).

No new call to `periodsOverlapping`, no new date function, no caching layer:
600 periods × ≤10 cycles is 6,000 integer operations, which is nothing. Do the simple
thing; a memoised ladder would be a second implementation of the same recurrence inside
one file, which is exactly the shape this design exists to avoid.

### 3.5 Preserving the 53 Gregorian fixtures — stated as a contract

The brief's hard requirement. Three mechanisms, in order of strength:

1. **`PlannedCharge` gains no field.** The acceptance criterion the orchestrator holds the
   task to is mechanical: **`git diff` on `billing.fixtures.ts` and `billing.bs.fixtures.ts`
   must touch only `terms:` objects — not one character inside any `expected:` array.**
   This is why §1 decision 11 refuses the otherwise-obviously-useful
   `rentCentsForPeriod` field. The cost is one line in the UI (§5.2); the benefit is that
   the 53 Gregorian and 6 Bikram Sambat fixtures become a genuine regression net rather
   than something that had to be re-baselined.
2. **An early return on line one.** `rentForPeriodStart` returns `terms.rentCents` before
   any arithmetic when `escalation === null`. Not "the loop runs and multiplies by 1" — an
   early return, so a no-clause lease executes a code path escalation cannot reach.
3. **`escalation: null` added explicitly to all 34 existing `terms` objects**
   (18 schedule + 5 generation + 11 billingEnd in `billing.fixtures.ts`, plus the 6 in
   `billing.bs.fixtures.ts`). Explicit, not `.optional()` on the TS output type: a
   mechanical diff that the suite then *proves* is behaviour-free, rather than a field
   quietly defaulting where nobody looks.

Wire-level, `escalation` is `.nullable().default(null)`, so no existing API caller or
stored row is required to send it.

### 3.6 The Bikram Sambat range, and the guarded catch

`escalationCyclesElapsed` probes `addYears(startDate, (k+1) * intervalYears)` to decide
whether to stop. Near the end of the BS table (AD 2034-04-13, per `docs/DATES.md`) that
probe can throw `BsDateOutOfRangeError` *before* the comparison that would have terminated
the loop. The loop therefore catches `RangeError` and breaks.

This is sound, not a papered-over bug: **if the next anniversary is not representable, it
is certainly past anything the schedule can reach**, because the route already clamps the
window with `validateEndDateSchedulable` and `buildScheduleOrThrow`
(`apps/api/src/lib/schedule.ts`). `BsDateOutOfRangeError extends RangeError`, so the catch
must be narrow — `if (e instanceof RangeError) break; throw e` — and commented with this
reason. `MAX_ESCALATION_CYCLES = 100` is the belt-and-braces bound so an implementation
bug can never hang the browser.

**Escalation adds no new BS failure mode.** It calls exactly the `addYears` the yearly
cadence already calls, through exactly the same `Calendar` resolved from `terms.calendar`.

### 3.7 The straddle, explicitly — the disputed-invoice case

Two equivalent statements of the same rule. The first is the explanation; the second is
the implementation.

- **Explanation:** an escalation snaps forward to the first billing period that *begins*
  on or after its raw anniversary. By construction, no period ever straddles.
- **Implementation:** the rent for period `p` is `rentAtCycle(terms, n)` where `n` is the
  number of raw anniversaries falling on or before `p.start`.

| Cadence | Raw anniversary | Lands on a period start? | Effect |
|---|---|---|---|
| yearly, `intervalYears` any | `addYears(startDate, k·i)` | **Always** — the period anchor is the same `addYears` from the same `startDate` | No straddle possible. The anniversary *is* a period boundary. |
| monthly, start on the 1st | e.g. `2027-04-01` | Yes | No straddle. |
| monthly, start mid-month | e.g. start `2026-03-15` → `2027-03-15` | **No** | March 2027 bills at the **OLD** rent; April 2027 is the first month at the new one. |

**Why old and not new, and not a split** (fixture `E2`):

- A split would emit two charges for one period, breaking `generationKey === periodStart`
  (I3) and doubling the invoice count at every anniversary. It also forces Phase 3's
  charge table to carry two rows with the same natural key. Rejected.
- Taking the new rent for the whole straddling month charges the increase for up to 30
  days before the agreement makes it due. Over-bills.
- Taking the old rent under-bills the landlord by a fraction of one month's *increase*,
  once per cycle — at 10% on ₹5,333 with a mid-month anchor, that is roughly ₹270 a year.
  Visible, small, and in the direction a dispute is survivable.

The yearly-cadence row is worth re-reading: because both the period anchor and the
escalation anchor are `calendar.addYears(startDate, n)`, they coincide exactly, including
on a leap-day start where both clamp to Feb 28 (fixture `E6`). **`clampDayToMonth` — reached
via `Calendar.addYears` — is the right tool, and it is already in use; escalation writes no
new date arithmetic whatsoever.** 29 February and 32 Jestha are handled by the identical
code path that already handles them for periods, and `E6`/`E8` pin both.

### 3.8 Invariants — new, and one restated

| # | Invariant | Asserted by |
|---|---|---|
| **I7′** | **RESTATED.** `daysOccupied === daysInPeriod ⟹ amountCents === rentForPeriodStart(terms, periodStart)`, exactly. Under `escalation: null` this reduces to the old I7 verbatim. | Property test over every schedule fixture. |
| **I15** | **No-clause identity.** Every fixture with `escalation: null` produces its committed `expected` byte-for-byte. | The existing suite, plus a CI check that no `expected:` line changed in either fixture file. |
| **I16** | **Rent is non-decreasing in `periodStart`** for any clause. Asserted on the rent, not on `amountCents` — a prorated final period legitimately falls. | Property test over every escalation fixture. |
| **I17** | **Cycle-0 identity.** `rentForPeriodStart(terms, d) === terms.rentCents` exactly, with no rounding, for every `d` before the first anniversary — including a non-round base like `533350`. | `E-R4`. |
| **I18** | **Order independence.** The ladder is a function of `(rentCents, rateBps, intervalYears, compounding, k)` only. Recomputing a schedule years later with a different `through` yields the same per-period rents. | Dedicated test; this is what makes Phase 3's regeneration safe. |
| **I19** | `billing.ts` gained no new date function. `escalationCyclesElapsed` reaches the calendar only through `Calendar.addYears`. | Source-grep test, same spirit as the existing purity guard. |
| I1, I8, I9, I13, I14 | **Unchanged and still hold.** Adding a clause changes the *terms object*, not monotonicity in `through` — the same argument Amendment A.3 makes for a policy flip. | Existing tests. |

### 3.9 Validation — `validateBillingTerms`

Gains, after the existing checks, all skipped when `escalation === null`:

- `rateBps` integer in `1..MAX_ESCALATION_RATE_BPS`. **Zero is rejected**: a 0% clause is
  no clause, and two representations of one state is a bug factory.
- `intervalYears` integer in `1..MAX_ESCALATION_INTERVAL_YEARS`.
- Nothing else. A clause on a lease shorter than one interval is harmless — it simply
  never fires — so it is a **form warning, not a 422**.

The `5000` ceiling is where the 100%-instead-of-10% typo dies: `10000` bps is refused at
the boundary and never reaches a charge. It does not eliminate the need for §6's correction
route (1000 vs 100 — 10% vs 1% — still passes), but it removes the most damaging case.

---

## 4. API surface

All paths under `/v1`. `401` and `500` possible everywhere, not repeated per row.

### 4.1 New routes — landlord only (`requireAuth`)

| Method | Path | Request | Response | Errors | Who |
|---|---|---|---|---|---|
| POST | `/v1/leases/:id/correct-escalation` | `correctEscalationBody` | `200 lease` | 404, 409, 422 | landlord, own org |
| GET | `/v1/leases/:id/escalation-corrections` | — | `{ items: escalationCorrection[] }` | 404 | landlord, own org |

```ts
correctEscalationBody = {
  escalation: rentEscalation.nullable(),      // null removes the clause entirely
  reason: z.string().trim().min(10).max(500), // REQUIRED
}
escalationCorrection = {
  id, leaseId,
  oldEscalation: rentEscalation.nullable(),
  newEscalation: rentEscalation.nullable(),
  reason, correctedByName, createdAt,
}
```

`409` cases, with their messages:

| Attempt | Message |
|---|---|
| lease is `draft` | *"This lease is still a draft. Edit the escalation clause directly."* (PATCH already allows it) |
| lease is `cancelled` | *"A cancelled lease cannot be corrected."* |

Unpaginated list, by design: a lease has at most a handful of corrections, ever.

### 4.2 Existing routes — new fields, no shape changes

| Route | Change |
|---|---|
| `POST /v1/leases` | `createLeaseBody` accepts `escalation` (nullable, defaults `null`). |
| `PATCH /v1/leases/:id` | Accepts `escalation` **on a `draft` only**. On anything else, `409` naming `/correct-escalation`. |
| `POST /v1/leases/:id/renew` | `escalation` optional; **defaults to the predecessor's clause**, matching how `rentFrequency` defaults. The renewal re-anchors on its own `start_date` and its own `rentCents` — correct, it is a new agreement. |
| `GET /v1/leases`, `GET /v1/leases/:id` | `leaseSummary` carries `escalation`. |
| `GET /v1/leases/:id/schedule` | **Shape unchanged. Numbers change.** |
| `GET /v1/portal/leases*` | `portalLease` carries `escalation`. |

### 4.3 Mutability, revised

`illegalUpdateField`'s `RENEW_FIELDS` currently names `/renew`. **Escalation needs its own
message**, because the user explicitly rejected renewal as the model for this clause —
pointing a landlord at `/renew` to fix a typo would push them into creating the fabricated
tenancy this whole design refuses.

```
status draft      -> escalation freely editable via PATCH
status active     -> PATCH 409: "The escalation clause is part of the signed agreement.
                     Use /correct-escalation to fix a mistake."
ended/terminated  -> same 409, same message. The route itself still works: a clause
                     mis-entered on a lease that has since ended still needs fixing.
cancelled         -> 409 on both paths.
```

**A correction is retroactive to cycle 0.** It replaces the clause as though it had always
been that — 100% → 10% re-prices every cycle. That is the only coherent reading of "I
typo'd". A landlord who wants a genuine mid-term *change* of clause is amending the
agreement, which is a new signed document and out of scope. Say so in the dialog copy.

### 4.4 Tenant isolation walk — "I am landlord B holding landlord A's UUID"

| Attempt | Result | Why |
|---|---|---|
| `POST /v1/leases/{A_lease}/correct-escalation` | `404` | `getLease(orgId = B, …)` returns nothing. The route resolves the lease before reading the body. Identical resolver to every other lease route — no new reach. |
| `GET /v1/leases/{A_lease}/escalation-corrections` | `404` | Same resolver, called first. |
| `POST /v1/leases/{own lease}/correct-escalation` with a forged `orgId` in the body | ignored | No route reads an org id from a request. Grep-checkable, already on the reviewer checklist. |
| Reads a correction row by id | no route accepts one | Corrections are only ever reached through a resolved lease. |
| Tenant hits either route | `404` from the router | Neither path is under `/v1/portal`; `requireTenant` never sees them. |
| Tenant reads the correction *history* | **structurally absent** | `portalLease` carries the current clause only. `reason` is landlord-written free text and belongs with `lease.notes` in the landlord-private set. |

`lease_escalation_correction` carries `org_id` and every repo function takes `orgId` first
and filters on it, per ARCHITECTURE §5. **The correction functions live in the existing
`db/repo/lease.ts`** — no new repo file, so `MIN_LANDLORD_REPO_FILES` and
`MIN_PORTAL_REPO_FILES` are **not** bumped.

### 4.5 What the tenant sees, and why

`portalLease` gains `escalation`. **Yes, the tenant sees the clause** — identical reasoning
to Amendment A.5's `moveOutBillingPolicy`: it is a term of their tenancy, it is the single
thing they most need to see coming, and withholding it would be worse than showing it. It
also lets the portal preview its own schedule through the same `billingTermsFor` +
`buildSchedule`.

---

## 5. Contract additions — file by file, named

**Four files extended. None new. Nothing rewritten.**

### 5.1 `packages/contract/src/billing.ts` — EXTENDED

Everything in §3.2: `rentEscalationMode`, `rentEscalationCompounding`, their label maps,
`rentEscalation`, `BPS_SCALE`, `MAX_ESCALATION_RATE_BPS`, `MAX_ESCALATION_INTERVAL_YEARS`,
`MAX_ESCALATION_CYCLES`, `ESCALATION_ROUNDING_UNIT`, `escalationCyclesElapsed`,
`rentForPeriodStart`, `escalationStepRents`, `nextEscalationOnOrAfter`. Plus
`leaseBillingTerms.escalation` and the one-line change inside `buildSchedule`.

Still imports `common.ts` and `./calendar/*` only. No cycle.

### 5.2 `packages/contract/src/billing.fixtures.ts` — EXTENDED

- `escalation: null` on all 34 existing `terms` objects. **No `expected` array changes.**
- `export interface EscalationRentFixture { name; terms; cycles; expected: number[] }`
- `export const escalationRentFixtures: readonly EscalationRentFixture[]` — `E-R1`..`E-R5`.
- Eight new entries in `scheduleFixtures` — `E1`..`E7`, `E9`.

### 5.3 `packages/contract/src/billing.bs.fixtures.ts` — EXTENDED

`escalation: null` on its 6 `terms`; one new BS escalation schedule fixture, `E8`.

### 5.4 `packages/contract/src/lease.ts` — EXTENDED

- `createLeaseBodyShape` gains `escalation: rentEscalation.nullable().default(null)`;
  `updateLeaseBody` inherits it through `.partial()`.
- `renewLeaseBody` gains `escalation: rentEscalation.nullable().optional()`.
- `leaseSummary` gains `escalation: rentEscalation.nullable()`.
- `billingTermsFor`'s `Pick<…>` gains `'escalation'`; the returned object gains it.
- `billingTermsFromCreateBody` gains `escalation: data.escalation ?? null`.
- NEW `correctEscalationBody`, `escalationCorrection` (§4.1).
- Re-export `rentEscalation`, `rentEscalationMode`, `rentEscalationCompounding` and their
  label maps — same one-import convenience as `rentFrequency`.

### 5.5 `packages/contract/src/portal.ts` — EXTENDED

`portalLease` gains `escalation: rentEscalation.nullable()`.

### 5.6 `packages/contract/src/routes.ts` — EXTENDED

```ts
leases: {
  ...existing,
  correctEscalation:     (id) => `/v1/leases/${id}/correct-escalation`,
  escalationCorrections: (id) => `/v1/leases/${id}/escalation-corrections`,
},
```

### 5.7 Fixtures to pin — every figure computed

**Rent ladders** (`escalationRentFixtures`):

| # | base | rate | mode | ladder | what it pins |
|---|---|---|---|---|---|
| `E-R1` | `533300` | 1000 | compound | `533300, 586600, 645300, 709800, 780800, 858900` | the user's own number; the five-step no-drift claim |
| `E-R2` | `533300` | 1000 | simple | `533300, 586600, 640000, 693300, 746600, 800000` | **half-up at exactly `.5`** (`799950 → 800000`) |
| `E-R3` | `150000` | 1000 | compound | `150000, 165000, 181500, 199700, 219700` | half-up mid-ladder (`199650 → 199700`) |
| `E-R4` | `533350` | 1000 | compound | cycle 0 is `533350` **exactly** | **I17 — the base rent is never rounded** |
| `E-R5` | `533300` | — | `escalation: null` | every cycle `533300` | the no-clause fast path |

**Schedules** (added to `scheduleFixtures`):

| # | Lease | What it pins |
|---|---|---|
| `E1` | monthly, rent `533300`, start `2026-04-01`, end `2031-03-31`, billingDay 1, 10%/1yr compound, through `2031-04-01` | **The requirement, end to end.** 60 entries, five runs of 12 at `533300 / 586600 / 645300 / 709800 / 780800`. Matches `E-R1` exactly. |
| `E2` | monthly, rent `100000`, start `2026-03-15`, end null, billingDay 1, 10%/1yr compound, through `2027-06-01` | **The straddle.** Period `2027-03-01` (which *contains* the `2027-03-15` anniversary) is `100000`; `2027-04-01` is the first at `110000`. 16 entries; the first is the `17/31 → 54839` stub from F3. |
| `E3` | yearly, rent `2400000`, start `2026-04-01`, 10%/**2**yr compound, through `2031-04-01` | **"every two year".** 6 entries: `2400000, 2400000, 2640000, 2640000, 2904000, 2904000`. |
| `E4` | `E1`'s terms with `compounding: 'simple'` | The two modes diverging from cycle 2 (`645300` vs `640000`). |
| `E5` | monthly, rent `100000`, start `2023-06-15`, ledgerStart `2026-07-01`, 10%/1yr compound, through `2026-12-01` | **Onboarding an in-flight escalating tenancy.** First generated period is `2026-07-01` at cycle 3 → `133100`, `periodIndex: 37`. Pins both the ledger-start interaction and "`rentCents` is the rent at *start*". |
| `E6` | yearly, rent `1200000`, start **`2028-02-29`**, 10%/1yr compound, through `2031-01-01` | **Leap-day anniversary.** Anniversaries clamp to `2029-02-28` and `2030-02-28` — the same dates F8's periods already start on. Rents `1200000, 1320000, 1452000`. |
| `E7` | monthly, rent `100000`, start `2026-01-01`, end `2027-06-10`, billingDay 5, 10%/1yr compound | **Proration on the escalated rent.** 18 entries: 12 at `100000`, 5 at `110000`, then June 2027 `10/30` days → `round(110000 × 10/30) = 36667`, due `2027-06-05`. This is what proves I7′. |
| `E8` | Bikram Sambat monthly lease, 10%/1yr compound (`billing.bs.fixtures.ts`) | The anniversary is a **BS** anniversary, landing on a Gregorian date that is not start+365. Proves the calendar seam carries through. |
| `E9` | `E1`'s terms with `escalation: null` | One flat run of 60. The regression net, at the cost of one fixture. |

---

## 6. Knock-on effects

### 6.1 The schedule summary — the collapse finally earns its keep

`apps/web/src/features/leases/schedule-summary.ts` already collapses consecutive
equal-amount periods, and its own comment anticipates this exactly: *"a rent change
mid-term that produces two different-amount runs … collapses and expands correctly too."*
It does. The **labelling** does not: `labelForGroup` returns `'Rent'` for index 0 and
`'Then'` for everything after, so `E1` renders *Rent / Then / Then / Then / Then*.

**Change `labelForGroup` to return a descriptor, not a string**, and let
`LeaseScheduleSummary` format it with `formatCivilDate` (which needs the calendar, and the
calendar does not belong in `schedule-summary.ts`):

```ts
export type GroupLabel =
  | { kind: 'rent' }            // single-rate lease, or the first run
  | { kind: 'from'; date: IsoDate }   // a later run — "From 1 Apr 2027"
  | { kind: 'firstPeriod' }
  | { kind: 'finalPeriod' }
  | { kind: 'proratedPeriod' };
```

`E1` then reads:

```
Rent              ₹5,333.00 / month   ·  12 periods  ·  Apr 2026 – Mar 2027
From Apr 2027     ₹5,866.00 / month   ·  12 periods  ·  Apr 2027 – Mar 2028
From Apr 2028     ₹6,453.00 / month   ·  12 periods  ·  Apr 2028 – Mar 2029
From Apr 2029     ₹7,098.00 / month   ·  12 periods  ·  Apr 2029 – Mar 2030
From Apr 2030     ₹7,808.00 / month   ·  12 periods  ·  Apr 2030 – Mar 2031
Total over the term                                            ₹3,90,696.00
          [ Show every period (60) ]
```

Five lines instead of sixty, and **"Total over the term" stops being obvious arithmetic and
starts being the number a landlord actually wants.** Both files are `apps/web`, so the
signature change is clean and needs no contract change.

**The preview window must grow.** `defaultPreviewThrough` runs `366 × 3` days forward, so a
five-year lease previews three of its five rates. **When a clause is present and `endDate`
is set, run the wizard's and the lease detail's preview to the full term** (still clamped
by the existing `SCHEDULE_SANITY_DAYS = 3653`). The review step exists to show the landlord
what they just agreed to, and a five-year clause is precisely the thing you review once.
60 rows is fine — it collapses to 5.

### 6.2 The lease form

A closed-by-default disclosure on the terms step, **"Rent increases over the term"**, so a
single-rate lease is visually unchanged:

- **Mode:** *No increase* (default) / *Percentage*.
- **Rate:** entered as a **percentage with up to 2 decimals** (`10`, `7.5`, `10.25`) and
  converted at the form edge — `Math.round(pct * 100)` in, `bps / 100` out. The landlord
  never types `1000`. **The `Math.round` is load-bearing: `7.35 * 100 === 734.9999999999999`
  in IEEE754**, and a truncating conversion would store `734` bps. Test it with `7.35`.
- **Interval:** *Every year* (default) / *Every 2 years*, with 3..10 available but not
  prominent.
- **Compounding:** *Compounds on the previous rent* (default) / *Always on the original
  rent*. Landlord language, never "compound/simple".
- **The live ladder read-back**, from `escalationStepRents`:
  *₹5,333 → ₹5,866 → ₹6,453 → ₹7,098 → ₹7,808*.
  **This is the single best defence against the 100%-vs-10% typo** — a landlord who meant
  10% sees `₹10,666` and stops, which no server-side validation can do as well.
- A soft warning, not a 422, when the term is shorter than one interval: *"This lease ends
  before the first increase would apply."*

### 6.3 The in-flight onboarding trap — the likeliest data-entry error in the feature

`rentCents` is **the rent at `start_date`**, not today's rent. A landlord onboarding a
tenancy that began in 2023 and has already escalated twice must enter the *original* rent.
Entering today's rent silently re-prices the whole remaining term.

Why not redefine `rentCents` as "rent at `ledgerStartDate`"? Because the anniversary clock
is anchored on `start_date`; anchoring the amount and the clock to different dates is
incoherent and would make `escalationCyclesElapsed` meaningless.

**The UI carries the whole mitigation.** When a clause is set and `startDate` is in the past
(`localToday(propertyTimezone)`, never the browser clock):

- relabel the field **"Rent at lease start"**;
- show **"Current rent: ₹1,331.00"** beside it, from `rentForPeriodStart(terms, today)`;
- repeat the current rent on the review step.

`E5` pins the behaviour; this copy is what makes it discoverable.

### 6.4 Lease detail and the portal

- **Terms panel** gains an *Escalation* row: *"10% every year, compounding — next increase
  1 Apr 2027 → ₹6,453.00"*, from `nextEscalationOnOrAfter`. **No date arithmetic in the
  component**: the anniversary day-and-month is just `startDate` rendered through
  `formatCivilDate`, and the next-increase date comes from the contract.
- **A corrections list** on the detail page when `escalationCorrections` is non-empty:
  old → new, reason, who, when.
- **Portal lease** shows the same escalation line and next-increase line. **No history** —
  `reason` is landlord-private.

### 6.5 Phase 3 — what to write into that task file now

1. **The generator reads `rentForPeriodStart`, never `lease.rent_cents`.** Nothing in
   `apps/api` may multiply a rent by a rate.
2. **A clause correction is a correction trigger**, identical in kind to Amendment A.5's
   `moveOutDate` edit. Already-written charges are **never silently re-priced**. The
   correction route gains a response field listing the `generationKey`s whose computed
   amount now differs from what was written, and the UI surfaces *"N charges were written
   under the old clause and need review"* with a void-and-supersede link each. **The
   generator never un-writes.**
3. **I18 is the licence to regenerate.** Because the ladder depends only on
   `(rentCents, rateBps, intervalYears, compounding, k)`, a self-healing cron run years
   later computes the same per-period rents it would have computed on day one.
4. Any Phase 3 text assuming a constant rent — a balance projection, an "expected annual
   income" report, a reminder template quoting "your rent of X" — must take the rent from
   the **charge row**, which is the materialised truth, not from `lease.rent_cents`.

---

## 7. Task split

Contract frozen first, then both agents dispatched at once. **The only shared surface is
`packages/contract/**`.** No file outside it is touched by both. Neither agent edits the
contract; if it is wrong, stop and report upward.

### 7.1 The paragraph that goes verbatim in both task files

> *A lease's rent is no longer a constant. `terms.rentCents` is the rent for cycle 0 only.
> The rent for any period is `rentForPeriodStart(terms, periodStart)` — in the contract,
> pure, fixture-pinned. If you find yourself multiplying a rent by a percentage, or
> converting a percentage to basis points anywhere except the lease form's input edge, you
> are writing the second implementation this whole design exists to prevent.*

### 7.2 backend-dev — `apps/api/**` only

1. **Schema**: `rentEscalationModeEnum`, `rentEscalationCompoundingEnum`, four `lease`
   columns, `lease_escalation_ck`, `lease_escalation_correction` + its index. One generated
   migration; verify the enum casts and `check()` support before committing it.
2. **`db/repo/lease.ts`**: select / insert / update the four columns on every existing
   query; `correctEscalation(orgId, db, userId, id, body)`;
   `listEscalationCorrections(orgId, db, leaseId)`. `orgId` first, filtered in every
   `WHERE`. **No new repo file — do not bump the guard floors.**
3. **`lib/mappers.ts`**: `mapLeaseSummary` / `mapPortalLease` assemble
   `escalation: mode === 'none' ? null : { mode, rateBps, intervalYears, compounding }`.
   New `mapEscalationCorrection`. Never spread a row.
4. **`illegalUpdateField`**: the four escalation fields are illegal on a non-draft, with
   the `/correct-escalation` message — **not** the `/renew` one (§4.3).
5. **`renewLease`**: carries the predecessor's clause when the body omits `escalation`.
6. **`routes/leases.ts`**: the two new routes. Resolve the lease *before* reading the body.
7. **Extend the source-grep guard**: `rateBps` / `escalation_rate_bps` may not appear in an
   arithmetic expression anywhere in `apps/api/src`; `BPS_SCALE` and
   `ESCALATION_ROUNDING_UNIT` may not be referenced outside `packages/contract`.
8. **Tests**:
   - `E1`..`E9` asserted **through `GET /v1/leases/:id/schedule`** — the fixture's exact
     `amountCents` and `dueDate`;
   - cross-org `404` on both new routes (§4.4);
   - `409` on `correct-escalation` against a `draft` and against a `cancelled`;
   - `409` on `PATCH` of `escalation` on an `active` lease, message naming
     `/correct-escalation`;
   - `422` on `rateBps: 10000` and on `rateBps: 0`;
   - the DB CHECK rejecting a half-written clause (rate with no interval);
   - a correction re-prices `GET /schedule` on the next call, and writes exactly one
     correction row.

### 7.3 frontend-dev — `apps/web/**` only

1. **Terms step**: the escalation disclosure, percent↔bps at the input edge with
   `Math.round`, the live ladder read-back from `escalationStepRents` (§6.2).
2. **"Rent at lease start" relabel + "Current rent" read-back** when a clause is set and
   `startDate < localToday(propertyTimezone)` (§6.3).
3. **`schedule-summary.ts`**: `labelForGroup` returns `GroupLabel`, not a string;
   `LeaseScheduleSummary` formats it via `formatCivilDate`. Update
   `schedule-summary.test.ts` and `LeaseScheduleSummary.test.tsx`.
4. **`schedule-preview.ts`**: extend the preview runway to the full term when a clause is
   present and `endDate` is set, still clamped by `SCHEDULE_SANITY_DAYS`.
5. **Lease detail**: the *Escalation* terms row with next-increase, and the corrections
   list.
6. **Correction dialog**: reason required (min 10 chars), an explicit *"this re-prices
   every period, including ones already shown"* warning, and a before/after ladder.
7. **Portal lease**: the escalation line and the next-increase line. No history.
8. **Tests**: `E1`..`E7`, `E9` asserted against `previewSchedule` — **the same fixtures the
   backend asserts**; the percent↔bps round-trip including `7.35`; the summary labelling
   with five runs; the ladder read-back rendering `₹10,666` for a 100% entry (the typo
   defence, asserted).

### 7.4 What they share — stated explicitly

`packages/contract/**`, frozen, and nothing else. Within it, the shared *executable*
surface is now `buildSchedule`, `effectiveBillingEnd`, `billingTermsFor`,
**`rentForPeriodStart`**, **`escalationStepRents`** and **`nextEscalationOnOrAfter`**.

---

## 8. Phasing — ship this before Phase 3

**Recommendation: land escalation now, as its own task, before Phase 3 starts.**

1. **It is a pure-function change today and a data migration later.** `buildSchedule` is
   the file Phase 3's generator is built on. Change the rent-per-period rule *after* charge
   rows exist and you are re-pricing written history; change it now and zero rows are at
   risk.
2. **Phase 3's hardest question is "did we write the right amount."** Writing the generator
   once, against the final rule, with the escalation fixtures already green, is strictly
   cheaper than writing it twice.
3. **`PlannedCharge` is unchanged**, so Phase 3's charge table design is unaffected either
   way. The only thing it inherits is a richer set of amounts — which it already has to
   handle, because proration already produces them.
4. The only piece that genuinely must wait is the correction route's Phase 3 half
   (re-flagging already-written charges), and that is purely additive.

Cost: one task of delay to Phase 3. Take it.

---

## 9. Risks, assumptions, and the one thing worth confirming

### 9.1 Risks

| Risk | Mitigation |
|---|---|
| **The in-flight onboarding trap** — a landlord enters today's rent where `rentCents` means the rent at `start_date`, silently re-pricing the term. **Highest-likelihood error in the feature.** | The "Rent at lease start" relabel + live "Current rent" read-back (§6.3); `E5` pins the semantics. |
| **Someone later adds `rentCentsForPeriod` to `PlannedCharge`** and quietly re-baselines the 53 fixtures. | Decision 11's reason goes in the zod schema's own comment, plus the CI check that no `expected:` line changes. |
| **Float sneaks in at the percent→bps conversion.** `7.35 * 100 === 734.9999999999999`. | `Math.round` at the form edge, tested with `7.35`; bps is the only representation stored or transported. |
| **Rounding to a whole major unit is wrong for a zero-decimal currency** (JPY, KRW). | Not in the `currency` enum today. `ESCALATION_ROUNDING_UNIT` is a named constant so the grep hits one place, plus a test asserting every member of the `currency` enum has 100 minor units. That test uses `Intl`, so it lives outside `billing.ts`. |
| **Compound vs simple mis-set**, producing a rent nobody expects by year 3. | Stored on the lease, shown in the terms panel, shown in the portal, and the live ladder makes the difference visible before save. |
| **`BsDateOutOfRangeError` from the anniversary probe** near the end of the BS table. | The narrow guarded `catch (RangeError) → break` in §3.6, with its justification commented. `E8` plus the existing `validateEndDateSchedulable` cover the path. |
| **`labelForGroup`'s signature change** breaks two existing web tests. | Both files are `apps/web`; frontend-dev owns both and the change is listed as task work, not discovered mid-flight. |
| A rolling lease (`endDate: null`) with a clause compounds for as long as `through` reaches. | Bounded by the route's 10-year sanity cap and `MAX_SCHEDULE_PERIODS`; 10 compounds at the 50% ceiling is `8.6e13`, two orders inside `MAX_SAFE_INTEGER`. |
| A correction on a long-ended lease re-prices a decade of history. | Allowed deliberately (a mis-entered clause on an ended lease still needs fixing), always audited, and in Phase 3 it surfaces as a review queue rather than a silent re-bill. |

### 9.2 Assumptions made without being told

1. The interval is a whole number of **years**. "Every six months" was not described and is
   not supported; adding it later means a `escalation_interval_months` column and a
   `Calendar.addMonths` anchor, which the design already accommodates.
2. The clause applies from the lease's own start, not from a separate "first increase date".
   A clause whose first increase is deliberately deferred (common in some markets) is not
   expressible today.
3. A renewal carries the predecessor's clause by default and re-anchors on its own start.
4. All six currencies in the enum have 100 minor units, so `ESCALATION_ROUNDING_UNIT = 100`
   is safe without putting `currency` into `LeaseBillingTerms`.
5. Corrections are not paginated and are not shown to tenants.

### 9.3 The one question worth asking — non-blocking, one sentence

Everything above is decided and buildable as written. One thing genuinely changes the
money and is cheap to confirm, so ask it as a single question rather than a batch:

> **"When the 10% lands, should the new rent round to whole rupees — ₹5,333 → ₹5,866 — or
> keep the exact paisa, ₹5,866.30?"**

**Default, already built into this plan: round to whole rupees** (nearest, half-up,
compounding from the rounded value). If they prefer exact minor units it is a
one-constant change — `ESCALATION_ROUNDING_UNIT = 1` — plus re-pinning `E-R1`, `E-R2`,
`E-R3` and the three schedule fixtures that quote a rounded figure. Do not hold the task on
the answer; build the default and change the constant if they say otherwise.

The straddle rule (§3.7) and compound-by-default (§1.4) are decided and do **not** need
confirming — they are documented, fixture-pinned, and reversible at the cost of one
fixture each.
