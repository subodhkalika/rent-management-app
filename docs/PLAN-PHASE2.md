# Phase 2 Plan — Leases

> Written by `architect`. A **plan**, not a contract. The orchestrator turns §4 into real
> files under `packages/contract/src/`, freezes them, then dispatches the §5 backend and
> frontend tasks in parallel.
>
> Supersedes `docs/PLAN-V1.md` where the two disagree. Every disagreement is marked
> **[CORRECTION]** with the reason. PLAN-V1 §4 was written assuming calendar months
> throughout; the 2026-10-05 decision (`monthly | yearly`) generalises it to calendar
> **periods**.

---

## 0. Decisions that matter, in one table

| # | Decision | One-line reason |
|---|---|---|
| 1 | Monthly periods are **calendar months**; yearly periods are **lease years anchored on `start_date`'s anniversary**. | "March rent" is what a landlord says monthly; "the 2026-27 lease year" is what they say yearly — a calendar-year anchor would hand an April lease a 9-month stub charge it never agreed to. |
| 2 | Proration is `round(rentCents * daysOccupied / daysInPeriod)`, `daysInPeriod` being the **full period's actual inclusive day count**. | Actual days is the number the tenant computes themselves; it also makes the day-shares of a period sum to exactly the rent. |
| 3 | Monthly due date = `min(billingDay, daysInMonth)`; **yearly due date = the period's first day**, `billing_day` ignored. | "Day 31 of a year" is meaningless, and a year's rent paid in advance is owed the day the year begins. |
| 4 | Due date is then **clamped into the occupied span**: `clamp(raw, occupiedStart, occupiedEnd)`. | One formula replaces PLAN-V1 §4.3's three special cases, and it honours the landlord's billing day whenever that day still falls inside a part-period. **[CORRECTION]** |
| 5 | `rent_frequency` is **immutable once a lease has ever been active**. A cadence change is a renewal in the same `chain_id`. | The predecessor's charges were written under its own cadence and stay valid; nothing is ever retro-recadenced. |
| 6 | **`move_out_date` does not affect billing. `end_date` alone clips the schedule.** | PLAN-V1 §4.5's `min(end_date, move_out_date)` silently refunds rent a fixed term still owes. **[CORRECTION]** — the one decision I would want confirmed (§6.2). |
| 7 | Generation horizon is **one rule for both cadences**: a period is wanted once `today >= periodStart − 31 days`. | PLAN-V1's "end of next calendar month" cannot be expressed for a yearly cadence; 31 days reproduces monthly behaviour exactly and gives a yearly charge a sane month of notice. **[CORRECTION]** |
| 8 | `ledger_start_date` must equal `start_date` **or** be a period start. | Otherwise a landlord onboarding an in-flight tenancy silently prorates a month the tenant owes in full. |
| 9 | `opening_balance_cents` is a **column on `lease` written in Phase 2**, materialised as a charge by Phase 3. | Phase 2's job is to produce billing primitives; the lease form is the only place this can be captured. |
| 10 | `POST /v1/leases` **always creates `draft`.** Activation is a separate explicit call. | The partial unique index is then exercised by exactly one endpoint, and a half-built wizard leaves a harmless visible draft instead of a double-booked unit. |
| 11 | `lease_unit_active_uq unique (unit_id) where status = 'active'` — **no `org_id` in it.** | `unit_id` is already globally unique; adding `org_id` would widen the key for zero benefit. Stricter without it, not looser. |
| 12 | `billing.ts` defines its own zod schemas and infers its TS types from them. | The pure function's return type and the wire shape are then the same object — they cannot drift. |

---

## 1. Billing — `packages/contract/src/billing.ts`

**This is the deliverable that matters.** One definition, used by the lease form's live
schedule preview in the browser and by the Phase 3 cron that writes charge rows on the
server. If the two ever disagree, a tenant sees one number and gets billed another.

### 1.1 Position in the dependency graph

```
common.ts  (zod, isoDate, money, localToday)   <- no imports but zod
    ^
billing.ts (periods, due dates, proration)     <- imports common.ts ONLY
    ^
billing.fixtures.ts                            <- imports billing.ts ONLY
    ^
lease.ts, portal.ts                            <- import billing.ts
```

`billing.ts` imports nothing from `lease.ts`. It **owns** `rentFrequency`; `lease.ts`
re-exports it. No cycle, and the low layer is the one with the executable logic.

### 1.2 Period definition

A **billing period** is the closed calendar interval the rent amount is quoted for.

| Frequency | Period k | Anchor |
|---|---|---|
| `monthly` | `[YYYY-MM-01, last day of YYYY-MM]` | the calendar month; `anchorDate` is ignored |
| `yearly` | `[ann_k, ann_{k+1} − 1 day]` where `ann_k = clampDayToMonth(startYear + k, startMonth, startDay)` | `lease.start_date` |

Anniversaries are always clamped **from the original start day**, never from the previous
anniversary, so there is no cumulative drift.

**Invariant: periods are a contiguous, gapless, non-overlapping cover.** Period `k+1`
starts the day after period `k` ends, by construction, for both cadences.

**Leap-day start.** A yearly lease starting `2028-02-29`:

```
ann_0 = 2028-02-29   period 0 = 2028-02-29 .. 2029-02-27   365 days
ann_1 = 2029-02-28   period 1 = 2029-02-28 .. 2030-02-27   365 days
ann_2 = 2030-02-28   period 2 = 2030-02-28 .. 2031-02-27   365 days
```

Lease year 0 ends on Feb 27 rather than Feb 28, and every later year runs Feb 28 → Feb 27.
Contiguous, no day uncovered, no day double-covered, full rent on every period. Deliberate,
documented, fixture-pinned (`F8`).

`periodContaining` supports negative indices (the maths is well defined before the anchor);
`buildSchedule` never asks for one because it starts at `max(startDate, ledgerStartDate)`.

### 1.3 Due date — one formula, zero special cases

```
rawDue  = frequency === 'monthly'
            ? clampDayToMonth(periodStart.year, periodStart.month, billingDay)
            : periodStart
dueDate = clampIsoDate(rawDue, occupiedStart, occupiedEnd)
```

| Case | Result |
|---|---|
| billingDay 31, February 2026 (non-leap) | `2026-02-28` |
| billingDay 31, February 2028 (leap) | `2028-02-29` |
| billingDay 31, February 2100 (century, non-leap) | `2100-02-28` |
| billingDay 29, February 2000 (century, leap) | `2000-02-29` |
| billingDay 31, April | `2026-04-30` |
| First period, start 03-15, billingDay 1 | `2026-03-15` — floored to move-in |
| First period, start 03-15, billingDay 20 | `2026-03-20` — **the landlord's billing day is honoured because it still falls inside the period**. PLAN-V1 §4.3 said `start_date` unconditionally. **[CORRECTION]** |
| Final period 06-01..06-10, billingDay 25 | `2026-06-10` — ceilinged to move-out |
| Yearly, any `billingDay` | `periodStart` |

The clamp is what closes "you do not let someone take the keys on the 28th and owe nothing
until the 5th" **and** "rent is never due after the tenant has gone", in one expression.

**`billing_day` on a yearly lease** is normalised server-side to `day-of-month(start_date)`
at create, so the stored column never contradicts behaviour. The UI hides the field.

### 1.4 Proration — period-agnostic form

```
prorate(rentCents, daysOccupied, daysInPeriod) = Math.round(rentCents * daysOccupied / daysInPeriod)
```

- `daysInPeriod` is the **full** period's inclusive day count: 28–31 monthly, 365–366 yearly.
- **Actual days remains the right denominator for a yearly period.** A 366-day lease year
  divided by 365 would overcharge by one day's rent on every leap year, and it is still the
  number a tenant can reproduce on a calculator and argue from.
- One rounding step on an integer expression. `Math.round` is half-up — pinned by fixture so
  nobody quietly swaps in banker's rounding.
- Overflow: worst case `1_000_000_00 × 366 = 3.66e10`, four orders of magnitude inside
  `Number.MAX_SAFE_INTEGER`. Safe, stated.
- A full period short-circuits to `rentCents` exactly rather than round-tripping through
  `prorate`, so `amountCents === rentCents` is an identity, not an approximation.

### 1.5 Exported surface

