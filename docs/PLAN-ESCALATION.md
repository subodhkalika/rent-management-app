# Plan — Rent escalation: stored rent steps

> Written by `architect`. A **plan**, not a contract. The orchestrator turns §5 into real
> contract files, freezes them, then dispatches the §7 backend and frontend tasks in
> parallel.
>
> Builds on `docs/PLAN-PHASE2.md` (including Amendment A) and `docs/DATES.md`. Where this
> file and PLAN-PHASE2 disagree, this one wins for anything touching the per-period rent.
>
> **REVISION 2 — 2026-10-06.** Revision 1 modelled the clause as a *rule*: a pure function
> of `(base, rateBps, cycle)` evaluated at read time. The user corrected it. Sections
> changed by R2 are marked **[R2]**; everything unmarked carried over intact.

---

## 0. The requirement, and the correction that reshaped it

> *"the aggrement consists of 10% rent increase every year or every two year… this needs
> to be implemented in the same lease. its the same tenanat, its the same lease but its
> leased for about 5 years or so."*

**This is ONE lease.** A five-year agreement with a 10%-per-year clause is a single signed
document with a single tenant. Modelling it as a renewal chain would fabricate four
tenancies that never happened and make `leaseDetail.chain` lie. The clause belongs on the
lease.

### 0.1 **[R2]** The clause is a PROPOSAL, not a rule

> *"rather than rounding, it should be modifiable by the owner, because lets say they had
> decided 10% previously but they had good relations and he is only doing 5% increase or
> say the increase is 536.55, he is only going to increase it to 530. … if the owner wants
> to override the rent value, they can always modify the rent value and it stays what they
> fix it to be."*

A pure function of `(base, rate, cycle)` cannot express any of that. **What replaces it is
a stored list of rent steps — `(effectiveFrom, rentCents)` — where the clause is merely the
generator that drafts them. The stored steps are the truth; the formula is scaffolding that
produced a first version.**

This is better than R1 for four reasons beyond the stated requirement:

1. **It is honest.** A landlord signing a five-year lease sees all five numbers and
   corrects any of them *before* saving, rather than trusting a formula to be right about
   year four.
2. **Rounding stops being a rule we impose.** The generator proposes a sensible figure; the
   landlord fixes it if they disagree. R1's open question about whole rupees versus paisa
   **dissolves** — see §9.3.
3. **It subsumes the explicit-amounts case** — commercial agreements that write each year's
   rent into the contract. Same model, no clause at all, just steps.
4. **`rentForPeriodStart` becomes a lookup, not arithmetic.** No compounding at read time,
   no rounding at read time, no calendar call at read time. Simpler and auditable.

### 0.2 What R2 keeps from R1, unchanged

Integer basis points at the clause level. The anniversary anchored on `lease.start_date` in
the property's own calendar via `Calendar.addYears`. A period taking the rent in force at
its start, never split. The audit trail. Shipping before Phase 3. The byte-identical
guarantee for a lease with no steps beyond its base.

---

## 1. Decisions that matter, in one table

| # | Decision | One-line reason |
|---|---|---|
| 1 | **[R2]** Steps live in a child table `lease_rent_step`. The clause stays as four columns on `lease`. | Steps are the data the engine reads; the clause is the thing that drafted them, and the two have different lifetimes. |
| 2 | **[R2]** `lease.rent_cents` stays the base. **Steps are increases only** — `effective_from > start_date`, enforced. | Overrides the coordinator's lean, for a concrete reason: see §2.2. A mirrored base step would be a latent torn write on a driver with no interactive transactions. |
| 3 | **[R2]** `effective_from` is stored **already snapped to a billing-period start**, and validated as one. | The R1 straddle question is resolved at *generation* time, visibly, in stored data — never re-litigated at read time. |
| 4 | **[R2]** Steps are generated **at create**, by the contract's generator, run first in the browser. | The form must show the full editable ladder before the first save, and a draft's schedule preview must not be a lie. |
| 5 | **[R2]** Overriding a step recomputes **later `clause` steps**, and **never** touches a later `manual` step. The diff is shown before commit. | The override *is* the rent, so the clause should carry forward from it — but a figure a landlord set by hand is a decision, not a draft. |
| 6 | **[R2]** `rentForPeriodStart` is a **pure lookup** over sorted steps: no arithmetic, no calendar call. | The fixtures-unchanged guarantee becomes an early return on line one with literally zero maths behind it. |
| 7 | **[R2]** `LeaseBillingTerms` gains `rentSteps` and **never carries the clause at all.** | The engine does not need to know a clause exists; removing it from the terms object makes that structural. |
| 8 | Rate in **integer basis points** (10% = `1000`), never a float. | `7.35 * 100 === 734.9999999999999`; a rate feeding money cannot carry that. |
| 9 | Interval in **years**, independent of `rent_frequency`. | Monthly-billed + annually-escalating is the dominant real case. |
| 10 | **Compound by default**, `simple` recorded on the lease. | "10% every year" is normally applied to last year's rent; both must be expressible. |
| 11 | **[R2]** The generator *proposes* a figure rounded to the whole major unit, half-up. It is a **proposal**, not a rule. | A draft of ₹5,866 is a better starting point than ₹5,866.30, and the landlord types over it if they disagree. |
| 12 | A period takes the rent in force at its `periodStart`. **No period is ever split.** | One period = one charge = one `generationKey`; splitting breaks I3. |
| 13 | **[R2]** `PlannedCharge` gains no field. | Byte-identical output for a lease with no steps is the hard requirement; any new field breaks it for every lease. |
| 14 | **[R2]** A **future** step edits freely on an active lease. A step already in effect needs `/correct` with a reason, audited. | "Has it taken effect" is the line money crosses; it is one date comparison. |
| 15 | **[R2]** The **clause** is no longer audited by a table — it is documentation and moves no money on its own. Two tracking columns on `lease` instead. | Audit what moves money. This is a net simplification R1 could not make. |
| 16 | **Ship before Phase 3.** | Stored per-period rents are exactly what you want in place *before* a generator starts writing charges against them. |

---

## 2. Data model delta  **[R2 — substantially rewritten]**

Conventions unchanged: `casing: 'snake_case'`, UUIDv7 PKs, money as integer minor units,
`date` for civil dates, `timestamptz` for instants, `org_id text not null references
organization(id) on delete cascade` on every org-owned table.

### 2.1 New enums

```ts
export const rentEscalationModeEnum        = pgEnum('rent_escalation_mode',        ['none','percent']);
export const rentEscalationCompoundingEnum = pgEnum('rent_escalation_compounding', ['compound','simple']);
export const rentStepSourceEnum            = pgEnum('rent_step_source',            ['clause','manual']);
```

`'none'` exists so `escalation_mode` is `NOT NULL` with a default and the migration is a
semantic no-op. **The contract does not use `'none'` on a lease response** — it uses
`escalation: null`. The mapper translates.

`rent_step_source` is the field decision 5 turns on: `'clause'` means "the generator drafted
this and nobody has touched it", `'manual'` means "a human set this number". A step becomes
`'manual'` the moment a human edits it, and stays `'manual'` until an explicit *Reset to the
agreed figure* action hands it back.

### 2.2 `lease` — the clause stays, as documentation

| Column | Type | Notes |
|---|---|---|
| `escalation_mode` | `rent_escalation_mode` NOT NULL default `'none'` | |
| `escalation_rate_bps` | `integer` NULL | Basis points. `1000` = 10%. NULL iff mode is `'none'`. |
| `escalation_interval_years` | `smallint` NULL | 1 or 2 in practice; 1..10 allowed. |
| `escalation_compounding` | `rent_escalation_compounding` NULL | |
| **`escalation_updated_at`** | `timestamptz` NULL | **[R2]** decision 15 |
| **`escalation_updated_by_user_id`** | `text` NULL FK → user | **[R2]** |

