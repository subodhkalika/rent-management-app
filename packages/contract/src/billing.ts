import { z } from 'zod';
import { isoDate, money, type IsoDate } from './common.js';
import {
  calendarSystem,
  calendarForSystem,
  MAX_BILLING_DAY,
  type Calendar,
  type CalendarSystem,
} from './calendar/index.js';
import {
  parseIsoDate,
  toIsoDate,
  addDays,
  compareIsoDate,
  daysBetweenInclusive,
  minIsoDate,
  maxIsoDate,
  clampIsoDate,
  daysFromCivil,
} from './calendar/civil-days.js';
import { isLeapYear, daysInMonth, addMonths, addYears, clampDayToMonth } from './calendar/gregorian.js';

/**
 * PURITY IS THE POINT.
 *
 * Everything in this file is plain integer/string arithmetic on `IsoDate` strings
 * and numbers. No wall-clock read, no bare/zero-argument `Date` construction, no
 * `Intl`, no I/O. Same rule for `./calendar/*`: a table-driven calendar needs it even
 * more than Gregorian does.
 *
 * `IsoDate` strings are fixed-width `YYYY-MM-DD`, so lexicographic comparison is
 * chronological comparison — `compareIsoDate` (from `./calendar/civil-days.js`) never
 * touches a `Date` object. Day-count arithmetic (`addDays`, `daysBetweenInclusive`)
 * uses the Howard Hinnant `days_from_civil` / `civil_from_days` algorithm: pure
 * integer conversion between a proleptic-Gregorian (year, month, day) triple and a
 * day count relative to the 1970-01-01 epoch. No `Date` object is ever constructed.
 *
 * The same logic runs in the browser's live schedule preview and (in Phase 3) the
 * server's cron. If it ever touched the wall clock or the runtime's locale, the two
 * could disagree — which is the one bug this design exists to prevent.
 *
 * CALENDAR SEAM — `./calendar/index.ts` exports the `Calendar` interface and
 * `calendarForSystem`, a resolver from the `calendarSystem` enum ('gregorian' |
 * 'bikram_sambat') to an implementation. `periodsOverlapping`, `periodContaining`,
 * `isPeriodStart` and `dueDateFor` all take a `CalendarSystem` (defaulting to
 * 'gregorian' so existing call sites are unaffected) and resolve it once internally.
 * `addDays`, `compareIsoDate`, `daysBetweenInclusive`, `minIsoDate`, `maxIsoDate` and
 * `clampIsoDate` stay OUTSIDE that interface, imported from `./calendar/civil-days.js`
 * — they operate on the proleptic day number, which is the same regardless of which
 * calendar is choosing period boundaries. `isLeapYear`, `daysInMonth`, `addMonths`,
 * `addYears` and `clampDayToMonth` stay exported from here with identical signatures,
 * now delegating to `./calendar/gregorian.js`. `isLeapYear` has no analogue on
 * `Calendar` — it is Gregorian-specific and is NOT part of the interface.
 */

export { calendarSystem, type CalendarSystem };
export { isLeapYear, daysInMonth, addMonths, addYears, clampDayToMonth };
export { parseIsoDate, toIsoDate, addDays, compareIsoDate, daysBetweenInclusive, minIsoDate, maxIsoDate, clampIsoDate };

/* ======================================================================== */
/* frequency                                                                 */
/* ======================================================================== */

export const rentFrequency = z.enum(['monthly', 'yearly']);
export type RentFrequency = z.infer<typeof rentFrequency>;

export const rentFrequencyLabels: Record<RentFrequency, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/* ======================================================================== */
/* move-out billing policy — property-level, read live, applied inside      */
/* buildSchedule only (Amendment A)                                         */
/* ======================================================================== */

export const moveOutBillingPolicy = z.enum(['bill_full_term', 'stop_at_move_out']);
export type MoveOutBillingPolicy = z.infer<typeof moveOutBillingPolicy>;

export const moveOutBillingPolicyLabels: Record<MoveOutBillingPolicy, string> = {
  bill_full_term: 'Bill the full term',
  stop_at_move_out: 'Stop rent at move-out',
};

/* ======================================================================== */
/* periods                                                                   */
/* ======================================================================== */

export const billingPeriod = z.object({
  /** 0-based from the lease's FIRST natural period. Anchored, NOT the array index. */
  index: z.number().int(),
  /** Natural period start, inclusive. NOT clipped to the lease. */
  start: isoDate,
  /** Natural period end, inclusive. */
  end: isoDate,
});
export type BillingPeriod = z.infer<typeof billingPeriod>;

