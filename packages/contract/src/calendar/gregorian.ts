import type { IsoDate } from '../common.js';
import { parseIsoDate, toIsoDate } from './civil-days.js';
import type { Calendar } from './index.js';

/**
 * The default calendar. Today's arithmetic, unchanged — moved here from `billing.ts`
 * behind the `Calendar` interface. `billing.ts` re-exports `isLeapYear`, `daysInMonth`,
 * `addMonths`, `addYears` and `clampDayToMonth` with identical signatures, delegating
 * to the functions below.
 */

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

/** Clamps `day` into the valid range for `year`/`month` — 31 in February becomes 28/29. */
export function clampDayToMonth(year: number, month: number, day: number): IsoDate {
  const dim = daysInMonth(year, month);
  return toIsoDate(year, month, Math.min(day, dim));
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Clamps the day to the target month's length — Jan 31 + 1 month = Feb 28/29. */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(d);
  const total = year * 12 + (month - 1) + n;
  const newYear = floorDiv(total, 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  return clampDayToMonth(newYear, newMonth, day);
}

/** Feb 29 -> Feb 28 when the target year is not a leap year. */
export function addYears(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(d);
  return clampDayToMonth(year + n, month, day);
}

function startOfMonth(d: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(d);
  return toIsoDate(year, month, 1);
}

function endOfMonth(d: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(d);
  return toIsoDate(year, month, daysInMonth(year, month));
}

function isValid(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

export const gregorian: Calendar = {
  id: 'gregorian',
  daysInMonth,
  monthsInYear: () => 12,
  maxDayOfMonth: () => 31,
  addMonths,
  addYears,
  clampDayToMonth,
  startOfMonth,
  endOfMonth,
  isValid,
};
