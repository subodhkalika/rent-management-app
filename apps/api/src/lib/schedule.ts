import {
  addDays,
  compareIsoDate,
  buildSchedule,
  calendarForSystem,
  isoFromBs,
  BS_MAX_YEAR,
  BsDateOutOfRangeError,
  type LeaseBillingTerms,
  type PlannedCharge,
  type IsoDate,
  type CalendarSystem,
} from '@rms/contract';
import { validationFailed } from './errors.js';

/**
 * Shared by both schedule routes (`routes/leases.ts`, `routes/portal-leases.ts`)
 * and by the lease repo's write paths — the one place that knows how to keep a
 * Bikram Sambat property's bounded date table from ever reaching a client as a
 * raw 500. See the functions below for the two distinct bugs this fixes.
 */

/**
 * Ten years, as a FIXED DAY COUNT — never a calendar computation. The contract's
 * "through must be within 10 years of startDate" rule is an INPUT SANITY bound
 * (it exists purely to keep `MAX_SCHEDULE_PERIODS` unreachable in practice), not a
 * billing calculation, so it must never depend on which calendar the property uses
 * and must never be able to throw.
 *
 * An earlier version computed it via `calendarForSystem(row.calendar)
 * .addYears(startDate, 10)` — correct for Gregorian, but for a Bikram Sambat
 * property starting after roughly AD 2023, `startYear + 10` lands past the data
 * table's ceiling (`BS_MAX_YEAR` = 2090), throwing `BsDateOutOfRangeError` before
 * scheduling ever ran — turning every such lease's schedule request into a 500.
 * `addDays` is pure day-number arithmetic (civil-days.ts's Hinnant layer) and
 * cannot throw for any input in this application's lifetime, and "ten years" means
 * the same span of days regardless of which calendar is choosing periods.
 *
 * 3653 ≈ 10 Gregorian years (365.2425 average, including leap days). Precision
 * doesn't matter here — this is a sanity ceiling, not a billing figure — but it
 * must stay close enough that "within 10 years" reads as ten years to a landlord.
 */
const TEN_YEARS_IN_DAYS = 3653;

export function scheduleSanityMaxThrough(startDate: IsoDate): IsoDate {
  return addDays(startDate, TEN_YEARS_IN_DAYS);
}

/**
 * The furthest Gregorian date `bs-data.ts`'s table can represent: the last day of
 * the last month of `BS_MAX_YEAR`. Computed from the contract's own exports
 * (`calendarForSystem`, `isoFromBs`) rather than hand-copied from a comment
 * (`bs-data.ts` currently documents this boundary as AD 2034-04-13), so this
 * self-corrects if the table is ever extended — the contract answers it, not a
 * literal date typed into `apps/api`. Memoized: the table is static for the life
 * of the process.
 */
let cachedFurthestBsDate: IsoDate | undefined;
export function furthestBsScheduleDate(): IsoDate {
  if (cachedFurthestBsDate !== undefined) return cachedFurthestBsDate;
  const bs = calendarForSystem('bikram_sambat');
  const lastMonth = bs.monthsInYear(BS_MAX_YEAR);
  const lastDay = bs.daysInMonth(BS_MAX_YEAR, lastMonth);
  cachedFurthestBsDate = isoFromBs(BS_MAX_YEAR, lastMonth, lastDay);
  return cachedFurthestBsDate;
}

/**
 * `buildSchedule`, with `BsDateOutOfRangeError` turned into a `422` naming the
 * real limit — never a `500`. This condition is reachable and legitimate: a
 * Bikram Sambat lease genuinely running past roughly AD 2034 cannot have a
 * schedule computed for it, so the caller is told plainly, not handed "Something
 * went wrong on our end".
 *
 * `BsDateOutOfRangeError extends RangeError`, so it is checked FIRST — the
 * generic `RangeError` branch below (`buildSchedule`'s own
 * `MAX_SCHEDULE_PERIODS` guard) would otherwise catch it under the wrong message.
 *
 * Deliberately does NOT catch the error by truncating the schedule at the range
 * edge — `buildSchedule` itself never does this, and nothing here second-guesses
 * it: a short schedule that LOOKS complete would under-bill with nobody noticing,
 * which is worse than an explicit error.
 */
export function buildScheduleOrThrow(terms: LeaseBillingTerms, through: IsoDate): PlannedCharge[] {
  try {
    return buildSchedule(terms, through);
  } catch (err) {
    if (err instanceof BsDateOutOfRangeError) {
      throw validationFailed({
        through: [
          `This lease's calendar (Bikram Sambat) only has data through ${furthestBsScheduleDate()}. ` +
            'A schedule cannot be computed past that date.',
        ],
      });
    }
    if (err instanceof RangeError) {
      throw validationFailed({ through: ['This date range produces too many billing periods'] });
    }
    throw err;
  }
}

/**
 * Refuses an `endDate` the lease's calendar cannot represent a schedule for, UP
 * FRONT — at create/update/end/renew time, never only discovered later when
 * someone asks for the schedule. Failing at the point the landlord enters the
 * date is kinder than failing months afterward.
 *
 * Only `bikram_sambat` has a bounded table; Gregorian has none, so this is a
 * no-op for every Gregorian property. `moveOutDate` never needs this check:
 * `effectiveBillingEnd` can only SHORTEN a schedule (billing.ts's I13), never
 * lengthen it past `endDate` — so a move-out date can never be the thing that
 * pushes a schedule past the table's edge.
 */
export function validateEndDateSchedulable(calendar: CalendarSystem, endDate: IsoDate | null): string | null {
  if (calendar !== 'bikram_sambat' || endDate === null) return null;
  const limit = furthestBsScheduleDate();
  if (compareIsoDate(endDate, limit) > 0) {
    return `This property's calendar (Bikram Sambat) only has data through ${limit}. Choose an end date on or before that.`;
  }
  return null;
}
