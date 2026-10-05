import { z } from 'zod';
import type { IsoDate } from '../common.js';
import { gregorian } from './gregorian.js';
import { bikramSambat } from './bikram-sambat.js';

export const calendarSystem = z.enum(['gregorian', 'bikram_sambat']);
export type CalendarSystem = z.infer<typeof calendarSystem>;

export const calendarSystemLabels: Record<CalendarSystem, string> = {
  gregorian: 'Gregorian',
  bikram_sambat: 'Bikram Sambat',
};

/**
 * A pluggable calendar for defining billing periods: what a "month" or a "year"
 * means for `periodsOverlapping`, `periodContaining`, `dueDateFor` and
 * `buildSchedule` in `billing.ts`.
 *
 * Deliberately does NOT include `addDays`, `compareIsoDate`, `daysBetweenInclusive`,
 * `minIsoDate`, `maxIsoDate` or `clampIsoDate`. Those live in `./civil-days.ts` and
 * operate on the proleptic day number — a day is a day regardless of which calendar
 * names its months, and `IsoDate` values are always Gregorian on the wire and in
 * storage (see `docs/DATES.md`). Putting day-level arithmetic on this interface would
 * invite a second, calendar-specific implementation of something that already has
 * exactly one correct answer. If you are tempted to add one of those six here: don't
 * — import them from `./civil-days.ts` (or `billing.ts`'s re-export) instead.
 */
export interface Calendar {
  readonly id: CalendarSystem;
  /** `month` is 1-based, in THIS calendar's own numbering. */
  daysInMonth(year: number, month: number): number;
  /** 12 for both calendars today; an interface, not a constant, for whatever comes next. */
  monthsInYear(year: number): number;
  /** The longest month this calendar ever has, in `year`. 31 Gregorian; 32 in Bikram Sambat. */
  maxDayOfMonth(year: number): number;
  /** Clamps the day to the target month's length, same contract as Gregorian's `addMonths`. */
  addMonths(d: IsoDate, n: number): IsoDate;
  /** Clamps the day to the target year's month length (leap-day style clamping). */
  addYears(d: IsoDate, n: number): IsoDate;
  /** `year`/`month` are in THIS calendar's own numbering; returns the Gregorian `IsoDate`. */
  clampDayToMonth(year: number, month: number, day: number): IsoDate;
  /** First day of the month containing `d`, in this calendar. */
  startOfMonth(d: IsoDate): IsoDate;
  /** Last day of the month containing `d`, in this calendar. */
  endOfMonth(d: IsoDate): IsoDate;
  /** `year`/`month`/`day` are in THIS calendar's own numbering. Never throws. */
  isValid(year: number, month: number, day: number): boolean;
}

export function calendarForSystem(system: CalendarSystem): Calendar {
  switch (system) {
    case 'gregorian':
      return gregorian;
    case 'bikram_sambat':
      return bikramSambat;
  }
}

/**
 * The calendar's structural ceiling for `billing_day` — a single fixed value per
 * calendar, independent of any specific year or month. 31 for Gregorian (no Gregorian
 * month ever has more). 32 for Bikram Sambat (reached in several years across
 * `bs-data.ts`).
 *
 * Deliberately NOT derived from `maxDayOfMonth(year)`: that method needs a year in
 * the CALENDAR's own numbering (a BS year, not a Gregorian one), and `billing.ts`
 * only ever has a lease's Gregorian `startDate` to hand, with no general way to
 * recover "which BS year is this" from the `Calendar` interface as specified. This
 * constant is a structural pre-check only — it does not claim billingDay is valid for
 * any particular month of any particular lease. `dueDateFor`'s clamping (via
 * `startOfMonth`/`endOfMonth`) is what gets the per-period answer right.
 */
export const MAX_BILLING_DAY: Record<CalendarSystem, number> = {
  gregorian: 31,
  bikram_sambat: 32,
};

/**
 * The widest billingDay any supported calendar allows.
 *
 * Request schemas accept up to this, because a schema cannot know which property —
 * and therefore which calendar — a lease belongs to. `validateBillingTerms` then
 * rejects a day that exceeds the lease's OWN calendar, so 32 is accepted on a Bikram
 * Sambat lease and refused on a Gregorian one.
 *
 * Derived, not written: adding a calendar with longer months widens this
 * automatically rather than leaving a stale literal behind.
 */
export const MAX_BILLING_DAY_ANY = Math.max(...Object.values(MAX_BILLING_DAY));

export { gregorian } from './gregorian.js';
export { bikramSambat, BsDateOutOfRangeError } from './bikram-sambat.js';
export {
  addDays,
  compareIsoDate,
  daysBetweenInclusive,
  minIsoDate,
  maxIsoDate,
  clampIsoDate,
  parseIsoDate,
  toIsoDate,
} from './civil-days.js';
