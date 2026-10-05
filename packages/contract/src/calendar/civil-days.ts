import type { IsoDate } from '../common.js';

/**
 * The day-number layer: pure integer conversion between a proleptic-Gregorian
 * (year, month, day) triple and a day count relative to the 1970-01-01 epoch
 * (Howard Hinnant's `days_from_civil` / `civil_from_days`), plus the handful of
 * operations — `addDays`, `compareIsoDate`, `daysBetweenInclusive`, `minIsoDate`,
 * `maxIsoDate`, `clampIsoDate` — that only ever need a day COUNT, never a calendar's
 * notion of a month or a year.
 *
 * This is deliberately calendar-independent. `IsoDate` strings are always Gregorian
 * on the wire and in storage (see `docs/DATES.md`), regardless of which `Calendar`
 * a lease uses to define its billing periods — so "how many days apart are these two
 * dates" and "what date is N days from this one" have exactly one correct answer,
 * shared by every `Calendar` implementation. `gregorian.ts` and `bikram-sambat.ts`
 * both import from here; neither re-implements it.
 *
 * No `Date`, no `Intl`, no I/O — same purity rule as `billing.ts`.
 */

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
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

/**
 * Gregorian month length, used only to validate `toIsoDate`'s round trip. Deliberately
 * NOT exported — `calendar/gregorian.ts` exports the canonical `daysInMonth` /
 * `isLeapYear` pair that `billing.ts` re-exports. Duplicating a 12-entry table here
 * avoids a cycle (`gregorian.ts` already imports this module for the day-number
 * primitives); the two are identical by construction and both covered by
 * `billing.test.ts`.
 */
function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const GREGORIAN_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function gregorianDaysInMonth(year: number, month: number): number {
  if (month === 2 && isGregorianLeapYear(year)) return 29;
  const d = GREGORIAN_MONTH_DAYS[month - 1];
  if (d === undefined) throw new RangeError(`Invalid month: ${month}`);
  return d;
}

/** Throws `RangeError` on an impossible calendar date (e.g. 2026-02-30). */
export function toIsoDate(year: number, month: number, day: number): IsoDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError(`Non-integer date component: ${year}-${month}-${day}`);
  }
  if (month < 1 || month > 12) {
    throw new RangeError(`Invalid month: ${month}`);
  }
  const dim = gregorianDaysInMonth(year, month);
  if (day < 1 || day > dim) {
    throw new RangeError(`Invalid day ${day} for ${year}-${pad(month, 2)}`);
  }
  return `${pad(Math.abs(year), 4)}-${pad(month, 2)}-${pad(day, 2)}` as IsoDate;
}

/**
 * Days since the 1970-01-01 epoch, for a proleptic-Gregorian (year, month, day).
 * Howard Hinnant's `days_from_civil`. Pure integer arithmetic, no `Date`.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // [0, 11]
  const doy = floorDiv(153 * mp + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of `daysFromCivil`. Howard Hinnant's `civil_from_days`. */
export function civilFromDays(z: number): { year: number; month: number; day: number } {
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