```ts
/* ---------- frequency ---------- */
export const rentFrequency: z.ZodEnum<['monthly', 'yearly']>;
export type RentFrequency = z.infer<typeof rentFrequency>;
export const rentFrequencyLabels: Record<RentFrequency, string>;   // Monthly | Yearly

/* ---------- plain calendar arithmetic — no instants, no timezone ---------- */
export function isLeapYear(year: number): boolean;
export function daysInMonth(year: number, month: number): number;        // month 1..12
export function parseIsoDate(d: IsoDate): { year: number; month: number; day: number };
export function toIsoDate(year: number, month: number, day: number): IsoDate;  // throws on impossible
export function clampDayToMonth(year: number, month: number, day: number): IsoDate;
export function addDays(d: IsoDate, n: number): IsoDate;
export function addMonths(d: IsoDate, n: number): IsoDate;   // clamps day to target month length
export function addYears(d: IsoDate, n: number): IsoDate;    // Feb 29 -> Feb 28 in a non-leap year
export function compareIsoDate(a: IsoDate, b: IsoDate): -1 | 0 | 1;
export function daysBetweenInclusive(from: IsoDate, to: IsoDate): number;  // 0 when to < from
export function minIsoDate(...d: IsoDate[]): IsoDate;
export function maxIsoDate(...d: IsoDate[]): IsoDate;
export function clampIsoDate(d: IsoDate, lo: IsoDate, hi: IsoDate): IsoDate;

/* ---------- periods ---------- */
export const billingPeriod: z.ZodObject<{ index, start, end }>;
export type BillingPeriod = z.infer<typeof billingPeriod>;
//   index  0-based from the lease's FIRST natural period. Anchored, NOT the array index.
//   start  natural period start, inclusive. NOT clipped to the lease.
//   end    natural period end, inclusive.

export function periodContaining(f: RentFrequency, anchorDate: IsoDate, on: IsoDate): BillingPeriod;
export function periodsOverlapping(f: RentFrequency, anchorDate: IsoDate, from: IsoDate, to: IsoDate): BillingPeriod[];
export function isPeriodStart(f: RentFrequency, anchorDate: IsoDate, d: IsoDate): boolean;

/* ---------- due date ---------- */
export function dueDateFor(input: {
  frequency: RentFrequency;
  period: BillingPeriod;
  occupiedStart: IsoDate;
  occupiedEnd: IsoDate;
  billingDay: number;            // 1..31; ignored when frequency === 'yearly'
}): IsoDate;

/* ---------- proration ---------- */
export function prorate(rentCents: number, daysOccupied: number, daysInPeriod: number): number;

/* ---------- terms + schedule ---------- */
export const leaseBillingTerms: z.ZodObject<{
  frequency, rentCents, billingDay, startDate, endDate /* nullable */, ledgerStartDate,
}>;
export type LeaseBillingTerms = z.infer<typeof leaseBillingTerms>;

export const plannedCharge: z.ZodObject<{
  generationKey, periodIndex, periodStart, periodEnd,
  occupiedStart, occupiedEnd, daysOccupied, daysInPeriod,
  dueDate, amountCents, isProrated,
}>;
export type PlannedCharge = z.infer<typeof plannedCharge>;

export function buildSchedule(terms: LeaseBillingTerms, through: IsoDate): PlannedCharge[];

/* ---------- generation ---------- */
export const GENERATION_LOOKAHEAD_DAYS = 31;
export const MAX_SCHEDULE_PERIODS = 600;
export const DEPOSIT_GENERATION_KEY = 'deposit';
export const OPENING_BALANCE_GENERATION_KEY = 'opening';

export function generationHorizon(today: IsoDate): IsoDate;             // addDays(today, 31)
export function chargesDueForGeneration(terms: LeaseBillingTerms, today: IsoDate): PlannedCharge[];
//   === buildSchedule(terms, generationHorizon(today)). The cron calls THIS.

/* ---------- validation, shared with the contract's superRefine ---------- */
export function validateBillingTerms(terms: LeaseBillingTerms): string | null;
```

`through` filters on **`periodStart <= through`** — the only coherent reading for a cron.

`buildSchedule` throws `RangeError` past `MAX_SCHEDULE_PERIODS`. The route validates
`through` is within 10 years of `startDate` first, so it never fires in practice.

### 1.6 Algorithm

```
windowStart = max(startDate, ledgerStartDate)        // == ledgerStartDate by invariant
windowEnd   = endDate ?? +infinity
for each period p in periodsOverlapping(freq, startDate, windowStart, min(windowEnd, through)):
  if p.start > through: break
  occupiedStart = max(p.start, windowStart)
  occupiedEnd   = min(p.end, windowEnd)
  if occupiedEnd < occupiedStart: continue
  daysInPeriod  = daysBetweenInclusive(p.start, p.end)
  daysOccupied  = daysBetweenInclusive(occupiedStart, occupiedEnd)
  amountCents   = daysOccupied === daysInPeriod ? rentCents
                                                : prorate(rentCents, daysOccupied, daysInPeriod)
  emit { generationKey: p.start, periodIndex: p.index, ..., 
         dueDate: dueDateFor({freq, period: p, occupiedStart, occupiedEnd, billingDay}),
         isProrated: daysOccupied < daysInPeriod }
```

Rent charges only. The deposit and the opening balance are single non-periodic charges
Phase 3 writes once, keyed `'deposit'` (due `start_date`) and `'opening'` (due
`ledger_start_date`). A period key is always `YYYY-MM-DD`, so no collision is possible.

### 1.7 Invariants each function guarantees

| # | Invariant | Where asserted |
|---|---|---|
| I1 | **Purity.** No `Date.now()`, no zero-arg `new Date()`, no `Intl`. Inputs are `IsoDate` strings and numbers. | A source-grep test in `billing.test.ts`, same spirit as the repo guards. |
| I2 | Integer money in, integer money out. No float escapes. | `prorate`, `buildSchedule` fixtures. |
| I3 | `generationKey === periodStart`, unique per lease across any schedule. | `buildSchedule` fixtures. |
| I4 | `periodStart <= occupiedStart <= occupiedEnd <= periodEnd`. | Property test over all fixtures. |
| I5 | `dueDate ∈ [occupiedStart, occupiedEnd]`. **Rent is never due before the keys or after the move-out.** | Property test over all fixtures. |
| I6 | `isProrated === (daysOccupied < daysInPeriod)`. | Property test. |
| I7 | `daysOccupied === daysInPeriod ⟹ amountCents === rentCents`, exactly. | Property test. |
| I8 | **Monotonicity:** for `X <= Y`, `buildSchedule(t, X)` is a strict prefix of `buildSchedule(t, Y)`. This is what makes the cron self-healing *and* idempotent. | Dedicated test over three `through` values per fixture. |
| I9 | Changing `through` never changes an existing entry's `amountCents`, `dueDate` or `generationKey`. Follows from I8; stated separately because it **is** the "tenant sees one number, gets billed another" guarantee. | Same test. |
| I10 | `chargesDueForGeneration(t, today) === buildSchedule(t, generationHorizon(today))`. The cron and the preview are one code path. | Dedicated test. |
| I11 | `periodsOverlapping` returns a contiguous, gapless, non-overlapping cover. | Dedicated test, both cadences, across a leap boundary. |
| I12 | `periodIndex` is anchored to the lease's first natural period and is **not** the array index. | `F9` pins it at 9 for a first-generated period. |

### 1.8 Timezone — confirmed, with one addition

**Confirmed.** Only "what is today" is timezone-sensitive, and it resolves in
`property.timezone` through the existing `localToday` in `common.ts`. Nothing in
`billing.ts` touches an instant, so there is no 23-hour day to get wrong.

For a **yearly** cadence the exposure is strictly smaller: one due date per year instead of
twelve, so one possible off-by-one-day per year instead of twelve.

Two wrinkles worth naming:

1. **The lookahead boundary is the only place `today` enters.** A UTC+14 and a UTC−11
   property can be on different calendar days at the same instant, so a yearly charge can
   materialise up to 25 hours apart for two landlords. Harmless: the row is keyed on the
   period, not on the run, and generation is idempotent and monotone (I8).
2. **The browser's today is not the property's today.** The lease form's preview runs in
   the user's locale. `buildSchedule` is unaffected because `through` is explicit — but any
   UI that renders "next charge" relative to today must call
   `localToday(lease.propertyTimezone)`, not the browser's clock. **Consequence for the
   contract: `propertyTimezone` must ride on `leaseSummary`, `leaseDetail` and
   `portalLease`.** Without it the client cannot be correct, and this is the one place a
   timezone bug would actually reach a tenant.