```sql
lease_escalation_ck CHECK (
  (escalation_mode = 'none'
     AND escalation_rate_bps IS NULL AND escalation_interval_years IS NULL
     AND escalation_compounding IS NULL)
  OR
  (escalation_mode = 'percent'
     AND escalation_rate_bps       BETWEEN 1 AND 5000
     AND escalation_interval_years BETWEEN 1 AND 10
     AND escalation_compounding    IS NOT NULL)
)
```

One all-or-nothing CHECK, so a half-written clause is unrepresentable. Four typed columns,
not JSONB: the range CHECK is expressible on columns, and a money-adjacent number deserves
a typed one. No index — you never query leases *by* escalation rate.

**`lease.rent_cents` stays, and remains the base rent at `start_date`.**

> **Why the base is NOT a step — overriding the coordinator's lean.** The coordinator leaned
> towards every rent being a step "so there is one answer to *what is the rent on this
> date*". There is still exactly one answer — `rentForPeriodStart` — and that answer should
> be a **function**, not a table shape. Three concrete reasons to keep the base on `lease`:
>
> 1. **No interactive transactions.** `db/index.ts` uses the Neon HTTP driver (PLAN-PHASE2
>    §5.4). A base step duplicated into `lease.rent_cents` is a two-statement write with a
>    torn state in which the two disagree about the rent — the single worst torn state this
>    schema could have. Not duplicating it makes the drift unrepresentable.
> 2. **`rent_cents` is already load-bearing** in `createLeaseBody`, `leaseSummary`,
>    `portalLease`, `leaseChainEntry`, the list page and `lease_money_ck`. Demoting it to a
>    mirror buys nothing and touches everything.
> 3. **The branch it costs is the branch we want.** `if (steps.length === 0) return
>    rentCents` on line one *is* the byte-identical guarantee (§3.3). Folding the base into
>    the table would remove the very early return the fixture promise rests on.
>
> **The landlord-facing experience is unchanged:** the form renders the base as row 0 of one
> editable ladder, bound to `rentCents`. *The ladder is a presentation; the base is a
> column; the increases are rows.*

### 2.3 `lease_rent_step` — NEW, the table the engine reads

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK → organization, cascade | |
| `lease_id` | `uuid` NOT NULL FK → lease, **cascade** | Only ever runs on the hard-delete of a `draft`/`cancelled` lease, same as `lease_tenant`. |
| `effective_from` | `date` NOT NULL | **A billing-period start, strictly after `lease.start_date`.** |
| `rent_cents` | `bigint` NOT NULL | The rent from this date until the next step. |
| `source` | `rent_step_source` NOT NULL | `clause` = generator-drafted and untouched; `manual` = a human set it. |
| `clause_expected_cents` | `bigint` NULL | What the clause *would* have said. Display only — drives the "agreed ₹5,866, you set ₹5,300" line. NULL when there was no clause. |
| `note` | `text` NULL | Landlord-private, e.g. *"good tenant — 5% only"*. **Absent from every portal shape.** |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | |

```sql
lease_rent_step_money_ck CHECK (rent_cents >= 0)

lease_rent_step_uq   UNIQUE (lease_id, effective_from)
lease_rent_step_idx  (org_id, lease_id, effective_from)
```

- **`lease_rent_step_uq` makes "two rents on the same day" unrepresentable.** No `org_id`
  in it, for exactly the reason PLAN-PHASE2 §3.3 gives for `lease_unit_active_uq`:
  `lease_id` is already the PK of an org-scoped table, so adding `org_id` widens the key
  without changing uniqueness. Flag it in the schema comment so a reviewer does not read it
  as a tenancy miss.
- **`effective_from > lease.start_date` cannot be a CHECK** (it is cross-row). Enforced in
  `validateBillingTerms`, in the repo write path, and by a route test. Say so in the schema
  comment, because an unenforceable-looking rule with no comment invites someone to drop it.
- **`effective_from` must be a billing-period start** — same enforcement points. Monthly
  periods are calendar months, so that means the 1st; yearly periods are lease
  anniversaries. Both are exactly what a landlord would pick, and the date picker offers
  only those.
- **No soft delete.** A future step that is removed never took effect and is simply gone. A
  step that *has* taken effect cannot be removed at all — only corrected (§4.3).

### 2.4 `lease_rent_step_correction` — NEW, append-only, the money audit

| Column | Type |
|---|---|
| `id` | `uuid` PK |
| `org_id` | `text` NOT NULL FK → organization, cascade |
| `lease_id` | `uuid` NOT NULL FK → lease, **restrict** |
| `step_id` | `uuid` NOT NULL FK → lease_rent_step, **restrict** |
| `effective_from` | `date` NOT NULL (copied, so the row reads standalone) |
| `old_rent_cents`, `new_rent_cents` | `bigint` NOT NULL |
| `reason` | `text` NOT NULL (10..500, enforced in the contract) |
| `corrected_by_user_id` | `text` NOT NULL FK → user |
| `created_at` | `timestamptz` NOT NULL |

```sql
lease_rent_step_correction_idx (org_id, lease_id, created_at)
```

Append-only: no `updated_at`, no `deleted_at`, no status. **Only ever written when a step
that had ALREADY TAKEN EFFECT is changed** — that is the money event. Editing a future step
writes nothing here, because nothing has been billed and nothing is owed.

> **[R2] R1's `lease_escalation_correction` table is CUT.** In R1 the clause drove billing,
> so changing it moved money and needed an audit table and a dedicated route. In R2 the
> clause moves no money by itself — re-drafting the ladder is a separate, explicit action
> whose *step* changes are what get audited. The principle is **audit what moves money**,
> and it leaves R2 with one audit table where R1 had one plus a route pair.

### 2.5 Migration

**Entirely additive. No backfill, no multi-step migration, no data at risk, and
semantically a no-op** — every existing lease gets `escalation_mode = 'none'` and zero
steps, and produces byte-identical schedules. Three enums, six columns on `lease`, two new
tables, one CHECK, three indexes.

Same two verification steps PLAN-PHASE2 §3.5 already requires: enum casts in any predicate
Drizzle emits untyped, and `check()` support in the installed `drizzle-orm` (otherwise
append `ALTER TABLE … ADD CONSTRAINT` to the *generated, uncommitted* migration).

---

## 3. The engine — `packages/contract/src/billing.ts`  **[R2]**

### 3.1 What `LeaseBillingTerms` gains, and what it deliberately does not

```ts
export const rentStep = z.object({
  /** A billing-period start, strictly after the lease's startDate. Already snapped —
   *  see §3.5. The straddle is resolved at generation, never at read. */
  effectiveFrom: isoDate,
  rentCents: money,
});
export type RentStep = z.infer<typeof rentStep>;

export const leaseBillingTerms = z.object({
  /* …nine existing fields, unchanged… */
  /** Ascending by effectiveFrom, no duplicates, all > startDate, all period starts.
   *  EMPTY = a constant rent for the whole term. */
  rentSteps: z.array(rentStep).default([]),
});
```

**The clause is not in `LeaseBillingTerms` and never will be.** The engine does not need to
know a clause exists. Making that structural — rather than a convention — is decision 7, and
it is what guarantees nobody reintroduces compounding at read time.

### 3.2 `rentForPeriodStart` — a lookup, not arithmetic

