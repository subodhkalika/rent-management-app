import { z } from 'zod';
import { isoDate, money, type IsoDate } from './common.js';

/**
 * PURITY IS THE POINT.
 *
 * Everything in this file is plain integer/string arithmetic on `IsoDate` strings
 * and numbers. No wall-clock read, no bare/zero-argument `Date` construction, no
 * `Intl`, no I/O.
 *
 * `IsoDate` strings are fixed-width `YYYY-MM-DD`, so lexicographic comparison is
 * chronological comparison — `compareIsoDate` below never touches a `Date` object.
 * Day-count arithmetic (`addDays`, `daysBetweenInclusive`) uses the Howard Hinnant
 * `days_from_civil` / `civil_from_days` algorithm: pure integer conversion between a
 * proleptic-Gregorian (year, month, day) triple and a day count relative to the
 * 1970-01-01 epoch. No `Date` object is ever constructed.
 *
 * The same logic runs in the browser's live schedule preview and (in Phase 3) the
 * server's cron. If it ever touched the wall clock or the runtime's locale, the two
 * could disagree — which is the one bug this design exists to prevent.
 */

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
/* plain calendar arithmetic — no instants, no timezone                     */
/* ======================================================================== */

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `month` is 1..12. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  const d = MONTH_DAYS[month - 1];
  if (d === undefined) throw new RangeError(`Invalid month: ${month}`);
  return d;
}

export function parseIsoDate(d: IsoDate): { year: number; month: number; day: number } {
  const parts = d.split('-');
  const yearStr = parts[0];
  const monthStr = parts[1];
  const dayStr = parts[2];
  if (yearStr === undefined || monthStr === undefined || dayStr === undefined) {
    throw new RangeError(`Invalid IsoDate: ${d}`);
  }
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Throws `RangeError` on an impossible calendar date (e.g. 2026-02-30). */
export function toIsoDate(year: number, month: number, day: number): IsoDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError(`Non-integer date component: ${year}-${month}-${day}`);
  }
  if (month < 1 || month > 12) {
    throw new RangeError(`Invalid month: ${month}`);
  }
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    throw new RangeError(`Invalid day ${day} for ${year}-${pad(month, 2)}`);
  }
  return `${pad(Math.abs(year), 4)}-${pad(month, 2)}-${pad(day, 2)}` as IsoDate;
}

/** Clamps `day` into the valid range for `year`/`month` — 31 in February becomes 28/29. */
export function clampDayToMonth(year: number, month: number, day: number): IsoDate {
  const dim = daysInMonth(year, month);
  return toIsoDate(year, month, Math.min(day, dim));
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * Days since the 1970-01-01 epoch, for a proleptic-Gregorian (year, month, day).
 * Howard Hinnant's `days_from_civil`. Pure integer arithmetic, no `Date`.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // [0, 11]
  const doy = floorDiv(153 * mp + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. Howard Hinnant's `civil_from_days`. */
function civilFromDays(z: number): { year: number; month: number; day: number } {
  const zz = z + 719468;
  const era = floorDiv(zz >= 0 ? zz : zz - 146096, 146097);
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = floorDiv(
    doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096),
    365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100)); // [0, 365]
  const mp = floorDiv(5 * doy + 2, 153); // [0, 11]
  const day = doy - floorDiv(153 * mp + 2, 5) + 1; // [1, 31]
  const month = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  const year = month <= 2 ? y + 1 : y;
  return { year, month, day };
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(d);
  const z = daysFromCivil(year, month, day) + n;
  const result = civilFromDays(z);
  return toIsoDate(result.year, result.month, result.day);
}

/** Clamps the day to the target month's length — Jan 31 + 1 month = Feb 28/29. */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(d);
  const total = (year * 12 + (month - 1)) + n;
  const newYear = floorDiv(total, 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  return clampDayToMonth(newYear, newMonth, day);
}

/** Feb 29 -> Feb 28 when the target year is not a leap year. */
export function addYears(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(d);
  return clampDayToMonth(year + n, month, day);
}