Tenant timezone remains unstored. It affects nothing financial.

### 1.9 Can a lease change frequency? No.

- On a `draft` lease, freely — nothing has been generated.
- Once a lease has ever been `active`, `rent_frequency` is immutable. `PATCH` attempting it
  returns `409 conflict` naming `/renew`.
- **So the question "what happens to already-generated charges" has no case to answer:** no
  charge on that lease was ever written under a different cadence. A cadence change is a
  renewal — predecessor keeps its monthly charges, successor generates yearly ones, both in
  the same `chain_id`, and Phase 3's balance aggregates over the chain.

---

## 2. Worked examples — `packages/contract/src/billing.fixtures.ts`

Exported as data so the API's route tests and the web app's preview tests assert
**identical numbers**. Every figure below is computed, not illustrative.

```ts
export interface ScheduleFixture  { name: string; terms: LeaseBillingTerms; through: IsoDate; expected: PlannedCharge[] }
export interface DueDateFixture   { name: string; input: Parameters<typeof dueDateFor>[0]; expected: IsoDate }
export interface ProrationFixture { name: string; rentCents: number; daysOccupied: number; daysInPeriod: number; expected: number }
export interface GenerationFixture{ name: string; terms: LeaseBillingTerms; today: IsoDate; expectedKeys: string[] }

export const scheduleFixtures:   readonly ScheduleFixture[];
export const dueDateFixtures:    readonly DueDateFixture[];
export const prorationFixtures:  readonly ProrationFixture[];
export const generationFixtures: readonly GenerationFixture[];
```

### 2.1 Schedule fixtures

**F1 — day 31 across a non-leap year.** monthly, rent `150000`, start `2026-01-01`,
end `null`, ledgerStart `2026-01-01`, billingDay `31`, through `2026-12-01`.
12 full periods, all `amountCents: 150000`, `isProrated: false`. Due dates:
`01-31, 02-28, 03-31, 04-30, 05-31, 06-30, 07-31, 08-31, 09-30, 10-31, 11-30, 12-31`.
**The February assertion is `2026-02-28`.**

**F2 — day 31 across a leap year.** Same, year 2028. February: `daysInPeriod: 29`,
due `2028-02-29`.

**F3 — starting mid-period, billing day before move-in.** monthly, rent `100000`,
start `2026-03-15`, ledgerStart `2026-03-15`, billingDay `1`, end `null`, through `2026-05-01`.

| key | period | occupied | days | due | amount | prorated |
|---|---|---|---|---|---|---|
| `2026-03-01` | 03-01..03-31 | 03-15..03-31 | 17/31 | **`2026-03-15`** | **`54839`** | yes |
| `2026-04-01` | 04-01..04-30 | full | 30/30 | `2026-04-01` | `100000` | no |
| `2026-05-01` | 05-01..05-31 | full | 31/31 | `2026-05-01` | `100000` | no |

`round(100000 × 17 / 31) = round(54838.7097) = 54839`.

**F3b — starting mid-period, billing day inside the stub.** Same as F3 but `billingDay: 20`.
First entry's due date is **`2026-03-20`**, everything else identical. This is the
**[CORRECTION]** to PLAN-V1 §4.3 made executable.

**F4 — ending mid-period.** monthly, rent `100000`, start `2026-01-01`, end `2026-06-10`,
billingDay `5`, through `2026-12-01`. **Exactly 6 entries** despite the far horizon:

| key | occupied | days | due | amount | prorated |
|---|---|---|---|---|---|
| `2026-01-01` .. `2026-05-01` | full | — | 5th of each month | `100000` | no |
| `2026-06-01` | 06-01..06-10 | 10/30 | `2026-06-05` | **`33333`** | yes |

**F5 — starts and ends inside the same period.** monthly, rent `100000`,
start `2026-03-05`, end `2026-03-20`, billingDay `1`, through `2026-12-01`.
**One entry:** key `2026-03-01`, occupied `03-05..03-20`, `16/31` days,
due **`2026-03-05`**, amount **`51613`**, prorated.

**F6 — clean yearly.** yearly, rent `2400000`, start `2026-04-01`, end `2029-03-31`,
billingDay `1` (ignored), through `2029-04-01`. **Three entries**, none prorated:

| key | period | daysInPeriod | due | amount |
|---|---|---|---|---|
| `2026-04-01` | 2026-04-01..2027-03-31 | `365` | `2026-04-01` | `2400000` |
| `2027-04-01` | 2027-04-01..2028-03-31 | **`366`** (contains 2028-02-29) | `2027-04-01` | `2400000` |
| `2028-04-01` | 2028-04-01..2029-03-31 | `365` | `2028-04-01` | `2400000` |

The fourth period would start `2029-04-01` — inside `through`, but past `end_date`. Excluded.

**F7 — yearly terminated mid-year.** yearly, rent `2400000`, start `2026-04-01`,
end `2026-09-30`, through `2027-04-01`. **One entry:** key `2026-04-01`,
period `2026-04-01..2027-03-31` (365 days), occupied `2026-04-01..2026-09-30` (183 days),
due `2026-04-01`, amount **`1203288`** (`round(2400000 × 183 / 365)`), prorated.
Note the whole prorated year falls due on day one — correct for a cadence paid in advance.

**F8 — yearly anchored on a leap day.** yearly, rent `1200000`, start `2028-02-29`,
end `null`, through `2031-01-01`. **Three entries**, none prorated:

| key | period | daysInPeriod | due |
|---|---|---|---|
| `2028-02-29` | 2028-02-29..2029-02-27 | `365` | `2028-02-29` |
| `2029-02-28` | 2029-02-28..2030-02-27 | `365` | `2029-02-28` |
| `2030-02-28` | 2030-02-28..2031-02-27 | `365` | `2030-02-28` |

**F9 — onboarding an in-flight tenancy.** monthly, rent `100000`, start `2025-06-15`,
ledgerStart `2026-03-01`, billingDay `1`, end `null`, through `2026-05-01`.
**Three entries**, all full, due on the 1st. The June-2025 stub and eight further months
**never appear** — they are the landlord's `openingBalanceCents`.
First entry's `periodIndex` is **`9`**, not `0` — this fixture is what pins I12.

**F10 — the composite case.** monthly, rent `100000`, start `2026-01-31`,
billingDay `31`, ledgerStart `2026-01-31`, through `2026-04-01`.

| key | occupied | days | due | amount | prorated |
|---|---|---|---|---|---|
| `2026-01-01` | 01-31..01-31 | 1/31 | `2026-01-31` | **`3226`** | yes |
| `2026-02-01` | full | 28/28 | **`2026-02-28`** | `100000` | no |
| `2026-03-01` | full | 31/31 | `2026-03-31` | `100000` | no |
| `2026-04-01` | full | 30/30 | `2026-04-30` | `100000` | no |

One-day proration and the February clamp in a single lease. If only one schedule fixture
survives review, keep this one.

### 2.2 Generation fixtures (the lookahead rule)

**F11 — monthly.** terms of F1.

| today | horizon | keys generated |
|---|---|---|
| `2026-02-28` | `2026-03-31` | `01-01, 02-01, 03-01` (3) |
| `2026-03-01` | `2026-04-01` | `01-01 … 04-01` (4) |
| `2026-03-20` | `2026-04-20` | `01-01 … 04-01` (4) |

Equivalent in practice to PLAN-V1's "current + next month", from the 1st onward.

**F12 — yearly.** terms of F6.

| today | horizon | keys generated |
|---|---|---|
| `2027-02-05` | `2027-03-08` | `2026-04-01` (1) |
| `2027-03-05` | `2027-04-05` | `2026-04-01, 2027-04-01` (2) |

Next year's charge appears 31 days before the lease year begins.

### 2.3 Due-date fixtures

| frequency | period | billingDay | occupied | expected |
|---|---|---|---|---|
| monthly | Feb 2026 | 31 | full | `2026-02-28` |
| monthly | Feb 2028 | 31 | full | `2028-02-29` |
| monthly | Feb 2100 | 31 | full | `2100-02-28` — century non-leap; catches a naive `year % 4` |
| monthly | Feb 2000 | 29 | full | `2000-02-29` — century leap |
| monthly | Apr 2026 | 31 | full | `2026-04-30` |
| monthly | Mar 2026 | 1 | 03-15..03-31 | `2026-03-15` (floored) |
| monthly | Mar 2026 | 20 | 03-15..03-31 | `2026-03-20` (honoured) |
| monthly | Jun 2026 | 25 | 06-01..06-10 | `2026-06-10` (ceilinged) |
| yearly | 2026-04-01.. | 15 | full | `2026-04-01` (ignored) |