```ts
export function rentForPeriodStart(terms: LeaseBillingTerms, periodStart: IsoDate): number {
  if (terms.rentSteps.length === 0) return terms.rentCents;   // EARLY RETURN, line 1
  let rent = terms.rentCents;
  for (const s of terms.rentSteps) {        // sorted ascending (I20)
    if (compareIsoDate(s.effectiveFrom, periodStart) > 0) break;
    rent = s.rentCents;
  }
  return rent;
}
```

No multiplication. No rounding. No calendar call. One `compareIsoDate` per step, over a
list whose realistic length is four. **This is strictly simpler than R1's compounding
fold**, and it is the coordinator's point: more auditable, because the number came from a
row somebody can look at rather than from a recurrence somebody has to re-derive.

**Beyond the last step, the rent is flat.** `rentForPeriodStart` never extrapolates. That is
deliberate and it is a real behaviour difference from R1 — see §3.6.

### 3.3 The one line that changes in `buildSchedule`

```diff
  const daysInPeriod = daysBetweenInclusive(p.start, p.end);
  const daysOccupied = daysBetweenInclusive(occupiedStart, occupiedEnd);
+ const periodRent   = rentForPeriodStart(terms, p.start);
  const amountCents =
-   daysOccupied === daysInPeriod ? terms.rentCents : prorate(terms.rentCents, daysOccupied, daysInPeriod);
+   daysOccupied === daysInPeriod ? periodRent : prorate(periodRent, daysOccupied, daysInPeriod);
```

Identical diff to R1. `effectiveBillingEnd`, the period walk, the due-date clamp, the
generation key and `isProrated` are all untouched. Proration applies to the rent in force
for that period, which restates I7 (§3.7).

### 3.4 The generator — still in the contract, and this is why

```ts
export const rentEscalationMode: z.ZodEnum<['none','percent']>;
export const rentEscalationCompounding: z.ZodEnum<['compound','simple']>;
export const rentEscalationModeLabels, rentEscalationCompoundingLabels;

export const BPS_SCALE = 10_000;
export const MAX_ESCALATION_RATE_BPS = 5_000;       // 50% per step — the typo ceiling
export const MAX_ESCALATION_INTERVAL_YEARS = 10;
export const MAX_GENERATED_STEPS = 30;
export const STEP_PROPOSAL_ROUNDING_UNIT = 100;     // one major unit — a PROPOSAL (§3.8)

export const rentEscalation = z.object({
  mode: z.literal('percent'),
  rateBps: z.number().int().min(1).max(MAX_ESCALATION_RATE_BPS),
  intervalYears: z.number().int().min(1).max(MAX_ESCALATION_INTERVAL_YEARS),
  compounding: rentEscalationCompounding,
});

/** Drafts the ladder. Snaps each effectiveFrom to a period start. Bounded by
 *  endDate and MAX_GENERATED_STEPS. The ONLY place the clause arithmetic lives. */
export function generateRentSteps(input: {
  clause: RentEscalation;
  baseRentCents: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  frequency: RentFrequency;
  calendar: CalendarSystem;
}): DraftRentStep[];          // RentStep + { source, clauseExpectedCents }

/** Re-drafts the ladder after a step is overridden. Later `clause` steps recompute
 *  from the new value; later `manual` steps are preserved verbatim (decision 5). */
export function recomputeLadderFrom(input: {
  clause: RentEscalation | null;
  steps: readonly DraftRentStep[];
  index: number;
  newRentCents: number;
}): DraftRentStep[];

/** What the clause alone would have said at cycle k. Display only — the
 *  "agreed ₹5,866, you set ₹5,300" line and `clause_expected_cents`. */
export function clauseExpectedRent(clause: RentEscalation, baseRentCents: number, cycle: number): number;
```

**The generator stays in `packages/contract` for the same reason `buildSchedule` does:** the
ladder the landlord previews in the browser must be byte-identical to the ladder the API
writes when the body omits `rentSteps`. Two implementations of the drafting arithmetic would
reintroduce exactly the divergence this design exists to prevent — one level up from where
R1 had it.

Arithmetic, unchanged from R1 and now confined to the generator:

```
proposeOnce(cents, bps) = Math.round(
  ((cents * (BPS_SCALE + bps)) / BPS_SCALE) / STEP_PROPOSAL_ROUNDING_UNIT
) * STEP_PROPOSAL_ROUNDING_UNIT

compound: fold proposeOnce from the previous step's rent
simple:   proposeOnce-style rounding of baseRentCents * (BPS_SCALE + k*rateBps) / BPS_SCALE
```

10%/yr compound from ₹5,333.00 drafts `586600, 645300, 709800, 780800` — the user's own
figures, now as four editable rows rather than an invisible recurrence.

Overflow is unchanged and bounded: worst case after ten 50% steps is ~`8.6e13`, two orders
inside `MAX_SAFE_INTEGER`, every intermediate exactly representable.

### 3.5 **[R2]** The straddle is resolved at generation, in stored data

R1 resolved the mid-month anniversary at read time, by counting anniversaries `<=
periodStart`. R2 does it once, at generation, and **stores the snapped date**:

```
rawAnniversary_k = calendar.addYears(startDate, k * intervalYears)
effectiveFrom_k  = the first period start on or after rawAnniversary_k
```

| Cadence | Raw anniversary | Snapped? | Stored `effective_from` |
|---|---|---|---|
| yearly, any interval | `addYears(startDate, k·i)` | No change needed — the period anchor is the same `addYears` from the same `startDate`, so it already *is* a period start | the anniversary |
| monthly, start on the 1st | `2027-04-01` | No change needed | `2027-04-01` |
| monthly, start mid-month (`2026-03-15` → `2027-03-15`) | mid-period | **Yes** | **`2027-04-01`** |

**This is a genuine improvement over R1.** A landlord reading the ladder sees *"Effective
1 Apr 2027"* — not a raw 15 March anniversary that mysteriously starts applying in April.
The rule is visible in the data instead of implicit in read-time arithmetic, and the
disputed-invoice case can no longer be re-litigated by a future reader of `buildSchedule`,
because `buildSchedule` has no opinion about it.

The reasoning for *which* way it snaps is unchanged from R1: a split would emit two charges
for one period (breaking `generationKey === periodStart`, I3) and double the anniversary
month's invoices; taking the new rent for the whole straddling month charges the increase up
to 30 days early. Snapping forward under-bills by a fraction of one month's *increase*, once
per cycle — roughly ₹270/year at 10% on ₹5,333. Visible, small, survivable. **And now the
landlord can simply override the step if they disagree**, which is the whole point of R2.

**Calendar.** `generateRentSteps` resolves `terms.calendar`, so a Bikram Sambat property
escalates on a BS anniversary. `clampDayToMonth` — reached through `Calendar.addYears` — is
the right tool and is already in use; 29 February and 32 Jestha go through the identical
path that already handles them for periods. **Escalation writes no new date arithmetic at
all, and R2 confines even that to the generator.** The BS table's AD-2034 ceiling is handled
by a narrow `catch (e) { if (e instanceof RangeError) break; throw e }` around the
anniversary probe inside `generateRentSteps`: if the next anniversary is not representable
it is certainly past anything the schedule can reach, the window already being clamped by
`validateEndDateSchedulable`. **`buildSchedule` itself can no longer throw a BS range error
from escalation at all**, because it never computes an anniversary — another R2 win.

### 3.6 **[R2]** Bounded ladders, and "flat past the last step"

A rolling lease (`endDate: null`) with a clause has no natural stopping point.
`generateRentSteps` emits at most `MAX_GENERATED_STEPS = 30` steps — 30 years at a one-year
interval, which no real lease reaches.

**Beyond the last stored step, the rent is flat.** State it loudly, because it is exactly
the kind of silence that bites: a lease still running past its generated ladder stops
escalating rather than extrapolating. Mitigation, which is cheap and belongs in this phase:
the lease detail shows **"Increases scheduled through <date>"**, and surfaces an *Extend the
ladder* action when the lease is still active and the last step is less than a year out.
The action is just "generate more steps and PUT them" — no new route.