/** Lexicographic comparison — correct because `IsoDate` is fixed-width `YYYY-MM-DD`. */
export function compareIsoDate(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Inclusive day count from `from` to `to`. `0` when `to < from`. */
export function daysBetweenInclusive(from: IsoDate, to: IsoDate): number {
  if (compareIsoDate(to, from) < 0) return 0;
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  return daysFromCivil(t.year, t.month, t.day) - daysFromCivil(f.year, f.month, f.day) + 1;
}

export function minIsoDate(...d: IsoDate[]): IsoDate {
  const first = d[0];
  if (first === undefined) throw new RangeError('minIsoDate requires at least one date');
  let result = first;
  for (const x of d.slice(1)) {
    if (compareIsoDate(x, result) < 0) result = x;
  }
  return result;
}

export function maxIsoDate(...d: IsoDate[]): IsoDate {
  const first = d[0];
  if (first === undefined) throw new RangeError('maxIsoDate requires at least one date');
  let result = first;
  for (const x of d.slice(1)) {
    if (compareIsoDate(x, result) > 0) result = x;
  }
  return result;
}

/** Clamps `d` into `[lo, hi]`. Assumes `lo <= hi`. */
export function clampIsoDate(d: IsoDate, lo: IsoDate, hi: IsoDate): IsoDate {
  return maxIsoDate(lo, minIsoDate(d, hi));
}

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

/** Builds the period at a known index relative to `anchorDate`, for either cadence. */
function periodAtIndex(f: RentFrequency, anchorDate: IsoDate, index: number): BillingPeriod {
  if (f === 'monthly') {
    const anchor = parseIsoDate(anchorDate);
    const anchorFirst = toIsoDate(anchor.year, anchor.month, 1);
    const start = addMonths(anchorFirst, index);
    const end = addDays(addMonths(anchorFirst, index + 1), -1);
    return { index, start, end };
  }
  const start = addYears(anchorDate, index);
  const end = addDays(addYears(anchorDate, index + 1), -1);
  return { index, start, end };
}

function yearlyIndexFor(anchorDate: IsoDate, on: IsoDate): number {
  const anchor = parseIsoDate(anchorDate);
  const onParsed = parseIsoDate(on);
  let k = onParsed.year - anchor.year;
  let period = periodAtIndex('yearly', anchorDate, k);
  while (compareIsoDate(on, period.start) < 0) {
    k -= 1;
    period = periodAtIndex('yearly', anchorDate, k);
  }
  while (compareIsoDate(on, period.end) > 0) {
    k += 1;
    period = periodAtIndex('yearly', anchorDate, k);
  }
  return k;
}

export function periodContaining(f: RentFrequency, anchorDate: IsoDate, on: IsoDate): BillingPeriod {
  if (f === 'monthly') {
    const anchor = parseIsoDate(anchorDate);
    const onParsed = parseIsoDate(on);
    const index = (onParsed.year - anchor.year) * 12 + (onParsed.month - anchor.month);
    return periodAtIndex(f, anchorDate, index);
  }
  const index = yearlyIndexFor(anchorDate, on);
  return periodAtIndex(f, anchorDate, index);
}

/** A contiguous, gapless, non-overlapping cover of every period overlapping `[from, to]`. */
export function periodsOverlapping(
  f: RentFrequency,
  anchorDate: IsoDate,
  from: IsoDate,
  to: IsoDate,
): BillingPeriod[] {
  if (compareIsoDate(from, to) > 0) return [];
  const firstIndex = periodContaining(f, anchorDate, from).index;
  const lastIndex = periodContaining(f, anchorDate, to).index;
  const result: BillingPeriod[] = [];
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    result.push(periodAtIndex(f, anchorDate, i));
  }
  return result;
}

export function isPeriodStart(f: RentFrequency, anchorDate: IsoDate, d: IsoDate): boolean {
  return compareIsoDate(periodContaining(f, anchorDate, d).start, d) === 0;
}

/* ======================================================================== */
/* due date — one formula, zero special cases                               */
/* ======================================================================== */

export function dueDateFor(input: {
  frequency: RentFrequency;
  period: BillingPeriod;
  occupiedStart: IsoDate;
  occupiedEnd: IsoDate;
  /** 1..31; ignored when `frequency === 'yearly'`. */
  billingDay: number;
}): IsoDate {
  const { frequency, period, occupiedStart, occupiedEnd, billingDay } = input;
  const raw =
    frequency === 'monthly'
      ? clampDayToMonth(parseIsoDate(period.start).year, parseIsoDate(period.start).month, billingDay)
      : period.start;
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
  billingDay: z.number().int().min(1).max(31),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  ledgerStartDate: isoDate,
  /** Raw move-out date. Never pre-applied — `effectiveBillingEnd` is the only interpreter. */
  moveOutDate: isoDate.nullable(),
  /** Resolved live from the property. */
  moveOutBillingPolicy,
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

  const periods = periodsOverlapping(terms.frequency, terms.startDate, windowStart, to);
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
  if (!isAtStart && !isPeriodStart(terms.frequency, terms.startDate, terms.ledgerStartDate)) {
    return 'ledgerStartDate must equal startDate or be the first day of a billing period';
  }
  if (terms.moveOutDate !== null && compareIsoDate(terms.moveOutDate, terms.startDate) < 0) {
    return 'moveOutDate must not be before startDate';
  }
  return null;
}
