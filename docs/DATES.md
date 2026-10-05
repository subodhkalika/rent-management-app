# Dates: where they live, and what a calendar swap would cost

Tracking document. **No alternative calendar is implemented.** This exists so that
adding one — Bikram Sambat is the named candidate — is a known, scoped change rather
than an archaeology exercise.

Keep this file current. If you add date handling anywhere, add it here.

## The distinction that decides everything

Two kinds of "date" in this system, and only one of them is calendar-sensitive in a
way that matters.

### A. Instants — `timestamptz`

`createdAt`, `updatedAt`, `deletedAt`, `expiresAt`, `acceptedAt`, `revokedAt`,
`addedOn`'s audit siblings.

An instant is an instant regardless of calendar. **A calendar swap changes only how
these are displayed.** Nothing structural. Stored as UTC, rendered in whatever
calendar and timezone the viewer wants.

### B. Civil dates — `date`, no time component

`lease.start_date`, `end_date`, `move_out_date`, `ledger_start_date`,
`charge.due_date`, `period_start`, `period_end`, `payment.received_on`,
`lease_tenant.added_on` / `removed_on`, `reminder_log.scheduled_for`.

These are calendar statements, not instants. **This is where a calendar swap is
structural**, and it splits again:

- **B1 — presentation.** Showing `2026-04-01` as `19 Baisakh 2083`. Localisation.
  Contained, low risk, no stored data changes.
- **B2 — period semantics.** What "monthly" *means*. A Nepali landlord billing
  monthly means a Bikram Sambat month (Baisakh, Jestha, …), not a Gregorian one.
  **This is the hard part**, and it lives almost entirely in one file.

## Why Bikram Sambat is harder than it looks

Not merely an offset. Gregorian arithmetic does not transfer:

- **Month lengths vary 29–32 days and change from year to year.** There is no closed
  form. Real implementations ship lookup tables, typically ~1970–2100 BS.
- **No leap-year rule** of the `year % 4` kind. `isLeapYear` has no analogue.
- **The year starts in mid-April** (Baisakh 1), so a BS year straddles two Gregorian
  ones and vice versa.
- Day-of-month 31 and 32 exist. `billing_day` clamped to `1..31` is already wrong
  for BS, before any arithmetic runs.

So `daysInMonth(year, month)` cannot stay a computation. It becomes a lookup.

## Where date logic actually lives

Deliberately concentrated. The grep guard in `apps/api` exists partly to keep it so.

| Location | Kind | Calendar-sensitive? |
|---|---|---|
| **`packages/contract/src/billing.ts`** | **B2 — all period and due-date arithmetic** | **Yes. This is the file.** |
| `packages/contract/src/billing.fixtures.ts` | worked examples | Yes — every expected value is Gregorian |
| `packages/contract/src/common.ts` — `isoDate` | validates `YYYY-MM-DD`, rejects impossible dates by round-tripping through `Date.UTC` | Yes — "impossible" is calendar-defined |
| `packages/contract/src/common.ts` — `localToday` | "what day is it in this timezone", via `Intl` | B1/B2 boundary — the answer is a calendar date |
| `packages/contract/src/common.ts` — `uuidv7` | `Date.now()` for key ordering | No. Not a date, a sort key. |
| `apps/api/src/lib/mappers.ts` | `.toISOString()` on instants | No — category A |
| `apps/api/src/db/repo/*.ts` | `new Date()` for `updatedAt` / `deletedAt` | No — category A |
| `apps/api/src/routes/tenants.ts` | invite `expiresAt` = now + 14d | No — a duration on an instant |
| `apps/api/src/routes/portal.ts` | invite liveness vs now | No — category A |
| `apps/web/**` | `toLocaleString()` on instants | B1 only — presentation |

**The concentration is the asset.** Everything structural is in `billing.ts`.
Everything else is either an instant or a render.

## What a swap would require

1. **A `Calendar` seam in `billing.ts`.** Today's functions — `isLeapYear`,
   `daysInMonth`, `addMonths`, `addYears`, `clampDayToMonth`, `periodsOverlapping`,
   `periodContaining` — become one implementation behind an interface. Gregorian
   stays the default; a Bikram Sambat implementation is table-driven.
2. **Storage stays Gregorian ISO.** `2026-04-01` in the database, always. BS is a
   lens over a stored civil date, never the storage format — ISO sorts, compares,
   and indexes correctly, and every tool understands it.
3. **A calendar setting, almost certainly on `property`.** It sits beside
   `timezone` and `move_out_billing_policy`, which are already per-property for the
   same reason: this follows the building's market.
4. **`billing_day` range widens** to the calendar's maximum month length (32 for BS).
   The `1..31` CHECK and the contract's `.max(31)` both become calendar-dependent.
5. **Fixtures fork.** Every one in `billing.fixtures.ts` is Gregorian by construction.
   A BS calendar needs its own set; the existing ones stay as the Gregorian
   conformance suite.
6. **Presentation everywhere in `apps/web`.** Mechanical but broad.

## Rules to keep the cost where it is

- **Never do date arithmetic outside `billing.ts`.** Not in a route, not in a
  component, not in a repo function. The `apps/api` source-grep guard enforces part
  of this; extend it rather than working around it.
- **Never store a formatted date.** Store the civil date; format at the edge.
- **Never compare a civil date to an instant.** "Is this charge overdue" is
  `due_date < localToday(property.timezone)` — two civil dates. It is never a
  `Date` comparison.
- **`billing.ts` stays pure.** No `Date.now()`, no `Intl`, no I/O. A table-driven
  calendar needs that property even more than Gregorian does.
- When adding a date field, decide A or B explicitly and record it here.

## Status

- **Decided:** storage stays Gregorian ISO regardless of any future calendar.
- **Decided:** the calendar setting, if added, is per-property.
- **Not built:** the `Calendar` seam. Tracked as task 006 — worth doing while
  `billing.ts` is young, since it is additive now and a rewrite once Phase 3's cron,
  Phase 4's reminders and Phase 6's reports all depend on its current shape.
- **Not built, and not currently planned:** Bikram Sambat itself.