### 2.4 Proration fixtures

| rentCents | daysOccupied | daysInPeriod | expected | why it is here |
|---|---|---|---|---|
| `100000` | 17 | 31 | `54839` | F3 |
| `100000` | 10 | 30 | `33333` | F4 |
| `100000` | 16 | 31 | `51613` | F5 |
| `100000` | 1 | 31 | `3226` | F10 |
| `2400000` | 183 | 365 | `1203288` | F7, yearly |
| `2400000` | 183 | 366 | `1200000` | leap lease year, exactly half |
| `100000` | 31 | 31 | `100000` | identity on a full period |
| `100000` | 29 | 29 | `100000` | identity, leap February |
| `100001` | 15 | 30 | `50001` | **pins `Math.round` half-up**; banker's rounding gives `50000` |
| `100000` | 0 | 31 | `0` | zero-day span |

---

## 3. Data model delta

Conventions unchanged: `casing: 'snake_case'`, UUIDv7 PKs from `uuidv7()`, money as
`bigint({ mode: 'number' })` integer minor units, `date` for day-precision, `timestamptz`
for instants, every org-owned table carries `org_id text not null references organization(id) on delete cascade`.

### 3.1 New enums

```ts
export const leaseStatusEnum   = pgEnum('lease_status',   ['draft','active','ended','terminated','cancelled']);
export const rentFrequencyEnum = pgEnum('rent_frequency', ['monthly','yearly']);
```

### 3.2 `lease`

| Column | Type | Notes / delta from PLAN-V1 §2.2 |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK → organization, **cascade** | |
| `unit_id` | `uuid` NOT NULL FK → unit, **`on delete restrict`** | **[CORRECTION]** PLAN-V1 left this unspecified. Units are soft-deleted, so a cascade here would be a latent data-loss path for financial history. Restrict. |
| `chain_id` | `uuid` NOT NULL | `= id` for a fresh lease, `= predecessor.chain_id` on renewal. Phase 3 balances aggregate on this. |
| `renewed_from_lease_id` | `uuid` NULL FK → lease, `on delete set null` | |
| `start_date` | `date` NOT NULL | |
| `end_date` | `date` NULL | NULL = rolling. **Inclusive.** The only thing that clips the schedule. |
| `move_out_date` | `date` NULL | Actual hand-back. **Does not affect billing.** May be before (early exit, still owes the term) or after (holdover) `end_date`. **[CORRECTION]** to PLAN-V1 §4.5. |
| `rent_cents` | `bigint` NOT NULL | |
| `currency` | `text` NOT NULL | Copied from the unit at create. Immutable. Not in `createLeaseBody`. |
| `rent_frequency` | `rent_frequency` NOT NULL default `'monthly'` | Immutable once the lease has ever been active. |
| `billing_day` | `smallint` NOT NULL default `1` | 1..31, CHECK. Normalised to `day-of-month(start_date)` when `yearly`. |
| `deposit_cents` | `bigint` NOT NULL default `0` | |
| `opening_balance_cents` | `bigint` NOT NULL default `0` | **NEW — not in PLAN-V1.** Written in Phase 2, materialised by Phase 3 as the `opening_balance` charge, `generation_key = 'opening'`, due `ledger_start_date`. Non-negative: a prepaid tenant is a Phase 3 *payment*, not a negative opening balance. |
| `ledger_start_date` | `date` NOT NULL | Defaults to `start_date`. Must equal `start_date` or be a period start. |
| `status` | `lease_status` NOT NULL default `'draft'` | |
| `end_reason` | `text` NULL | one of the contract's `endReason` values |
| `end_note` | `text` NULL | free text captured at `/end` |
| `notes` | `text` NULL | **Landlord-private. Structurally absent from every portal shape.** |
| `deleted_at` | `timestamptz` NULL | only ever set on `draft`/`cancelled` |
| `created_by_user_id` | `text` NOT NULL FK → user | |
| `created_at`, `updated_at` | `timestamptz` NOT NULL | |

**CHECK constraints**

```sql
lease_dates_ck       CHECK (end_date IS NULL OR end_date >= start_date)
lease_ledger_ck      CHECK (ledger_start_date >= start_date
                            AND (end_date IS NULL OR ledger_start_date <= end_date))
lease_billing_day_ck CHECK (billing_day BETWEEN 1 AND 31)
lease_money_ck       CHECK (rent_cents >= 0 AND deposit_cents >= 0 AND opening_balance_cents >= 0)
```

No CHECK ties `move_out_date` to `end_date` — holdover is legal in both directions.

**Indexes**

```sql
lease_org_unit_idx         (org_id, unit_id, status)
lease_chain_idx            (org_id, chain_id)
lease_org_status_start_idx (org_id, status, start_date)
lease_unit_active_uq       UNIQUE (unit_id) WHERE status = 'active'
```

Deliberately **not** added: a cross-org index for the Phase 3 cron's scan. Tens of
landlords × tens of units is a sequential scan measured in milliseconds. Index what you
query; do not pre-index what you have not written yet.

### 3.3 `lease_unit_active_uq` — the most valuable constraint in the schema

```sql
CREATE UNIQUE INDEX lease_unit_active_uq ON lease (unit_id) WHERE status = 'active';
```

```ts
uniqueIndex('lease_unit_active_uq').on(t.unitId).where(sql`${t.status} = 'active'`)
```

- **No `org_id`.** `unit_id` is the PK of a table that already carries `org_id`, so adding
  it widens the key without changing uniqueness. The one-column form is *stricter*, not
  looser. Flag it in the schema comment so the reviewer does not read it as a tenancy miss.
- **No `deleted_at IS NULL`.** An `active` lease is never soft-deleted (`deleted_at` is
  reachable only from `draft`/`cancelled`).
- **Verify the generated SQL.** Drizzle may emit `WHERE "status" = 'active'` without a
  cast; Postgres can require `'active'::lease_status` in an index predicate. If the
  migration errors, add the cast in the *generated, not-yet-applied* migration file.
- **Error returned when it fires:** `409 conflict`,
  `"This unit already has an active lease. End the current lease before starting a new one."`
  Produced in two places: a pre-check in `activateLease` for the clean path, and
  `isUniqueViolation(err)` (`lib/db-errors.ts`) around the UPDATE for the race. The catch is
  the authority; the pre-check is the nice message. Same pattern as `unit_label_uq` today.
- **It is not a lateral-movement primitive.** Landlord B can only reach the index through a
  lease row B owns, so B can never learn whether A's unit is occupied. §6.1 walks it.

### 3.4 `lease_tenant`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `text` NOT NULL FK → organization, cascade | |
| `lease_id` | `uuid` NOT NULL FK → lease, **cascade** | Only ever runs on the hard-delete of a `draft`/`cancelled` lease. |
| `tenant_id` | `uuid` NOT NULL FK → tenant, **restrict** | Tenants are only ever soft-deleted. |
| `is_primary` | `boolean` NOT NULL default `false` | |
| `added_on` | `date` NOT NULL | |
| `removed_on` | `date` NULL | roommate swap |
| `created_at` | `timestamptz` NOT NULL | |

```sql
lease_tenant_ck        CHECK (removed_on IS NULL OR removed_on >= added_on)

lease_tenant_lease_idx   (org_id, lease_id)
lease_tenant_tenant_idx  (org_id, tenant_id)                                  -- the portal's driving scan
lease_tenant_live_uq     UNIQUE (lease_id, tenant_id) WHERE removed_on IS NULL
lease_tenant_primary_uq  UNIQUE (lease_id) WHERE is_primary AND removed_on IS NULL
```

Two **[CORRECTION]**s to PLAN-V1 §2.2:

1. `lease_tenant_uq unique (lease_id, tenant_id)` becomes **partial on `removed_on IS NULL`**.
   The full version blocks a roommate who leaves and comes back — which is exactly the
   history the table exists to record.
2. "exactly one primary per lease, enforced in the repo" becomes
   `lease_tenant_primary_uq`, **enforced by the database**. At-most-one is a constraint;
   at-least-one stays an `activate` precondition because no index can express it.