/**
 * Builds the period at a known index relative to `anchorDate`, for either cadence,
 * under `calendar`.
 *
 * Monthly: `calendar.startOfMonth`/`addMonths`/`endOfMonth` do the calendar-specific
 * work; `index` counts calendar months from the one containing `anchorDate`.
 *
 * Yearly: periods anchor on `anchorDate`'s own day, not the start of its month or
 * year — a lease starting mid-month renews on that same day each cycle. `addYears`
 * is the only calendar-specific step; the period boundary one day before the next
 * anniversary is day-number arithmetic (`addDays`), same as before.
 */
function periodAtIndex(f: RentFrequency, calendar: Calendar, anchorDate: IsoDate, index: number): BillingPeriod {
  if (f === 'monthly') {
    const anchorFirst = calendar.startOfMonth(anchorDate);
    const start = calendar.addMonths(anchorFirst, index);
    const end = calendar.endOfMonth(start);
    return { index, start, end };
  }
  const start = calendar.addYears(anchorDate, index);
  const end = addDays(calendar.addYears(anchorDate, index + 1), -1);
  return { index, start, end };
}

/**
 * Finds the period index containing `on`, for either cadence, by estimating from the
 * day-number distance to `anchorDate` and correcting to the exact boundary. Works for
 * ANY `Calendar` without needing to know the calendar's own year/month numbering for
 * an arbitrary `IsoDate` — `Calendar` does not expose that reverse mapping, only
 * `addMonths`/`addYears`/`startOfMonth`/`endOfMonth`, which this builds on via
 * `periodAtIndex`. The correction loop makes the result exact regardless of how
 * rough the initial guess is; for Gregorian, where the old code computed the index in
 * one step via year/month subtraction, this converges in zero or one iteration and
 * returns an identical index — it replaces a special case with a general one, not a
 * different answer.
 */
function periodIndexFor(f: RentFrequency, calendar: Calendar, anchorDate: IsoDate, on: IsoDate): number {
  const anchorBase = f === 'monthly' ? calendar.startOfMonth(anchorDate) : anchorDate;
  const averageDaysPerPeriod = f === 'monthly' ? 30 : 365;
  const signedDays =
    daysFromCivilOf(on) - daysFromCivilOf(anchorBase); // positive when `on` is after the anchor
  let k = Math.trunc(signedDays / averageDaysPerPeriod);
  let period = periodAtIndex(f, calendar, anchorDate, k);
  while (compareIsoDate(on, period.start) < 0) {
    k -= 1;
    period = periodAtIndex(f, calendar, anchorDate, k);
  }
  while (compareIsoDate(on, period.end) > 0) {
    k += 1;
    period = periodAtIndex(f, calendar, anchorDate, k);
  }
  return k;
}

/**
 * Signed day-number distance from the 1970-01-01 epoch, for the estimate in
 * `periodIndexFor`. Reuses the day-number layer rather than re-deriving it:
 * `IsoDate` is always Gregorian on the wire (see `docs/DATES.md`), so this is valid
 * regardless of which `Calendar` is in play — it is only ever used here as an
 * ESTIMATE, corrected to exactness by the while-loops above.
 */
function daysFromCivilOf(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return daysFromCivil(year, month, day);
}

export function periodContaining(
  f: RentFrequency,
  anchorDate: IsoDate,
  on: IsoDate,
  system: CalendarSystem = 'gregorian',
): BillingPeriod {
  const calendar = calendarForSystem(system);
  const index = periodIndexFor(f, calendar, anchorDate, on);
  return periodAtIndex(f, calendar, anchorDate, index);
}

/** A contiguous, gapless, non-overlapping cover of every period overlapping `[from, to]`. */
export function periodsOverlapping(
  f: RentFrequency,
  anchorDate: IsoDate,
  from: IsoDate,
  to: IsoDate,
  system: CalendarSystem = 'gregorian',
): BillingPeriod[] {
  if (compareIsoDate(from, to) > 0) return [];
  const calendar = calendarForSystem(system);
  const firstIndex = periodIndexFor(f, calendar, anchorDate, from);
  const lastIndex = periodIndexFor(f, calendar, anchorDate, to);
  const result: BillingPeriod[] = [];
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    result.push(periodAtIndex(f, calendar, anchorDate, i));
  }
  return result;
}

export function isPeriodStart(
  f: RentFrequency,
  anchorDate: IsoDate,
  d: IsoDate,
  system: CalendarSystem = 'gregorian',
): boolean {
  return compareIsoDate(periodContaining(f, anchorDate, d, system).start, d) === 0;
}