### 3.7 Invariants — new, restated, and one dropped

| # | Invariant | Status |
|---|---|---|
| **I7′** | `daysOccupied === daysInPeriod ⟹ amountCents === rentForPeriodStart(terms, periodStart)`. With `rentSteps: []` this is the old I7 verbatim. | Carried from R1 |
| **I15** | **No-steps identity.** Every fixture with `rentSteps: []` produces its committed `expected` byte-for-byte. | **Strengthened** — the early return now has zero arithmetic behind it |
| **I16** | ~~Rent is non-decreasing.~~ | **[R2] DROPPED.** A landlord may *reduce* rent — a downturn renegotiation, or a concession. Nothing asserts monotonicity, and `E12` pins a decrease so nobody reintroduces it. |
| **I17** | Rent before the first step is `terms.rentCents` **exactly**. | Carried; now trivially true |
| **I18** | **Order independence / regeneration safety.** | **[R2] Massively strengthened.** In R1 this was a property of a recurrence. In R2 the rent for a period is *stored data*. Phase 3 regenerating a schedule in 2031 reads the same rows it read in 2026. |
| **I20** | **NEW.** `rentSteps` is strictly ascending by `effectiveFrom`, no duplicates, every entry `> startDate` and a period start. | `validateBillingTerms` + `lease_rent_step_uq` + a property test |
| **I21** | **NEW.** `rentForPeriodStart` performs no arithmetic and makes no calendar call. | Source-grep test over the function body |
| **I22** | **NEW.** `generateRentSteps` is deterministic and total: same inputs → same ladder, and it never throws for any in-range lease. | Generator fixtures + a fuzz over the BS boundary |
| I1, I8, I9, I13, I14 | Unchanged and still hold. Adding steps changes the terms object, not monotonicity in `through`. | Existing tests |

### 3.8 **[R2]** Where rounding went

`STEP_PROPOSAL_ROUNDING_UNIT = 100`, half-up, nearest — **but it is now the generator's
opening offer, not a money rule the system imposes.** A draft of ₹5,866 is a better starting
point than ₹5,866.30; a landlord who wants the paisa types `5866.30` and it is stored
exactly. No rounding happens anywhere at read time, so the "does it drift when compounded
five times" question has no surface left: **the five numbers are five rows.**

### 3.9 Validation — `validateBillingTerms`

Gains, all skipped when `rentSteps` is empty:

- strictly ascending `effectiveFrom`, no duplicates (I20);
- every `effectiveFrom > startDate`;
- every `effectiveFrom` is `isPeriodStart(frequency, startDate, effectiveFrom, calendar)`;
- every `effectiveFrom <= endDate` when `endDate` is set — a step after the term ends is
  dead data, and a `422` is kinder than a silently-ignored row;
- `rentCents >= 0` on each.

Clause validation (`rateBps ∈ 1..5000`, `intervalYears ∈ 1..10`) moves to the lease
request schemas, since the clause is no longer in `LeaseBillingTerms`. Zero bps is still
rejected — two representations of "no clause" is a bug factory. The 5000 ceiling is still
where the 100%-instead-of-10% typo dies, though R2 makes it far less critical: the landlord
*sees the drafted ladder* before saving.

---

## 4. API surface  **[R2 — rewritten]**

All paths under `/v1`. `401` and `500` possible everywhere.

### 4.1 New routes — landlord only (`requireAuth`, own org)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/leases/:id/rent-steps` | — | `{ items: rentStepSummary[] }` | 404 |
| PUT | `/v1/leases/:id/rent-steps` | `{ steps: rentStepInput[] }` | `{ items: rentStepSummary[] }` | 404, 409, 422 |
| POST | `/v1/leases/:id/rent-steps/:stepId/correct` | `{ rentCents, reason }` | `rentStepSummary` | 404, 409, 422 |
| GET | `/v1/leases/:id/rent-step-corrections` | — | `{ items: rentStepCorrection[] }` | 404 |

```ts
rentStepInput = {
  effectiveFrom: isoDate,
  rentCents: money,
  source: rentStepSource,            // the client says which; the server trusts it only
                                     //   to the extent that it re-derives 'clause' steps
  note: z.string().trim().max(500).optional(),
}
rentStepSummary = rentStepInput.extend({
  id: uuid,
  clauseExpectedCents: z.number().int().nullable(),
  createdAt, updatedAt,
})
```

**`PUT` replaces the whole ladder, not one step.** The client has to hold the whole ladder
anyway to render the before/after diff (§4.4), a landlord has at most a handful of steps, and
one endpoint with one rule beats a patch endpoint plus a cascade endpoint. No optimistic
`expectedVersion` column: a landlord editing their own lease in two tabs is not a scenario
worth a column at tens-of-units scale.

**`PUT` 409s, with their messages:**

| Condition | Message |
|---|---|
| the body changes or removes a step with `effective_from <= localToday(property.timezone)` | *"This increase has already taken effect. Use Correct, and tell us why."* |
| the body adds a step with `effective_from <= today` | *"A rent increase cannot be backdated. Correct the step that is in force instead."* |
| the lease is `cancelled` | *"A cancelled lease cannot be changed."* |

`422`: anything `validateBillingTerms` rejects (I20's ordering, a non-period-start date, a
step past `endDate`, a step at or before `startDate`).