### 3.5 Migration

**Entirely additive. No backfill, no multi-step migration, no data at risk.** Two new
enums, two new empty tables. One generated migration via `pnpm --filter api db:generate`.

Two things to verify in the generated SQL before committing:

1. the enum cast in `lease_unit_active_uq`'s predicate (§3.3);
2. that the installed `drizzle-orm` emits `check()` constraints — if not, append the four
   `ALTER TABLE ... ADD CONSTRAINT` statements to the *generated, uncommitted* migration.
   (The "never hand-edit a committed migration" rule is about applied migrations.)

### 3.6 Behaviour changes to existing routes — not a migration, but it ships here

PLAN-V1 §5.3 requires these and Phase 1 could not implement them because no `lease` table
existed. **They are backend-dev work in Phase 2** and they touch files Phase 1 wrote:

| Route | New behaviour |
|---|---|
| `DELETE /v1/tenants/:id` | `409 conflict` while the tenant is on any `active` lease. The TODO is already written at `apps/api/src/routes/tenants.ts:75` and `db/repo/tenant.ts:249`. |
| `DELETE /v1/units/:id` | `409 conflict` while the unit has an `active` lease. |
| `DELETE /v1/properties/:id` | `409 conflict` while **any** unit under it has an `active` lease. |

Message for all three: name the blocking lease and tell the landlord to end it first.

---

## 4. API surface

Conventions unchanged. All paths under `/v1`. Landlord routes behind `requireAuth`, tenant
routes under `/v1/portal/*` behind `requireTenant` via `middleware/auth-layer.ts` — **no
new entry is needed in that table**, the existing `under(path, '/v1/portal')` branch
already covers the new portal routes, and the fallthrough already covers the landlord ones.
`401` and `500` are possible on every route and are not repeated per row.

### 4.1 Leases — landlord (`requireAuth`)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/leases` | `pageQuery` + `?status=&unitId=&propertyId=&tenantId=` | `paged(leaseSummary)` | 400 |
| POST | `/v1/leases` | `createLeaseBody` | `201 lease` — always `status: 'draft'` | 404 (unit or any tenant not in org), 422 |
| GET | `/v1/leases/:id` | — | `leaseDetail` | 404 |
| PATCH | `/v1/leases/:id` | `updateLeaseBody` | `lease` | 404, 409 (immutable field on a non-draft), 422 |
| POST | `/v1/leases/:id/activate` | — | `lease` | 404, 409 |
| POST | `/v1/leases/:id/cancel` | `cancelLeaseBody` | `lease` | 404, 409 (not `draft`) |
| POST | `/v1/leases/:id/end` | `endLeaseBody` | `lease` | 404, 409 (not `active`), 422 |
| POST | `/v1/leases/:id/renew` | `renewLeaseBody` | `201 lease` (new row, same `chain_id`) | 404, 409, 422 |
| DELETE | `/v1/leases/:id` | — | `204` | 404, 409 (status not `draft`/`cancelled`) |
| GET | `/v1/leases/:id/schedule` | `?through=YYYY-MM-DD` | `leaseSchedule` — **computed, nothing written** | 404, 400, 422 |
| POST | `/v1/leases/:id/tenants` | `addLeaseTenantBody` | `201 leaseTenantSummary` | 404 (lease or tenant), 409 (already on the lease / lease ended), 422 |
| POST | `/v1/leases/:id/tenants/:tenantId/remove` | `removeLeaseTenantBody` | `leaseTenantSummary` | 404, 409 (last remaining tenant on an active lease), 422 |
| POST | `/v1/leases/:id/tenants/:tenantId/primary` | — | `leaseTenantSummary` | 404, 409 (tenant already removed) |

**Roster changes are their own routes, not folded into `PATCH`.** **[CORRECTION]** to
PLAN-V1 §3.4 ("`updateLeaseBody` … tenant roster"): a PATCH carrying a full roster array
cannot express *when* someone left, which is the entire point of `removed_on`.

**`PATCH` mutability, by status**

| Status | May change |
|---|---|
| `draft` | everything in `updateLeaseBody`, including `unitId` and `rentFrequency` |
| `active` | `notes`, `billingDay`, `depositCents`, `moveOutDate`, and an `endDate` that is **>= the current one** |
| `ended`, `terminated`, `cancelled` | `notes`, `moveOutDate` only |

Anything else on a non-draft is `409 conflict` with a message naming `/renew` (for
`rentCents`, `rentFrequency`, `startDate`, `unitId`, `currency`) or `/end` (for an
`endDate` that would shorten the term). **Shortening a term is ending it early — that is
what `/end` is for.** This removes a whole class of Phase 3 ambiguity about charges that
fall outside a retroactively shortened term.

`ledgerStartDate`, `openingBalanceCents` and `chainId` are immutable on anything but a
`draft`.

### 4.2 Leases — tenant (`requireTenant`)

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/v1/portal/leases` | — | `{ items: portalLease[] }` — **all orgs the caller is a tenant in** | — |
| GET | `/v1/portal/leases/:id` | — | `portalLeaseDetail` | 404 |
| GET | `/v1/portal/leases/:id/schedule` | `?through=YYYY-MM-DD` | `portalLeaseSchedule` | 404, 400, 422 |

- **Unpaginated by design.** A tenant has a handful of leases. No cursor, no 400 on a
  forged one, one fewer thing to get wrong.
- The portal schedule is the most useful Phase 2 screen and the exact surface that must
  match the Phase 3 cron. It is computed server-side from the same `buildSchedule`.
- **Routing footgun:** `routes.portal.profile` is `/v1/portal/:tenantId/profile`. Register
  the lease routes in a separate `routes/portal-leases.ts` and `app.route()` it **before**
  `portal` in `index.ts`, so `/v1/portal/leases/:id` can never be matched as a `:tenantId`.
  `requireUuidParam` makes the collision unreachable in practice; the ordering makes it
  unreachable by construction.

### 4.3 Error codes, enumerated

| Code | When |
|---|---|
| `400 bad_request` | malformed `?through=`, bad cursor, non-UUID path param |
| `404 not_found` | lease / unit / tenant absent **or** belonging to another org **or**, in the portal, not on the caller's roster. Never a 403 — a 403 confirms the row exists. |
| `409 conflict` | every illegal state transition (§5); unit already has an active lease; unit is `unavailable`; immutable field on a non-draft; renewal overlaps the predecessor; removing the last tenant from an active lease; deleting a lease that has been active |
| `422 validation_failed` | any `superRefine` failure — `primaryTenantId` not in `tenantIds`, duplicate tenant ids, `endDate < startDate`, `ledgerStartDate` not a period start, `through` more than 10 years out |

---

## 5. Lease lifecycle state machine

```
                  ┌── cancel ──► cancelled ──delete──► (gone)
                  │
draft ──activate──┴──► active ──end(reason ∈ breach|eviction)──► terminated
  │                      │
  └── delete ──► (gone)  └──end(any other reason)──────────────► ended
                         │
                         └── renew ──► NEW lease row, same chain_id
                                       predecessor ends the day before