/* ======================================================================== */
/* due date — one formula, zero special cases                               */
/* ======================================================================== */

/** The billingDay-th day of the month containing `anyDateInMonth`, under `calendar`,
 *  clamped to that month's actual length. Built only from `startOfMonth`/`endOfMonth`
 *  (interface) plus `addDays`/`daysBetweenInclusive` (day-number layer) — no reverse
 *  year/month mapping needed, unlike the old Gregorian-only `clampDayToMonth` call
 *  this replaces here. */
function dayOfMonthClamped(calendar: Calendar, anyDateInMonth: IsoDate, day: number): IsoDate {
  const start = calendar.startOfMonth(anyDateInMonth);
  const end = calendar.endOfMonth(anyDateInMonth);
  const length = daysBetweenInclusive(start, end);
  const clamped = Math.min(Math.max(day, 1), length);
  return addDays(start, clamped - 1);
}

export function dueDateFor(input: {
  frequency: RentFrequency;
  period: BillingPeriod;
  occupiedStart: IsoDate;
  occupiedEnd: IsoDate;
  /** 1..32; ignored when `frequency === 'yearly'`. Bound by the calendar's own
   *  maximum — see `MAX_BILLING_DAY` / `Calendar.maxDayOfMonth`. */
  billingDay: number;
  /** Defaults to Gregorian so existing call sites are unaffected. */
  calendar?: CalendarSystem;
}): IsoDate {
  const { frequency, period, occupiedStart, occupiedEnd, billingDay, calendar: system = 'gregorian' } = input;
  const calendar = calendarForSystem(system);
  const raw = frequency === 'monthly' ? dayOfMonthClamped(calendar, period.start, billingDay) : period.start;
  return clampIsoDate(raw, occupiedStart, occupiedEnd);
}

/* ======================================================================== */
/* proration                                                                 */
/* ======================================================================== */

export function prorate(rentCents: number, daysOccupied: number, daysInPeriod: number): number {
  return Math.round((rentCents * daysOccupied) / daysInPeriod);
}

/* ======================================================================== */
/* terms + schedule                                                          */
/* ======================================================================== */

export const leaseBillingTerms = z.object({
  frequency: rentFrequency,
  rentCents: money,
  /** 1..32 — 32 because Bikram Sambat months reach 32 days (see
   *  `./calendar/bs-data.ts`). The true per-calendar ceiling is narrower
   *  (`Calendar.maxDayOfMonth` / `MAX_BILLING_DAY`); `validateBillingTerms` enforces
   *  it. This bound is only the outer structural limit shared by every calendar. */
  billingDay: z.number().int().min(1).max(32),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  ledgerStartDate: isoDate,
  /** Raw move-out date. Never pre-applied — `effectiveBillingEnd` is the only interpreter. */
  moveOutDate: isoDate.nullable(),
  /** Resolved live from the property. */
  moveOutBillingPolicy,
  /** Which calendar defines this lease's periods. Storage and every `IsoDate` value
   *  here stay Gregorian regardless — see `docs/DATES.md`. */
  calendar: calendarSystem,
});
export type LeaseBillingTerms = z.infer<typeof leaseBillingTerms>;

export const plannedCharge = z.object({
  generationKey: isoDate,
  periodIndex: z.number().int(),
  periodStart: isoDate,
  periodEnd: isoDate,
  occupiedStart: isoDate,
  occupiedEnd: isoDate,
  daysOccupied: z.number().int().nonnegative(),
  daysInPeriod: z.number().int().positive(),
  dueDate: isoDate,
  amountCents: z.number().int().nonnegative(),
  isProrated: z.boolean(),
});
export type PlannedCharge = z.infer<typeof plannedCharge>;

/**
 * The last day this lease bills for. The ONLY place the move-out policy is
 * interpreted. Exported so it is independently testable and nameable — NOT so
 * callers can call it before `buildSchedule`. `buildSchedule` calls it internally;
 * callers pass raw terms via `billingTermsFor` (in `lease.ts`).
 *
 * Can only ever SHORTEN `endDate`, never extend it (I13).
 */
export function effectiveBillingEnd(terms: LeaseBillingTerms): IsoDate | null {
  if (terms.moveOutBillingPolicy === 'bill_full_term') return terms.endDate;
  if (terms.moveOutDate === null) return terms.endDate;
  if (terms.endDate === null) return terms.moveOutDate;
  return minIsoDate(terms.moveOutDate, terms.endDate);
}

