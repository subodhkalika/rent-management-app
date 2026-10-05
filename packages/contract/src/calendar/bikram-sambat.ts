import type { IsoDate } from '../common.js';
import { parseIsoDate, toIsoDate, daysFromCivil, civilFromDays } from './civil-days.js';
import type { Calendar } from './index.js';
import { BS_MIN_YEAR, BS_MAX_YEAR, BS_EPOCH_AD, BS_MONTH_LENGTHS } from './bs-data.js';

/**
 * Bikram Sambat, table-driven from `bs-data.ts`.
 *
 * `IsoDate` values are ALWAYS Gregorian on the wire and in storage (see
 * `docs/DATES.md`) — BS is a lens over the same day numbers the Gregorian calendar
 * uses, never the storage format. Every method here converts its `IsoDate` argument
 * to a day number (via `civil-days.ts`'s Hinnant layer, which is pure Gregorian
 * proleptic-calendar arithmetic and therefore calendar-independent — it only cares
 * that `IsoDate` strings ARE Gregorian, not which calendar is choosing periods), maps
 * that day number to a BS (year, month, day) using the cumulative offsets built from
 * `BS_MONTH_LENGTHS` below, does whatever BS-native arithmetic was asked for, and
 * converts back. No BS date is ever written to storage or returned on the wire.
 */

export class BsDateOutOfRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'BsDateOutOfRangeError';
  }
}

const EPOCH_DAY_NUMBER = (() => {
  const { year, month, day } = parseIsoDate(BS_EPOCH_AD);
  return daysFromCivil(year, month, day);
})();

/**
 * Day number (relative to the Gregorian 1970-01-01 epoch) of BS `{year}-01-01`, for
 * every year the table covers, precomputed once. `YEAR_START_DAY_NUMBER[i]` is the
 * day number of BS `(BS_MIN_YEAR + i)-01-01`. The final entry — one past the last
 * table row — is the day number of the day AFTER the last date this module supports,
 * i.e. an exclusive upper bound; there is no BS `(BS_MAX_YEAR + 1)` row to anchor it
 * to otherwise.
 */
const YEAR_START_DAY_NUMBER: readonly number[] = (() => {
  const starts: number[] = [EPOCH_DAY_NUMBER];
  for (const row of BS_MONTH_LENGTHS) {
    const yearTotal = row.reduce((a, b) => a + b, 0);
    const previous = starts[starts.length - 1];
    if (previous === undefined) throw new RangeError('unreachable: starts is never empty');
    starts.push(previous + yearTotal);
  }
  return starts;
})();

function requireYearIndex(year: number): number {
  if (!Number.isInteger(year) || year < BS_MIN_YEAR || year > BS_MAX_YEAR) {
    throw new BsDateOutOfRangeError(
      `Bikram Sambat year ${year} is outside the supported range [${BS_MIN_YEAR}, ${BS_MAX_YEAR}]`,
    );
  }
  return year - BS_MIN_YEAR;
}

function monthRow(year: number): readonly number[] {
  const idx = requireYearIndex(year);
  const row = BS_MONTH_LENGTHS[idx];
  if (row === undefined) throw new BsDateOutOfRangeError(`No Bikram Sambat data for year ${year}`);
  return row;
}

function bsDaysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid Bikram Sambat month: ${month}`);
  }
  const row = monthRow(year);
  const d = row[month - 1];
  if (d === undefined) throw new RangeError(`Invalid Bikram Sambat month: ${month}`);
  return d;
}

/** Day-number of BS (year, month, day). Throws `BsDateOutOfRangeError` if `year` is
 *  outside the table, `RangeError` if `month`/`day` is structurally invalid. */
function dayNumberFromBs(year: number, month: number, day: number): number {
  const idx = requireYearIndex(year);
  const row = monthRow(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid Bikram Sambat month: ${month}`);
  }
  const dim = row[month - 1];
  if (dim === undefined || !Number.isInteger(day) || day < 1 || day > dim) {
    throw new RangeError(`Invalid day ${day} for Bikram Sambat ${year}-${month}`);
  }
  let offset = 0;
  for (let m = 0; m < month - 1; m += 1) {
    offset += row[m] ?? 0;
  }
  const yearStart = YEAR_START_DAY_NUMBER[idx];
  if (yearStart === undefined) throw new RangeError('unreachable: year start missing');
  return yearStart + offset + (day - 1);
}