ended ── renew ──► NEW lease row, same chain_id, gap allowed
```

`ended` and `terminated` are **terminal**. `cancelled` is terminal except for hard delete.

### 5.1 Transition table

| From | To | Route | Preconditions (else `409`) | Writes `unit.status` |
|---|---|---|---|---|
| `draft` | `active` | `POST /activate` | ≥1 live `lease_tenant`; exactly one live primary; unit is live and not `unavailable`; no other `active` lease on the unit | `occupied` |
| `draft` | `cancelled` | `POST /cancel` | — | unchanged |
| `draft` | gone | `DELETE` | — (Phase 3 adds: zero charges, zero payments) | unchanged |
| `cancelled` | gone | `DELETE` | same | unchanged |
| `active` | `ended` | `POST /end`, reason ∉ {`breach`,`eviction`} | `endDate >= start_date` and `>= ledger_start_date` | `vacant` **only if** no other active lease on the unit **and** `unit.status = 'occupied'` |
| `active` | `terminated` | `POST /end`, reason ∈ {`breach`,`eviction`} | same | same |
| `active` | `ended` + new row | `POST /renew` | `newStart > predecessor.start_date`; predecessor is ended at `newStart − 1` | stays `occupied` |
| `ended` | new row | `POST /renew` | `newStart > predecessor.end_date` — **a gap is allowed** | `occupied` |

`statusForEndReason(reason)` is a pure function **exported from `lease.ts`**, so the dialog
can say "this will mark the lease Terminated" before the landlord commits, and the server
derives the status rather than trusting a client-chosen one.

`endReason` enum: `term_ended | renewed | mutual | tenant_notice | landlord_notice | breach | eviction | other`.
`breach` and `eviction` → `terminated`; everything else → `ended`.

### 5.2 Illegal transitions and what they return

| Attempt | Result |
|---|---|
| `activate` on anything but `draft` | `409` — "Only a draft lease can be activated." |
| `activate` where the unit has an active lease | `409` — "This unit already has an active lease. End the current lease before starting a new one." |
| `activate` on an `unavailable` unit | `409` — "This unit is marked unavailable. Change its status before activating a lease." |
| `activate` with no tenants / no primary | `409` — "Add at least one tenant and mark one as primary before activating." |
| `end` on a `draft` | `409` — "Activate the lease first, or cancel it." |
| `end` on `ended`/`terminated`/`cancelled` | `409` — "This lease has already ended." |
| `cancel` on anything but `draft` | `409` |
| `renew` from `draft`, `terminated` or `cancelled` | `409` — "Only an active or ended lease can be renewed." |
| `renew` whose `startDate` overlaps the predecessor's term | `409` |
| `DELETE` on `active`/`ended`/`terminated` | `409` — "Leases that have been active are kept for the record. End the lease instead." |

**Renewal from `ended` is allowed and a gap is permitted. [CORRECTION]** to PLAN-V1 §5.1,
which enforced `start_date = predecessor.end_date + 1` and 409'd on a gap. A unit genuinely
sits vacant between terms, and forcing contiguity makes the landlord fabricate dates.
Overlap is still `409`.

### 5.3 Renewal mechanics

- New row: `chain_id = predecessor.chain_id`, `renewed_from_lease_id = predecessor.id`,
  `currency` and `unit_id` copied, `status = 'active'`, `ledger_start_date = startDate`,
  `opening_balance_cents = 0`.
- `carryTenantIds` defaults to the predecessor's **live** roster (`removed_on IS NULL`);
  `primaryTenantId` defaults to the predecessor's primary.
- `rentFrequency` defaults to the predecessor's. **Supplying a different one is the
  supported way to change cadence.**
- A future-dated renewal is created `active`, not `draft`. The unit is genuinely booked;
  `lease_unit_active_uq` correctly blocks anyone else from taking it. `unit.status` reads
  `occupied` with the lease card showing "starts 1 Apr" — a one-bit field cannot say more,
  and that is acceptable.

### 5.4 Write ordering — there are no interactive transactions

The Neon HTTP driver (`db/index.ts`) has no interactive transactions. Order every
multi-statement operation so the torn state is **safe and detectable**:

| Operation | Order | Torn state |
|---|---|---|
| `activate` | lease row → `unit.status` | active lease on a unit still marked `vacant`. Lease is the system of record. |
| `end` | lease row → `unit.status` | ended lease on a unit still marked `occupied`. |
| `renew` | **end the predecessor first**, then insert the successor | unit with zero active leases and a chain that stops. Visible, fixable, no double-booking. Inserting first would hit `lease_unit_active_uq` and 500 on the legitimate path. |
| `create` + roster | lease row → `lease_tenant` rows | a draft with no tenants. `activate` refuses it. |

`unit.status` is a cached denormalisation of "does this unit have an active lease". Phase 3's
daily consistency check **reports** disagreements; it never silently repairs them.

### 5.5 Multiple tenants, joint liability, roommate history

- Every tenant on a lease is **jointly and severally liable for the whole amount**. Phase 3
  computes one balance per lease (per chain), never a per-tenant split. Stated now so
  nobody builds a split in Phase 3.
- `is_primary` marks who reminders address (Phase 4). Exactly one live primary, enforced by
  `lease_tenant_primary_uq`.
- **Roommate swap:** `POST /tenants/:tenantId/remove` sets `removed_on`; `POST /tenants`
  inserts the arriving one. The lease, its rent and its schedule are untouched.
- **Removing the primary** requires `primaryTenantId` to be reassigned first, or the remove
  returns `409` naming the `/primary` route. Keeps the partial unique index satisfiable.
- **Removing the last live tenant from an `active` lease** is `409`. End the lease instead.
- `removedOn` defaults to `localToday(property.timezone)` server-side when omitted — the
  one place in Phase 2 that reads the clock, and it reads it in the property's zone.

### 5.6 What a removed tenant can still see

**Everything on that lease, read-only, forever** — including periods billed after they
left, and (in Phase 3) payments a co-tenant made. They were jointly liable for the whole
term; there is nothing on it they did not already have access to.

Mechanically: `repo/portal/lease.ts`'s `listLeases` and `resolveLease` join `lease_tenant`
**without** a `removed_on` filter. The response carries `yourRole: 'current' | 'former'` and
`removedOn`, so the UI can show a banner instead of pretending nothing changed.

A **second** resolver, `resolveActiveLease(scope, db, leaseId)`, adds
`removed_on IS NULL AND lease.status = 'active'`. Nothing in Phase 2 calls it — it exists
and is named now so Phase 5's "raise a maintenance request" uses the right one instead of
inventing a filter at the call site. A removed tenant reads; a removed tenant does not write.

---

## 6. Contract additions — file by file

Five files. **Two are new, three are extended. Nothing is rewritten.**

### 6.1 `packages/contract/src/billing.ts` — NEW

Full surface in §1.5. Imports `common.ts` only. Defines `rentFrequency`.

### 6.2 `packages/contract/src/billing.fixtures.ts` — NEW

Full contents in §2. Separate file so `billing.ts` stays pure logic and both test suites
import the fixtures by name.

### 6.3 `packages/contract/src/lease.ts` — NEW

```ts
import { rentFrequency, plannedCharge, type RentFrequency } from './billing.js';

export const leaseStatus = z.enum(['draft','active','ended','terminated','cancelled']);
export const leaseStatusLabels: Record<LeaseStatus, string>;
export const endReason = z.enum([
  'term_ended','renewed','mutual','tenant_notice','landlord_notice','breach','eviction','other',
]);
export const endReasonLabels: Record<EndReason, string>;
export function statusForEndReason(r: EndReason): 'ended' | 'terminated';
export { rentFrequency };   // re-export so lease consumers need one import

/* ---------- requests ---------- */
createLeaseBody = z.object({
  unitId: uuid,
  tenantIds: z.array(uuid).min(1).max(8),
  primaryTenantId: uuid,
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  rentCents: money,
  rentFrequency,
  billingDay: z.number().int().min(1).max(31).default(1),
  depositCents: money.default(0),
  ledgerStartDate: isoDate.optional(),       // server defaults to startDate
  openingBalanceCents: money.default(0),
  notes: z.string().trim().max(2000).optional(),
}).superRefine(...)        // primaryTenantId ∈ tenantIds; no duplicate ids;
                           // validateBillingTerms(...) from billing.ts

updateLeaseBody        // createLeaseBody's shape, all optional, + moveOutDate
endLeaseBody           = { endDate, moveOutDate?, reason: endReason, note? }
renewLeaseBody         = { startDate, endDate?, rentCents, rentFrequency?, billingDay?,
                           depositCents?, carryTenantIds?, primaryTenantId?, notes? }
cancelLeaseBody        = { reason? }
addLeaseTenantBody     = { tenantId, isPrimary: boolean.default(false), addedOn? }
removeLeaseTenantBody  = { removedOn? }
leaseListQuery         = pageQuery.extend({ status?, unitId?, propertyId?, tenantId? })
scheduleQuery          = { through: isoDate }      // refined: within 10 years

/* ---------- responses ---------- */
leaseTenantSummary = { tenantId, firstName, lastName, isPrimary, addedOn, removedOn }
leaseSummary = {
  id, chainId, status, unitId, unitLabel, propertyId, propertyName,
  propertyTimezone,                                   // §1.8 — the client cannot be correct without it
  startDate, endDate, moveOutDate,
  rentCents, currency, rentFrequency, billingDay,
  depositCents, openingBalanceCents, ledgerStartDate,
  tenantCount, primaryTenantName,
  renewedFromLeaseId, endReason, createdAt, updatedAt,
}
lease = leaseSummary                                  // every write route returns this
leaseDetail = leaseSummary.extend({
  tenants: leaseTenantSummary[],
  notes,                                              // landlord-private, detail only
  unitStatus,
  propertyAddress: address,
  chain: { id, status, startDate, endDate, rentCents }[],   // one query on chain_id
})
leaseSchedule = { leaseId, currency, computedThrough: isoDate, periods: plannedCharge[] }
```

`plannedCharge` is imported from `billing.ts`, **not redeclared** — the pure function's
return type and the wire shape are the same zod object, so they cannot drift.

### 6.4 `packages/contract/src/portal.ts` — EXTENDED

```ts
portalCoTenant = { firstName, lastName, isPrimary, isCurrent }
// No email. No phone. NO tenantId — structurally absent, not filtered.