export const MAX_SCHEDULE_PERIODS = 600;
export const GENERATION_LOOKAHEAD_DAYS = 31;
export const DEPOSIT_GENERATION_KEY = 'deposit';
export const OPENING_BALANCE_GENERATION_KEY = 'opening';

/**
 * Rent charges only. The deposit and the opening balance are single non-periodic
 * charges Phase 3 writes once, keyed `DEPOSIT_GENERATION_KEY` (due `startDate`) and
 * `OPENING_BALANCE_GENERATION_KEY` (due `ledgerStartDate`). A period key is always
 * `YYYY-MM-DD`, so no collision is possible.
 *
 * `through` filters on `periodStart <= through` — the only coherent reading for a
 * cron. Throws `RangeError` past `MAX_SCHEDULE_PERIODS`.
 */
export function buildSchedule(terms: LeaseBillingTerms, through: IsoDate): PlannedCharge[] {
  const windowStart = maxIsoDate(terms.startDate, terms.ledgerStartDate);
  const billingEnd = effectiveBillingEnd(terms);
  const to = billingEnd === null ? through : minIsoDate(billingEnd, through);

  if (compareIsoDate(windowStart, to) > 0) return [];

  const periods = periodsOverlapping(terms.frequency, terms.startDate, windowStart, to, terms.calendar);
  if (periods.length > MAX_SCHEDULE_PERIODS) {
    throw new RangeError(
      `Schedule would produce ${periods.length} periods, exceeding MAX_SCHEDULE_PERIODS (${MAX_SCHEDULE_PERIODS})`,
    );
  }

  const result: PlannedCharge[] = [];
  for (const p of periods) {
    if (compareIsoDate(p.start, through) > 0) break;

    const occupiedStart = maxIsoDate(p.start, windowStart);
    const occupiedEnd = billingEnd === null ? p.end : minIsoDate(p.end, billingEnd);
    if (compareIsoDate(occupiedEnd, occupiedStart) < 0) continue;

    const daysInPeriod = daysBetweenInclusive(p.start, p.end);
    const daysOccupied = daysBetweenInclusive(occupiedStart, occupiedEnd);
    const amountCents =
      daysOccupied === daysInPeriod ? terms.rentCents : prorate(terms.rentCents, daysOccupied, daysInPeriod);

    result.push({
      generationKey: p.start,
      periodIndex: p.index,
      periodStart: p.start,
      periodEnd: p.end,
      occupiedStart,
      occupiedEnd,
      daysOccupied,
      daysInPeriod,
      dueDate: dueDateFor({
        frequency: terms.frequency,
        period: p,
        occupiedStart,
        occupiedEnd,
        billingDay: terms.billingDay,
        calendar: terms.calendar,
      }),
      amountCents,
      isProrated: daysOccupied < daysInPeriod,
    });
  }
  return result;
}

/* ======================================================================== */
/* generation                                                                */
/* ======================================================================== */

export function generationHorizon(today: IsoDate): IsoDate {
  return addDays(today, GENERATION_LOOKAHEAD_DAYS);
}

/** The cron calls THIS. `=== buildSchedule(terms, generationHorizon(today))`. */
export function chargesDueForGeneration(terms: LeaseBillingTerms, today: IsoDate): PlannedCharge[] {
  return buildSchedule(terms, generationHorizon(today));
}

/* ======================================================================== */
/* validation, shared with the contract's superRefine                       */
/* ======================================================================== */

export function validateBillingTerms(terms: LeaseBillingTerms): string | null {
  if (terms.billingDay > MAX_BILLING_DAY[terms.calendar]) {
    return `billingDay must not exceed ${MAX_BILLING_DAY[terms.calendar]} for this calendar`;
  }
  if (terms.endDate !== null && compareIsoDate(terms.endDate, terms.startDate) < 0) {
    return 'endDate must not be before startDate';
  }
  if (compareIsoDate(terms.ledgerStartDate, terms.startDate) < 0) {
    return 'ledgerStartDate must not be before startDate';
  }
  if (terms.endDate !== null && compareIsoDate(terms.ledgerStartDate, terms.endDate) > 0) {
    return 'ledgerStartDate must not be after endDate';
  }
  const isAtStart = compareIsoDate(terms.ledgerStartDate, terms.startDate) === 0;
  if (!isAtStart && !isPeriodStart(terms.frequency, terms.startDate, terms.ledgerStartDate, terms.calendar)) {
    return 'ledgerStartDate must equal startDate or be the first day of a billing period';
  }
  if (terms.moveOutDate !== null && compareIsoDate(terms.moveOutDate, terms.startDate) < 0) {
    return 'moveOutDate must not be before startDate';
  }
  return null;
}