**`/correct` 409s:** the step is in the future (*"This increase has not taken effect yet —
edit it directly."*); the lease is `cancelled`.

**`/correct` always writes a `lease_rent_step_correction` row.** `reason` is required,
10..500 characters. In Phase 3 the response gains the affected `generationKey`s (§6.5).

> **R1's `/correct-escalation` and `/escalation-corrections` are CUT** (decision 15). The
> clause now edits through the ordinary `PATCH /v1/leases/:id`, on any status but
> `cancelled`, writing `escalation_updated_at` / `escalation_updated_by_user_id`. It is
> documentation; editing it changes no rent until somebody re-drafts the ladder and PUTs it.

### 4.2 Existing routes — new fields, no shape changes

| Route | Change |
|---|---|
| `POST /v1/leases` | `createLeaseBody` gains `escalation` (nullable, default `null`) **and `rentSteps` (optional array)**. See §4.3. |
| `PATCH /v1/leases/:id` | **`escalation` is editable on any status but `cancelled`** — it moves no money. `rentCents` stays frozen on an active lease, unchanged. |
| `POST /v1/leases/:id/renew` | `escalation` optional, defaults to the predecessor's; `rentSteps` optional, otherwise generated from the renewal's own clause and base. |
| `GET /v1/leases`, `/v1/leases/:id` | `leaseSummary` gains `escalation`; `leaseDetail` gains `rentSteps`. Keeps the list light. |
| `GET /v1/leases/:id/schedule` | **Shape unchanged. Numbers come from stored steps.** |
| `GET /v1/portal/leases*` | `portalLease` gains `escalation`; `portalLeaseDetail` gains `rentSteps`. |

### 4.3 **[R2]** When steps are generated — at create, drafted in the browser

Decision 4, in full:

1. The lease form calls **`generateRentSteps`** as soon as a clause, a base rent, a start
   date and a cadence exist. The full ladder renders immediately, **editable**.
2. The landlord adjusts any row. Edited rows flip to `source: 'manual'`.
3. `POST /v1/leases` carries `rentSteps` in the body. The server validates and writes them
   verbatim.
4. **If the body omits `rentSteps` and a clause is present, the server generates them with
   the same contract function.** Identical ladder either way — that is why the generator
   lives in `packages/contract`.
5. Write order, per PLAN-PHASE2 §5.4: lease row → `lease_rent_step` rows → `lease_tenant`
   rows. Torn state is a draft with a base rent and no ladder — visible, harmless, and
   fixed by one `PUT /rent-steps`. **Activation does not depend on steps existing**, so a
   torn create cannot block the lifecycle.

Not at activation: PLAN-PHASE2 §10 makes create always-draft, and a draft's schedule preview
must show the real ladder rather than a lie it will become later. Not lazily: materialising
rows on a `GET` is a write on a read.

### 4.4 **[R2]** The cascade — what happens to later steps, and how it is made visible

Decision 5, in full. `recomputeLadderFrom` is pure and runs **client-side first**, so the
diff shown is the exact ladder that will be stored.

| Later step's `source` | On overriding an earlier step |
|---|---|
| `clause` | **Recomputed** by applying the clause to the new value. The override *is* the rent now, so the agreement carries forward from it. |
| `manual` | **Preserved verbatim.** A figure a landlord set by hand is a decision, not a draft, and must never move underneath them. |

The dialog, before anything is submitted:

```
Change 1 Apr 2028 from ₹6,453.00 to ₹5,300.00

  This also updates, because the agreement carries forward from the new figure:
    1 Apr 2029   ₹7,098.00  ->  ₹5,830.00
    1 Apr 2030   ₹7,808.00  ->  ₹6,413.00

  Unchanged, because you set it by hand:
    1 Apr 2031   ₹8,000.00

  [ Also update later years ]  (on)        [ Cancel ]  [ Apply ]
```

Turning the toggle off writes only the one step and leaves the rest alone. **Nothing is ever
recomputed server-side without the landlord having seen the diff** — the server writes the
array it is given.

An override **above** the clause's figure is allowed, with an inline warning (*"This is more
than the 10% in the agreement."*). Not blocked: the app does not know what side agreements
exist, and blocking would make a legitimate renegotiation impossible. An override **below**
the previous step is also allowed, unremarked — that is I16's removal, and the whole
"good relations" case.

### 4.5 **[R2]** Mutability after activation

| Lease status | Step with `effective_from > today` | Step with `effective_from <= today` |
|---|---|---|
| `draft` | free (`PUT`) | n/a — a draft has no past |
| `active` | **free (`PUT`), unaudited** — this is the requirement | `/correct` + reason, **audited** |
| `ended`, `terminated` | free (`PUT`) — dead data, harmless | `/correct` + reason, audited |
| `cancelled` | `409` | `409` |

"Today" is `localToday(property.timezone)` — never the browser's clock, never the server's
default. One date comparison, using the pattern PLAN-PHASE2 §5.5 already established for
`removedOn`.

A future step edits freely and unaudited because **nothing has been billed and nothing is
owed** — auditing every keystroke on a figure that has not taken effect is noise that makes
the real audit trail harder to read. The line money crosses is "has it taken effect", and
that is the line the audit table sits on.

### 4.6 Tenant isolation walk — "I am landlord B holding landlord A's UUID"

| Attempt | Result | Why |
|---|---|---|
| `GET` / `PUT /v1/leases/{A_lease}/rent-steps` | `404` | `getLease(orgId = B, …)` resolves **before** the body is read. Identical resolver to every other lease route — no new reach. |
| `POST /v1/leases/{own lease}/rent-steps/{A_step_id}/correct` | `404` | **The one genuinely new cross-org shape in R2.** `stepId` comes from the path, so the repo must resolve it as `WHERE org_id = $B AND lease_id = $resolved AND id = $stepId` — never by `id` alone. **Requires a dedicated test**, the same way PLAN-PHASE2 §7.1 singles out the foreign-`tenantId` roster insert. |
| `PUT /rent-steps` with a forged `orgId` in the body | ignored | No route reads an org id from a request. Grep-checkable, already on the reviewer checklist. |
| `GET /v1/leases/{A_lease}/rent-step-corrections` | `404` | Same resolver, called first. |
| Tenant hits any of the four | `404` from the router | None is under `/v1/portal`; `requireTenant` never sees them. |
| Tenant reads a step's `note` or the correction history | **structurally absent** | `portalRentStep` has no `note`, no `source`, no `clauseExpectedCents`. Separate type, not the landlord shape with fields removed. |

Both new tables carry `org_id`; every repo function takes `orgId` first and filters on it,
per ARCHITECTURE §5. **All step functions live in the existing `db/repo/lease.ts`** — no new
repo file, so `MIN_LANDLORD_REPO_FILES` and `MIN_PORTAL_REPO_FILES` are **not** bumped.

### 4.7 What the tenant sees

`portalLease` gains `escalation` (what was agreed) and `portalLeaseDetail` gains
**`rentSteps`** as `portalRentStep = { effectiveFrom, rentCents }` — **the actual ladder,
the real numbers they will pay.** Same reasoning as Amendment A.5's `moveOutBillingPolicy`:
it is a term of their tenancy and the thing they most need to see coming.

Deliberately **not** shown: `note` (landlord-private), `source`, `clauseExpectedCents`, and
the correction history. We show the tenant what they will pay and what was agreed. We do not
editorialise about the gap between them — if the landlord took 5% instead of 10%, the tenant
can see both numbers and draw their own conclusion.

---

## 5. Contract additions — file by file, named  **[R2]**

Five files extended, none new.

### 5.1 `packages/contract/src/billing.ts`

`rentStep`, `draftRentStep` (`rentStep` + `source` + `clauseExpectedCents`),
`rentStepSource`, `rentEscalationMode`, `rentEscalationCompounding` + label maps,
`rentEscalation`, `BPS_SCALE`, `MAX_ESCALATION_RATE_BPS`, `MAX_ESCALATION_INTERVAL_YEARS`,
`MAX_GENERATED_STEPS`, `STEP_PROPOSAL_ROUNDING_UNIT`, `rentForPeriodStart`,
`generateRentSteps`, `recomputeLadderFrom`, `clauseExpectedRent`, plus
`leaseBillingTerms.rentSteps` and the one-line `buildSchedule` change.

Still imports `common.ts` and `./calendar/*` only. No cycle.

### 5.2 `packages/contract/src/billing.fixtures.ts`

- **`rentSteps: []` on all 34 existing `terms` objects. No `expected` array changes.**
- `export interface GeneratorFixture { name; input; expected: DraftRentStep[] }` and
  `export const generatorFixtures` — `G1`..`G6`.
- `export interface LadderFixture { name; clause; steps; index; newRentCents; expected }`
  and `export const ladderFixtures` — `L1`..`L3`.
- New entries in `scheduleFixtures` — `E1`, `E2b`, `E3`, `E5`, `E6`, `E7`, `E9`..`E13`.

### 5.3 `packages/contract/src/billing.bs.fixtures.ts`

`rentSteps: []` on its 6 `terms`; one BS generator fixture (`G6`) and one BS schedule
fixture (`E8`).

### 5.4 `packages/contract/src/lease.ts`

- `createLeaseBodyShape` gains `escalation: rentEscalation.nullable().default(null)` and
  `rentSteps: z.array(rentStepInput).max(MAX_GENERATED_STEPS).optional()`.
- `updateLeaseBody` inherits `escalation`; **`rentSteps` is omitted from it** — the `PUT`
  route owns the ladder, so a PATCH can never half-write it.
- `renewLeaseBody` gains both, optional.
- `leaseSummary` gains `escalation: rentEscalation.nullable()`; `leaseDetail` gains
  `rentSteps: rentStepSummary[]`.
- `billingTermsFor`'s `Pick<…>` gains `'rentSteps'`; its argument type widens to accept a
  shape carrying the steps.
- `billingTermsFromCreateBody` gains `rentSteps: data.rentSteps ?? []`.
- NEW `rentStepInput`, `rentStepSummary`, `putRentStepsBody`, `correctRentStepBody`,
  `rentStepCorrection`.
- Re-export `rentEscalation`, `rentEscalationMode`, `rentEscalationCompounding`,
  `rentStepSource` and their label maps.

### 5.5 `packages/contract/src/portal.ts`

`portalRentStep = { effectiveFrom, rentCents }`. `portalLease` gains `escalation`;
`portalLeaseDetail` gains `rentSteps: portalRentStep[]`.

### 5.6 `packages/contract/src/routes.ts`

```ts
leases: {
  ...existing,
  rentSteps:           (id)         => `/v1/leases/${id}/rent-steps`,
  correctRentStep:     (id, stepId) => `/v1/leases/${id}/rent-steps/${stepId}/correct`,
  rentStepCorrections: (id)         => `/v1/leases/${id}/rent-step-corrections`,
},
```

### 5.7 Fixtures to pin — every figure computed  **[R2]**

**Generator** (`generatorFixtures`) — these replace R1's `E-R*` rent ladders:

| # | Input | Expected ladder |
|---|---|---|
| `G1` | base `533300`, 10%, 1yr, compound, start `2026-04-01`, end `2031-03-31`, monthly | `2027-04-01: 586600`, `2028-04-01: 645300`, `2029-04-01: 709800`, `2030-04-01: 780800` — **the user's own numbers, as four rows** |
| `G2` | same, `simple` | `586600, 640000, 693300, 746600`. **`G2b` extends it one cycle** to `800000` — `533300 × 1.5 = 799950 → 7999.5 → 8000`, which pins half-up at exactly the `.5` boundary; banker's rounding gives `799900` |
| `G3` | base `533350` (non-round), 10%, compound | the base is **untouched**; the first step is `586700`. Pins "we never rewrite the base". |
| `G4` | **start `2026-03-15`, monthly** | **first step is `2027-04-01`, not `2027-03-15`** — §3.5's snap, pinned in the generator where it now lives |
| `G5` | yearly, 10% every **2** years, start `2026-04-01` | steps at `2028-04-01`, `2030-04-01` — and each lands exactly on a period start with no snapping, because both anchors are the same `addYears` |
| `G6` | Bikram Sambat monthly, 10%/1yr | anniversaries are **BS** anniversaries landing on Gregorian dates that are not start+365, each snapped to a BS month start |
| `G7` | leap-day start `2028-02-29`, yearly | steps at `2029-02-28`, `2030-02-28` — the same clamping F8's periods already use |
| `G8` | rolling lease, `endDate: null` | exactly `MAX_GENERATED_STEPS` steps, no more (§3.6) |

**Ladder recompute** (`ladderFixtures`):

| # | Scenario | Expected |
|---|---|---|
| `L1` | `G1`'s ladder; override index 1 (`2028-04-01`) to `530000`; all later steps are `clause` | `586600`, **`530000`**, `583000`, `641300` |
| `L2` | same, but the `2031-04-01` step was already `manual` at `800000` | `586600`, **`530000`**, `583000`, `641300`, **`800000` unchanged** — decision 5, pinned |
| `L3` | `clause: null` (the commercial case), override index 1 | only index 1 changes; nothing cascades |

**Schedules** (added to `scheduleFixtures`) — `terms.rentSteps` is the stored ladder:

| # | What it pins |
|---|---|
| `E1` | **The requirement, end to end.** `G1`'s ladder over 60 monthly periods: five runs of 12 at `533300 / 586600 / 645300 / 709800 / 780800`, total ₹3,90,696.00 |
| `E2b` | `G4`'s snapped step applied: period `2027-03-01` is at `100000`, `2027-04-01` is the first at `110000`. **Now a consequence of stored data, not of read-time counting.** |
| `E3` | `G5`'s two-yearly ladder: `2400000, 2400000, 2640000, 2640000, 2904000, 2904000` |
| `E5` | **Onboarding an in-flight escalating tenancy.** start `2023-06-15`, ledgerStart `2026-07-01`, steps at the 2024/2025/2026 anniversaries. First generated period `2026-07-01` at `133100`, `periodIndex: 37`. |
| `E6` | `G7`'s leap-day ladder: `1200000, 1320000, 1452000` |
| `E7` | **Proration on the stepped rent.** end `2027-06-10`: 12 at `100000`, 5 at `110000`, then `round(110000 × 10/30) = 36667` due `2027-06-05`. Proves I7′. |
| `E8` | Bikram Sambat, `G6`'s ladder |
| `E9` | `E1`'s terms with **`rentSteps: []`** — one flat run of 60. The regression net. |
| `E10` | **The override.** `L1`'s ladder: `533300, 586600, 530000, 583000, 641300`. **The "good relations" case, end to end.** |
| `E11` | `L2`'s ladder, proving a `manual` step survives a cascade through a schedule |
| `E12` | **A decrease.** A step below its predecessor. Pins I16's removal so nobody reintroduces monotonicity. |
| `E13` | **Explicit ladder, no clause.** `escalation: null`, four hand-entered steps. Proves the engine never needs a clause — the commercial case, free. |

---

## 6. Knock-on effects

### 6.1 The schedule summary — the collapse finally earns its keep

Unchanged from R1, and now driven by stored steps. `groupScheduleByAmount` already handles
multiple runs; its own comment anticipates exactly this. The **labelling** does not:
`labelForGroup` returns `'Rent'` then `'Then'` forever, so `E1` renders *Rent / Then / Then
/ Then / Then*.

**Change `labelForGroup` to return a descriptor, not a string** — `{kind:'rent'} |
{kind:'from', date} | {kind:'firstPeriod'} | {kind:'finalPeriod'} |
{kind:'proratedPeriod'}` — and let `LeaseScheduleSummary` format it with `formatCivilDate`
(which needs the calendar, and the calendar does not belong in `schedule-summary.ts`). Both
files are `apps/web`, so no contract change. `E1` reads:

```
Rent            ₹5,333.00 / month  ·  12 periods  ·  Apr 2026 – Mar 2027
From Apr 2027   ₹5,866.00 / month  ·  12 periods  ·  Apr 2027 – Mar 2028
From Apr 2028   ₹6,453.00 / month  ·  12 periods  ·  Apr 2028 – Mar 2029
From Apr 2029   ₹7,098.00 / month  ·  12 periods  ·  Apr 2029 – Mar 2030
From Apr 2030   ₹7,808.00 / month  ·  12 periods  ·  Apr 2030 – Mar 2031
Total over the term                                       ₹3,90,696.00
        [ Show every period (60) ]
```

Five lines instead of sixty, and "Total over the term" stops being obvious arithmetic.
**The preview window must grow:** `defaultPreviewThrough` runs 366×3 days, so a five-year
lease previews three of its five rates — when steps exist and `endDate` is set, run to the
full term, still clamped by `SCHEDULE_SANITY_DAYS`.

### 6.2 **[R2]** The lease form — the ladder editor is the feature

The terms step gains a **Rent ladder** panel, closed by default so a single-rate lease is
visually unchanged.

1. **Clause fields** — mode (*No increase* / *Percentage*), rate, interval, compounding.
   Rate is entered as a **percentage** and converted at the form edge with
   `Math.round(pct * 100)`. That `Math.round` is load-bearing: `7.35 * 100 ===
   734.9999999999999`, and a truncating conversion stores `734` bps. Test it with `7.35`.
   Compounding reads as *"Compounds on the previous rent"* / *"Always on the original
   rent"*, never "compound/simple".
2. **The ladder renders immediately** from `generateRentSteps`, **with the base as row 0**
   (bound to `rentCents`, editable) and each step below it:

   ```
   From 1 Apr 2026   ₹5,333.00     (base)
   From 1 Apr 2027   ₹5,866.00     agreed 10%              [edit]
   From 1 Apr 2028   ₹5,300.00     agreed ₹6,453  −17.9%   [edit] [reset]
   From 1 Apr 2029   ₹5,830.00     agreed 10%              [edit]
   From 1 Apr 2030   ₹6,413.00     agreed 10%              [edit]
   ```

   The *agreed* column is `clauseExpectedRent`; `[reset]` returns a `manual` step to
   `clause`. **This is the honesty win** — all five numbers on screen before the first save.
3. **Editing the base, the rate or the interval re-drafts every `clause` step** and leaves
   `manual` ones alone, through `recomputeLadderFrom` — same rule as the cascade, same diff
   preview (§4.4).
4. **Adding a step by hand** is allowed, with the date picker offering only period starts.
   That is `E13`'s case, and it means a commercial lease with explicit per-year amounts needs
   no clause at all.
5. A soft warning, not a `422`, when the term ends before the first increase would apply.

### 6.3 The in-flight onboarding trap — mitigated, and now visible

`rentCents` is the rent at `start_date`, not today. Entering today's rent silently re-prices
the term. **R2 softens this considerably**: the ladder is on screen, so a landlord entering
today's ₹6,453 as the base sees the ladder start at ₹6,453 and run to ₹9,445 — obviously
wrong at a glance, where R1's invisible recurrence was not.

Keep the rest of the mitigation anyway. When steps exist and `startDate` is in the past
(`localToday(propertyTimezone)`, never the browser clock): relabel the field **"Rent at
lease start"**, show **"Rent today: ₹6,453.00"** beside it from `rentForPeriodStart`, and
repeat it on review. `E5` pins the behaviour.

### 6.4 Lease detail and the portal

- **Terms panel** gains a *Rent ladder* section: the same table as the form, read-only until
  edited, with `[Edit]` opening the `PUT` flow and `[Correct]` on any step already in force.
  Below it: **"Increases scheduled through 1 Apr 2030"** and, when §3.6's condition is met,
  *Extend the ladder*.
- **"Next increase: 1 Apr 2027 → ₹5,866.00"**, read straight off the first step whose
  `effectiveFrom > localToday(propertyTimezone)`. **No contract function needed** — R1's
  `nextEscalationOnOrAfter` is **cut**, because finding the next row in a sorted array is
  not date arithmetic.
- **Corrections list** when `rentStepCorrections` is non-empty: old → new, reason, who, when.
- **Portal lease detail** shows the ladder as plain rows and the agreed clause as one line.
  No `note`, no `source`, no variance, no history (§4.7).

### 6.5 Phase 3 — what to write into that task file now

1. **The generator reads `rentForPeriodStart` over stored steps, never
   `lease.rent_cents`, and never the clause.** Nothing in `apps/api` may multiply a rent by
   a rate; the clause arithmetic exists only inside `generateRentSteps`.
2. **`POST /rent-steps/:stepId/correct` is a correction trigger**, identical in kind to
   Amendment A.5's `moveOutDate` edit. Already-written charges are **never silently
   re-priced**. The route's response gains the affected `generationKey`s, and the UI surfaces
   *"N charges were written at the old rent and need review"* with a void-and-supersede link
   each. **The generator never un-writes.**
3. **`PUT /rent-steps` cannot touch a charged period**, because it already refuses any step
   with `effective_from <= today`, and Phase 3 only writes charges for periods that have
   started or are within the 31-day lookahead. **Phase 3 must tighten that bound**: the
   refusal becomes "effective_from is at or before the start of the latest period that has a
   written charge", which is strictly wider than `today` by up to the lookahead. Write it
   into the task file; it is a one-line change to an existing guard, and discovering it later
   means discovering it as a mis-billed period.
4. **I18 is the licence to regenerate.** The rent for a period is a stored row, so a
   self-healing cron run in 2031 computes what it would have computed in 2026.
5. Any report, projection or reminder quoting "your rent of X" takes it from the **charge
   row**, which is the materialised truth.

---

## 7. Task split

Contract frozen first, then both agents dispatched at once. **The only shared surface is
`packages/contract/**`.** Neither agent edits it; if it is wrong, stop and report upward.

### 7.1 The paragraph that goes verbatim in both task files  **[R2]**

> *A lease's rent is no longer a constant, and it is no longer a formula. It is a list of
> stored steps. The rent for any period is `rentForPeriodStart(terms, periodStart)` — a pure
> lookup in the contract, fixture-pinned. The clause is only a generator:
> `generateRentSteps` drafts a ladder the landlord then edits, and the stored steps are the
> truth from that moment on. If you find yourself multiplying a rent by a percentage
> anywhere outside `generateRentSteps`, or converting a percentage to basis points anywhere
> except the lease form's input edge, you are writing the second implementation this whole
> design exists to prevent.*

### 7.2 backend-dev — `apps/api/**` only

1. **Schema**: three enums, six `lease` columns, `lease_escalation_ck`, `lease_rent_step`,
   `lease_rent_step_correction`, their CHECK and three indexes. One generated migration;
   verify enum casts and `check()` support before committing.
2. **`db/repo/lease.ts`** (no new repo file, **do not bump the guard floors**):
   `listRentSteps`, `replaceRentSteps`, `correctRentStep`, `listRentStepCorrections`;
   `createLease` writes the ladder (generating it when the body omits it);
   `renewLease` carries or regenerates. `orgId` first, filtered in every `WHERE`.
   **`correctRentStep` resolves `stepId` by `(org_id, lease_id, id)` — never by `id`
   alone** (§4.6).
3. **`lib/mappers.ts`**: `mapRentStep`, `mapPortalRentStep`, `mapRentStepCorrection`;
   `mapLeaseSummary` assembles `escalation: mode === 'none' ? null : {…}`;
   `mapLeaseDetail` attaches `rentSteps`. Never spread a row.
4. **`routes/leases.ts`**: the four new routes, each resolving the lease **before** reading
   the body. `PATCH` allows `escalation` on any status but `cancelled`, writing the two
   tracking columns.
5. **Schedule routes**: `billingTermsFor` now needs `rentSteps`, so both schedule routes
   load them alongside the lease. One extra query on the lease-detail and schedule paths;
   the list route does **not** load steps.
6. **Extend the source-grep guard**: `rateBps` / `escalation_rate_bps` may not appear in any
   arithmetic expression in `apps/api/src`; `BPS_SCALE` and `STEP_PROPOSAL_ROUNDING_UNIT`
   may not be referenced outside `packages/contract`.
7. **Tests**: `E1`..`E13` through `GET /schedule`; `G1`..`G8` through `POST /v1/leases` with
   `rentSteps` omitted, asserting the server-generated ladder equals the fixture; cross-org
   `404` on all four routes **plus the dedicated foreign-`stepId` test**; every `PUT` and
   `/correct` 409; `422` on each I20 violation; the unique index firing on a duplicate
   `effective_from`; a correction writing exactly one audit row and re-pricing
   `GET /schedule` on the next call.

### 7.3 frontend-dev — `apps/web/**` only

1. **The ladder editor** on the terms step (§6.2): clause fields, percent↔bps with
   `Math.round`, the live ladder with the base as row 0, per-row edit and reset, the
   *agreed* variance column.
2. **The cascade diff dialog** (§4.4), driven by `recomputeLadderFrom` client-side so the
   preview is the exact ladder that will be stored.
3. **"Rent at lease start" relabel + "Rent today"** when steps exist and `startDate <
   localToday(propertyTimezone)` (§6.3).
4. **`schedule-summary.ts`**: `labelForGroup` returns `GroupLabel`; `LeaseScheduleSummary`
   formats it. Update `schedule-summary.test.ts` and `LeaseScheduleSummary.test.tsx`.
5. **`schedule-preview.ts`**: extend the runway to the full term when steps exist and
   `endDate` is set, still clamped by `SCHEDULE_SANITY_DAYS`.
6. **Lease detail**: the rent-ladder section, *Next increase*, *Increases scheduled
   through*, *Extend the ladder*, the corrections list, and the correct-step dialog (reason
   ≥ 10 chars, explicit *"this changes a rent that is already in force"* warning).
7. **Portal lease detail**: the ladder rows and the agreed-clause line. No note, no source,
   no variance, no history.
8. **Tests**: `E1`..`E13` against `previewSchedule` and `G1`..`G8` against
   `generateRentSteps` — **the same fixtures the backend asserts**; the `7.35` round-trip;
   the cascade dialog listing exactly the steps that change and exactly the `manual` ones
   that do not (`L2`); five-run summary labelling.

### 7.4 What they share — stated explicitly

`packages/contract/**`, frozen. The shared **executable** surface is now `buildSchedule`,
`effectiveBillingEnd`, `billingTermsFor`, **`rentForPeriodStart`**, **`generateRentSteps`**,
**`recomputeLadderFrom`** and **`clauseExpectedRent`**.

---

## 8. Phasing — ship before Phase 3

Unchanged from R1, and stronger.

1. **It is a pure-function-plus-two-tables change today and a data migration later.** Change
   the rent-per-period rule after charge rows exist and you are re-pricing written history.
2. Phase 3's hardest question is "did we write the right amount". Writing the generator once
   against the final rule, with these fixtures green, is strictly cheaper than twice.
3. `PlannedCharge` is unchanged, so Phase 3's charge table design is unaffected either way.
4. **R2 adds a reason R1 did not have:** Phase 3's guard on editing a charged period
   (§6.5 item 3) only makes sense once steps exist. Landing steps first means that guard is
   written against real rows rather than designed in the abstract.

Cost: one task of delay to Phase 3. Take it.

---

## 9. Risks, assumptions, and what is left to ask

### 9.1 Risks  **[R2]**

| Risk | Mitigation |
|---|---|
| **A foreign `stepId` replayed against your own lease.** The one genuinely new cross-org shape R2 introduces. | Resolve by `(org_id, lease_id, id)`, never by `id` alone; a dedicated route test, called out in §7.2 the way PLAN-PHASE2 §7.1 calls out the roster insert. |
| **A step edited after Phase 3 has billed it.** | `PUT` refuses anything at or before today; Phase 3 tightens that to "at or before the latest charged period start" (§6.5 item 3). Named now so it is a one-line change, not a mis-billed period. |
| **A torn create** leaves a draft with a base rent and no ladder. | Harmless and visible; activation does not depend on steps. One `PUT /rent-steps` fixes it. Write order fixed in §4.3. |
| **"Flat past the last step"** — a rolling lease silently stops escalating at step 30. | Stated explicitly in §3.6, surfaced as *"Increases scheduled through <date>"* plus an *Extend the ladder* action. |
| **The cascade surprising a landlord.** | `recomputeLadderFrom` runs client-side, the diff is rendered before submit, `manual` steps are listed as explicitly unchanged, and the server only ever writes the array it was given. |
| **`lease.rent_cents` and the first step disagreeing about day one.** | Unrepresentable: steps are strictly `> start_date`, enforced in `validateBillingTerms`, the repo and a route test. The base is not duplicated anywhere. |
| Float at the percent→bps edge (`7.35 * 100`). | `Math.round` at the form edge, tested with `7.35`; bps is the only form stored or transported. |
| Someone later adds a field to `PlannedCharge` and re-baselines the fixtures. | Decision 13's reason goes in the zod schema's own comment, plus the CI check that no `expected:` line changes in either fixture file. |
| `labelForGroup`'s signature change breaks two existing web tests. | Both files are `apps/web`; listed as task work, not discovered mid-flight. |
| An override set **above** the clause, i.e. more than the agreement allows. | Allowed with an inline warning, not blocked — the app cannot know what side agreements exist, and blocking would make a legitimate renegotiation impossible. |

### 9.2 Assumptions  **[R2]**

1. Whole-year intervals only. "Every six months" was not described; adding it means an
   `escalation_interval_months` column and an `addMonths` anchor, which the generator already
   accommodates.
2. The clause applies from the lease's own start. A deliberately deferred first increase is
   expressible **by hand** — delete the first generated step — which is a real R2 win over
   R1, where it was impossible.
3. A renewal carries the predecessor's clause by default and re-anchors on its own start.
4. `MAX_GENERATED_STEPS = 30` is beyond any real lease.
5. Corrections are unpaginated and not shown to tenants.
6. Last-writer-wins on `PUT /rent-steps`. No version column; two tabs is not a scenario worth
   one at this scale.

### 9.3 **[R2]** The open question R1 had is now closed

R1 ended by asking whether an escalated rent should round to whole rupees or keep the paisa.
**That question dissolves.** The generator *proposes* whole rupees because a proposal should
look like a number a landlord would ask for; the landlord types over it if they disagree, and
whatever they type is stored exactly. There is no rounding rule left for the system to
impose and therefore nothing to confirm.

**No open questions. This is buildable as written.**


---

# Revision 3 — the schedule preview is a rent ladder, not a charge table

User feedback, after seeing R2's summary rendered:

> "I think we need to remove the originally computed table altogether for now. I dont
> think we need Total over the term ₹181,935.48 and also the table entirely can be
> hidden that displays every period. Period, due date, days, amount. that table is not
> needed and should not be computed at the beginning, should not be there as well."

**Decided, and it simplifies R2 further.**

## What the lease form shows

1. **The prorated first period**, when there is one — its dates, its due date and its
   amount. This was always the part carrying information, and the user confirmed it
   twice ("its good to have a prorated period duedate and price shown").
2. **The rent ladder** — the base and each increase with the date it takes effect,
   editable. Which is the thing R2 made the landlord-facing truth anyway.

Nothing else. No per-period table, no disclosure to one, and no term total.

## What is removed

- `LeaseScheduleTable` as a preview surface, and the `Collapsible` that revealed it.
- `scheduleTotalCents` and the "Total over the term" row.
- **The full-term `buildSchedule` call in the wizard.** Not merely hidden — not
  computed. A five-year monthly lease was building sixty `PlannedCharge` objects to
  render four numbers, on every keystroke in the terms step.

## Why this is right rather than merely smaller

A charge table in the lease form was answering a question nobody asked there. A
landlord drafting a lease wants to know the rent, when it rises, and what the odd
first month costs. The month-by-month ledger is a **Phase 3 question about real
charges**, and Phase 3 will answer it from written rows rather than a projection —
which is the honest source, since by then the rows exist and a projection could
disagree with them.

The total has the same problem: over a five-year term it is a number no landlord
reconciles against anything, computed from a forecast that escalation overrides can
change at any point.

## Consequences

- `buildSchedule` keeps every caller it has on the API side. The wizard stops being
  one of them; the prorated first period comes from a single-period call.
- R2 §6's claim that the collapse "finally earns its keep" with multi-rate ladders is
  **withdrawn** — there is no collapse, because there is no table. The ladder is the
  display, and it was always going to be.
- `schedule-summary.ts`'s grouping and `labelForGroup` lose their purpose in the
  wizard. Keep them only if the lease detail page still wants a schedule view; decide
  that when Phase 3 replaces it with real charges.
- One fewer thing for a Bikram Sambat lease to render per period.