/** Inverse of `dayNumberFromBs`. Throws `BsDateOutOfRangeError` outside the table. */
function bsFromDayNumber(z: number): { year: number; month: number; day: number } {
  const first = YEAR_START_DAY_NUMBER[0];
  const last = YEAR_START_DAY_NUMBER[YEAR_START_DAY_NUMBER.length - 1]; // exclusive
  if (first === undefined || last === undefined || z < first || z >= last) {
    throw new BsDateOutOfRangeError(
      `Day number ${z} is outside the Bikram Sambat table's range ` +
        `(BS ${BS_MIN_YEAR}-01-01 through the last day of BS ${BS_MAX_YEAR})`,
    );
  }
  // Binary search for the containing year: the largest index whose year-start <= z.
  let lo = 0;
  let hi = BS_MONTH_LENGTHS.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const start = YEAR_START_DAY_NUMBER[mid];
    if (start !== undefined && start <= z) lo = mid;
    else hi = mid - 1;
  }
  const year = BS_MIN_YEAR + lo;
  const row = BS_MONTH_LENGTHS[lo];
  const yearStart = YEAR_START_DAY_NUMBER[lo];
  if (row === undefined || yearStart === undefined) {
    throw new RangeError('unreachable: resolved year has no data');
  }
  let remaining = z - yearStart; // [0, yearTotal)
  let month = 1;
  for (const len of row) {
    if (remaining < len) break;
    remaining -= len;
    month += 1;
  }
  return { year, month, day: remaining + 1 };
}

function dayNumberFromIso(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return daysFromCivil(year, month, day);
}

function isoFromDayNumber(z: number): IsoDate {
  const { year, month, day } = civilFromDays(z);
  return toIsoDate(year, month, day);
}

/** Converts a Gregorian `IsoDate` to its Bikram Sambat civil date. */
export function bsFromIso(d: IsoDate): { year: number; month: number; day: number } {
  return bsFromDayNumber(dayNumberFromIso(d));
}

/** Converts a Bikram Sambat civil date to the Gregorian `IsoDate` it falls on. */
export function isoFromBs(year: number, month: number, day: number): IsoDate {
  return isoFromDayNumber(dayNumberFromBs(year, month, day));
}

function monthsInYear(year: number): number {
  requireYearIndex(year);
  return 12;
}

function maxDayOfMonth(year: number): number {
  const row = monthRow(year);
  return Math.max(...row);
}

function clampDayToMonth(year: number, month: number, day: number): IsoDate {
  const dim = bsDaysInMonth(year, month);
  return isoFromBs(year, month, Math.min(Math.max(day, 1), dim));
}

function addMonths(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = bsFromIso(d);
  const total = year * 12 + (month - 1) + n;
  const newYear = Math.floor(total / 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  return clampDayToMonth(newYear, newMonth, day);
}

function addYears(d: IsoDate, n: number): IsoDate {
  const { year, month, day } = bsFromIso(d);
  return clampDayToMonth(year + n, month, day);
}

function startOfMonth(d: IsoDate): IsoDate {
  const { year, month } = bsFromIso(d);
  return isoFromBs(year, month, 1);
}

function endOfMonth(d: IsoDate): IsoDate {
  const { year, month } = bsFromIso(d);
  return isoFromBs(year, month, bsDaysInMonth(year, month));
}

function isValid(year: number, month: number, day: number): boolean {
  try {
    if (!Number.isInteger(year) || year < BS_MIN_YEAR || year > BS_MAX_YEAR) return false;
    if (!Number.isInteger(month) || month < 1 || month > 12) return false;
    const dim = bsDaysInMonth(year, month);
    return Number.isInteger(day) && day >= 1 && day <= dim;
  } catch {
    return false;
  }
}

export const bikramSambat: Calendar = {
  id: 'bikram_sambat',
  daysInMonth: bsDaysInMonth,
  monthsInYear,
  maxDayOfMonth,
  addMonths,
  addYears,
  clampDayToMonth,
  startOfMonth,
  endOfMonth,
  isValid,
};
