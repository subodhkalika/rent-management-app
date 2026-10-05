# Task 006 — A calendar seam in billing.ts

**Status:** queued. Do after Phase 2 lands and is reviewed, before Phase 3.

Read `docs/DATES.md` first. This builds the seam that document describes. It does
**not** implement Bikram Sambat or any other calendar.

## Why now rather than later

`billing.ts` is young. Today its date arithmetic has exactly two consumers: the lease
form preview and `GET /leases/:id/schedule`.

After Phase 3 it also backs the charge-generation cron; after Phase 4, reminder
scheduling; after Phase 6, every report and export. The seam is additive today and a
rewrite through four features later.

This is insurance, not a feature. It should change no behaviour and no fixture value.

## What to build

Group the Gregorian arithmetic behind an interface, with Gregorian as the default
implementation:

```ts
export interface Calendar {
  readonly id: 'gregorian';            // widen when a second one exists
  daysInMonth(year: number, month: number): number;
  monthsInYear(year: number): number;  // 12 for Gregorian; an interface, not a constant
  maxDayOfMonth(year: number): number; // 31 Gregorian; 32 in Bikram Sambat
  addMonths(d: IsoDate, n: number): IsoDate;
  addYears(d: IsoDate, n: number): IsoDate;
  clampDayToMonth(year: number, month: number, day: number): IsoDate;
  startOfMonth(d: IsoDate): IsoDate;
  endOfMonth(d: IsoDate): IsoDate;
  isValid(year: number, month: number, day: number): boolean;
}

export const gregorian: Calendar;
```

`addDays`, `compareIsoDate`, `daysBetweenInclusive`, `minIsoDate`, `maxIsoDate` and
`clampIsoDate` stay calendar-independent — a day is a day, and these operate on the
proleptic day number. Keep them outside the interface and say so in a comment, or
someone will dutifully add them to it.

## Constraints

- **No behaviour change.** Every existing fixture must pass unmodified. If any
  expected value moves, the refactor is wrong — stop and report.
- **Keep the existing exported functions.** `daysInMonth`, `isLeapYear` and the rest
  stay exported with their current signatures, delegating to `gregorian`. Dev agents
  and tests already import them; breaking those is churn for no gain.
- `periodsOverlapping`, `periodContaining` and `dueDateFor` route their month
  arithmetic through the calendar rather than calling the module functions directly.
  That is the actual seam — the rest is naming.
- **Purity still holds.** I1 must keep passing. A table-driven calendar needs it more
  than Gregorian does.
- `isLeapYear` is Gregorian-specific and has no general analogue. Leave it exported
  as a Gregorian helper; do **not** put it on the interface.

## Also

- `billing_day`'s `1..31` bound is Gregorian. Leave the value, add a comment pointing
  at `maxDayOfMonth` so the next person sees the dependency.
- `isoDate` in `common.ts` validates by round-tripping through `Date.UTC`, which is a
  Gregorian validity check. Note it in a comment; do not change it.
- Update `docs/DATES.md`: move the seam from "not built" to built, and record what a
  second calendar would still require.

## Done when

`pnpm check` passes with **no fixture value altered**, and adding a second `Calendar`
implementation would touch no file outside `billing.ts` and a new calendar module.