portalLease = {
  id, orgId, landlordName,
  status: leaseStatus,
  unitLabel, propertyName, propertyAddress, propertyTimezone,
  startDate, endDate, moveOutDate,
  rentCents, currency, rentFrequency, billingDay, depositCents,
  yourRole: z.enum(['current','former']),
  removedOn: isoDate.nullable(),
}
portalLeaseDetail = portalLease.extend({ coTenants: portalCoTenant[], ledgerStartDate })
portalLeaseSchedule = { leaseId, currency, computedThrough, periods: plannedCharge[] }
```

Structurally absent from every portal shape: `notes`, `openingBalanceCents`, `chainId`,
`renewedFromLeaseId`, `endReason`, `createdBy`, and any co-tenant contact detail.
`openingBalanceCents` is withheld because a debt figure with no ledger to explain it
(Phase 3) is worse than no figure.

### 6.5 `packages/contract/src/routes.ts` — EXTENDED

```ts
leases: {
  list, create, get, update, remove,
  activate:         (id) => `/v1/leases/${id}/activate`,
  cancel:           (id) => `/v1/leases/${id}/cancel`,
  end:              (id) => `/v1/leases/${id}/end`,
  renew:            (id) => `/v1/leases/${id}/renew`,
  schedule:         (id) => `/v1/leases/${id}/schedule`,
  addTenant:        (id) => `/v1/leases/${id}/tenants`,
  removeTenant:     (id, tenantId) => `/v1/leases/${id}/tenants/${tenantId}/remove`,
  setPrimaryTenant: (id, tenantId) => `/v1/leases/${id}/tenants/${tenantId}/primary`,
},
portal: {
  ...existing,
  leases:        () => '/v1/portal/leases',
  lease:         (id) => `/v1/portal/leases/${id}`,
  leaseSchedule: (id) => `/v1/portal/leases/${id}/schedule`,
},
```

### 6.6 `packages/contract/src/index.ts` — EXTENDED

Add `export * from './billing.js'` and `'./billing.fixtures.js'` and `'./lease.js'`.
`billing.js` must be exported **before** `lease.js` for readability; module order does not
affect correctness because there is no cycle.

### 6.7 `common.ts` — UNCHANGED

`money`, `moneyDelta`, `moneyTotal`, `isoDate`, `timezone` and `localToday` already exist
and are exactly what Phase 2 needs. One fewer file to freeze.

---

## 7. The tenant attack walk, again — new portal routes

Setup: Dana is authenticated. `scope.pairs = [{org A, t1}, {org B, t2}]`, resolved fresh
from the database by `requireTenant` on every request. She holds `L_X`, a lease UUID
belonging to landlord C's tenant Eve, and `L_N`, her next-door neighbour's lease — **same
org A, same landlord, different tenant.**

| Attempt | Result | Why |
|---|---|---|
| `GET /v1/portal/leases/L_X` | `404` | `resolveLease(scope, db, id)` filters `lease.id = $1 AND (lease.org_id, lease_tenant.tenant_id) IN scope.pairs`. Zero rows. 404, never 403 — existence stays unconfirmed. |
| **`GET /v1/portal/leases/L_N`** | **`404`** | **The dangerous one.** A filter on `org_id` alone returns this row — Dana *is* a tenant in org A. The pair filter requires `lease_tenant.tenant_id = t1` as well. `portal-tenancy.guard.test.ts` already asserts every portal repo function references **both** `orgId` and `tenantId`; this is precisely the case it exists for. |
| `GET /v1/portal/leases/L_X/schedule` | `404` | The route calls `resolveLease` **first** and 404s before `billing.ts` is reached. The schedule is built from the resolved row's columns; nothing from the request survives into the computation except the lease id that was just verified. |
| `GET /v1/portal/leases/{own L1}?orgId=C` | the param is ignored | No portal route reads an org id from the request. Grep-checkable; already on the reviewer checklist. |
| Replays a `lease_tenant.id` as a lease id | `404` | No route accepts one. The roster is only ever reached through a resolved lease. |
| Replays a co-tenant's `tenantId` against `/v1/portal/:tenantId/profile` | `404` | Not in `scope.pairs`. And `portalCoTenant` does not carry `tenantId` at all, so she never gets one to replay. |
| Dana was removed from L1 on 2026-03-01, requests L1 | `200`, `yourRole: 'former'` | Deliberate (§5.6). Joint liability means there is nothing on that lease she did not already have. |
| Dana (removed) tries to write to L1 | no portal write exists in Phase 2 | Named for Phase 5: the write path uses `resolveActiveLease`, which adds `removed_on IS NULL`. |
| Co-tenant's email or phone | not in the response | No column for it in `portalCoTenant`. Structurally absent, not filtered in a mapper. |
| Landlord's `lease.notes` | not in the response | Same. |
| `t1` archived mid-session | next request `403` | `resolveScope` re-runs per request and excludes archived/soft-deleted. `t2` survives; if `t1` was her only tenancy, the scope is empty and `requireTenant` 403s. |
| Landlord A calls `DELETE /v1/tenants/t1/portal-access` | next request, `t1` drops out | `tenant.user_id` is nulled; `resolveScope` keys on `user_id`. No session to invalidate. |
| Dana creates her own org, calls `GET /v1/leases` | `200 { items: [] }` | `requireAuth` now passes for *her own empty org*; `listLeases(orgId = D, …)` returns nothing. Zero reach into A, B or C. |
| Dana (as landlord of D) calls `GET /v1/leases/{her own L1 id}` | `404` | `getLease(orgId = D, db, L1)` — L1's `org_id` is A. |
| `?through=9999-12-31` on the portal schedule | `422` | `scheduleQuery` refines `through` to within 10 years of `startDate`; `MAX_SCHEDULE_PERIODS` is a second floor that cannot be reached. |
| Forged pagination cursor on `/v1/portal/leases` | n/a | Unpaginated by design. |

### 7.1 And the landlord-vs-landlord walk

**"I am landlord B holding landlord A's UUIDs."**

| Attempt | Result | Why |
|---|---|---|
| `POST /v1/leases { unitId: A_unit, … }` | `404 Unit not found` | `createLease` resolves the unit through the existing `getUnit(orgId = B, …)`, which already filters `org_id`, `deleted_at IS NULL` and `liveProperties`. |
| **`POST /v1/leases { tenantIds: [A_tenant] }`** | **`404 Tenant not found`** | **The single most likely cross-org bug in Phase 2.** The roster insert must never trust the body's ids: resolve them with one `SELECT id FROM tenant WHERE org_id = $B AND id IN (...) AND deleted_at IS NULL` and 404 if the returned count is short. A blind multi-row `INSERT INTO lease_tenant` from the request array writes A's tenant into B's lease. **Requires a dedicated test.** |
| `POST /v1/leases/{own draft}/tenants { tenantId: A_tenant }` | `404` | Same check, same test. |
| `POST /v1/leases/{A_lease}/activate` | `404` | `getLease(orgId = B, …)` returns nothing. B never reaches `lease_unit_active_uq`, so the index cannot be used to probe whether A's unit is occupied. |
| `GET /v1/leases/{A_lease}/schedule` | `404` | Same. |
| `POST /v1/leases { unitId: <B's own soft-deleted unit> }` | `404` | Existing `getUnit` behaviour, unchanged. |

---

## 8. Task split

Frozen contract, then both agents dispatched at once. **The only shared surface is
`packages/contract/**`.** No file outside it is touched by both.

### 8.1 backend-dev — `apps/api/**` only

1. **Schema** (`db/schema.ts`): `leaseStatusEnum`, `rentFrequencyEnum`, `lease`,
   `leaseTenant`, all CHECKs and indexes from §3. One generated migration; verify the two
   items in §3.5 before committing it.
2. **`db/repo/lease.ts`** — `orgId` first on every exported function, split query builders
   for `.toSQL()` assertion, exactly as `property.ts`/`unit.ts`/`tenant.ts` do today:
   `listLeases`, `getLease`, `getLeaseDetail`, `getChain`, `createLease`, `updateLease`,
   `activateLease`, `cancelLease`, `endLease`, `renewLease`, `hardDeleteLease`,
   `addLeaseTenant`, `removeLeaseTenant`, `setPrimaryTenant`, `resolveTenantIds`,
   `countActiveLeasesForUnit`, `countActiveLeasesForTenant`,
   `countActiveLeasesForProperty`.
3. **`db/repo/portal/lease.ts`** — `scope: TenantScope` first, body referencing both
   `orgId` and `tenantId`: `listLeases`, `resolveLease`, `resolveActiveLease`,
   `listCoTenants`.
4. **Bump both guard floors:** `MIN_LANDLORD_REPO_FILES` 3 → 4,
   `MIN_PORTAL_REPO_FILES` 2 → 3.
5. **Routes:** `routes/leases.ts`, `routes/portal-leases.ts`. Mount `portal-leases`
   **before** `portal` in `index.ts` (§4.2). No change to `middleware/auth-layer.ts`.
6. **`lib/mappers.ts`:** `mapLeaseSummary`, `mapLeaseDetail`, `mapLeaseTenant`,
   `mapPortalLease`, `mapPortalLeaseDetail`. Never spread a row.
7. **Both schedule routes are built from `@rms/contract`'s `buildSchedule`.** Zero local
   date arithmetic anywhere in `apps/api`. Add a source-grep test that fails if
   `apps/api/src` contains a second `daysInMonth`, a `/ 30`, or any proration expression.
8. **Amend three existing delete routes** per §3.6.
9. **Tests:**
   - cross-org isolation for every new repo function (existing convention);
   - the whole of §7 and §7.1 as route tests — especially the foreign-`tenantId` roster
     insert;
   - every illegal transition in §5.2 → the exact 409;
   - `lease_unit_active_uq` firing → the named 409, asserted against a real double-activate;
   - `scheduleFixtures` asserted **through the HTTP route** — `GET /schedule` returns the
     fixture's exact `amountCents` and `dueDate` values.

### 8.2 frontend-dev — `apps/web/**` only

1. **`features/leases/api.ts`** — react-query hooks against `routes.leases.*`, same
   `useInfiniteQuery` + keyset cursor pattern as `features/units/api.ts`.
2. **Leases list page** — filters for status / property / unit / tenant, with loading,
   empty and error states.
3. **Create wizard** — unit → tenants (multi-select + primary picker) → terms → review.
   The review step renders a **live schedule preview computed client-side by
   `buildSchedule`**, not fetched. This is the screen the whole phase is for.
4. **Frequency toggle.** Selecting `yearly` hides `billingDay` and shows
   "A yearly lease is due on the first day of each lease year." Selecting `monthly` shows
   it with "We bill the last day of shorter months — 31 becomes 28 in February."
5. **"Existing tenancy" disclosure** on the terms step revealing `ledgerStartDate` and
   `openingBalanceCents`, with the period-start restriction surfaced as inline help, not
   as a server 422 the user discovers on submit.
6. **Lease detail** — terms, roster with add / remove / set-primary, chain timeline,
   schedule table, status actions.
7. **Activate / End / Renew / Cancel dialogs.** Each surfaces its `409` message verbatim as
   a toast — the backend writes those messages for the landlord to read, so do not
   re-write them client-side. The End dialog shows `statusForEndReason(reason)` live.
8. **Lease cards** on the unit detail and tenant detail pages.
9. **`/portal/leases` and `/portal/leases/:id`** — terms, co-tenant display names, schedule
   table, and a banner when `yourRole === 'former'`.
10. **Any "today"-relative rendering uses `localToday(lease.propertyTimezone)`**, never the
    browser clock (§1.8). One test for a lease in a zone 12+ hours from the test runner's.
11. **Tests:** the wizard's validation failure paths, and a test asserting the preview
    matches `scheduleFixtures` — **the same fixtures the backend asserts**.

### 8.3 What they share — stated explicitly

`packages/contract/**`, frozen, and nothing else.

Within it, **`billing.ts` and `billing.fixtures.ts` are executable shared logic, not
types.** This is the phase where the contract stops being only schemas. Put this sentence
in both task files verbatim:

> *The number the lease form previews and the number the Phase 3 cron writes must be
> produced by the same call to `buildSchedule`. If you find yourself writing date
> arithmetic, stop — it already exists in the contract, and a second copy is the bug this
> whole design is built to prevent.*

Neither agent edits `packages/contract`. If the contract is wrong, stop and report upward.

---

## 9. Risks, assumptions, and the one thing I want confirmed

### 9.1 Risks I am confident about

| Risk | Mitigation |
|---|---|
| **A second implementation of the date maths** — the whole phase's failure mode. | Frontend imports `buildSchedule` directly; backend has a source-grep test banning local date arithmetic; both assert the same fixtures. |
| **The roster insert trusting a body `tenantId`** — writes another org's tenant onto a lease. | `resolveTenantIds(orgId, …)` with a count check, plus a dedicated cross-org route test (§7.1). |
| Drizzle emits the partial-index predicate without an enum cast; Postgres rejects it. | Read the generated migration before committing; add `::lease_status` if needed. |
| Installed `drizzle-orm` may not support `check()` in the table extras array. | Append the four `ALTER TABLE` statements to the generated, uncommitted migration. |
| **No interactive transactions.** `activate`, `end` and `renew` are multi-statement. | Write ordering in §5.4 makes every torn state safe and detectable; Phase 3's daily check reports `unit.status` disagreements. |
| `Math.round` vs banker's rounding silently diverging between a future server and the browser. | `prorationFixtures` pins `(100001, 15, 30) → 50001`. |
| `periodIndex` is anchored, not positional — easy to use as an array index. | Documented in the type, pinned by `F9` at `9`. |
| The yearly Feb-29 anchor shifting every later year to Feb 28 → Feb 27. | Documented in §1.2, pinned by `F8`. No day is ever uncovered or double-covered. |
| A landlord changing `billing_day` on an active lease. | Allowed; it moves **future** due dates only. Already-generated Phase 3 charges are rows and are never recomputed. Flagged for Phase 3's generator. |
| The portal route `/v1/portal/leases/:id` colliding with `/v1/portal/:tenantId/profile`. | Separate router mounted first + `requireUuidParam`. |
| `GET /v1/leases` ordered by `asc(id)` rather than by `start_date desc`, which is what a landlord expects. | Deliberate: keyset pagination on UUIDv7 is the established convention and a landlord has tens of leases. Noted so the reviewer does not flag it. Revisit only if a real landlord complains. |

### 9.2 The one decision I want confirmed

**Does `move_out_date` stop the rent?**

- **My recommendation, and the default this plan is written to:** **no.** `end_date` alone
  clips the schedule. A tenant who leaves on the 10th of a term running to the 30th still
  owes to the 30th — that is what a fixed term is. A landlord who agrees to release them
  early does so by calling `/end` with an earlier `endDate`, which is an explicit act.
- **What PLAN-V1 §4.5 said:** `min(end_date, move_out_date)`. That silently writes off
  rent the landlord is owed, with no record that a concession was ever made.
- **Cost of being wrong:** one line in `buildSchedule`'s caller, plus re-deriving `F4` and
  `F7`. Cheap to reverse, but it must be decided **before** Phase 3 writes charge rows
  against it.

### 9.3 Assumptions I made without being told

1. `currency` is inherited from the unit and immutable on the lease — PLAN-V1 §2.2 says so;
   I kept it out of `createLeaseBody` entirely rather than accepting and ignoring it.
2. A lease may carry at most 8 tenants. Arbitrary but non-zero; a roster of 50 is a data
   entry error, not a tenancy.
3. `opening_balance_cents` is non-negative. A tenant who is *in credit* at onboarding is
   recorded as a Phase 3 payment, not a negative opening balance.
4. The portal lease list is unpaginated. A tenant with more than a handful of leases does
   not exist.
5. Phase 2 writes no charge rows and no `charge` table. `GET /schedule` is pure computation
   on both actors' routes.
6. `GET /schedule` has no status restriction — it works on a `draft` (that is the preview),
   on an `active` lease, and on an `ended` one (that is the record).
